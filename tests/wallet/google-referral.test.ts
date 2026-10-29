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
  /** Google refusing any write that carries the referral module. */
  rejectReferral: false,
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
      google.rejectReferral &&
      method !== "GET" &&
      JSON.stringify(options?.body).includes('"referral"')
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

const URL_ = "https://voone.app/alta/clinica-aurea?ref=AB2CD";
const withReferral: LoyaltyCard = {
  ...rewardsPass,
  tier: "Plata",
  referral: { code: "AB2CD", url: URL_ }
};
const TEXT = `Tu código: AB2CD. Comparte este enlace: ${URL_}`;
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
  google.rejectReferral = false;
  google.rejectBestEffort = false;
});

describe("Google card: the referral share", () => {
  it("creates the object with a referral module, the same words as the Apple field", async () => {
    await issue(withReferral);

    expect(moduleOf("referral")).toEqual({ id: "referral", header: "Recomienda", body: TEXT });
  });

  it("adds no such module when the card has no referral", async () => {
    await issue(rewardsPass);

    expect(moduleOf("referral")).toBeUndefined();
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

    await provider().syncCard(ref, { ...withReferral, points: 1900 });

    const after = stored().textModulesData ?? [];

    expect(after.map((m) => m.id).sort()).toEqual([...before, "referral"].sort());
    expect(after.find((m) => m.id === "referral")?.body).toBe(TEXT);
    expect(after.find((m) => m.id === "benefits")?.body).toBe("Ventajas.");
    expect(after.find((m) => m.id === "points")?.body).toBe("1900");
  });

  it("goes in the best-effort patch after the balance patch", async () => {
    await issue(rewardsPass);
    google.calls.length = 0;

    await provider().syncCard(ref, { ...withReferral, points: 1900 });

    const patches = google.calls.filter((c) => c.method === "PATCH");

    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[0].body)).not.toContain('"referral"');
    expect(patches[0].body).toHaveProperty("loyaltyPoints");
    expect(JSON.stringify(patches[1].body)).toContain('"referral"');
  });

  it("carries the boost and the referral together without losing either", async () => {
    await issue(rewardsPass);

    await provider().syncCard(ref, { ...withReferral, boost: { kind: "referral" } });

    expect(moduleOf("referral")?.body).toBe(TEXT);
    expect(moduleOf("boost")?.body).toBe("Tu primera visita suma el doble de puntos.");
  });

  it("still updates the balance, and succeeds, when Google rejects the module", async () => {
    await issue(rewardsPass);
    google.rejectReferral = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider().syncCard(ref, { ...withReferral, points: 1900 })
    ).resolves.toBeUndefined();

    expect(moduleOf("points")?.body).toBe("1900");
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-data");
    error.mockRestore();
  });

  it("creates the card without the module when Google rejects it", async () => {
    google.rejectReferral = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(issue(withReferral)).resolves.toBeDefined();

    expect(moduleOf("referral")).toBeUndefined();
    expect(moduleOf("points")).toBeDefined();
    error.mockRestore();
  });

  it("the points-credit patch does not drop the module", async () => {
    await issue(withReferral);

    await patchObject(OBJECT_ID, { loyaltyPointsBalance: 2000, notify: true });

    expect(moduleOf("referral")?.body).toBe(TEXT);
  });
});

describe("Google card: a stale referral module", () => {
  it("is removed by a sync whose card has no referral, keeping every other module", async () => {
    await issue(withReferral);

    await provider().syncCard(ref, { ...rewardsPass, tier: "Plata", points: 1900 });

    const ids = (stored().textModulesData ?? []).map((m) => m.id);

    expect(ids).not.toContain("referral");
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
    await issue(withReferral);
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
