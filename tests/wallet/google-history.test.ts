import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import type { WalletSyncRepository } from "../../src/wallet/engine/wallet-sync.repository";
import { GoogleWalletProvider } from "../../src/wallet/providers/google/google-wallet.provider";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";

type Stored = Record<string, unknown> & {
  textModulesData?: Array<{ id: string; header: string; body: string }>;
};

const google = vi.hoisted(() => ({
  objects: new Map<string, Record<string, unknown>>(),
  calls: [] as Array<{ path: string; method: string; body?: Record<string, unknown> }>,
  /** Google refusing any write that carries the history module. */
  rejectHistory: false,
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
      google.rejectHistory &&
      method !== "GET" &&
      JSON.stringify(options?.body).includes('"history"')
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

const withHistory: LoyaltyCard = {
  ...rewardsPass,
  tier: "Plata",
  history: [
    { at: "2026-11-12T10:00:00.000Z", kind: "visit", name: "Limpieza facial", points: 450 },
    { at: "2026-11-02T09:30:00.000Z", kind: "gift", points: 50 }
  ]
};
const TEXT = "12 nov · Limpieza facial · +450 puntos\n2 nov · Puntos de regalo · +50 puntos";
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
  google.rejectHistory = false;
  google.rejectBestEffort = false;
});

describe("Google card: the points history", () => {
  it("creates the object with a Historial module, the same lines as the Apple back field", async () => {
    await issue(withHistory);

    expect(moduleOf("history")).toEqual({ id: "history", header: "Historial", body: TEXT });
  });

  it("adds no such module for a member with no movements", async () => {
    await issue(rewardsPass);

    expect(moduleOf("history")).toBeUndefined();
  });

  it("a sync adds the module and keeps every other module", async () => {
    await issue(rewardsPass);
    const before = stored().textModulesData?.map((m) => m.id) ?? [];

    await provider().syncCard(ref, { ...withHistory, points: 1900 });

    const after = stored().textModulesData ?? [];

    expect(after.map((m) => m.id).sort()).toEqual([...before, "history"].sort());
    expect(after.find((m) => m.id === "history")?.body).toBe(TEXT);
    expect(after.find((m) => m.id === "points")?.body).toBe("1900");
  });

  it("goes in the best-effort patch after the balance patch", async () => {
    await issue(rewardsPass);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withHistory, points: 1900 });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[0].body)).not.toContain('"history"');
    expect(JSON.stringify(patches[1].body)).toContain('"history"');
  });

  it("still updates the balance, and succeeds, when Google rejects the module", async () => {
    await issue(rewardsPass);
    google.rejectHistory = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...withHistory, points: 1900 })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(moduleOf("history")).toBeUndefined();
    error.mockRestore();
  });

  it("creates the card without the module when Google rejects it", async () => {
    google.rejectHistory = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(issue(withHistory)).resolves.toBeDefined();

    expect(stored()).toBeDefined();
    expect(moduleOf("history")).toBeUndefined();
    error.mockRestore();
  });

  it("is replaced as new movements arrive, not appended", async () => {
    await issue(withHistory);

    await provider().syncCard(ref, {
      ...withHistory,
      history: [{ at: "2026-11-14T10:00:00.000Z", kind: "visit", points: 90 }]
    });

    expect(moduleOf("history")?.body).toBe("14 nov · Visita · +90 puntos");
  });

  it("is removed by a sync whose card has none, keeping every other module", async () => {
    await issue(withHistory);

    await provider().syncCard(ref, { ...rewardsPass, tier: "Plata", points: 1900 });

    const ids = (stored().textModulesData ?? []).map((m) => m.id);

    expect(ids).not.toContain("history");
    expect(ids).toEqual(expect.arrayContaining(["points", "tier", "rewards"]));
  });

  it("costs a card that never had one no extra write", async () => {
    await issue(rewardsPass);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...rewardsPass, rewards: undefined });

    expect(google.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
