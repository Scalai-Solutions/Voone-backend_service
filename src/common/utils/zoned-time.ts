export interface ZonedDate {
  /** "YYYY-MM-DD" in the zone. */
  dateKey: string;
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends ZonedDate {
  hour: number;
  minute: number;
  second: number;
}

export const zonedParts = (date: Date, timeZone: string): ZonedParts => {
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
  const year = value("year");
  const month = value("month");
  const day = value("day");

  return {
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
};

/** The calendar date `date` falls on in `timeZone`. */
export const zonedDate = (date: Date, timeZone: string): ZonedDate => {
  const { dateKey, year, month, day } = zonedParts(date, timeZone);

  return { dateKey, year, month, day };
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

/** The UTC instant at which the wall clock in `timeZone` reads the given time (DST-aware). */
export const zonedWallTimeToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date => {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const secondGuess = new Date(wall - zonedOffsetMinutes(new Date(wall), timeZone) * 60_000);

  return new Date(wall - zonedOffsetMinutes(secondGuess, timeZone) * 60_000);
};

export interface DailySchedule {
  timeZone: string;
  hour: number;
  minute: number;
}

/** The next instant strictly after `now` at which the zone's clock reads hour:minute. */
export const nextDailyRun = (now: Date, schedule: DailySchedule): Date => {
  const { year, month, day } = zonedParts(now, schedule.timeZone);
  const at = (dayOffset: number) =>
    zonedWallTimeToUtc(
      year,
      month,
      day + dayOffset,
      schedule.hour,
      schedule.minute,
      schedule.timeZone
    );
  const today = at(0);

  return today > now ? today : at(1);
};
