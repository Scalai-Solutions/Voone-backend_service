import type { AutomationEvent } from "@prisma/client";

import type { ZonedDate } from "../../../../common/utils/zoned-time";
import type { AutomationSetting } from "../automation-settings.service";
import type { AutomationRecipient } from "../dispatch.service";

export interface TriggerContext {
  clinicId: string;
  /** Today in the dispatcher's time zone. */
  today: ZonedDate;
  now: Date;
  /** The clinic's resolved setting for this trigger's event; triggers read `timing` from it. */
  setting: AutomationSetting;
}

/**
 * A time-based automation. The dispatcher asks each registered trigger whether it is due today
 * and, if so, who should receive it; sending, consent, switches and de-duplication are handled
 * by AutomationDispatchService. Adding an event means adding one of these and registering it.
 */
export interface ScheduledTrigger {
  readonly event: AutomationEvent;
  isDue(today: ZonedDate): boolean;
  /** Batched queries only: this runs once per clinic per day. */
  findRecipients(context: TriggerContext): Promise<AutomationRecipient[]>;
  idempotencyKey(clinicId: string, today: ZonedDate): string;
}

export const DAY_MS = 24 * 60 * 60 * 1_000;
