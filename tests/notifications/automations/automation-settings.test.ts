import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  legacyNotificationSettingsSchema,
  legacySettingsToPatch
} from "../../../src/modules/notifications/notifications.schema";
import { AutomationSettingsService } from "../../../src/modules/notifications/automations/automation-settings.service";

const build = (
  stored: { settings?: Record<string, unknown>; rows?: Array<Record<string, unknown>> } = {}
) => {
  const writes: unknown[] = [];
  const automationWrites: Array<{
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  const prisma = {
    clinicNotificationSettings: {
      upsert: async (args: unknown) => {
        writes.push(args);
        return {
          notifyOnCredit: "MILESTONE_AND_TIER",
          marketingEnabled: true,
          googleReviewUrl: null,
          ...stored.settings
        };
      }
    },
    clinicAutomation: {
      findMany: async () => stored.rows ?? [],
      upsert: async (args: (typeof automationWrites)[number]) => (automationWrites.push(args), args)
    },
    $transaction: async (ops: unknown[]) => ops
  };

  return { service: new AutomationSettingsService(prisma as never), writes, automationWrites };
};

describe("AutomationSettingsService", () => {
  it("returns catalog defaults for a clinic that never edited anything", async () => {
    const { service } = build();

    const view = await service.get("c1");

    expect(view.automations.BIRTHDAY.enabled).toBe(true);
    expect(view.automations.REVIEW_REQUEST.enabled).toBe(false);
    expect(view.automations.BONO_INACTIVE.header).toBe("¡No olvides tu tratamiento! 💆‍♀️");
  });

  it("refuses copy that uses a variable the event does not offer", async () => {
    const { service } = build();

    await expect(
      service.patch("c1", { automations: { BIRTHDAY: { body: "Hola {referral_reward}" } } })
    ).rejects.toThrow(/variable no disponible: \{referral_reward\}/);
  });

  it("refuses to switch the review request on without a Google link", async () => {
    const { service } = build();

    await expect(
      service.patch("c1", { automations: { REVIEW_REQUEST: { enabled: true } } })
    ).rejects.toThrow(/enlace de reseñas/);
  });

  it("allows switching it on in the same request that supplies the link", async () => {
    const { service } = build({ settings: { googleReviewUrl: "https://g.page/r/abc" } });

    await expect(
      service.patch("c1", {
        googleReviewUrl: "https://g.page/r/abc",
        automations: { REVIEW_REQUEST: { enabled: true } }
      })
    ).resolves.toBeDefined();
  });

  it("refuses to clear the link while the event is on", async () => {
    const { service } = build({
      settings: { googleReviewUrl: "https://g.page/r/abc" },
      rows: [{ event: "REVIEW_REQUEST", enabled: true, header: "h", body: "b", notify: true }]
    });

    await expect(service.patch("c1", { googleReviewUrl: null })).rejects.toThrow(
      /enlace de reseñas/
    );
  });
});

describe("AutomationSettingsService timing", () => {
  it("reads the catalog defaults when nothing is stored, and only for events that have timing", async () => {
    const { service } = build();

    const { automations } = await service.get("c1");

    expect(automations.BONO_INACTIVE.timing).toEqual({ inactiveDays: 30 });
    expect(automations.REVIEW_REQUEST.timing).toEqual({ minVisits: 2 });
    expect(automations.REFERRAL_PROMO.timing).toEqual({ activeDays: 90 });
    expect(automations.BIRTHDAY.timing).toEqual({});
  });

  it("reads a stored value, and falls back to the default for one out of range or not a number", async () => {
    const row = { enabled: true, header: "h", body: "b", notify: true };
    const { service } = build({
      rows: [
        { ...row, event: "BONO_INACTIVE", timing: { inactiveDays: 14 } },
        { ...row, event: "REVIEW_REQUEST", timing: { minVisits: 999 } },
        { ...row, event: "REFERRAL_PROMO", timing: { activeDays: "60" } }
      ]
    });

    const { automations } = await service.get("c1");

    expect(automations.BONO_INACTIVE.timing).toEqual({ inactiveDays: 14 });
    expect(automations.REVIEW_REQUEST.timing).toEqual({ minVisits: 2 });
    expect(automations.REFERRAL_PROMO.timing).toEqual({ activeDays: 90 });
  });

  it("stores a changed threshold alongside the event's copy", async () => {
    const { service, automationWrites } = build();

    await service.patch("c1", {
      automations: { BONO_INACTIVE: { timing: { inactiveDays: 21 } } }
    });

    expect(automationWrites).toHaveLength(1);
    expect(automationWrites[0].update).toMatchObject({
      enabled: true,
      header: "¡No olvides tu tratamiento! 💆‍♀️",
      timing: { inactiveDays: 21 }
    });
  });

  it("stores no timing for an event that has none", async () => {
    const { service, automationWrites } = build();

    await service.patch("c1", { automations: { BIRTHDAY: { enabled: false } } });

    expect(automationWrites[0].update.timing).toBe(Prisma.DbNull);
  });

  it("refuses a value outside the field's range", async () => {
    const { service } = build();

    await expect(
      service.patch("c1", { automations: { BONO_INACTIVE: { timing: { inactiveDays: 3 } } } })
    ).rejects.toThrow(/entre 7 y 365/);
  });

  it("refuses a threshold the event does not have", async () => {
    const { service } = build();

    await expect(
      service.patch("c1", { automations: { BIRTHDAY: { timing: { inactiveDays: 30 } } } })
    ).rejects.toThrow(/no admite el plazo inactiveDays/);
  });
});

describe("backward compatibility with clients from before the automation catalog", () => {
  it("still returns the flat birthday and bono fields", async () => {
    const { service } = build({
      rows: [
        { event: "BIRTHDAY", enabled: false, header: "Hola", body: "Feliz día", notify: false }
      ]
    });

    const view = await service.get("c1");

    expect(view).toMatchObject({
      birthdayEnabled: false,
      birthdayHeader: "Hola",
      birthdayBody: "Feliz día",
      birthdayNotify: false,
      bonoReminderEnabled: true
    });
  });

  it("translates the old full-object PUT body into the same partial update", () => {
    const patch = legacySettingsToPatch(
      legacyNotificationSettingsSchema.parse({
        notifyOnCredit: "ALWAYS",
        marketingEnabled: false,
        birthdayEnabled: true,
        birthdayHeader: "Feliz cumple",
        birthdayBody: "Disfruta",
        birthdayNotify: true,
        bonoReminderEnabled: false,
        bonoReminderHeader: "Sesiones",
        bonoReminderBody: "Te quedan sesiones",
        bonoReminderNotify: false
      })
    );

    expect(patch).toEqual({
      notifyOnCredit: "ALWAYS",
      marketingEnabled: false,
      automations: {
        BIRTHDAY: { enabled: true, header: "Feliz cumple", body: "Disfruta", notify: true },
        BONO_INACTIVE: {
          enabled: false,
          header: "Sesiones",
          body: "Te quedan sesiones",
          notify: false
        }
      }
    });
  });
});
