import type { PrismaClient } from "@prisma/client";

import {
  nextDailyRun,
  zonedDate,
  type DailySchedule,
  type ZonedDate
} from "../../../common/utils/zoned-time";
import { config } from "../../../config/env";
import { resolveAutomations } from "./automation-settings.service";
import type { AutomationDispatchService } from "./dispatch.service";
import type { ScheduledTrigger } from "./triggers/types";

export interface DispatcherSchedule extends DailySchedule {
  /** Postgres advisory-lock key: one dispatcher tick runs at a time across replicas. */
  lockKey: number;
}

export const defaultDispatcherSchedule = (): DispatcherSchedule => ({
  timeZone: config.NOTIFICATION_DISPATCH_TIME_ZONE,
  hour: config.NOTIFICATION_DISPATCH_HOUR,
  minute: config.NOTIFICATION_DISPATCH_MINUTE,
  lockKey: 7_424_001
});

export interface DispatchTickSummary {
  date: string;
  clinicsChecked: number;
  sends: number;
  deliveriesCreated: number;
  failures: number;
}

/**
 * The one scheduler for every time-based automation. Once a day (09:00 Madrid by default) it
 * walks the active clinics and, for each registered trigger that is due and switched on,
 * asks it for recipients and hands them to the dispatch service. Triggers are registered, not
 * known here, so a new event never edits this class.
 */
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: AutomationDispatchService,
    private readonly triggers: readonly ScheduledTrigger[],
    private readonly schedule: DispatcherSchedule = defaultDispatcherSchedule()
  ) {}

  /** One tick. Returns null when another replica holds the lock. */
  async runOnce(now = new Date()): Promise<DispatchTickSummary | null> {
    // A transaction-scoped advisory lock: released on commit/rollback, so a crashed replica can
    // never leave it held, and no connection-pool affinity is needed.
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<
          Array<{ locked: boolean }>
        >`SELECT pg_try_advisory_xact_lock(${this.schedule.lockKey}) AS locked`;

        return locked ? this.tick(now) : null;
      },
      { timeout: 30 * 60_000, maxWait: 10_000 }
    );
  }

  private async tick(now: Date): Promise<DispatchTickSummary> {
    const today = zonedDate(now, this.schedule.timeZone);
    const summary: DispatchTickSummary = {
      date: today.dateKey,
      clinicsChecked: 0,
      sends: 0,
      deliveriesCreated: 0,
      failures: 0
    };
    const due = this.triggers.filter((trigger) => trigger.isDue(today));
    const clinics = await this.prisma.clinic.findMany({
      where: { isActive: true },
      select: { id: true, automations: true },
      orderBy: { createdAt: "asc" }
    });

    for (const clinic of clinics) {
      summary.clinicsChecked += 1;
      const settings = resolveAutomations(clinic.automations);

      for (const trigger of due) {
        if (!settings[trigger.event].enabled) continue;

        // Each (clinic, event) fails alone: one broken query must not stop the other sends.
        try {
          await this.runTrigger(trigger, clinic.id, today, now, summary);
        } catch (error) {
          summary.failures += 1;
          console.error("[notifications] automation failed", {
            clinicId: clinic.id,
            event: trigger.event,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return summary;
  }

  private async runTrigger(
    trigger: ScheduledTrigger,
    clinicId: string,
    today: ZonedDate,
    now: Date,
    summary: DispatchTickSummary
  ): Promise<void> {
    const recipients = await trigger.findRecipients({ clinicId, today, now });
    const result = await this.sender.dispatch({
      clinicId,
      event: trigger.event,
      idempotencyKey: trigger.idempotencyKey(clinicId, today),
      recipients,
      meta: { date: today.dateKey, timeZone: this.schedule.timeZone }
    });

    if (result.deliveriesCreated > 0) summary.sends += 1;
    summary.deliveriesCreated += result.deliveriesCreated;
  }
}

export interface DispatcherHandle {
  stop(): void;
}

/** Runs the dispatcher daily on its schedule, then `alsoDaily` work, until stopped. */
export const startNotificationDispatcher = (
  dispatcher: NotificationDispatcher,
  schedule: DailySchedule = defaultDispatcherSchedule(),
  /** Other work that rides the same daily tick. Failures are logged and never stop the loop. */
  alsoDaily?: () => Promise<unknown>
): DispatcherHandle => {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;

    const delayMs = Math.max(1_000, nextDailyRun(new Date(), schedule).getTime() - Date.now());

    timer = setTimeout(() => void run(), delayMs);
    timer.unref?.();
  };

  const run = async () => {
    try {
      const summary = await dispatcher.runOnce();

      console.info("[notifications] dispatcher tick", summary ?? "skipped: another replica has it");
    } catch (error) {
      console.error("[notifications] dispatcher tick failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (alsoDaily) {
      try {
        await alsoDaily();
      } catch (error) {
        console.error("[notifications] daily wallet task failed", {
          error: error instanceof Error ? error.name : "unknown"
        });
      }
    }

    scheduleNext();
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
};
