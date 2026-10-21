/**
 * The unit a client sees. The engine keeps progress in euros (thresholds, tiers and rewards are
 * all euro figures); everything shown to a client or to staff as "points" is that progress
 * times this constant, so one euro spent is ten points. Converted at the edge, never stored,
 * so no threshold or balance has to be rescaled.
 */
export const POINTS_PER_EURO = 10;

export const toPoints = (progress: number): number => Math.round(progress * POINTS_PER_EURO);
