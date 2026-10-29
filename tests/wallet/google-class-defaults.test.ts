import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgramTemplate } from "../../src/wallet/engine/wallet-pass-provider.interface";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { createOrUpdateClass } from "../../src/wallet/providers/google/classService";
import { createObject } from "../../src/wallet/providers/google/objectService";
import { GoogleWalletProvider } from "../../src/wallet/providers/google/google-wallet.provider";

const DEFAULT_LOGO = "https://cdn.voone.example/voone-logo.png";

const state = vi.hoisted(() => ({
  defaultLogo: undefined as string | undefined,
  // What reached Google: the class bodies POSTed by the stand-in client below.
  googleBodies: [] as Array<Record<string, unknown>>
}));

// config is parsed once at import, so the default logo is swapped on the mocked object.
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();
  const config = { ...original.config };

  Object.defineProperty(config, "VOONE_DEFAULT_LOGO_URL", { get: () => state.defaultLogo });

  return { ...original, config };
});

// Stands in for Google's API: the existence check answers 404 so the class is created
// (the body is what reaches Google), and the link-field read-back answers empty.
vi.mock("../../src/wallet/providers/google/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/wallet/providers/google/client")>();
  const request = async (_path: string, options?: { body?: unknown }) => {
    if (!options) throw new original.GoogleWalletApiError("not found", 404, "Not Found");

    state.googleBodies.push(options.body as Record<string, unknown>);

    return {};
  };
  const requestWithResponse = async () => ({ status: 200, statusText: "OK", body: {} });

  return {
    ...original,
    getAuthenticatedClient: () => ({ request, requestWithResponse })
  };
});

const repo = {
  findProgram: async () => null,
  recordProgram: async () => {}
} as unknown as WalletSyncRepository;

const programWith = (images: { logoUrl?: string; heroImageUrl?: string }): ProgramTemplate => ({
  templateId: "tpl-1",
  clinicName: "Centro Prueba",
  template: {
    programName: "Club Prueba",
    backgroundColor: "#30221f",
    pointsLabel: "Puntos",
    tierLabel: "Nivel",
    ...images
  }
});

const provision = async (program: ProgramTemplate): Promise<Record<string, unknown>> => {
  state.googleBodies.length = 0;
  await new GoogleWalletProvider(repo).provisionProgram(program);

  return state.googleBodies[0];
};

beforeEach(() => {
  process.env.GOOGLE_WALLET_ISSUER_ID = "issuer-1";
  state.defaultLogo = undefined;
  state.googleBodies.length = 0;
});

describe("the Google class for a template with no images of its own", () => {
  it("falls back to the configured Voone logo and has no hero image", async () => {
    state.defaultLogo = DEFAULT_LOGO;

    const body = await provision(programWith({}));

    expect(body.programLogo).toEqual({ sourceUri: { uri: DEFAULT_LOGO } });
    expect("heroImage" in body).toBe(false);
  });

  it("has no logo and no hero when no default is configured", async () => {
    const body = await provision(programWith({}));

    expect("programLogo" in body).toBe(false);
    expect("heroImage" in body).toBe(false);
  });

  it("never carries a borrowed i.ibb.co image", async () => {
    state.defaultLogo = DEFAULT_LOGO;

    const body = await provision(programWith({}));

    expect(JSON.stringify(body)).not.toContain("i.ibb.co");
  });

  it("keeps the clinic's own images when it has them", async () => {
    state.defaultLogo = DEFAULT_LOGO;

    const body = await provision(
      programWith({
        logoUrl: "https://clinica.example/logo.png",
        heroImageUrl: "https://clinica.example/hero.png"
      })
    );

    expect(body.programLogo).toEqual({ sourceUri: { uri: "https://clinica.example/logo.png" } });
    expect(body.heroImage).toMatchObject({
      sourceUri: { uri: "https://clinica.example/hero.png" }
    });
  });
});

describe("createOrUpdateClass without images", () => {
  it("omits programLogo and heroImage rather than sending empty images", async () => {
    state.googleBodies.length = 0;

    await createOrUpdateClass({
      issuerName: "Centro Prueba",
      classId: "issuer-1.class",
      programName: "Club Prueba",
      hexBackgroundColor: "#30221f",
      homepageUrl: "https://voone.app"
    });
    const [body] = state.googleBodies;

    expect("programLogo" in body).toBe(false);
    expect("heroImage" in body).toBe(false);
  });
});

interface ClassBody {
  accountNameLabel: string;
  accountIdLabel: string;
  linksModuleData: { uris: Array<{ id: string }> };
  appLinkData: { displayText: { defaultValue: { value: string } } };
  textModulesData: Array<{ header: string }>;
  classTemplateInfo: {
    detailsTemplateOverride?: {
      detailsItemInfos: Array<{
        item: { firstValue: { fields: Array<{ fieldPath: string }> } };
      }>;
    };
  };
}

describe("the Spanish, neutral words on a Google card", () => {
  const classWithLinks = async (): Promise<ClassBody> =>
    (await provision({
      templateId: "tpl-1",
      clinicName: "Centro Prueba",
      template: {
        programName: "Club Prueba",
        backgroundColor: "#30221f",
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        websiteUrl: "https://clinica.example",
        appointmentUrl: "https://clinica.example/reservar",
        benefitsText: "Ventajas.",
        infoText: "Informacion."
      }
    })) as unknown as ClassBody;

  it("labels the member name and number with miembro", async () => {
    const body = await classWithLinks();

    expect(body.accountNameLabel).toBe("Nombre de miembro");
    expect(body.accountIdLabel).toBe("N.º de miembro");
  });

  it("labels the default links, button and modules in Spanish", async () => {
    const body = await classWithLinks();

    expect(body.linksModuleData.uris.map((link: { id: string }) => link.id)).toEqual([
      "Web",
      "Reservar cita"
    ]);
    expect(body.appLinkData.displayText.defaultValue.value).toBe("Reservar cita");
    expect(
      body.textModulesData
        .map((module: { header: string }) => module.header)
        .filter((header: string) => ["Beneficios", "Información"].includes(header))
    ).toEqual(["Beneficios", "Información"]);
  });

  it("describes the hero image in Spanish for a screen reader", async () => {
    const body = (await provision(
      programWith({ heroImageUrl: "https://clinica.example/hero.png" })
    )) as unknown as { heroImage: { contentDescription: { defaultValue: { value: string } } } };

    expect(body.heroImage.contentDescription.defaultValue.value).toBe("Imagen de Club Prueba");
  });

  it("falls back to the same miembro labels when a class names none", async () => {
    state.googleBodies.length = 0;

    await createOrUpdateClass({
      issuerName: "Centro Prueba",
      classId: "issuer-1.class",
      programName: "Club Prueba",
      hexBackgroundColor: "#30221f",
      homepageUrl: "https://voone.app"
    });
    const [body] = state.googleBodies as unknown as ClassBody[];

    expect(body.accountNameLabel).toBe("Nombre de miembro");
    expect(body.accountIdLabel).toBe("N.º de miembro");
  });

  it("shows the rewards: the gift count on the card and the rewards module in the details", async () => {
    const body = (await classWithLinks()) as unknown as {
      classTemplateInfo: {
        cardTemplateOverride: { cardRowTemplateInfos: unknown[] };
        detailsTemplateOverride: { detailsItemInfos: unknown[] };
      };
    };

    expect(JSON.stringify(body.classTemplateInfo.cardTemplateOverride)).toContain(
      "object.secondaryLoyaltyPoints"
    );
    expect(JSON.stringify(body.classTemplateInfo.detailsTemplateOverride)).toContain(
      "object.textModulesData['rewards']"
    );
  });

  it("points the details at the member's own tier benefits module", async () => {
    const body = (await classWithLinks()) as unknown as {
      classTemplateInfo: { detailsTemplateOverride: { detailsItemInfos: unknown[] } };
    };

    expect(JSON.stringify(body.classTemplateInfo.detailsTemplateOverride)).toContain(
      "object.textModulesData['tierbenefits']"
    );
  });

  it("keeps the shared benefits module for a clinic with no programme", async () => {
    const body = await classWithLinks();

    expect(body.textModulesData.map((m: { header: string }) => m.header)).toContain("Beneficios");
  });

  it("leaves the hand-typed benefits off the class of a clinic whose programme owns them", async () => {
    const body = (await provision({
      templateId: "tpl-1",
      clinicName: "Centro Prueba",
      tierBenefitsFromProgramme: true,
      template: {
        programName: "Club Prueba",
        backgroundColor: "#30221f",
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "TEXTO ANTIGUO",
        infoText: "Informacion."
      }
    })) as unknown as ClassBody;

    expect(JSON.stringify(body.textModulesData)).not.toContain("TEXTO ANTIGUO");
    expect(body.textModulesData.map((m: { header: string }) => m.header)).toContain("Información");
  });

  it("never says socia anywhere in the class", async () => {
    expect(JSON.stringify(await classWithLinks())).not.toMatch(/\bsocias?\b/i);
  });

  it("labels the member number on the object with miembro", async () => {
    state.googleBodies.length = 0;

    await createObject({
      objectId: "issuer-1.member_1",
      classId: "issuer-1.class",
      accountName: "Ana",
      accountId: "ABC12",
      loyaltyPointsLabel: "Puntos",
      loyaltyPointsBalance: 10
    });
    const [body] = state.googleBodies as Array<{
      textModulesData: Array<{ id: string; header: string }>;
    }>;

    expect(body.textModulesData.find((module) => module.id === "member_id")?.header).toBe(
      "N.º de miembro"
    );
  });
});

describe("the details template on the Google class", () => {
  const provisionClassBody = async (
    options?: Parameters<typeof createOrUpdateClass>[1]
  ): Promise<ClassBody> => {
    state.googleBodies.length = 0;

    await createOrUpdateClass(
      {
        issuerName: "Centro Prueba",
        classId: "issuer-1.class",
        programName: "Club Prueba",
        hexBackgroundColor: "#30221f",
        homepageUrl: "https://voone.app"
      },
      options
    );

    return state.googleBodies[0] as unknown as ClassBody;
  };

  it("ends with the messages items so TEXT_AND_NOTIFY messages render on the details view", async () => {
    const body = await provisionClassBody();

    expect(
      body.classTemplateInfo.detailsTemplateOverride?.detailsItemInfos.map(
        (item) => item.item.firstValue.fields[0].fieldPath
      )
    ).toEqual([
      "class.textModulesData['clinic']",
      "object.textModulesData['member_id']",
      "object.textModulesData['member_since']",
      "object.textModulesData['rewards']",
      "object.textModulesData['boost']",
      "object.textModulesData['tierbenefits']",
      "object.textModulesData['referral']",
      "class.textModulesData['benefits']",
      "object.accountName",
      "object.accountId",
      "class.textModulesData['info']",
      "class.messages",
      "object.messages"
    ]);
  });

  it("still omits the details override for the default-template test class", async () => {
    const body = await provisionClassBody({ omitDetailsTemplateOverride: true });

    expect(body.classTemplateInfo.detailsTemplateOverride).toBeUndefined();
  });
});
