import { describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/infrastructure/database/prisma-client";
import { refreshClinicCards } from "../../src/modules/wallet-refresh/clinic-card-refresh";
import { createTemplateSchema } from "../../src/modules/templates/templates.schema";

describe("refreshClinicCards", () => {
  it("queues one sync per member of the clinic that holds a wallet pass", async () => {
    const find = vi
      .spyOn(prisma.member, "findMany")
      .mockResolvedValue([{ id: "m1" }, { id: "m2" }, { id: "m3" }] as never);
    const enqueued: string[] = [];
    const queue = {
      enqueueMemberSync: async (id: string) => void enqueued.push(id),
      close: async () => undefined
    };

    expect(await refreshClinicCards("clinic-1", queue)).toBe(3);
    expect(enqueued).toEqual(["m1", "m2", "m3"]);
    expect(find).toHaveBeenCalledWith({
      where: { clinicId: "clinic-1", erasedAt: null, walletObjects: { some: {} } },
      select: { id: true }
    });
    find.mockRestore();
  });

  it("does nothing, and does not throw, when wallets are not configured", async () => {
    expect(await refreshClinicCards("clinic-1", null)).toBe(0);
  });

  it("does not throw when the member lookup fails", async () => {
    const find = vi.spyOn(prisma.member, "findMany").mockRejectedValue(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = { enqueueMemberSync: async () => undefined, close: async () => undefined };

    expect(await refreshClinicCards("clinic-1", queue)).toBe(0);
    find.mockRestore();
    log.mockRestore();
  });
});

describe("template image URLs", () => {
  const base = {
    presetId: "preset-1",
    programName: "Club",
    hexBackgroundColor: "#2a2e35",
    treatments: [{ name: "Facial", pointsAllotted: 100 }]
  };

  it("refuses a pasted line of text that contains a URL and other words", () => {
    const result = createTemplateSchema.safeParse({
      ...base,
      heroImageUrl: "https://i.ibb.co/a/hero.jpg  logo  https://i.ibb.co/b/logo.png  featured image"
    });

    expect(result.success).toBe(false);
  });

  it("accepts one URL, a blank, and the optional dark-background logo", () => {
    const result = createTemplateSchema.safeParse({
      ...base,
      heroImageUrl: "https://i.ibb.co/a/hero.jpg",
      logoUrl: "",
      logoOnDarkUrl: "https://i.ibb.co/b/logo-light.png"
    });

    expect(result.success).toBe(true);
  });
});
