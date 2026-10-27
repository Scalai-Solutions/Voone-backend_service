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
  /** Google refusing any write that carries the tierbenefits module. */
  rejectTierBenefits: false,
  /** Google refusing the second, best-effort patch (the one without the balance). */
  rejectBestEffort: false
}));

// Google's object store with its PATCH semantics: top-level fields REPLACE what is stored.
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
      google.rejectTierBenefits &&
      method !== "GET" &&
      JSON.stringify(options?.body).includes("tierbenefits")
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

const withTier: LoyaltyCard = {
  ...rewardsPass,
  tier: "Plata",
  tierBenefits: { tier: "Plata", lines: ["Descuento del 3% en cosmética", "Prioridad en huecos"] }
};
const TEXT = "Plata\n• Descuento del 3% en cosmética\n• Prioridad en huecos";
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
  google.rejectTierBenefits = false;
  google.rejectBestEffort = false;
});

describe("Google card: the member's tier benefits", () => {
  it("creates the object with the tierbenefits module, the same words as the Apple field", async () => {
    await issue(withTier);

    expect(moduleOf("tierbenefits")).toEqual({
      id: "tierbenefits",
      header: "Beneficios de tu nivel",
      body: TEXT
    });
  });

  it("adds no such module for a clinic with no programme", async () => {
    await issue({ ...rewardsPass, tierBenefits: undefined });

    expect(moduleOf("tierbenefits")).toBeUndefined();
  });

  it("a sync adds the module and keeps every other module", async () => {
    await issue({ ...rewardsPass, tierBenefits: undefined });
    google.objects.set(OBJECT_ID, {
      ...stored(),
      textModulesData: [
        ...(stored().textModulesData ?? []),
        { id: "benefits", header: "Beneficios", body: "Ventajas." },
        { id: "info", header: "Información", body: "Info." }
      ]
    });
    const before = stored().textModulesData?.map((m) => m.id) ?? [];

    await provider().syncCard(ref, { ...withTier, points: 1900 });

    const after = stored().textModulesData ?? [];

    expect(after.map((m) => m.id).sort()).toEqual([...before, "tierbenefits"].sort());
    expect(after.find((m) => m.id === "tierbenefits")?.body).toBe(TEXT);
    expect(after.find((m) => m.id === "benefits")?.body).toBe("Ventajas.");
    expect(after.find((m) => m.id === "info")?.body).toBe("Info.");
    expect(after.find((m) => m.id === "rewards")?.body).toContain("🎁 Limpieza facial");
    expect(after.find((m) => m.id === "points")?.body).toBe("1900");
  });

  it("a sync replaces the text when the member moves to another tier", async () => {
    await issue(withTier);

    await provider().syncCard(ref, {
      ...withTier,
      tier: "Oro",
      tierBenefits: { tier: "Oro", lines: ["Happy Hour"] }
    });

    expect(moduleOf("tierbenefits")?.body).toBe("Oro\n• Happy Hour");
    expect(moduleOf("tier")?.body).toBe("Oro");
  });

  it("goes in the best-effort patch after the balance patch, together with the rewards", async () => {
    await issue({ ...withTier, rewards: undefined, tierBenefits: undefined });
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withTier, points: 1900 });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[0].body)).not.toContain("tierbenefits");
    expect(patches[0].body).toHaveProperty("loyaltyPoints");
    expect(JSON.stringify(patches[1].body)).toContain("tierbenefits");
  });

  it("sends a patch of its own for a programme clinic that has no rewards parts", async () => {
    await issue({ ...withTier, rewards: undefined });
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withTier, rewards: undefined });

    expect(moduleOf("tierbenefits")?.body).toBe(TEXT);
  });

  it("still updates the balance, and succeeds, when Google rejects the module", async () => {
    await issue({ ...withTier, tierBenefits: undefined });
    google.rejectTierBenefits = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...withTier, points: 1900, tier: "Oro" })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(moduleOf("tier")?.body).toBe("Oro");
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-data");
    error.mockRestore();
  });

  it("creates the card without the module when Google rejects it", async () => {
    google.rejectTierBenefits = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(issue(withTier)).resolves.toBeDefined();

    expect(stored()).toBeDefined();
    expect(moduleOf("tierbenefits")).toBeUndefined();
    expect(moduleOf("points")).toBeDefined();
    error.mockRestore();
  });

  it("the points-credit patch does not drop the module", async () => {
    await issue(withTier);

    await patchObject(OBJECT_ID, { loyaltyPointsBalance: 2000, notify: true });

    expect(moduleOf("tierbenefits")?.body).toBe(TEXT);
  });
});

describe("Google card: a stale tier benefits module", () => {
  it("is removed by a sync whose card has no tier benefits, keeping every other module", async () => {
    await issue(withTier);

    await provider().syncCard(ref, { ...withTier, tierBenefits: undefined, points: 1900 });

    const ids = (stored().textModulesData ?? []).map((m) => m.id);

    expect(ids).not.toContain("tierbenefits");
    expect(ids).toEqual(expect.arrayContaining(["points", "member_id", "tier", "rewards"]));
    expect(moduleOf("points")?.body).toBe("1900");
  });

  it("is removed for a clinic that no longer has a live programme (no rewards either)", async () => {
    await issue(withTier);

    await provider().syncCard(ref, { ...withTier, tierBenefits: undefined, rewards: undefined });

    expect(moduleOf("tierbenefits")).toBeUndefined();
    expect(moduleOf("rewards")?.body).toContain("🎁 Limpieza facial");
  });

  it("is removed in the best-effort patch, after the balance patch", async () => {
    await issue(withTier);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withTier, tierBenefits: undefined });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(JSON.stringify(patches[1].body)).not.toContain("tierbenefits");
    expect(patches[0].body).toHaveProperty("loyaltyPoints");
  });

  it("costs a clinic with no programme and no such module no extra write", async () => {
    await issue({ ...rewardsPass, rewards: undefined, tierBenefits: undefined });
    google.calls.length = 0;

    await provider().syncCard(ref, { ...rewardsPass, rewards: undefined, tierBenefits: undefined });

    expect(google.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("does not stop the balance patch if the removal fails", async () => {
    await issue(withTier);
    google.rejectBestEffort = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...withTier, tierBenefits: undefined, points: 1900 })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
