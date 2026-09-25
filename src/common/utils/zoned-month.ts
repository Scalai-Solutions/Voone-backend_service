/**
 * The start of the current month in a given time zone, as a UTC instant.
 *
 * "Points issued this month" is read by a clinic in Madrid, so the month has to start at
 * midnight there. Using UTC would misattribute every movement made between 00:00 and
 * 01:00 Madrid time on the 1st (02:00 in summer) to the previous month — a small window,
 * but one that makes a figure on a dashboard wrong in a way nobody can explain.
 */
const offsetMs = (at: Date, timeZone: string): number => {
  // Formatting the same instant in the zone and in UTC and differencing them is the
  // standard way to recover an offset without a tz database dependency.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(at);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );

  return asUtc - at.getTime();
};

export const startOfMonthIn = (timeZone: string, now: Date = new Date()): Date => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  // Midnight on the 1st, read as if it were UTC, then shifted back by the zone's offset
  // at that moment. Measured at the candidate instant rather than at `now`, so a month
  // that begins on one side of a DST change is still correct.
  const naive = Date.UTC(get("year"), get("month") - 1, 1, 0, 0, 0);

  return new Date(naive - offsetMs(new Date(naive), timeZone));
};

/** Every clinic is Spanish, so this is the only zone the product currently has. */
export const CLINIC_TIME_ZONE = "Europe/Madrid";
