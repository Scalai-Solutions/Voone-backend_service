import { describe, expect, it, vi } from "vitest";

import {
  GOOGLE_SAVE_CHECK_DELAYS_MS,
  NotificationService,
  type GoogleSaveCheckJob
} from "../../src/modules/notifications/notification.service";

/** The watch that sends the tier welcome once a member has saved their Google pass. */
const build = (opts: { saved: boolean; welcomed?: boolean; tier?: string | null; pass?: boolean }) => {
  const scheduled: Array<{ job: GoogleSaveCheckJob; delayMs: number }> = [];
  const keys: unknown[] = [];
  const prisma = {
    member: {
      findFirst: async () => ({
        id: "m1",
        clinicId: "c1",
        tier: opts.tier === undefined ? "Bronce" : opts.tier,
        walletObjects: opts.pass === false ? [] : [{ externalObjectId: "issuer.member_m1" }]
      })
    },
    notification: {
      findFirst: async ({ where }: { where: { idempotencyKey: string } }) => (
        keys.push(where.idempotencyKey),
        opts.welcomed ? { id: "n1" } : null
      )
    }
  };
  const jobs = {
    enqueueGoogleSaveCheck: async (job: GoogleSaveCheckJob, delayMs: number) =>
      void scheduled.push({ job, delayMs })
  };
  const service = new NotificationService(
    prisma as never,
    {} as never,
    {} as never,
    jobs as never,
    null,
    async () => opts.saved
  );
  const welcome = vi.spyOn(service, "onGooglePassSaved").mockResolvedValue(null);

  return { service, scheduled, welcome, keys };
};

describe("watching for a Google pass save", () => {
  it("starts with a short first look", async () => {
    const { service, scheduled } = build({ saved: false });

    await service.watchGooglePassSave("m1");

    expect(scheduled).toEqual([
      { job: { memberId: "m1", attempt: 0 }, delayMs: GOOGLE_SAVE_CHECK_DELAYS_MS[0] }
    ]);
  });

  it("sends the tier welcome once the pass is saved, and stops looking", async () => {
    const { service, scheduled, welcome, keys } = build({ saved: true });

    await service.processGoogleSaveCheck({ memberId: "m1", attempt: 0 });

    expect(welcome).toHaveBeenCalledWith("m1");
    expect(scheduled).toEqual([]);
    // The same key as the tier message, so the callback and the watch cannot both send it.
    expect(keys).toEqual(["tier:m1:Bronce"]);
  });

  it("looks again later while the pass is not saved", async () => {
    const { service, scheduled, welcome } = build({ saved: false });

    await service.processGoogleSaveCheck({ memberId: "m1", attempt: 2 });

    expect(welcome).not.toHaveBeenCalled();
    expect(scheduled).toEqual([
      { job: { memberId: "m1", attempt: 3 }, delayMs: GOOGLE_SAVE_CHECK_DELAYS_MS[3] }
    ]);
  });

  it("gives up after the last look", async () => {
    const { service, scheduled } = build({ saved: false });

    await service.processGoogleSaveCheck({
      memberId: "m1",
      attempt: GOOGLE_SAVE_CHECK_DELAYS_MS.length - 1
    });

    expect(scheduled).toEqual([]);
  });

  it("does nothing once the member has already been welcomed to the tier", async () => {
    const { service, scheduled, welcome } = build({ saved: true, welcomed: true });

    await service.processGoogleSaveCheck({ memberId: "m1", attempt: 0 });

    expect(welcome).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it("does nothing for a member with no tier or no Google pass", async () => {
    for (const opts of [{ tier: null }, { pass: false }]) {
      const { service, scheduled, welcome } = build({ saved: true, ...opts });

      await service.processGoogleSaveCheck({ memberId: "m1", attempt: 0 });

      expect(welcome).not.toHaveBeenCalled();
      expect(scheduled).toEqual([]);
    }
  });
});
