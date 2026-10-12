import type { Candidate, RewardOption } from "./engine.types";

/**
 * The arithmetic the engine's determinism rests on.
 *
 * Separated because these are the easiest things to get subtly wrong in a port and the
 * hardest to notice: a programme built with banker's rounding differs from the validated
 * spreadsheet by a euro here and there, which looks like noise until a threshold lands on
 * the wrong side of a price.
 */

/**
 * Round half away from zero, as a spreadsheet does.
 *
 * NOT Math.round, which rounds half UP and so disagrees on negatives, and not the
 * banker's rounding some languages default to. The 1e-9 absorbs binary float error, so a
 * value that is mathematically x.5 but stored as x.49999999999 still rounds away.
 */
export const rha = (x: number): number => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);

/** Round to the nearest multiple of `step`, half away from zero. */
export const roundTo = (x: number, step: number): number => rha(x / step) * step;

/** Round down to a multiple of `step`. The epsilon keeps 69.99999997 from flooring to 60. */
export const floorTo = (x: number, step: number): number => Math.floor(x / step + 1e-9) * step;

/** One decimal place, half away from zero. Visit frequency is reported this way. */
export const r1 = (x: number): number => rha(x * 10) / 10;

/** Median, averaging the middle pair on an even count. Does not mutate its input. */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The item ids of an option, in the order the option holds them. */
export const ids = (option: RewardOption): string[] => option.items.map((item) => item.id);

/**
 * Compares two lists of id-lists, lexicographically and then by length.
 *
 * The last tie-break in every sort. Without a total order the beam search would depend on
 * the host's sort stability, and two runs of the same input could differ — which is the
 * one thing the engine promises never to do.
 */
export const cmpLists = (a: string[][], b: string[][]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];

    for (let j = 0; j < Math.min(x.length, y.length); j += 1) {
      if (x[j] !== y[j]) return x[j] < y[j] ? -1 : 1;
    }

    if (x.length !== y.length) return x.length - y.length;
  }

  return a.length - b.length;
};

/**
 * Orders options by how close they land to a value target.
 *
 * The shared tail of every option sort: distance to target, then fewer items, then lower
 * cost, then ids. Each step exists to break a tie the previous one left.
 */
export const byDistanceTo =
  (target: number) =>
  (a: RewardOption, b: RewardOption): number =>
    Math.abs(a.value - target) - Math.abs(b.value - target) ||
    a.items.length - b.items.length ||
    a.cost - b.cost ||
    cmpLists([ids(a)], [ids(b)]);

/** Every single candidate, and every pair drawn from two different categories. */
export const buildOptions = (pool: Candidate[], triple = false): RewardOption[] => {
  const out: RewardOption[] = pool.map((c) => ({ items: [c], value: c.value, cost: c.cost }));

  // Triples come only from the dozen highest-value candidates, and only in late
  // relaxation steps: the full set would be cubic in the catalogue size.
  if (triple) {
    const top = [...pool].sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1)).slice(0, 12);

    for (let a = 0; a < top.length; a += 1) {
      for (let b = a + 1; b < top.length; b += 1) {
        for (let c = b + 1; c < top.length; c += 1) {
          const [x, y, z] = [top[a], top[b], top[c]];

          if (x.cat === y.cat || x.cat === z.cat || y.cat === z.cat) continue;

          out.push({
            items: [x, y, z],
            value: x.value + y.value + z.value,
            cost: x.cost + y.cost + z.cost
          });
        }
      }
    }
  }

  // Different categories only: two of the same thing reads as one gift, not a pack.
  for (let a = 0; a < pool.length; a += 1) {
    for (let b = a + 1; b < pool.length; b += 1) {
      if (pool[a].cat === pool[b].cat) continue;

      out.push({
        items: [pool[a], pool[b]],
        value: pool[a].value + pool[b].value,
        cost: pool[a].cost + pool[b].cost
      });
    }
  }

  return out;
};
