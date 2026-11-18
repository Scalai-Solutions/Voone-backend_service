import { describe, expect, it } from "vitest";

import { run } from "../../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../../src/modules/onboarding/engine.types";
import { itemsTitle } from "../../../src/modules/onboarding/reward-title";
import { resolveAutomations } from "../../../src/modules/notifications/automations/automation-settings.service";
import type { AutomationTiming } from "../../../src/modules/notifications/automations/catalog";
import { BirthdayTrigger } from "../../../src/modules/notifications/automations/triggers/birthday.trigger";
import { BonoInactiveTrigger } from "../../../src/modules/notifications/automations/triggers/bono-inactive.trigger";
import { ReferralPromoTrigger } from "../../../src/modules/notifications/automations/triggers/referral-promo.trigger";
import {
  ReviewRequestNotifier,
  ReviewRequestTrigger
} from "../../../src/modules/notifications/automations/triggers/review-request.trigger";
import catalog from "../../onboarding/reference/sapphira.catalogo.json";

const DAY = 86_400_000;
const now = new Date("2026-11-01T20:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const today = (day: number) => ({
  dateKey: `2026-11-${String(day).padStart(2, "0")}`,
  year: 2026,
  month: 11,
  day
});
const DEFAULTS = resolveAutomations([]);
/** The trigger context with the event's catalog defaults, or the given timing over them. */
const ctxFor = (event: keyof typeof DEFAULTS, timing: AutomationTiming = {}) => ({
  clinicId: "c1",
  today: today(1),
  now,
  setting: { ...DEFAULTS[event], timing: { ...DEFAULTS[event].timing, ...timing } }
});

const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};
const livePrograms = (): { program: Program; prisma: { findFirst: () => Promise<unknown> } } => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return { program: result, prisma: { findFirst: async () => ({ output: result }) } };
};

describe("BirthdayTrigger", () => {
  it("picks members whose birthday is today, whatever year they were born", async () => {
    const { prisma: program } = livePrograms();
    const prisma = {
      member: {
        findMany: async () => [
          { id: "today", birthDate: new Date("1990-11-01T00:00:00Z"), tier: "Bronce" },
          { id: "tomorrow", birthDate: new Date("1990-11-02T00:00:00Z"), tier: "Bronce" }
        ]
      },
      onboardingProgram: program
    };

    const recipients = await new BirthdayTrigger(prisma as never).findRecipients(
      ctxFor("BIRTHDAY")
    );

    expect(recipients.map((r) => r.memberId)).toEqual(["today"]);
  });

  it("gives each member the birthday gift of their own tier, from the live programme", async () => {
    const { program, prisma: live } = livePrograms();
    const prisma = {
      member: {
        findMany: async () => [
          { id: "gold", birthDate: new Date("1990-11-01T00:00:00Z"), tier: "Oro" },
          { id: "bronze", birthDate: new Date("1985-11-01T00:00:00Z"), tier: "Bronce" }
        ]
      },
      onboardingProgram: live
    };

    const recipients = await new BirthdayTrigger(prisma as never).findRecipients(
      ctxFor("BIRTHDAY")
    );
    const gift = (tier: "oro" | "bronce") => itemsTitle(program.gifts[tier].birthday!.items);

    expect(recipients).toEqual([
      { memberId: "gold", values: { birthday_gift: gift("oro") } },
      { memberId: "bronze", values: { birthday_gift: gift("bronce") } }
    ]);
    expect(gift("oro")).not.toBe(gift("bronce"));
  });
});

describe("BonoInactiveTrigger", () => {
  const ctx = ctxFor("BONO_INACTIVE");
  const build = (opts: {
    bonos: Array<{ id: string; memberId: string; startedAt: Date }>;
    lastVisit?: Record<string, Date>;
    reminders?: Array<{ memberId: string; createdAt: Date }>;
  }) =>
    new BonoInactiveTrigger({
      memberBono: { findMany: async () => opts.bonos },
      paidVisit: {
        groupBy: async () =>
          Object.entries(opts.lastVisit ?? {}).map(([memberBonoId, occurredAt]) => ({
            memberBonoId,
            _max: { occurredAt }
          }))
      },
      notificationDelivery: {
        findMany: async () =>
          (opts.reminders ?? []).map((r) => ({
            memberId: r.memberId,
            notification: { createdAt: r.createdAt }
          }))
      }
    } as never);

  it("reminds at 30 days without a session, not at 29", async () => {
    const trigger = build({
      bonos: [
        { id: "b30", memberId: "m30", startedAt: daysAgo(100) },
        { id: "b29", memberId: "m29", startedAt: daysAgo(100) }
      ],
      lastVisit: { b30: daysAgo(30), b29: daysAgo(29) }
    });

    expect((await trigger.findRecipients(ctx)).map((r) => r.memberId)).toEqual(["m30"]);
  });

  it("uses the clinic's own inactivity threshold", async () => {
    const trigger = build({
      bonos: [
        { id: "b14", memberId: "m14", startedAt: daysAgo(100) },
        { id: "b13", memberId: "m13", startedAt: daysAgo(100) }
      ],
      lastVisit: { b14: daysAgo(14), b13: daysAgo(13) }
    });

    expect(
      (await trigger.findRecipients(ctxFor("BONO_INACTIVE", { inactiveDays: 14 }))).map(
        (r) => r.memberId
      )
    ).toEqual(["m14"]);
  });

  it("counts a never-used bono from the day it started", async () => {
    const trigger = build({ bonos: [{ id: "b", memberId: "m", startedAt: daysAgo(31) }] });

    expect((await trigger.findRecipients(ctx)).map((r) => r.memberId)).toEqual(["m"]);
  });

  it("sends once per inactivity streak", async () => {
    const trigger = build({
      bonos: [{ id: "b", memberId: "m", startedAt: daysAgo(100) }],
      lastVisit: { b: daysAgo(40) },
      reminders: [{ memberId: "m", createdAt: daysAgo(10) }]
    });

    expect(await trigger.findRecipients(ctx)).toEqual([]);
  });

  it("starts a new streak after the member uses a session again", async () => {
    const trigger = build({
      bonos: [{ id: "b", memberId: "m", startedAt: daysAgo(200) }],
      lastVisit: { b: daysAgo(31) },
      // The old reminder was sent BEFORE the session they have since used.
      reminders: [{ memberId: "m", createdAt: daysAgo(90) }]
    });

    expect((await trigger.findRecipients(ctx)).map((r) => r.memberId)).toEqual(["m"]);
  });
});

/** paidVisit.groupBy as Postgres would answer it: only members at the HAVING threshold. */
const visitCounts =
  (counts: Record<string, number>) =>
  async ({ having }: { having: { memberId: { _count: { gte: number } } } }) =>
    Object.entries(counts)
      .filter(([, count]) => count >= having.memberId._count.gte)
      .map(([memberId, count]) => ({ memberId, _count: { _all: count } }));

describe("ReviewRequestTrigger", () => {
  const ctx = ctxFor("REVIEW_REQUEST");
  const build = (opts: { recent: string[]; counts: Record<string, number>; asked?: string[] }) =>
    new ReviewRequestTrigger({
      paidVisit: {
        findMany: async () => opts.recent.map((memberId) => ({ memberId })),
        groupBy: visitCounts(opts.counts)
      },
      notificationDelivery: {
        findMany: async () => (opts.asked ?? []).map((memberId) => ({ memberId }))
      }
    } as never);

  it("asks members with 2+ visits who have not been asked", async () => {
    const trigger = build({
      recent: ["first", "second", "asked"],
      counts: { first: 1, second: 2, asked: 3 },
      asked: ["asked"]
    });

    expect((await trigger.findRecipients(ctx)).map((r) => r.memberId)).toEqual(["second"]);
  });

  it("uses the clinic's own visit number", async () => {
    const trigger = build({ recent: ["second", "third"], counts: { second: 2, third: 3 } });

    expect(
      (await trigger.findRecipients(ctxFor("REVIEW_REQUEST", { minVisits: 3 }))).map(
        (r) => r.memberId
      )
    ).toEqual(["third"]);
  });

  it("does nothing when nobody visited this week", async () => {
    expect(await build({ recent: [], counts: {} }).findRecipients(ctx)).toEqual([]);
  });
});

describe("ReviewRequestNotifier (sent when the 2nd visit is credited)", () => {
  const build = (visits: number, asked = false, timing: AutomationTiming | null = null) => {
    const sent: unknown[] = [];
    const notifier = new ReviewRequestNotifier(
      {
        clinicAutomation: {
          findMany: async () =>
            timing ? [{ ...DEFAULTS.REVIEW_REQUEST, event: "REVIEW_REQUEST", timing }] : []
        },
        paidVisit: { groupBy: visitCounts({ m1: visits }) },
        notificationDelivery: { findMany: async () => (asked ? [{ memberId: "m1" }] : []) }
      } as never,
      {
        dispatch: async (request: unknown) => {
          sent.push(request);
          return { skipped: false };
        }
      } as never
    );

    return { notifier, sent };
  };

  it("sends once the member has a 2nd visit, keyed to the member", async () => {
    const { notifier, sent } = build(2);

    await notifier.notifyIfDue({ memberId: "m1", clinicId: "c1" });

    expect(sent).toEqual([
      {
        clinicId: "c1",
        event: "REVIEW_REQUEST",
        idempotencyKey: "review:member:m1",
        recipients: [{ memberId: "m1" }]
      }
    ]);
  });

  it("follows the clinic's own visit number", async () => {
    const afterFirst = build(1, false, { minVisits: 1 });
    const notYet = build(2, false, { minVisits: 3 });

    expect(
      await afterFirst.notifier.notifyIfDue({ memberId: "m1", clinicId: "c1" })
    ).not.toBeNull();
    expect(await notYet.notifier.notifyIfDue({ memberId: "m1", clinicId: "c1" })).toBeNull();
    expect(afterFirst.sent).toHaveLength(1);
    expect(notYet.sent).toEqual([]);
  });

  it("sends nothing after the 1st visit, or to a member already asked", async () => {
    const first = build(1);
    const asked = build(3, true);

    expect(await first.notifier.notifyIfDue({ memberId: "m1", clinicId: "c1" })).toBeNull();
    expect(await asked.notifier.notifyIfDue({ memberId: "m1", clinicId: "c1" })).toBeNull();
    expect([...first.sent, ...asked.sent]).toEqual([]);
  });
});

describe("ReferralPromoTrigger", () => {
  const ctx = ctxFor("REFERRAL_PROMO");
  it("is due only on the configured day of the month", () => {
    const first = new ReferralPromoTrigger({} as never, 1);
    const fifteenth = new ReferralPromoTrigger({} as never, 15);

    expect(first.isDue(today(1))).toBe(true);
    expect(first.isDue(today(2))).toBe(false);
    expect(fifteenth.isDue(today(15))).toBe(true);
    expect(fifteenth.isDue(today(1))).toBe(false);
  });

  it("is keyed by month, so a changed day cannot send twice in one month", () => {
    const trigger = new ReferralPromoTrigger({} as never, 1);

    expect(trigger.idempotencyKey("c1", today(1))).toBe(trigger.idempotencyKey("c1", today(20)));
  });

  it("selects members active in the last 90 days, consenting or not", async () => {
    const wheres: Array<Record<string, unknown>> = [];
    const { program, prisma: live } = livePrograms();
    const prisma = {
      member: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => (
          wheres.push(where),
          [{ id: "m1" }]
        )
      },
      onboardingProgram: live,
      referral: { groupBy: async () => [] }
    };

    const recipients = await new ReferralPromoTrigger(prisma as never, 1).findRecipients(ctx);

    expect(recipients).toEqual([
      { memberId: "m1", values: { referral_reward: program.refLad[0].name } }
    ]);
    expect(wheres[0]).not.toHaveProperty("consentMarketing");
    const where = wheres[0] as {
      OR: Array<{ paidVisits: { some: { occurredAt: { gte: Date } } } }>;
    };

    expect(where.OR[0].paidVisits.some.occurredAt.gte.getTime()).toBe(daysAgo(90).getTime());
  });

  it("uses the clinic's own activity window", async () => {
    const wheres: Array<Record<string, unknown>> = [];
    const { prisma: live } = livePrograms();
    const prisma = {
      member: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => (wheres.push(where), [])
      },
      onboardingProgram: live,
      referral: { groupBy: async () => [] }
    };

    await new ReferralPromoTrigger(prisma as never, 1).findRecipients(
      ctxFor("REFERRAL_PROMO", { activeDays: 30 })
    );
    const where = wheres[0] as {
      OR: Array<{ paidVisits: { some: { occurredAt: { gte: Date } } } }>;
    };

    expect(where.OR[0].paidVisits.some.occurredAt.gte.getTime()).toBe(daysAgo(30).getTime());
  });

  it("names the reward of each member's own next referral", async () => {
    const { program, prisma: live } = livePrograms();
    const prisma = {
      member: { findMany: async () => [{ id: "new" }, { id: "veteran" }] },
      onboardingProgram: live,
      referral: { groupBy: async () => [{ referrerId: "veteran", _count: { _all: 3 } }] }
    };

    const recipients = await new ReferralPromoTrigger(prisma as never, 1).findRecipients(ctx);
    const step = (n: number) => program.refLad.find((candidate) => candidate.n === n)!.name;

    expect(recipients).toEqual([
      { memberId: "new", values: { referral_reward: step(1) } },
      { memberId: "veteran", values: { referral_reward: step(5) } }
    ]);
  });

  it("sends to nobody when the clinic has no live programme", async () => {
    const prisma = {
      member: { findMany: async () => [{ id: "m1" }] },
      onboardingProgram: { findFirst: async () => null },
      referral: { groupBy: async () => [] }
    };

    expect(await new ReferralPromoTrigger(prisma as never, 1).findRecipients(ctx)).toEqual([]);
  });
});
