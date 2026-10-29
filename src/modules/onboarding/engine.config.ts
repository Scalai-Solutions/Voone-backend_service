import type {
  CategoryCode,
  InvestmentLevel,
  Objective,
  OccupancyLevel,
  Segment,
  TierCode
} from "./engine.types";

/**
 * Every number the engine uses.
 *
 * Kept as data rather than as constants scattered through the algorithm, because
 * recalibrating after the pilot must be a config change and not a deploy. Each generated
 * programme stores CONFIG_VERSION, so a programme can always be regenerated exactly as it
 * was first produced — changing a value here must never silently alter a published one.
 *
 * Values are the reference engine's CFG, v1.2.0, unchanged. Do not "tidy" them: the
 * partners validated these against a spreadsheet, and the differential test compares this
 * port against the reference across the whole answer space.
 */
export const ENGINE_VERSION = "1.2.0";
export const CONFIG_VERSION = "2026-10-07.1";

export interface CategoryConfig {
  name: string;
  /** Demand weight for ticket estimation. Zero means it does not inform the estimate. */
  w: number;
  /** Weeks between repeat purchases, for the visit-frequency estimate. */
  iv: number;
  /** What the centre pays, as a share of the sale price. */
  cost: number;
  /** Whether spending on it earns progress. False for pharmacological medicine. */
  points: boolean;
  /** Whether the ENGINE may propose it as a reward, in the programmes it generates. */
  reward: boolean;
  /**
   * Whether the centre's admin may choose it BY HAND as a reward ("Cambiar" > "O cualquier
   * artículo del catálogo"). Wider than `reward` on purpose: waxing and diagnosis are not
   * proposed (a diagnosis costs the centre nothing, so a 5 euro one would look like a free
   * reward and dominate every ladder) but the owner may still choose them. Only the
   * prescription and medical categories stay out, a legal constraint in Spain (see MFA).
   * Used by the item swap alone; nothing the engine computes reads it.
   */
  manualReward: boolean;
  /** Whether it may be given before Plata, where budgets are smallest. */
  early: boolean;
  pharma?: boolean;
}

export const CATEGORIES: Record<CategoryCode, CategoryConfig> = {
  FAC: {
    name: "Facial de cabina",
    w: 3,
    iv: 5,
    cost: 0.2,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  APF: {
    name: "Aparatología facial",
    w: 2,
    iv: 4.5,
    cost: 0.12,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  MAS: {
    name: "Masaje",
    w: 2,
    iv: 6,
    cost: 0.1,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  COR: {
    name: "Tratamiento corporal",
    w: 3,
    iv: 4,
    cost: 0.15,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  LAS: {
    name: "Depilación láser",
    w: 3,
    iv: 7,
    cost: 0.08,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  CER: {
    name: "Depilación con cera",
    w: 2,
    iv: 5,
    cost: 0.15,
    points: true,
    reward: false,
    // Not proposed by the engine, but the admin may choose it by hand.
    manualReward: true,
    early: false
  },
  // Hair, nails and brows come from an earlier scope. Kept so a centre that still has
  // such rows classifies rather than falling through to "unclassified".
  PEL: {
    name: "Peluquería",
    w: 3,
    iv: 7,
    cost: 0.15,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  UNA: {
    name: "Manos y pies",
    w: 3,
    iv: 3,
    cost: 0.15,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  CEJ: {
    name: "Cejas y pestañas",
    w: 2,
    iv: 6,
    cost: 0.15,
    points: true,
    reward: true,
    manualReward: true,
    early: false
  },
  COS: {
    name: "Cosmética de venta",
    w: 0,
    iv: 0,
    cost: 0.5,
    points: true,
    reward: true,
    manualReward: true,
    early: true
  },
  PRE: {
    name: "Presoterapia y regalos de coste casi nulo",
    w: 0,
    iv: 0,
    cost: 0.05,
    points: true,
    reward: true,
    manualReward: true,
    early: true
  },
  DIA: {
    name: "Diagnóstico y valoración",
    w: 0,
    iv: 0,
    cost: 0,
    points: true,
    reward: false,
    // Not proposed (cost 0 would make any diagnosis look free), but the admin may choose it.
    manualReward: true,
    early: false
  },
  // Never earns progress and is never a reward. A legal constraint in Spain, not a
  // preference: giving away a prescription-only treatment is not ours to do.
  MFA: {
    name: "Medicina: farmacológico",
    w: 0,
    iv: 0,
    cost: 0,
    points: false,
    reward: false,
    // The legal block: never a reward, not even by the admin's own choice.
    manualReward: false,
    early: false,
    pharma: true
  },
  MNF: {
    name: "Medicina: acto médico sin medicamento",
    w: 0,
    iv: 0,
    cost: 0,
    points: false,
    reward: false,
    // Medical too: no medicine is given away, with or without a medicament.
    manualReward: false,
    early: false
  }
};

/** A catalogue with any of these is `high`; failing that, any `MID_IF_ANY` makes it `mid`. */
export const HIGH_IF_ANY: CategoryCode[] = ["MFA"];
export const MID_IF_ANY: CategoryCode[] = ["APF", "COR", "LAS"];

export interface SegmentConfig {
  /** Lifts the weighted median into a realistic average ticket. */
  comb: number;
  /** Discounts the theoretical visit rate to what clients actually do. */
  comp: number;
  tmin: number;
  tmax: number;
  ref: number;
}

export const SEGMENTS: Record<Segment, SegmentConfig> = {
  low: { comb: 1.3, comp: 0.5, tmin: 25, tmax: 70, ref: 0.25 },
  mid: { comb: 1.1, comp: 0.5, tmin: 50, tmax: 150, ref: 0.2 },
  high: { comb: 1.1, comp: 0.5, tmin: 50, tmax: 150, ref: 0.2 }
};

export interface Bucket {
  id: string;
  label: string;
  max: number | null;
  value: number;
}

export const TICKET_BUCKETS: Record<"low" | "mid", Bucket[]> = {
  low: [
    { id: "t1", label: "Menos de 25 €", max: 25, value: 20 },
    { id: "t2", label: "25 a 40 €", max: 40, value: 32 },
    { id: "t3", label: "40 a 60 €", max: 60, value: 50 },
    { id: "t4", label: "Más de 60 €", max: null, value: 70 }
  ],
  mid: [
    { id: "t1", label: "Menos de 60 €", max: 60, value: 50 },
    { id: "t2", label: "60 a 100 €", max: 100, value: 80 },
    { id: "t3", label: "100 a 150 €", max: 150, value: 125 },
    { id: "t4", label: "Más de 150 €", max: null, value: 175 }
  ]
};

export interface FreqBucket {
  id: string;
  label: string;
  maxW: number | null;
  weeks: number;
}

export const FREQ_BUCKETS: FreqBucket[] = [
  { id: "f1", label: "Cada 3 semanas", maxW: 3.5, weeks: 3 },
  { id: "f2", label: "Cada mes", maxW: 5, weeks: 4.3 },
  { id: "f3", label: "Cada 6 a 8 semanas", maxW: 9, weeks: 7 },
  { id: "f4", label: "Cada 2 o 3 meses", maxW: 14, weeks: 10.8 },
  { id: "f5", label: "Cada 4 a 6 meses", maxW: null, weeks: 21.7 }
];

export const INVESTMENT: Record<InvestmentLevel, number> = {
  conservador: 0.04,
  equilibrado: 0.05,
  generoso: 0.06
};

export interface OccupancyConfig {
  label: string;
  sub: string;
  /**
   * What giving away chair time costs. A half-empty agenda fills a gap; a full one gives
   * up a sellable appointment, so the same gift costs the centre more.
   */
  svc: number;
  /** Budget weight per ladder segment. */
  tramo: number[];
  ref: number;
}

export const OCCUPANCY: Record<OccupancyLevel, OccupancyConfig> = {
  o1: {
    label: "Menos del 50%",
    sub: "Hay mucho hueco que llenar",
    svc: 0.7,
    tramo: [1.15, 1, 1, 1],
    ref: 1.5
  },
  o2: { label: "50 a 70%", sub: "Ocupación media", svc: 1.0, tramo: [1, 1, 1, 1], ref: 1.0 },
  o3: { label: "70 a 85%", sub: "Bastante llena", svc: 1.2, tramo: [1.05, 0.9, 1, 1.1], ref: 0.8 },
  o4: {
    label: "Más del 85%",
    sub: "Agenda casi completa",
    svc: 1.4,
    tramo: [1.1, 0.8, 1, 1.2],
    ref: 0.6
  }
};

/** Categories that consume a cabin slot, so `svc` applies to their cost. */
export const TIME_CATS: CategoryCode[] = [
  "FAC",
  "APF",
  "MAS",
  "COR",
  "LAS",
  "PEL",
  "UNA",
  "CEJ",
  "PRE"
];

export interface ObjectiveConfig {
  /** How a segment's budget splits across its three rewards. */
  pos: number[];
  /** Budget weight per segment. The first is doubled: early rewards hook a new client. */
  mult: number[];
  ref: number;
}

export const OBJECTIVES: Record<Objective, ObjectiveConfig> = {
  equilibrado: { pos: [0.8, 1, 1.2], mult: [2, 1, 1, 1], ref: 1 },
  mas_visitas: { pos: [0.9, 1, 1.1], mult: [2, 1, 1, 1], ref: 1 },
  mas_gasto: { pos: [0.8, 1, 1.2], mult: [2, 1, 1, 1.3], ref: 1 },
  mas_clientes_nuevos: { pos: [0.8, 1, 1.2], mult: [2, 1, 1, 1], ref: 1.5 }
};

/**
 * The ranges the centre's own ticket and visits figures may take. Outside them a figure is almost
 * certainly a typo, and a typo rebuilds the whole programme around it. Shared by the schema that
 * refuses a bad one and by the estimates the screen reads, so the two cannot disagree.
 */
export const ANSWER_LIMITS = {
  ticket: { min: 10, max: 1000 },
  visits: { min: 0.5, max: 26 }
} as const;

export const TIERS: TierCode[] = ["bronce", "plata", "oro", "platino", "diamante"];

export const TIER_NAMES: Record<TierCode, string> = {
  bronce: "Bronce",
  plata: "Plata",
  oro: "Oro",
  platino: "Platino",
  diamante: "Diamante"
};

/** Months as a member before a tier can be entered, however fast the threshold is met. */
export const MIN_TENURE: Record<TierCode, number> = {
  bronce: 0,
  plata: 0,
  oro: 12,
  platino: 24,
  diamante: 36
};

export interface TierBenefit {
  /** Progress multiplier: a Diamante euro is worth 1.3 progress euros. */
  mult: number;
  birthday: { v: number; c: number } | null;
  discount: number;
  events: number;
  tests: boolean;
  extra: string[];
}

export const TIER_BENEFITS: Record<TierCode, TierBenefit> = {
  bronce: {
    mult: 1.0,
    birthday: { v: 0.2, c: 0.1 },
    discount: 0,
    events: 0,
    tests: false,
    extra: ["Tarjeta con su nombre y escalera de premios"]
  },
  plata: {
    mult: 1.0,
    birthday: { v: 0.35, c: 0.1 },
    discount: 0.03,
    events: 0,
    tests: false,
    extra: ["Prioridad en huecos de última hora y lista de espera"]
  },
  oro: {
    mult: 1.1,
    birthday: { v: 0.5, c: 0.12 },
    discount: 0.05,
    events: 0,
    tests: true,
    extra: [
      "Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento"
    ]
  },
  platino: {
    mult: 1.2,
    birthday: { v: 0.75, c: 0.15 },
    discount: 0.1,
    events: 1,
    tests: true,
    extra: [
      "Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento",
      "Acceso 48 horas antes a tratamientos y productos nuevos"
    ]
  },
  diamante: {
    mult: 1.3,
    birthday: { v: 1.0, c: 0.2 },
    discount: 0.15,
    events: 2,
    tests: true,
    extra: [
      "Acceso preferente a la Happy Hour: huecos que el centro quiere llenar rápido, con un 30% de descuento",
      "Cita garantizada en 48 horas",
      "Plan anual personalizado"
    ]
  }
};

/**
 * Scalar parameters. Named as in the reference so the two can be read side by side.
 *
 * Only the fields the programme design needs are here. The reference also carries figures
 * for an internal revenue projection (adhesion, margin, fee, retention and so on) which
 * this port deliberately omits — see the engine's header.
 */
export const P = {
  premiosPerTramo: 3,
  /** A client should never go more than this many visits without something happening. */
  maxVisitsBetween: 1.5,
  discountMaxProducts: 3,
  refInv: 0.1,
  refRepeatEvery: 3,
  refSteps: [
    { n: 1, v: 0.3 },
    { n: 3, v: 0.75 },
    { n: 5, v: 1.25 },
    { n: 7, v: 1.75 },
    { n: 10, v: 2.75 }
  ],
  perkUpgradeCost: 0.05,
  surpriseMaxCost: 0.1,
  surpriseRatio: 0.06,
  earlyFloorPctT: 0.1,
  /** How far over its cost budget a single reward may go. */
  tol: 0.15,
  /** Share of a reward's budget that must come back as perceived value. */
  vb: 0.3,
  /** A reward may be worth at most this many times its value target. */
  cap: 2.0,
  round: 10,
  years: 5,
  maxYears: 6,
  minVisitsSilver: 2,
  minGrowth: 1.5,
  visitsSilver: 3,
  /** After Diamante, one reward repeats every 0.75 × annual spend. */
  loopA: 0.75,
  beam: 400,
  occVisits: 1.3,
  repeatShare: 0.42,
  uplift: 0.1,
  giftCats: ["COS", "PRE", "FAC", "APF", "MAS", "PEL", "UNA", "CEJ"] as CategoryCode[]
} as const;

/**
 * Keyword rules, in priority order. The first substring that appears in the lower-cased
 * name wins, so order carries meaning: medicine and diagnosis come first, otherwise
 * "Diagnóstico de láser" would classify as laser hair removal.
 */
export const KEYWORDS: Array<[CategoryCode, string[]]> = [
  [
    "MFA",
    [
      "toxina",
      "botox",
      "bótox",
      "bruxismo",
      "hiperhidrosis",
      "hialurónico",
      "hialuronico",
      "rinomodelación",
      "rinomodelacion",
      "sculptra",
      "polinucleótidos",
      "polinucleotidos",
      "skinbooster",
      "mesoterapia",
      "hialuronidasa",
      "relleno",
      "vial"
    ]
  ],
  [
    "MNF",
    ["consulta médica", "consulta medica", "láser plasma", "laser plasma", "verrugas", "lunares"]
  ],
  ["DIA", ["diagnóstico", "diagnostico", "valoración", "valoracion"]],
  ["PRE", ["presoterapia", "ampolla", "(extra)", " extra"]],
  ["CER", ["cera"]],
  [
    "LAS",
    [
      "láser cuerpo",
      "laser cuerpo",
      "zona mini",
      "zona pequeña",
      "zona mediana",
      "depilación láser",
      "depilacion laser"
    ]
  ],
  [
    "APF",
    [
      "hydrafacial",
      "bio-pen",
      "biopen",
      "dermapen",
      "radiofrecuencia facial",
      "hollywood",
      "electroporación",
      "electroporacion"
    ]
  ],
  [
    "COR",
    [
      "lipolítico",
      "lipolitico",
      "corporal",
      "maderoterapia",
      "chocolate",
      "anticelulítico",
      "anticelulitico",
      "presoterapia"
    ]
  ],
  ["MAS", ["masaje"]],
  ["FAC", ["facial", "higiene", "limpieza", "mirada"]],
  [
    "PEL",
    [
      "corte",
      "tinte",
      "mechas",
      "color",
      "peinado",
      "peinar",
      "lavar",
      "keratina",
      "capilar",
      "alisado",
      "barbería",
      "barberia"
    ]
  ],
  ["UNA", ["manicura", "pedicura", "semipermanente", "uñas", "unas"]],
  ["CEJ", ["cejas", "pestañas", "pestanas", "lifting"]]
];
