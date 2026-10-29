import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { GoogleWalletProvider } from "../../src/wallet/providers/google/google-wallet.provider";
import { patchObject } from "../../src/wallet/providers/google/objectService";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";

type Stored = Record<string, unknown> & {
  textModulesData?: Array<{ id: string; header: string; body: string }>;
};

const google = vi.hoisted(() => ({
  objects: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<{ path: string; method: string; body?: Record<string, unknown> }>,
  /** Google refusing any write that carries the boost module. */
  rejectBoost: false,
  /** Google refusing the second, best-effort patch (the one without the balance). */
  rejectBestEffort: false
}));

// Google's object store with its PATCH semantics: top-level fields REPLACE what is stored.
// Issuing a card builds a save link, which signs with the service account key. CI has none (and a
// test must never sign with a real one), so the link is a fixed stand-in.
vi.mock("../../src/wallet/providers/google/jwt", () => ({
  buildSaveLink: (objectId: string) => `https://pay.google.com/gp/v/save/test-${objectId}`
}));

vi.mock("../../src/wallet/providers/google/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/wallet/providers/google/client")>();
  const request = async (
    path: string,
    options?: { method?: string; body?: Record<string, unknown> }
  ) => {
    const method = options?.method ?? "GET";

    google.calls.push({ path, method, body: options?.body });

    if (
      google.rejectBoost &&
      method !== "GET" &&
      JSON.stringify(options?.body).includes('"boost"')
    ) {
      throw new original.GoogleWalletApiError("bad module", 400, "Bad Request", {
        member: "private-data"
      });
    }

    if (
      google.rejectBestEffort &&
      method === "PATCH" &&
      !("loyaltyPoints" in (options?.body ?? {}))
    ) {
      throw new original.GoogleWalletApiError("bad patch", 500, "Server Error");
    }

    if (method === "POST") {
      const body = options?.body as { id: string };

      google.objects.set(body.id, structuredClone(body));

      return {};
    }

    const id = decodeURIComponent(path.replace("/loyaltyObject/", ""));
    const stored = google.objects.get(id);

    if (!stored) throw new original.GoogleWalletApiError("not found", 404, "Not Found");

    if (method === "PATCH") {
      google.objects.set(id, { ...stored, ...structuredClone(options?.body) });

      return {};
    }

    return structuredClone(stored);
  };

  return {
    ...original,
    assertIssuerScopedId: () => {},
    getAuthenticatedClient: () => ({ request })
  };
});

const withBoost: LoyaltyCard = {
  ...rewardsPass,
  tier: "Plata",
  boost: { kind: "perk", until: "2026-09-12T10:00:00.000Z" }
};
const TEXT = "Tu próxima visita suma el doble de puntos. Válido hasta el 12 sept.";
const OBJECT_ID = `issuer-1.member_${rewardsPass.memberId.replace(/-/g, "_")}`;

const repo = {
  findCard: async () => null,
  recordCard: async () => {},
  markSynced: async () => {},
  markFailed: async () => {}
} as unknown as WalletSyncRepository;

const provider = () => new GoogleWalletProvider(repo);
const ref = { provider: "GOOGLE", externalId: OBJECT_ID, memberId: rewardsPass.memberId } as never;
const stored = (): Stored => google.objects.get(OBJECT_ID) as Stored;
const moduleOf = (id: string) => stored().textModulesData?.find((m) => m.id === id);
const issue = (card: LoyaltyCard) =>
  provider().issueCard(card, { provider: "GOOGLE", externalId: "issuer-1.class" } as never);

beforeEach(() => {
  process.env.GOOGLE_WALLET_ISSUER_ID = "issuer-1";
  google.objects.clear();
  google.calls.length = 0;
  google.rejectBoost = false;
  google.rejectBestEffort = false;
});

describe("Google card: the pending double points", () => {
  it("creates the object with a boost module, the same words as the Apple field", async () => {
    await issue(withBoost);

    expect(moduleOf("boost")).toEqual({ id: "boost", header: "Puntos dobles", body: TEXT });
  });

  it("adds no such module when nothing is pending", async () => {
    await issue(rewardsPass);

    expect(moduleOf("boost")).toBeUndefined();
  });

  it("a sync adds the module and keeps every other module", async () => {
    await issue(rewardsPass);
    google.objects.set(OBJECT_ID, {
      ...stored(),
      textModulesData: [
        ...(stored().textModulesData ?? []),
        { id: "benefits", header: "Beneficios", body: "Ventajas." }
      ]
    });
    const before = stored().textModulesData?.map((m) => m.id) ?? [];

    await provider().syncCard(ref, { ...withBoost, points: 1900 });

    const after = stored().textModulesData ?? [];

    expect(after.map((m) => m.id).sort()).toEqual([...before, "boost"].sort());
    expect(after.find((m) => m.id === "boost")?.body).toBe(TEXT);
    expect(after.find((m) => m.id === "benefits")?.body).toBe("Ventajas.");
    expect(after.find((m) => m.id === "points")?.body).toBe("1900");
  });

  it("goes in the best-effort patch after the balance patch", async () => {
    await issue(rewardsPass);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withBoost, points: 1900 });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[0].body)).not.toContain('"boost"');
    expect(patches[0].body).toHaveProperty("loyaltyPoints");
    expect(JSON.stringify(patches[1].body)).toContain('"boost"');
  });

  it("still updates the balance, and succeeds, when Google rejects the module", async () => {
    await issue(rewardsPass);
    google.rejectBoost = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(provider().syncCard(ref, { ...withBoost, points: 1900 })).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-data");
    error.mockRestore();
  });

  it("creates the card without the module when Google rejects it", async () => {
    google.rejectBoost = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(issue(withBoost)).resolves.toBeDefined();

    expect(moduleOf("boost")).toBeUndefined();
    expect(moduleOf("points")).toBeDefined();
    error.mockRestore();
  });

  it("the points-credit patch does not drop the module", async () => {
    await issue(withBoost);

    await patchObject(OBJECT_ID, { loyaltyPointsBalance: 2000, notify: true });

    expect(moduleOf("boost")?.body).toBe(TEXT);
  });
});

describe("Google optional modules: a patch that only changes their text", () => {
  it.each([
    ["tierBenefits", "tierbenefits"],
    ["boost", "boost"],
    ["referral", "referral"]
  ])("writes a changed %s text even though the module count is the same", async (key, id) => {
    await issue({
      ...rewardsPass,
      tier: "Plata",
      tierBenefits: { tier: "Plata", lines: ["A"] },
      boost: { kind: "referral" },
      referral: { code: "AB2CD", url: "https://voone.app/alta/x?ref=AB2CD" }
    });

    await patchObject(OBJECT_ID, { [key]: { text: "texto nuevo" } });

    expect(moduleOf(id)?.body).toBe("texto nuevo");
  });
});

describe("Google card: a stale boost module", () => {
  it("is removed by a sync whose card has no boost, keeping every other module", async () => {
    await issue(withBoost);

    await provider().syncCard(ref, { ...rewardsPass, tier: "Plata", points: 1900 });

    const ids = (stored().textModulesData ?? []).map((m) => m.id);

    expect(ids).not.toContain("boost");
    expect(ids).toEqual(expect.arrayContaining(["points", "member_id", "tier", "rewards"]));
    expect(moduleOf("points")?.body).toBe("1900");
  });

  it("costs a card that never had one no extra write", async () => {
    await issue(rewardsPass);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...rewardsPass, rewards: undefined });

    expect(google.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("does not stop the balance patch if the removal fails", async () => {
    await issue(withBoost);
    google.rejectBestEffort = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...rewardsPass, points: 1900 })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
