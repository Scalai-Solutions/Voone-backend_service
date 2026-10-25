import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgramTemplate } from "../../src/wallet/engine/wallet-pass-provider.interface";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { createOrUpdateClass } from "../../src/wallet/providers/google/classService";
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
