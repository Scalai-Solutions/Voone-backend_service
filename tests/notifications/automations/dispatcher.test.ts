import { AutomationEvent } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { NotificationDispatcher } from "../../../src/modules/notifications/automations/dispatcher";
import type { ScheduledTrigger } from "../../../src/modules/notifications/automations/triggers/types";

const schedule = { timeZone: "Europe/Madrid", hour: 9, minute: 0, lockKey: 1 };

const trigger = (
  event: AutomationEvent,
  overrides: Partial<ScheduledTrigger> = {}
): ScheduledTrigger => ({
  event,
  isDue: () => true,
  findRecipients: vi.fn(async () => [{ memberId: "m1" }]),
  idempotencyKey: (clinicId) => `${event}:${clinicId}`,
  ...overrides
});

const build = (opts: {
  locked?: boolean;
  automations?: Array<Record<string, unknown>>;
  triggers: ScheduledTrigger[];
  dispatch?: ReturnType<typeof vi.fn>;
}) => {
  const dispatch = opts.dispatch ?? vi.fn(async () => ({ recipients: 1, deliveriesCreated: 1 }));
  const tx = { $queryRaw: async () => [{ locked: opts.locked ?? true }] };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    clinic: {
      findMany: async () => [{ id: "c1", automations: opts.automations ?? [] }]
    }
  };

  return {
    dispatcher: new NotificationDispatcher(
      prisma as never,
      { dispatch } as never,
      opts.triggers,
      schedule
    ),
    dispatch
  };
};

describe("NotificationDispatcher", () => {
  it("skips the whole tick when another replica holds the lock", async () => {
    const t = trigger(AutomationEvent.BIRTHDAY);
    const { dispatcher, dispatch } = build({ locked: false, triggers: [t] });

    expect(await dispatcher.runOnce()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs only the triggers that are due, using Madrid's calendar day", async () => {
    const referral = trigger(AutomationEvent.REFERRAL_PROMO, { isDue: (today) => today.day === 1 });
    const { dispatcher, dispatch } = build({
      // The referral push is off until a clinic switches it on.
      automations: [
        { event: "REFERRAL_PROMO", enabled: true, header: "h", body: "b", notify: true }
      ],
      triggers: [referral, trigger(AutomationEvent.BIRTHDAY)]
    });

    // 23:30 UTC on 31 Oct is already 1 Nov in Madrid.
    const summary = await dispatcher.runOnce(new Date("2026-10-31T23:30:00Z"));

    expect(summary).toMatchObject({ date: "2026-11-01", sends: 2 });
    expect(dispatch).toHaveBeenCalledTimes(2);

    // The next day the monthly one is no longer due.
    await dispatcher.runOnce(new Date("2026-11-02T12:00:00Z"));
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("does not look for recipients of an event the clinic has switched off", async () => {
    const birthday = trigger(AutomationEvent.BIRTHDAY);
    const { dispatcher } = build({
      automations: [{ event: "BIRTHDAY", enabled: false, header: "h", body: "b", notify: true }],
      triggers: [birthday]
    });

    await dispatcher.runOnce();

    expect(birthday.findRecipients).not.toHaveBeenCalled();
  });

  it("keeps going when one event fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = trigger(AutomationEvent.BIRTHDAY, {
      findRecipients: async () => {
        throw new Error("boom");
      }
    });
    const healthy = trigger(AutomationEvent.BONO_INACTIVE);
    const { dispatcher, dispatch } = build({ triggers: [broken, healthy] });

    const summary = await dispatcher.runOnce();

    expect(summary).toMatchObject({ failures: 1, sends: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
