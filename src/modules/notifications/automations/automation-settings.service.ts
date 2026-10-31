import {
  AutomationEvent,
  type ClinicAutomation,
  type ClinicNotificationSettings,
  type PrismaClient
} from "@prisma/client";

import { NotificationValidationError } from "../notification.errors";
import type { NotificationSettingsPatch } from "../notifications.schema";
import { unknownVariables } from "../template";
import { AUTOMATION_CATALOG, automationDefinition } from "./catalog";

export interface AutomationSetting {
  enabled: boolean;
  header: string;
  body: string;
  notify: boolean;
}

export type AutomationSettingsMap = Record<AutomationEvent, AutomationSetting>;

export interface ClinicNotificationSettingsView {
  notifyOnCredit: ClinicNotificationSettings["notifyOnCredit"];
  marketingEnabled: boolean;
  googleReviewUrl: string | null;
  referralRewardText: string | null;
  automations: AutomationSettingsMap;
  /** Flat birthday and bonoReminder fields, kept so a client from before the automation catalog
   *  still reads and renders the settings. New clients use `automations`. */
  birthdayEnabled: boolean;
  birthdayHeader: string;
  birthdayBody: string;
  birthdayNotify: boolean;
  bonoReminderEnabled: boolean;
  bonoReminderHeader: string;
  bonoReminderBody: string;
  bonoReminderNotify: boolean;
}

/** Stored rows over the catalog defaults: a clinic that never edited an event reads its defaults. */
export const resolveAutomations = (
  rows: ReadonlyArray<Pick<ClinicAutomation, "event" | "enabled" | "header" | "body" | "notify">>
): AutomationSettingsMap => {
  const stored = new Map(rows.map((row) => [row.event, row]));

  return Object.fromEntries(
    AUTOMATION_CATALOG.map(({ event, defaults }) => {
      const row = stored.get(event);

      return [
        event,
        row
          ? { enabled: row.enabled, header: row.header, body: row.body, notify: row.notify }
          : { ...defaults }
      ];
    })
  ) as AutomationSettingsMap;
};

export const toSettingsView = (
  settings: ClinicNotificationSettings,
  rows: ReadonlyArray<ClinicAutomation>
): ClinicNotificationSettingsView => {
  const automations = resolveAutomations(rows);

  return {
    notifyOnCredit: settings.notifyOnCredit,
    marketingEnabled: settings.marketingEnabled,
    googleReviewUrl: settings.googleReviewUrl,
    referralRewardText: settings.referralRewardText,
    automations,
    birthdayEnabled: automations.BIRTHDAY.enabled,
    birthdayHeader: automations.BIRTHDAY.header,
    birthdayBody: automations.BIRTHDAY.body,
    birthdayNotify: automations.BIRTHDAY.notify,
    bonoReminderEnabled: automations.BONO_INACTIVE.enabled,
    bonoReminderHeader: automations.BONO_INACTIVE.header,
    bonoReminderBody: automations.BONO_INACTIVE.body,
    bonoReminderNotify: automations.BONO_INACTIVE.notify
  };
};

/** Reads and writes a clinic's notification settings and automation copy. */
export class AutomationSettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(clinicId: string): Promise<ClinicNotificationSettingsView> {
    const [settings, rows] = await Promise.all([
      this.settingsRow(clinicId),
      this.prisma.clinicAutomation.findMany({ where: { clinicId } })
    ]);

    return toSettingsView(settings, rows);
  }

  /**
   * Applies a partial update. Only the fields sent change, so a screen that does not know a
   * field can never overwrite it. Rejects copy that uses a {variable} the event does not
   * provide, and refuses to switch an event on while the clinic setting it needs is empty.
   */
  async patch(
    clinicId: string,
    patch: NotificationSettingsPatch
  ): Promise<ClinicNotificationSettingsView> {
    const current = await this.get(clinicId);
    const { automations, ...clinicFields } = patch;
    const merged = { ...current, ...stripUndefined(clinicFields) };

    for (const [event, change] of Object.entries(automations ?? {})) {
      const definition = automationDefinition(event as AutomationEvent);
      const next = { ...current.automations[definition.event], ...stripUndefined(change ?? {}) };

      for (const field of ["header", "body"] as const) {
        const unknown = unknownVariables(next[field], definition.variables);

        if (unknown.length > 0) {
          throw new NotificationValidationError(
            `${definition.label}: variable no disponible: ${unknown.map((name) => `{${name}}`).join(", ")}`
          );
        }
      }

      merged.automations = { ...merged.automations, [definition.event]: next };
    }

    // Checked against the merged result so clearing a link while its event is on is refused too.
    for (const definition of AUTOMATION_CATALOG) {
      if (
        definition.requires &&
        merged.automations[definition.event].enabled &&
        !merged[definition.requires]
      ) {
        throw new NotificationValidationError(
          `${definition.label}: completa ${definition.requires === "googleReviewUrl" ? "el enlace de reseñas de Google" : "la recompensa por referido"} para activarla`
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.clinicNotificationSettings.upsert({
        where: { clinicId },
        create: { clinicId, ...stripUndefined(clinicFields) },
        update: stripUndefined(clinicFields)
      }),
      ...Object.keys(automations ?? {}).map((event) => {
        const value = merged.automations[event as AutomationEvent];

        return this.prisma.clinicAutomation.upsert({
          where: { clinicId_event: { clinicId, event: event as AutomationEvent } },
          create: { clinicId, event: event as AutomationEvent, ...value },
          update: value
        });
      })
    ]);

    return this.get(clinicId);
  }

  private settingsRow(clinicId: string) {
    return this.prisma.clinicNotificationSettings.upsert({
      where: { clinicId },
      create: { clinicId },
      update: {}
    });
  }
}

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
