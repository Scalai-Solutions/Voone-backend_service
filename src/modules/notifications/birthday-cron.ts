import { config } from "../../config/env";
import type { NotificationService } from "./notification.service";

export interface BirthdayCronSchedule {
  timeZone: string;
  hour: number;
  minute: number;
  frequencyMinutes: number;
}

const defaultSchedule = (): BirthdayCronSchedule => ({
  timeZone: config.BIRTHDAY_NOTIFICATION_TIME_ZONE,
  hour: config.BIRTHDAY_NOTIFICATION_HOUR,
  minute: config.BIRTHDAY_NOTIFICATION_MINUTE,
  frequencyMinutes: config.BIRTHDAY_NOTIFICATION_FREQUENCY_MINUTES
});

const zonedParts = (
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
};

const zonedOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return Math.round((asUtc - date.getTime()) / 60_000);
};

const zonedWallTimeToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date => {
  const firstGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset = zonedOffsetMinutes(firstGuess, timeZone);
  const secondGuess = new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60_000
  );
  const correctedOffset = zonedOffsetMinutes(secondGuess, timeZone);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - correctedOffset * 60_000);
};

export const nextBirthdayCronRun = (
  now = new Date(),
  schedule: BirthdayCronSchedule = defaultSchedule()
): Date => {
  const parts = zonedParts(now, schedule.timeZone);
  const todayAnchor = zonedWallTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    schedule.hour,
    schedule.minute,
    schedule.timeZone
  );

  if (schedule.frequencyMinutes === 1440) {
    if (todayAnchor > now) return todayAnchor;

    return zonedWallTimeToUtc(
      parts.year,
      parts.month,
      parts.day + 1,
      schedule.hour,
      schedule.minute,
      schedule.timeZone
    );
  }

  const frequencyMs = schedule.frequencyMinutes * 60_000;

  if (todayAnchor > now) return todayAnchor;

  return new Date(
    todayAnchor.getTime() +
      (Math.floor((now.getTime() - todayAnchor.getTime()) / frequencyMs) + 1) * frequencyMs
  );
};

export interface BirthdayCronHandle {
  stop(): void;
}

export const startBirthdayNotificationCron = (
  notifications: NotificationService,
  cronSchedule: BirthdayCronSchedule = defaultSchedule()
): BirthdayCronHandle => {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;

    const nextRun = nextBirthdayCronRun(new Date(), cronSchedule);
    const delayMs = Math.max(1_000, nextRun.getTime() - Date.now());

    timer = setTimeout(() => {
      void run();
    }, delayMs);
    timer.unref?.();
  };

  const run = async () => {
    try {
      const result = await notifications.runBirthdayAutomations();
      console.info("[notifications] birthday cron completed", result);
    } catch (error) {
      console.error("[notifications] birthday cron failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
};
