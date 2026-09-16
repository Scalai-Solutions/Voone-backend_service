/**
 * The calendar year in Madrid, which is what a member's pass prints.
 *
 * Not `new Date().getFullYear()`: the container runs UTC, so a sign-up at 23:30 on the
 * 31st of December would record the previous year. The value is stored rather than
 * derived at render time, because it appears on something that reads as a physical card
 * and must not change later because timezone handling did.
 */
export const madridYear = (at: Date): number =>
  Number(
    new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", year: "numeric" }).format(at)
  );
