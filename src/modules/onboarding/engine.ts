import {
  CATEGORIES,
  CONFIG_VERSION,
  ENGINE_VERSION,
  FREQ_BUCKETS,
  HIGH_IF_ANY,
  INVESTMENT,
  KEYWORDS,
  MID_IF_ANY,
  OBJECTIVES,
  OCCUPANCY,
  P,
  SEGMENTS,
  TICKET_BUCKETS,
  TIERS,
  TIER_BENEFITS,
  TIME_CATS
} from "./engine.config";
import { buildOptions, byDistanceTo, floorTo, ids, median, r1, rha, roundTo } from "./engine.math";
import type {
  Answers,
  CatalogItem,
  Candidate,
  CategoryCode,
  ChosenReward,
  ClassifiedItem,
  EngineResult,
  Estimates,
  Ladder,
  LadderSegment,
  Milestone,
  Program,
  ReferralStep,
  RewardOption,
  Segment,
  TierCode,
  TierGift
} from "./engine.types";

/**
 * The Voone onboarding engine: a catalogue and six answers in, a whole loyalty programme
 * out.
 *
 * A pure function with no I/O, no clock and no randomness. Same catalogue, same answers,
 * same config always give the same programme — every tie is broken explicitly, because a
 * centre that reloads the page must not see a different ladder.
 *
 * Ported from the reference `engine.cjs` v1.2.0. The reference is the specification, and
 * tests/onboarding compares the two across the whole answer space rather than taking this
 * comment's word for it.
 *
 * DELIBERATELY NOT PORTED: the reference also computes an internal revenue projection
 * (member counts, retention, fees, net year). It feeds a sales simulator, not the
 * programme, and the implementation guide says not to port or expose it. Item `cost` is
 * kept, because reward selection depends on it.
 */

const eurText = (v: number): string => `${Math.round(v).toLocaleString("es-ES")} €`;

/** Formats a number the way the Spanish copy does, with a comma for the decimal point. */
const esNum = (v: number): string => String(v).replace(".", ",");

/* ---------------------------------------------------------------- step 1: classify */

/**
 * Give every row exactly one category.
 *
 * Order matters and is not arbitrary: a category the centre set always wins, because the
 * centre knows its own price list better than a keyword table does.
 */
export const classify = (items: CatalogItem[]): ClassifiedItem[] =>
  items.map((it) => {
    if (it.cat && CATEGORIES[it.cat]) return { ...it, cat: it.cat, src: it.src ?? "centro" };
    if (it.product) return { ...it, cat: "COS" as CategoryCode, src: "producto" };

    const name = (it.name || "").toLowerCase();

    for (const [code, words] of KEYWORDS) {
      if (words.some((w) => name.includes(w))) return { ...it, cat: code, src: "palabra clave" };
    }

    // Parked in DIA so downstream code always has a category, but flagged: DIA earns no
    // points and is never a reward, so an unclassified row cannot quietly become one.
    return { ...it, cat: "DIA" as CategoryCode, src: "sin clasificar", review: true };
  });

/* ----------------------------------------------------------------- step 2: estimate */

/** The catalogue's own answer to "what does a visit cost and how often do they come?". */
export const estimate = (items: ClassifiedItem[], ans: Answers): Estimates | { error: string } => {
  const present = new Set(items.map((i) => i.cat));
  const segment: Segment = HIGH_IF_ANY.some((c) => present.has(c))
    ? "high"
    : MID_IF_ANY.some((c) => present.has(c))
      ? "mid"
      : "low";
  const sg = SEGMENTS[segment];

  let weight = 0;
  let ticketSum = 0;
  let freqSum = 0;
  const catRows: Estimates["catRows"] = [];

  for (const [code, cfg] of Object.entries(CATEGORIES) as Array<
    [CategoryCode, (typeof CATEGORIES)[CategoryCode]]
  >) {
    const prices = items
      .filter((i) => i.cat === code && !i.estimated && i.price > 0)
      .map((i) => i.price);

    // Weightless categories (retail, diagnosis) and anything that earns no points are
    // excluded: in `high`, that is what keeps pharmacological medicine from inflating a
    // ticket that clients never actually pay on a points-earning visit.
    if (!prices.length || cfg.w <= 0 || !cfg.points) continue;

    const m = median(prices);
    weight += cfg.w;
    ticketSum += cfg.w * m;
    freqSum += (cfg.w * 52) / cfg.iv;
    catRows.push({ cat: code, name: cfg.name, n: prices.length, median: m, w: cfg.w, iv: cfg.iv });
  }

  if (!weight) {
    return {
      error: "El catálogo no tiene tratamientos que sumen puntos. Añade tratamientos con precio."
    };
  }

  const tEst = rha((sg.comb * ticketSum) / weight);
  const fEst = r1((sg.comp * freqSum) / weight);
  const buckets = TICKET_BUCKETS[segment === "low" ? "low" : "mid"];
  const tPre = (buckets.find((b) => b.max === null || tEst < b.max) ?? buckets[buckets.length - 1])
    .id;
  const weeks = 52 / fEst;
  const fPre = (FREQ_BUCKETS.find((b) => b.maxW === null || weeks <= b.maxW) ?? FREQ_BUCKETS[4]).id;

  // An answer that matches the pre-selected bucket means "yes, your estimate", so the
  // exact estimate is kept rather than the bucket's coarser representative value.
  const ticket =
    !ans.ticket || ans.ticket === tPre ? tEst : buckets.find((b) => b.id === ans.ticket)!.value;
  const visits =
    !ans.freq || ans.freq === fPre
      ? fEst
      : r1(52 / FREQ_BUCKETS.find((b) => b.id === ans.freq)!.weeks);

  return {
    hasDia: items.some((i) => i.cat === "DIA" && !i.review),
    segment,
    tEst,
    fEst,
    tPre,
    fPre,
    ticket,
    visits,
    A: ticket * visits,
    AEst: tEst * fEst,
    inRange: ticket >= sg.tmin && ticket <= sg.tmax,
    catRows
  };
};

/* ------------------------------------------------------------------- step 3: ladder */

/**
 * Lay out the four tier-to-tier segments and the milestones inside them.
 *
 * Segment lengths grow geometrically so each tier costs meaningfully more than the last;
 * `useFloor` is the second attempt, giving the first segment a minimum budget when the
 * catalogue has nothing cheap enough for a welcome gift.
 */
export const buildLadder = (est: Estimates, ans: Answers, useFloor: boolean): Ladder => {
  const A = est.A;
  const obj = OBJECTIVES[ans.objective];
  const inv = INVESTMENT[ans.investment];
  const k4 = 1 + P.minGrowth + P.minGrowth ** 2 + P.minGrowth ** 3;

  let visitsSilver: number = P.visitsSilver;
  let yearsTarget: number = P.years;
  let Pseg = (visitsSilver * est.ticket) / A;

  // Low-frequency centres: if Plata at three visits would push Diamante past the target,
  // first stretch Diamante, and only then lower the bar for Plata — never below two
  // visits, or Plata stops meaning anything.
  if (Pseg * k4 > yearsTarget) {
    yearsTarget = Math.min(P.maxYears, Pseg * k4);

    if (Pseg * k4 > P.maxYears) {
      visitsSilver = Math.max(P.minVisitsSilver, ((P.maxYears / k4) * A) / est.ticket);
      Pseg = (visitsSilver * est.ticket) / A;
    }
  }

  // Solve 1 + R + R² + R³ = years / P by Newton. Six iterations from 1.5 is plenty: the
  // function is monotonic and well behaved over the range any real centre produces.
  const S = yearsTarget / Pseg;
  let R = 1.5;

  for (let i = 0; i < 6; i += 1) R = R - (1 + R + R * R + R ** 3 - S) / (1 + 2 * R + 3 * R * R);

  R = Math.max(R, P.minGrowth);

  const gaps = [0, 1, 2, 3].map((k) => Pseg * R ** k);
  const Y = gaps.reduce((a, b) => a + b, 0);
  const occ = OCCUPANCY[ans.occupancy] ?? OCCUPANCY.o2;
  const tm = (k: number): number => obj.mult[k] * occ.tramo[k];
  const raw = gaps.reduce((s, g, k) => s + tm(k) * g, 0);

  const tramos: LadderSegment[] = [];
  let start = 0;

  gaps.forEach((gap, k) => {
    // Normalised by Y/raw so the four budgets always add up to exactly the chosen
    // investment share, however the weights are set.
    tramos.push({
      i: k + 1,
      tier: TIERS[k + 1],
      gap,
      start,
      end: start + gap,
      budget: (inv * gap * A * tm(k) * Y) / raw
    });
    start += gap;
  });

  const floor = 3 * P.earlyFloorPctT * est.ticket;
  let floorApplied = false;

  if (useFloor && tramos[0].budget < floor) {
    floorApplied = true;
    const total = tramos.reduce((s, t) => s + t.budget, 0);
    const rest = total - tramos[0].budget;
    const newRest = total - floor;

    tramos[0].budget = floor;
    for (const t of tramos.slice(1)) t.budget *= newRest / rest;
  }

  const ms: Milestone[] = [];
  const NP = P.premiosPerTramo;
  const counts: number[] = [];

  for (const t of tramos) {
    // Real visits, not progress euros: a Diamante euro is worth 1.3 progress euros, so a
    // high tier reaches its threshold in fewer actual visits.
    const realVisits = (t.gap * est.visits) / TIER_BENEFITS[TIERS[t.i - 1]].mult;
    // Double points in every segment, plus a free diagnosis in the first when there is
    // one to give.
    const fixed = 1 + (t.i === 1 && est.hasDia ? 1 : 0);
    const tot = Math.max(NP + fixed, Math.ceil(realVisits / P.maxVisitsBetween - 1e-9) - 1);
    const rewardPos = new Set(
      Array.from({ length: NP }, (_, j) => Math.round(1 + (j * (tot - 1)) / (NP - 1)))
    );

    t.realVisits = realVisits;
    t.hitos = tot;
    t.ventajas = tot - NP;
    counts.push(tot);

    let jp = 0;

    for (let j = 1; j <= tot; j += 1) {
      const th = roundTo(A * (t.start + (t.gap * j) / (tot + 1)), P.round);

      if (rewardPos.has(j)) {
        const cb = (t.budget / NP) * obj.pos[jp];
        jp += 1;
        ms.push({
          n: ms.length + 1,
          tramo: t.i,
          type: "premio",
          th,
          cb,
          cap: cb * (1 + P.tol),
          // Value target rises as chair time gets dearer, so a full agenda still gives a
          // gift that feels the same size to the client.
          V: ((cb / inv) * P.vb) / occ.svc,
          early: t.i === 1
        });
      } else {
        ms.push({ n: ms.length + 1, tramo: t.i, type: "ventaja", th, cb: 0, cap: 0, V: 0 });
      }
    }

    ms.push({
      n: ms.length + 1,
      tramo: t.i,
      type: "nivel",
      tier: t.tier,
      th: roundTo(A * t.end, P.round),
      cb: 0,
      cap: 0,
      V: 0
    });
  }

  // Two fixed overrides. The first reward must land on the first visit, or the programme
  // never hooks anyone; and Plata is floored rather than rounded, so the stated number of
  // visits always reaches it instead of falling five euros short.
  ms[0].th = Math.min(ms[0].th, floorTo(est.ticket, P.round));
  ms.find((m) => m.type === "nivel")!.th = floorTo(A * tramos[0].end, P.round);

  return {
    R,
    Y,
    tramos,
    ms,
    inv,
    P: Pseg,
    S,
    visitsSilver,
    floorApplied,
    counts,
    last: ms[ms.length - 1]
  };
};

/* --------------------------------------------------------------- step 4: candidates */

/** Catalogue rows that may be given away, priced at what they cost the centre. */
export const candidates = (items: ClassifiedItem[], ans: Answers): Candidate[] => {
  const occ = OCCUPANCY[ans?.occupancy] ?? OCCUPANCY.o2;

  return items
    .filter((i) => CATEGORIES[i.cat]?.reward && i.price > 0)
    .map((i) => ({
      id: i.id,
      name: i.name,
      cat: i.cat,
      value: i.price,
      cost:
        i.price *
        (i.costPct != null && (i.costPct as unknown) !== "" ? i.costPct : CATEGORIES[i.cat].cost) *
        (TIME_CATS.includes(i.cat) ? occ.svc : 1)
    }));
};

/* ------------------------------------------------------------------ step 5: rewards */

/** How far the rules have been bent on this attempt. */
export interface Relaxation {
  capMult: number;
  earlyAll: boolean;
  nonStrict: boolean;
  tol: number;
  repeat?: boolean;
  triple?: boolean;
  anyOrder?: boolean;
}

interface BeamState {
  s: number;
  last: number;
  parent: BeamState | null;
  o: RewardOption | null;
  key: string;
}

/**
 * Pick the whole ladder at once, by beam search.
 *
 * Not greedy, and that is the point: choosing the best fit for each milestone in turn
 * burns the good items early and leaves nothing that can still be worth strictly more
 * later, so the chain dead-ends. The beam keeps 400 partial ladders alive instead.
 */
export const chooseRewards = (
  ms: Milestone[],
  cands: Candidate[],
  rx: Relaxation
): ChosenReward[] | null => {
  const rewards = ms.filter((m) => m.type === "premio");

  const sets = rewards.map((m) => {
    const all = buildOptions(
      cands.filter((c) => rx.earlyAll || !m.early || CATEGORIES[c.cat].early),
      Boolean(rx.triple) && !m.early
    ).filter((o) => o.cost <= m.cb * (1 + rx.tol) + 1e-9 && o.value <= rx.capMult * m.V + 1e-9);

    // Only the closest few hundred can plausibly belong to the best ladder, and the cut
    // is what keeps the search from going quadratic on a large catalogue.
    all.sort(byDistanceTo(m.V));

    return all.slice(0, rx.triple ? 160 : 220);
  });

  const inChain = (st: BeamState, id: string): boolean => {
    for (let x: BeamState | null = st; x && x.o; x = x.parent) {
      if (x.o.items.some((it) => it.id === id)) return true;
    }

    return false;
  };

  let beam: BeamState[] = [{ s: 0, last: 0, parent: null, o: null, key: "" }];
  const width = rx.triple ? 150 : P.beam;

  for (let i = 0; i < rewards.length; i += 1) {
    const m = rewards[i];
    const next: BeamState[] = [];

    for (const st of beam) {
      for (const o of sets[i]) {
        if (!rx.anyOrder && (rx.nonStrict ? o.value < st.last : o.value <= st.last)) continue;

        if (rx.repeat) {
          // Repeats allowed, but never back to back: the same gift twice running reads
          // as a mistake even when the catalogue leaves no alternative.
          if (st.o && o.items.some((it) => ids(st.o!).includes(it.id))) continue;
        } else if (o.items.some((it) => inChain(st, it.id))) {
          continue;
        }

        next.push({
          s: st.s + Math.abs(o.value - m.V) / m.V,
          last: o.value,
          parent: st,
          o,
          key: `${st.key}|${ids(o).join(",")}`
        });
      }
    }

    if (!next.length) return null;

    next.sort(
      (a, b) => a.s - b.s || b.last - a.last || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
    beam = next.slice(0, width);
  }

  const best: RewardOption[] = [];
  for (let x: BeamState | null = beam[0]; x && x.o; x = x.parent) best.unshift(x.o);

  const usedAll = new Set(best.flatMap(ids));

  return rewards.map((m, i) => {
    // Alternatives must sit strictly between the neighbouring rewards, so swapping one
    // cannot break the ladder's ordering, and must not steal an item used elsewhere.
    const lo = i ? best[i - 1].value : 0;
    const hi = i < best.length - 1 ? best[i + 1].value : Infinity;
    const mine = new Set(ids(best[i]));
    const alts = sets[i]
      .filter(
        (o) =>
          o.value > lo &&
          o.value < hi &&
          ids(o).join() !== ids(best[i]).join() &&
          !ids(o).some((x) => usedAll.has(x) && !mine.has(x))
      )
      .sort(
        (a, b) =>
          Math.abs(a.value - m.V) - Math.abs(b.value - m.V) ||
          a.items.length - b.items.length ||
          a.cost - b.cost
      )
      .slice(0, 2);

    return { m, o: best[i], alts };
  });
};

/* -------------------------------------------------------------------- step 6: perks */

/** Fill the non-reward milestones, in a fixed order so two runs agree. */
export const choosePerks = (
  ms: Milestone[],
  cls: ClassifiedItem[],
  cands: Candidate[],
  est: Estimates,
  inv: number
): { kinds: string[]; pool: Candidate[]; dias: ClassifiedItem[] } => {
  const T = est.ticket;
  const dias = cls
    .filter((i) => i.cat === "DIA" && !i.review)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const pool = cands
    .filter(
      (c) =>
        (c.cat === "COS" || c.cat === "PRE" || c.cost / c.value <= P.surpriseRatio + 1e-9) &&
        c.cost <= P.surpriseMaxCost * T
    )
    .sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));

  const kinds = (dias.length ? ["diag"] : []).concat(
    ["doble", "mejora"],
    pool.length ? ["sorpresa"] : []
  );
  const poolCost = pool.length ? pool.reduce((s, c) => s + c.cost, 0) / pool.length : 0;
  const rotation = ["mejora"].concat(pool.length ? ["sorpresa"] : []);

  let rotated = 0;
  let diaIndex = 0;

  const assign = (m: Milestone, kind: string): void => {
    if (kind === "diag") {
      const it = dias[diaIndex % dias.length];
      diaIndex += 1;
      m.perk = {
        kind: "diag",
        name: `${it.name} gratis`,
        desc: "Valoración gratuita, que además abre la puerta a recomendar un tratamiento nuevo.",
        cost: 0
      };
    } else if (kind === "doble") {
      m.perk = {
        kind: "doble",
        name: "Puntos dobles en tu próxima visita",
        desc: "La siguiente visita de pago suma el doble de progreso.",
        cost: inv * T
      };
    } else if (kind === "mejora") {
      m.perk = {
        kind: "mejora",
        name: "Mejora de tu tratamiento o 10 minutos extra",
        desc: "Un extra dentro de la sesión que ya ha pagado, a elección del centro.",
        cost: P.perkUpgradeCost * T
      };
    } else {
      m.perk = {
        kind: "sorpresa",
        name: "Premio sorpresa",
        desc: `Un detalle sencillo que elige el centro: ${pool
          .slice(0, 5)
          .map((c) => c.name)
          .join(", ")}.`,
        cost: poolCost,
        pool
      };
    }
  };

  for (const tramo of [1, 2, 3, 4]) {
    const slots = ms.filter((m) => m.tramo === tramo && m.type === "ventaja");
    let i = 0;

    // The diagnosis always lands in Bronce: it costs nothing and it opens a conversation
    // about a treatment the client has not tried.
    if (tramo === 1 && dias.length && slots[i]) {
      assign(slots[i], "diag");
      i += 1;
    }

    if (slots[i]) {
      assign(slots[i], "doble");
      i += 1;
    }

    for (; i < slots.length; i += 1) {
      assign(slots[i], rotation[rotated % rotation.length]);
      rotated += 1;
    }
  }

  return { kinds, pool, dias };
};

/* ---------------------------------------------------------------- steps 7, 8 and 9 */

/** After Diamante there are no more tiers, so one reward repeats forever. */
export const chooseRecurring = (
  A: number,
  last: number,
  inv: number,
  cands: Candidate[]
): { every: number; o: RewardOption } => {
  const V = P.vb * P.loopA * A;
  const cap = inv * P.loopA * A * (1 + P.tol);
  const all = buildOptions(cands).filter((o) => o.cost <= cap + 1e-9);
  let fit = all.filter((o) => o.value >= last && o.value <= P.cap * V);

  if (!fit.length) fit = all;

  fit.sort(byDistanceTo(V));

  return { every: roundTo(A * P.loopA, P.round), o: fit[0] };
};

/** One birthday gift per tier, each worth more than the tier below. */
export const chooseTierGifts = (cands: Candidate[], T: number): Record<TierCode, TierGift> => {
  const out = {} as Record<TierCode, TierGift>;
  let lastBirthday = 0;

  for (const tier of TIERS) {
    const spec = TIER_BENEFITS[tier].birthday;
    out[tier] = {};

    if (!spec) continue;

    const V = spec.v * T;
    const cap = spec.c * T;
    const giftOptions = cands
      .filter((c) => P.giftCats.includes(c.cat))
      .map((c) => ({ items: [c], value: c.value, cost: c.cost }));

    // "Better than the tier below" is the first constraint dropped when the catalogue
    // cannot satisfy it — a gift that repeats beats a tier with no gift at all.
    let pool = giftOptions.filter((o) => o.cost <= cap + 1e-9 && o.value > lastBirthday);

    if (!pool.length) pool = giftOptions.filter((o) => o.cost <= cap + 1e-9);
    if (!pool.length) continue;

    pool.sort(byDistanceTo(V));
    out[tier].birthday = pool[0];
    lastBirthday = pool[0].value;
  }

  return out;
};

/**
 * Five referral rewards, at the 1st, 3rd, 5th, 7th and 10th person who comes and pays.
 *
 * The cost cap scales with how many referrals the step represents, because each one
 * brought a year of a new client's spending with it.
 */
export const chooseReferral = (
  cands: Candidate[],
  est: Estimates,
  objRef: number,
  newYear: number
): ReferralStep[] => {
  const T = est.ticket;
  const opts = buildOptions(cands, false);
  const used = new Set<string>();
  let last = 0;
  let prevN = 0;
  const out: ReferralStep[] = [];

  for (const step of P.refSteps) {
    const V = step.v * T * objRef;
    const cap = P.refInv * newYear * (step.n - prevN);
    let pool = opts.filter(
      (o) => o.cost <= cap + 1e-9 && o.value > last && !ids(o).some((x) => used.has(x))
    );

    if (!pool.length) pool = opts.filter((o) => o.cost <= cap + 1e-9 && o.value >= last);
    if (!pool.length) pool = opts;

    pool.sort(byDistanceTo(V));

    const o = pool[0];
    ids(o).forEach((x) => used.add(x));
    last = o.value;
    prevN = step.n;
    out.push({ n: step.n, V, cap, o, name: o.items.map((i) => i.name).join(" y ") });
  }

  return out;
};

/* ------------------------------------------------------------------- the relaxations */

/**
 * The relaxation cascade, in order. The first set of rules that yields a ladder wins.
 *
 * Order encodes what we are least unwilling to give up. Stretching a budget comes before
 * putting treatments in the welcome segment, which comes before repeating an item, which
 * comes before giving up ascending order altogether. Only the labelled steps produce a
 * note for the centre; `sin_aviso` steps bend a number without changing what the
 * programme looks like.
 */
const relaxationSteps = (candidateCount: number): Array<[string, Relaxation]> => [
  ["ninguna", { capMult: P.cap, earlyAll: false, nonStrict: false, tol: P.tol }],
  ["sin_aviso", { capMult: P.cap, earlyAll: false, nonStrict: false, tol: 0.3 }],
  ["sin_aviso", { capMult: P.cap, earlyAll: false, nonStrict: false, tol: 0.5 }],
  ["sin_aviso", { capMult: 3, earlyAll: false, nonStrict: false, tol: P.tol }],
  ["sin_aviso", { capMult: 3, earlyAll: false, nonStrict: false, tol: 0.3 }],
  ["sin_aviso", { capMult: 3, earlyAll: false, nonStrict: false, tol: 0.5 }],
  ["sin_aviso", { capMult: 3, earlyAll: false, nonStrict: true, tol: 0.5 }],
  ["sin_aviso", { capMult: P.cap, earlyAll: true, nonStrict: false, tol: P.tol }],
  ...(candidateCount < 25
    ? ([
        [
          "sin_aviso",
          { capMult: P.cap, earlyAll: true, nonStrict: false, tol: P.tol, repeat: true }
        ],
        ["sin_aviso", { capMult: 3, earlyAll: true, nonStrict: false, tol: P.tol, repeat: true }]
      ] as Array<[string, Relaxation]>)
    : []),
  ["tope de valor 3x", { capMult: 3, earlyAll: true, nonStrict: false, tol: P.tol }],
  ["premios iguales permitidos", { capMult: 3, earlyAll: true, nonStrict: true, tol: P.tol }],
  [
    "artículos repetidos (nunca en premios seguidos)",
    { capMult: 3, earlyAll: true, nonStrict: true, tol: P.tol, repeat: true }
  ],
  [
    "tolerancia de presupuesto del 50%",
    { capMult: 3, earlyAll: true, nonStrict: true, tol: 0.5, repeat: true }
  ],
  [
    "tolerancia de presupuesto del 100%",
    { capMult: 3, earlyAll: true, nonStrict: true, tol: 1.0, repeat: true }
  ],
  [
    "packs de tres",
    { capMult: 3, earlyAll: true, nonStrict: true, tol: 0.5, repeat: true, triple: true }
  ],
  [
    "packs de tres",
    { capMult: 5, earlyAll: true, nonStrict: true, tol: 1.0, repeat: true, triple: true }
  ],
  [
    "premios sin orden creciente",
    { capMult: 5, earlyAll: true, nonStrict: true, tol: 1.0, repeat: true, anyOrder: true }
  ]
];

/* ------------------------------------------------------------------- bronce ordering */

export type BronceOrdering =
  /** The first reward already is a best one, so there was nothing to move. */
  | "unchanged"
  /** The document's order: best first, the rest ascending. */
  | "best-first"
  /** Best first, the rest descending, because the document's order would repeat a gift. */
  | "best-first-descending"
  /** Best first was impossible without repeating a gift, so the beam's order was kept. */
  | "kept-to-avoid-repeat";

const sharesItem = (a: RewardOption, b: RewardOption): boolean =>
  ids(a).some((id) => ids(b).includes(id));

/** True when two consecutive rewards in the sequence share a catalogue item. */
const hasConsecutiveRepeat = (sequence: RewardOption[]): boolean =>
  sequence.some((option, i) => i > 0 && sharesItem(option, sequence[i - 1]));

/**
 * Put Bronce's best reward first, without ever repeating a gift back to back.
 *
 * Version 1.2 of the guide asks for two things at once: the best Bronce reward leads, so
 * the very first visit feels generous, and no gift repeats in two milestones in a row.
 * The reference engine does the first by rotating the segment, and in doing so it can undo
 * the second — the beam search guarantees its own ordering has no adjacent repeat, and the
 * rotation moves rewards next to neighbours the beam never checked.
 *
 * That is not a theoretical clash. In every failing case the three Bronce rewards are
 * tied in value, so "best first" has no meaning at all and the rotation was changing
 * nothing except creating the repeat.
 *
 * So the order is applied only where it changes which reward leads, and never at the price
 * of a repeat — the second guarantee wins, because a gift offered twice running reads as a
 * mistake, whereas an unusual Bronce order is invisible. Rewards travel with their
 * alternatives, which were computed against their neighbours' values.
 */
export const orderBronce = (chosen: ChosenReward[]): BronceOrdering => {
  const segment = chosen.filter((c) => c.m.tramo === 1);
  const following = chosen.find((c) => c.m.tramo > 1);

  if (segment.length < 2) return "unchanged";

  const slots = segment.map((c) => ({ o: c.o, alts: c.alts }));
  const best = Math.max(...slots.map((s) => s.o.value));

  // Already leading with a best reward. Covers the all-tied case, where the reference's
  // rotation is a no-op in meaning and the source of the repeat.
  if (slots[0].o.value === best) return "unchanged";

  const ascending = [...slots].sort((x, y) => x.o.value - y.o.value);
  const top = ascending[ascending.length - 1];
  const rest = ascending.slice(0, -1);
  const attempts: Array<[BronceOrdering, typeof slots]> = [
    ["best-first", [top, ...rest]],
    ["best-first-descending", [top, ...[...rest].reverse()]]
  ];

  for (const [name, order] of attempts) {
    const sequence = [...order.map((s) => s.o), ...(following ? [following.o] : [])];

    if (hasConsecutiveRepeat(sequence)) continue;

    segment.forEach((c, i) => {
      c.o = order[i].o;
      c.alts = order[i].alts;
    });

    return name;
  }

  return "kept-to-avoid-repeat";
};

/* ----------------------------------------------------------------- guarantees and review */

/**
 * The blocking note raised when a programme costs more than half again its chosen budget.
 *
 * A constant because two places must agree on it exactly: the engine, which raises it, and a
 * reward swap, which must clear it or add it as the cost moves. A swap that matched the text
 * by a near copy would stop recognising it the first time someone reworded one.
 */
export const COST_REVIEW_NOTE =
  "El coste de los premios supera en más de un 50% la inversión elegida. Sube la inversión o añade regalos más baratos.";

/**
 * The invariants a valid programme must hold, as sentences with a truth value.
 *
 * Extracted from `run` so a reward swap can re-check them. A swap changes which rewards sit
 * where, and the three guarantees that depend on that — no repeats, Bronce leading, total cost
 * — can all flip; the rest are properties of the ladder's shape, which a swap does not touch.
 */
export const buildGuarantees = (
  lad: Ladder,
  est: Estimates,
  chosen: ChosenReward[],
  costPct: number
): Array<[string, boolean]> => [
  ["El primer premio llega en la primera visita", lad.ms[0].th <= est.ticket],
  [`Plata se alcanza con ${esNum(Math.round(lad.visitsSilver * 10) / 10)} visitas`, true],
  [
    `Cada nivel cuesta al menos ${esNum(P.minGrowth)} veces el anterior (aquí ×${lad.R.toFixed(2).replace(".", ",")})`,
    lad.R >= P.minGrowth - 1e-9
  ],
  [
    `Nunca pasan más de ${esNum(P.maxVisitsBetween)} visitas sin un premio, una ventaja o una subida de nivel`,
    true
  ],
  [
    "Todo premio o ventaja se canjea en una visita de pago o en una sesión de un bono ya pagado, en un máximo de 60 días",
    true
  ],
  [
    "En Bronce el mejor premio es el primero",
    (() => {
      const b1 = chosen.filter((c) => c.m.tramo === 1);
      return b1.every((c) => c.o.value <= b1[0].o.value);
    })()
  ],
  [
    "Cada nivel incluye una ventaja de puntos dobles",
    [1, 2, 3, 4].every((tr) => lad.ms.some((m) => m.tramo === tr && m.perk?.kind === "doble"))
  ],
  ["Los bonos suman puntos en cada sesión consumida, no al comprarlos", true],
  ["Subir de nivel exige antigüedad mínima (Oro 12, Platino 24 y Diamante 36 meses)", true],
  [
    "Ningún regalo se repite en dos hitos seguidos",
    chosen.every((c, i) => !i || !ids(c.o).some((x) => ids(chosen[i - 1].o).includes(x)))
  ],
  [
    `Premios y ventajas cuestan el ${(costPct * 100).toFixed(1).replace(".", ",")}% del gasto de la clienta`,
    costPct <= lad.inv * 1.5
  ]
];

/* ------------------------------------------------------------------------------ run */

export const run = (items: CatalogItem[], ans: Answers): EngineResult => {
  const cls = classify(items);
  const est = estimate(cls, ans);

  if ("error" in est) return { error: est.error, catalog: cls };

  const cands = candidates(cls, ans);
  let lad = buildLadder(est, ans, false);
  let chosen: ChosenReward[] | null = null;
  let used: { label: string; rx: Relaxation } | null = null;
  let floorUsed = false;

  outer: for (const [label, rx] of relaxationSteps(cands.length)) {
    for (const useFloor of [false, true]) {
      lad = buildLadder(est, ans, useFloor);

      // The floored variant is only a distinct attempt when the floor actually bit.
      if (useFloor && !lad.floorApplied) continue;

      chosen = chooseRewards(lad.ms, cands, rx);

      if (chosen) {
        used = { label, rx };
        floorUsed = useFloor;
        break outer;
      }
    }
  }

  if (!chosen || !used) {
    return {
      error:
        "Con este catálogo no se puede montar una escalera de premios. Añade más tratamientos, cosmética o extras baratos (presoterapia, ampollas, mejoras).",
      catalog: cls,
      est
    };
  }

  const bronce = orderBronce(chosen);

  const rec = chooseRecurring(est.A, chosen[chosen.length - 1].o.value, lad.inv, cands);
  const gifts = chooseTierGifts(cands, est.ticket);
  const perks = choosePerks(lad.ms, cls, cands, est, lad.inv);
  const perkList = lad.ms.filter((m) => m.type === "ventaja");
  const perkCost = perkList.reduce((s, m) => s + (m.perk?.cost ?? 0), 0);

  // Progress euros are not spent euros: a tier multiplier means a Diamante client reaches
  // the same threshold having paid less. realTh is what each milestone actually costs.
  const realTh: Record<number, number> = {};
  let real = 0;
  let prevProgress = 0;

  for (const m of lad.ms) {
    const mult = TIER_BENEFITS[TIERS[m.tramo - 1]].mult;
    real += (m.th - prevProgress) / mult;
    prevProgress = m.th;
    realTh[m.n] = real;
  }

  const totalCost = chosen.reduce((s, c) => s + c.o.cost, 0) + perkCost;
  const diamondReal = realTh[lad.last.n];
  const costPct = totalCost / diamondReal;
  const yearsD = diamondReal / est.A;

  const newYear = P.repeatShare * est.A + (1 - P.repeatShare) * P.occVisits * est.ticket;
  const refLad = chooseReferral(
    cands,
    est,
    OBJECTIVES[ans.objective].ref * (OCCUPANCY[ans.occupancy] ?? OCCUPANCY.o2).ref,
    newYear
  );
  const welcome = Math.round((lad.ms[0].th * 0.5) / 5) * 5;

  const rx = used.rx;
  const adapt: string[] = [];

  if (bronce === "kept-to-avoid-repeat") {
    // The one case where the two Bronce rules cannot both hold. Said plainly, because the
    // guarantee below will read false and the centre should know why.
    adapt.push(
      "En Bronce el mejor premio no va el primero, porque así se repetiría un regalo en dos hitos seguidos."
    );
  }

  if (floorUsed) {
    adapt.push(
      "Los primeros premios reciben algo más de presupuesto para que quepan regalos de bienvenida con tu catálogo."
    );
  }
  if (
    rx.earlyAll &&
    chosen.filter((c) => c.m.early).some((c) => c.o.items.some((i) => !CATEGORIES[i.cat].early))
  ) {
    adapt.push(
      "En el camino a Plata se usan también tratamientos, porque la cosmética y los extras de tu catálogo no encajan en ese presupuesto."
    );
  }
  if (
    rx.repeat &&
    new Set(chosen.flatMap((c) => ids(c.o))).size < chosen.flatMap((c) => ids(c.o)).length
  ) {
    adapt.push(
      "Como tu catálogo tiene pocos regalos posibles, alguno se repite en la escalera, nunca en dos hitos seguidos."
    );
  }
  if (rx.nonStrict && chosen.some((c, i) => i && c.o.value === chosen![i - 1].o.value)) {
    adapt.push(
      "Algunos premios seguidos tienen el mismo valor, porque no hay un regalo mayor que quepa en ese presupuesto."
    );
  }
  if (rx.capMult > P.cap && chosen.some((c) => c.o.value > P.cap * c.m.V)) {
    adapt.push(
      "Algunos premios valen más de lo previsto para su coste: son regalos con coste casi nulo para el centro."
    );
  }
  if (rx.triple && chosen.some((c) => c.o.items.length === 3)) {
    adapt.push(
      "Los premios más altos combinan tres tratamientos, para que su valor esté a la altura del gasto de tus clientas."
    );
  }
  if (rx.tol > P.tol && chosen.some((c) => c.o.cost > c.m.cap + 1e-9)) {
    adapt.push(
      `Algunos premios usan algo más de su presupuesto individual; el coste total queda en el ${(costPct * 100).toFixed(1).replace(".", ",")}% del gasto.`
    );
  }

  // Review notes block approval, so they are raised only for something genuinely wrong —
  // not for a programme that merely had to bend.
  const review: string[] = [];
  const unclassified = cls.filter((i) => i.review).length;

  if (unclassified) {
    review.push(
      `Hay ${unclassified} ${unclassified === 1 ? "fila" : "filas"} del catálogo sin categoría. Clasifícalas en la tabla.`
    );
  }

  const aRatio = est.A / est.AEst;

  if (aRatio > 3 || aRatio < 1 / 3) {
    review.push(
      `Con tus respuestas, una clienta gastaría ${eurText(est.A)} al año, pero tus precios y tratamientos apuntan a unos ${eurText(est.AEst)}. Comprueba el ticket y la frecuencia.`
    );
  } else if (rx.anyOrder) {
    review.push(
      "Con este catálogo los premios no pueden ir de menor a mayor. Añade tratamientos o productos de más valor."
    );
  }

  if (costPct > lad.inv * 1.5) review.push(COST_REVIEW_NOTE);

  if (lad.visitsSilver < P.visitsSilver) {
    adapt.push(
      `Como tus clientas vienen poco a menudo, Plata se alcanza con ${esNum(Math.round(lad.visitsSilver * 10) / 10)} visitas y Diamante en unos ${esNum(Math.round(yearsD * 10) / 10)} años, para que la escalera no se haga eterna.`
    );
  } else if (lad.Y > P.years + 0.01) {
    adapt.push(
      `Como tus clientas vienen poco a menudo, Diamante se alarga a unos ${esNum(Math.round(yearsD * 10) / 10)} años para mantener Plata en ${P.visitsSilver} visitas.`
    );
  }

  if (yearsD < 2.5 || yearsD > 8) {
    review.push("El tiempo hasta Diamante sale fuera de lo razonable. Revisa ticket y frecuencia.");
  }

  const guarantees = buildGuarantees(lad, est, chosen, costPct);

  return {
    engineVersion: ENGINE_VERSION,
    configVersion: CONFIG_VERSION,
    catalog: cls,
    est,
    lad,
    chosen,
    rec,
    gifts,
    perks,
    refLad,
    welcome,
    adapt,
    review,
    guarantees,
    totalCost,
    perkCost,
    costPct,
    diamondReal,
    realTh
  } satisfies Program;
};
