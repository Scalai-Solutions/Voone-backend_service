import { WalletProviderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/infrastructure/database/prisma-client";
import { refreshClinicCards } from "../../src/modules/wallet-refresh/clinic-card-refresh";
import { refreshGoogleClasses } from "../../src/modules/wallet-refresh/google-class-refresh";
import { GoogleWalletProvider } from "../../src/wallet/providers/google/google-wallet.provider";

const google = vi.hoisted(() => ({
  patches: [] as Array<{ path: string; body: Record<string, unknown> }>,
  failClass: undefined as string | undefined
}));

// Google's side: the class exists (the GET answers), the PATCH is recorded, and one class can be
// made to fail.
vi.mock("../../src/wallet/providers/google/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/wallet/providers/google/client")>();
  const request = async () => ({});
  const requestWithResponse = async (
    path: string,
    options?: { method?: string; body?: Record<string, unknown> }
  ) => {
    if (options?.method === "PATCH") {
      if (google.failClass && path.includes(google.failClass)) {
        throw new original.GoogleWalletApiError("secret detail from google", 500, "Server Error", {
          member: "private-data"
        });
      }

      google.patches.push({ path, body: options.body ?? {} });
    }

    return { status: 200, statusText: "OK", body: {} };
  };

  return {
    ...original,
    isGoogleWalletConfigured: () => true,
    getAuthenticatedClient: () => ({ request, requestWithResponse })
  };
});

const repo = {} as never;
const provider = () => new GoogleWalletProvider(repo);

const row = (clinicId: string, classId: string) => ({
  externalClassId: classId,
  clinicTemplate: {
    id: `tpl-${clinicId}`,
    clinicId,
    clinic: { id: clinicId, name: `Centro ${clinicId}` },
    programName: "Club",
    hexBackgroundColor: "#30221f",
    logoUrl: null,
    heroImageUrl: null,
    websiteUrl: "https://clinica.example",
    appointmentUrl: null,
    appLinkText: null,
    appLinkDescription: null,
    pointsLabel: "Puntos",
    tierLabel: "Nivel",
    benefitsText: "Ventajas.",
    infoText: null
  }
});

const prismaWith = (rows: unknown[]) => {
  const findMany = vi.fn(async () => rows);

  return { prisma: { walletClass: { findMany } } as never, findMany };
};

beforeEach(() => {
  process.env.GOOGLE_WALLET_ISSUER_ID = "issuer-1";
  google.patches.length = 0;
  google.failClass = undefined;
});

describe("refreshGoogleClasses", () => {
  it("PATCHes a recorded Google class with the template, including the rewards rows", async () => {
    const { prisma: db, findMany } = prismaWith([row("c1", "issuer-1.club_1")]);

    const result = await refreshGoogleClasses({
      prisma: db,
      provider: provider(),
      clinicId: "c1",
      apply: true
    });

    expect(result).toEqual({ found: 1, refreshed: 1, failed: 0 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: WalletProviderType.GOOGLE, clinicTemplate: { clinicId: "c1" } }
      })
    );
    expect(google.patches).toHaveLength(1);
    expect(google.patches[0].path).toContain("issuer-1.club_1");

    const template = JSON.stringify(google.patches[0].body.classTemplateInfo);

    expect(template).toContain("object.secondaryLoyaltyPoints");
    expect(template).toContain("object.textModulesData['rewards']");
    expect(google.patches[0].body.programName).toBe("Club");
  });

  it("writes nothing on a dry run, and says what it would do", async () => {
    const { prisma: db } = prismaWith([row("c1", "issuer-1.club_1")]);

    const result = await refreshGoogleClasses({
      prisma: db,
      provider: provider(),
      apply: false
    });

    expect(result).toEqual({ found: 1, refreshed: 0, failed: 0 });
    expect(google.patches).toHaveLength(0);
  });

  it("covers every clinic when none is named", async () => {
    const { prisma: db, findMany } = prismaWith([]);

    await refreshGoogleClasses({ prisma: db, provider: provider(), apply: true });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: WalletProviderType.GOOGLE } })
    );
  });

  it("carries on past a class that fails, logging the error name and clinic only", async () => {
    google.failClass = "club_1";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { prisma: db } = prismaWith([row("c1", "issuer-1.club_1"), row("c2", "issuer-1.club_2")]);

    const result = await refreshGoogleClasses({ prisma: db, provider: provider(), apply: true });

    expect(result).toEqual({ found: 2, refreshed: 1, failed: 1 });
    expect(google.patches.map((p) => p.path)).toEqual([expect.stringContaining("club_2")]);
    expect(JSON.stringify(error.mock.calls)).toContain("c1");
    expect(JSON.stringify(error.mock.calls)).toContain("GoogleWalletApiError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-data");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
    error.mockRestore();
  });

  it("does nothing when Google is not configured", async () => {
    const { prisma: db, findMany } = prismaWith([row("c1", "issuer-1.club_1")]);
    const unconfigured = { isConfigured: () => false } as unknown as GoogleWalletProvider;

    const result = await refreshGoogleClasses({
      prisma: db,
      provider: unconfigured,
      apply: true
    });

    expect(result).toEqual({ found: 0, refreshed: 0, failed: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("refreshClinicCards and the Google class", () => {
  const queueThat = (enqueued: string[]) => ({
    enqueueMemberSync: async (id: string) => void enqueued.push(id),
    close: async () => undefined
  });

  it("refreshes the clinic's Google classes, then queues the members", async () => {
    const order: string[] = [];
    const find = vi.spyOn(prisma.member, "findMany").mockResolvedValue([{ id: "m1" }] as never);
    const classes = vi.fn(async () => void order.push("classes"));

    await refreshClinicCards(
      "clinic-1",
      { enqueueMemberSync: async () => void order.push("member"), close: async () => undefined },
      classes
    );

    expect(classes).toHaveBeenCalledWith("clinic-1");
    expect(order).toEqual(["classes", "member"]);
    find.mockRestore();
  });

  it("still queues every member when the class refresh throws", async () => {
    const find = vi
      .spyOn(prisma.member, "findMany")
      .mockResolvedValue([{ id: "m1" }, { id: "m2" }] as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enqueued: string[] = [];

    const queued = await refreshClinicCards("clinic-1", queueThat(enqueued), async () => {
      throw new Error("google is down");
    });

    expect(queued).toBe(2);
    expect(enqueued).toEqual(["m1", "m2"]);
    find.mockRestore();
    log.mockRestore();
  });
});
