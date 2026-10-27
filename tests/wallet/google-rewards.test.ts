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
  calls: [] as Array<{ path: string; method: string; body?: Record<string, unknown> }>
}));

// A small stand-in for Google's object store with Google's PATCH semantics: top-level fields in
// the body REPLACE what is stored, so an array patched with one element leaves one element.
vi.mock("../../src/wallet/providers/google/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/wallet/providers/google/client")>();
  const request = async (
    path: string,
    options?: { method?: string; body?: Record<string, unknown> }
  ) => {
    const method = options?.method ?? "GET";

    google.calls.push({ path, method, body: options?.body });

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

// The provider derives it: issuer, then the member id with its hyphens made safe.
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
});

describe("Google card: redeemable rewards", () => {
  it("creates the object with the gift count and the rewards module", async () => {
    await issue(rewardsPass);

    expect(stored().secondaryLoyaltyPoints).toEqual({ label: "Regalos", balance: { int: 2 } });
    expect(moduleOf("rewards")).toEqual({
      id: "rewards",
      header: "Recompensas disponibles",
      body: [
        "🎁 Limpieza facial · hasta 15 nov",
        "🎁 Kit de minitallas · hasta 20 dic",
        "Preséntalas en el centro para canjearlas."
      ].join("\n")
    });
  });

  it("creates a zero count and the empty text for a programme member with none", async () => {
    await issue({ ...rewardsPass, rewards: { available: [] } });

    expect(stored().secondaryLoyaltyPoints).toEqual({ label: "Regalos", balance: { int: 0 } });
    expect(moduleOf("rewards")?.body).toContain("Aún no tienes recompensas disponibles.");
  });

  it("adds neither for a clinic with no programme", async () => {
    await issue({ ...rewardsPass, rewards: undefined });

    expect(stored().secondaryLoyaltyPoints).toBeUndefined();
    expect(moduleOf("rewards")).toBeUndefined();
  });

  it("shows the same lines as the Apple back field, truncated the same way", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      title: `Premio ${i + 1}`,
      expiresAt: "2026-09-12T10:00:00.000Z"
    }));

    await issue({ ...rewardsPass, rewards: { available: nine } });

    expect(moduleOf("rewards")?.body).toContain("🎁 Premio 8 · hasta 12 sept");
    expect(moduleOf("rewards")?.body).toContain("… y 1 más");
    expect(stored().secondaryLoyaltyPoints).toMatchObject({ balance: { int: 9 } });
  });

  it("a sync updates the count and the module and keeps every other object module", async () => {
    await issue(rewardsPass);
    // Whatever else the object carries must survive a patch that replaces the array.
    google.objects.set(OBJECT_ID, {
      ...stored(),
      textModulesData: [
        ...(stored().textModulesData ?? []),
        { id: "benefits", header: "Beneficios", body: "Ventajas." },
        { id: "info", header: "Información", body: "Info." }
      ]
    });
    const before = stored().textModulesData?.map((m) => m.id);

    await provider().syncCard(ref, { ...rewardsPass, rewards: { available: [] }, points: 1900 });

    const after = stored().textModulesData ?? [];

    expect(after.map((m) => m.id).sort()).toEqual([...(before ?? [])].sort());
    expect(after.find((m) => m.id === "benefits")?.body).toBe("Ventajas.");
    expect(after.find((m) => m.id === "info")?.body).toBe("Info.");
    expect(after.find((m) => m.id === "member_id")).toBeDefined();
    expect(after.find((m) => m.id === "rewards")?.body).toContain("Aún no tienes");
    expect(after.find((m) => m.id === "points")?.body).toBe("1900");
    expect(stored().secondaryLoyaltyPoints).toEqual({ label: "Regalos", balance: { int: 0 } });
  });

  it("a sync adds the module to an object created before rewards existed", async () => {
    await issue({ ...rewardsPass, rewards: undefined });

    await provider().syncCard(ref, rewardsPass);

    expect(moduleOf("rewards")?.body).toContain("🎁 Limpieza facial");
    expect(moduleOf("tier")).toBeDefined();
    expect(moduleOf("member_since")).toBeDefined();
    expect(stored().secondaryLoyaltyPoints).toMatchObject({ balance: { int: 2 } });
  });

  it("a sync for a clinic with no programme leaves the rewards parts untouched", async () => {
    await provider()
      .syncCard(ref, { ...rewardsPass, rewards: undefined })
      .catch(() => {});
    google.objects.set(OBJECT_ID, {
      id: OBJECT_ID,
      textModulesData: [{ id: "rewards", header: "x", body: "kept" }]
    });
    google.calls.length = 0;

    await provider().syncCard(ref, { ...rewardsPass, rewards: undefined });

    expect(moduleOf("rewards")?.body).toBe("kept");
    expect(google.calls.at(-1)?.body).not.toHaveProperty("secondaryLoyaltyPoints");
  });

  it("the points-credit patch does not drop the rewards module", async () => {
    await issue(rewardsPass);

    await patchObject(OBJECT_ID, { loyaltyPointsBalance: 2000, notify: true });

    expect(moduleOf("rewards")?.body).toContain("🎁 Limpieza facial");
    expect(moduleOf("points")?.body).toBe("2000");
  });
});
