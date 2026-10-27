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
  /** Google refusing anything that carries the rewards fields. */
  rejectRewards: false
}));

// Issuing a card builds a save link, which signs with the service account key. CI has no key (and
// a test must never sign with a real one), so the link is a fixed stand-in.
vi.mock("../../src/wallet/providers/google/jwt", () => ({
  buildSaveLink: (objectId: string) => `https://pay.google.com/gp/v/save/test-${objectId}`
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

    if (
      google.rejectRewards &&
      method !== "GET" &&
      JSON.stringify(options?.body).includes("secondaryLoyaltyPoints")
    ) {
      throw new original.GoogleWalletApiError("bad rewards field", 400, "Bad Request", {
        member: "private-data"
      });
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
  google.rejectRewards = false;
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

describe("Google card: the rewards text is bounded", () => {
  it("fits 500 characters even for eight long titles, saying how many it left out", async () => {
    const long = Array.from({ length: 12 }, (_, i) => ({
      title: `${i + 1} ${"T".repeat(80)}`,
      expiresAt: "2026-11-15T10:00:00.000Z"
    }));

    await issue({ ...rewardsPass, rewards: { available: long } });

    const body = moduleOf("rewards")?.body ?? "";
    const shown = body.split("\n").filter((l) => l.startsWith("🎁")).length;

    expect(body.length).toBeLessThanOrEqual(500);
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(body).toContain(`… y ${12 - shown} más`);
    // The count on the card is still every reward.
    expect(stored().secondaryLoyaltyPoints).toMatchObject({ balance: { int: 12 } });
  });
});

describe("Google card: the new fields can never stop the points updating", () => {
  it("sends the rewards in their own patch after the balance, tier and state patch", async () => {
    await issue({ ...rewardsPass, rewards: undefined });
    google.calls.length = 0;

    await provider().syncCard(ref, { ...rewardsPass, points: 1900 });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(patches).toHaveLength(2);
    expect(patches[0].body).toHaveProperty("loyaltyPoints");
    expect(patches[0].body).toHaveProperty("state", "ACTIVE");
    expect(JSON.stringify(patches[0].body)).not.toContain("secondaryLoyaltyPoints");
    expect(JSON.stringify(patches[0].body)).not.toContain("Recompensas disponibles");
    expect(patches[1].body).toHaveProperty("secondaryLoyaltyPoints");
  });

  it("still updates the points, and still succeeds, when Google rejects the rewards fields", async () => {
    await issue(rewardsPass);
    google.rejectRewards = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...rewardsPass, points: 1900, tier: "Oro" })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(moduleOf("tier")?.body).toBe("Oro");
    // Logged by the error's name and status only, never the response body.
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-data");
    error.mockRestore();
  });

  it("creates the object without the rewards when Google rejects them", async () => {
    google.rejectRewards = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(issue(rewardsPass)).resolves.toBeDefined();

    expect(stored()).toBeDefined();
    expect(stored().secondaryLoyaltyPoints).toBeUndefined();
    expect(moduleOf("rewards")).toBeUndefined();
    expect(moduleOf("points")).toBeDefined();
    error.mockRestore();
  });

  it("does not hide a failure that has nothing to do with the rewards", async () => {
    await expect(provider().syncCard(ref, rewardsPass)).rejects.toThrow();
  });
});
