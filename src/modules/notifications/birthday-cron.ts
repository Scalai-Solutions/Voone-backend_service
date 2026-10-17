import type { NotificationService } from "./notification.service";

const MADRID_TIME_ZONE = "Europe/Madrid";
const HOUR = 9;
const MINUTE = 0;

const madridParts = (
  date: Date
): { year: number; month: number; day: number; hour: number; minute: number; second: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TIME_ZONE,
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

const madridOffsetMinutes = (date: Date): number => {
  const parts = madridParts(date);
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

const madridWallTimeToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date => {
  const firstGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset = madridOffsetMinutes(firstGuess);
  const secondGuess = new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60_000
  );
  const correctedOffset = madridOffsetMinutes(secondGuess);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - correctedOffset * 60_000);
};

export const nextBirthdayCronRun = (now = new Date()): Date => {
  const parts = madridParts(now);
  let target = madridWallTimeToUtc(parts.year, parts.month, parts.day, HOUR, MINUTE);

  if (target <= now) {
    target = madridWallTimeToUtc(parts.year, parts.month, parts.day + 1, HOUR, MINUTE);
  }

  return target;
};

export interface BirthdayCronHandle {
  stop(): void;
}

export const startBirthdayNotificationCron = (
  notifications: NotificationService
): BirthdayCronHandle => {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;

    const nextRun = nextBirthdayCronRun();
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
      schedule();
    }
  };

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
};
