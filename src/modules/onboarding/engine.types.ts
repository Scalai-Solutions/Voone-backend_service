/**
 * The onboarding engine's vocabulary.
 *
 * A centre uploads its catalogue and answers six questions; the engine turns that into a
 * complete loyalty programme — tier thresholds, a ladder of rewards drawn from the
 * centre's own price list, interleaved perks, a recurring reward and a referral ladder.
 *
 * Ported from the reference implementation `src/engine.cjs` v1.2.0, which the partners
 * validated against a spreadsheet. The reference is the specification: where this file
 * and the guide disagree, the reference wins, and tests/onboarding/reference holds a copy
 * so that claim is checked rather than asserted.
 */

/** Category codes. Each catalogue row ends up in exactly one. */
export type CategoryCode =
  | "FAC"
  | "APF"
  | "MAS"
  | "COR"
  | "LAS"
  | "CER"
  | "PEL"
  | "UNA"
  | "CEJ"
  | "COS"
  | "PRE"
  | "DIA"
  | "MFA"
  | "MNF";

export type TierCode = "bronce" | "plata" | "oro" | "platino" | "diamante";

export type Segment = "low" | "mid" | "high";

export type Objective = "equilibrado" | "mas_visitas" | "mas_gasto" | "mas_clientes_nuevos";

export type InvestmentLevel = "conservador" | "equilibrado" | "generoso";

export type OccupancyLevel = "o1" | "o2" | "o3" | "o4";

/** One row of the centre's price list, before classification. */
export interface CatalogItem {
  /**
   * Stable per centre, and part of every tie-break — so it must not change between runs.
   * Two runs over the same catalogue with different ids can produce different ladders.
   */
  id: string;
  name: string;
  /** Sale price in euros, VAT included. Rows priced at 0 are never rewards. */
  price: number;
  /** Retail product. Forces category COS. */
  product?: boolean;
  /** Category chosen by the centre. Beats keyword classification. */
  cat?: CategoryCode;
  /** Per-item cost ratio, 0 to 1. Beats the category default. */
  costPct?: number | null;
  /** The price is a guess, so the row is excluded from ticket estimation. */
  estimated?: boolean;
  /** Where an existing classification came from. Set by classify. */
  src?: string;
}

/** A catalogue row after classification. `cat` is now certain. */
export interface ClassifiedItem extends CatalogItem {
  cat: CategoryCode;
  src: string;
  /** Nothing matched, so the centre must choose. Blocks approval. */
  review?: boolean;
}

/**
 * The six onboarding answers.
 *
 * `ticket` and `freq` are null when the centre accepted the engine's own estimate, which
 * is the common case — the pre-selected bucket is computed from the catalogue.
 */
export interface Answers {
  ticket?: string | null;
  freq?: string | null;
  /**
   * The centre's own exact figures, which win over the buckets above when set. The buckets stay
   * as quick picks; these are what the programme is actually built from. Everything downstream
   * — every threshold, budget and reward — flows from annual spend (ticket × visits), so
   * changing either one regenerates the whole programme.
   */
  ticketValue?: number | null;
  visitsValue?: number | null;
  objective: Objective;
  investment: InvestmentLevel;
  occupancy: OccupancyLevel;
  /**
   * Active clients per year. Sizes an internal revenue projection that this port
   * deliberately omits, so it changes nothing about the programme. Carried only so the
   * answer set matches the reference.
   */
  members?: string;
}

/** A reward candidate: one catalogue row priced at what it costs the centre. */
export interface Candidate {
  id: string;
  name: string;
  cat: CategoryCode;
  /** What the client sees: the sale price. */
  value: number;
  /** What the centre pays, after the category ratio and any chair-time multiplier. */
  cost: number;
}

/** One or more candidates given together. Pairs must come from different categories. */
export interface RewardOption {
  items: Candidate[];
  value: number;
  cost: number;
}

export type PerkKind = "diag" | "doble" | "mejora" | "sorpresa";

export interface Perk {
  kind: PerkKind;
  name: string;
  desc: string;
  /** Imputed cost to the centre. Zero for a free diagnosis. */
  cost: number;
  /** Only for `sorpresa`: the items the centre may choose from at redemption. */
  pool?: Candidate[];
}

export type MilestoneType = "premio" | "ventaja" | "nivel";

/** One rung of the ladder, before a reward or perk is attached. */
export interface Milestone {
  /** 1-based position across the whole ladder. */
  n: number;
  /** Which of the four tier-to-tier segments this sits in, 1 to 4. */
  tramo: number;
  type: MilestoneType;
  /** Progress euros at which it unlocks. */
  th: number;
  /** Only on a `nivel` milestone: the tier entered. */
  tier?: TierCode;
  /** Cost budget, cost cap and value target. Zero on perk and tier milestones. */
  cb: number;
  cap: number;
  V: number;
  /** True in the first segment, where only `early` categories are normally allowed. */
  early?: boolean;
  perk?: Perk;
}

export interface LadderSegment {
  i: number;
  tier: TierCode;
  gap: number;
  start: number;
  end: number;
  budget: number;
  realVisits?: number;
  hitos?: number;
  ventajas?: number;
}

export interface Ladder {
  /** Geometric growth between segments. */
  R: number;
  /** Total years to Diamante. */
  Y: number;
  tramos: LadderSegment[];
  ms: Milestone[];
  inv: number;
  P: number;
  S: number;
  visitsSilver: number;
  floorApplied: boolean;
  counts: number[];
  last: Milestone;
}

export interface Estimates {
  segment: Segment;
  /** Estimated from the catalogue. */
  tEst: number;
  fEst: number;
  /** The pre-selected bucket ids. */
  tPre: string;
  fPre: string;
  /** What the programme actually uses, after the centre's answers. */
  ticket: number;
  visits: number;
  /** Annual spend of a regular client. Everything scales from this. */
  A: number;
  AEst: number;
  inRange: boolean;
  hasDia: boolean;
  catRows: Array<{
    cat: CategoryCode;
    name: string;
    n: number;
    median: number;
    w: number;
    iv: number;
  }>;
}

export interface ChosenReward {
  m: Milestone;
  o: RewardOption;
  /** Up to two swaps the centre may make without breaking the ladder's ordering. */
  alts: RewardOption[];
  /**
   * The title the centre wrote for this reward, replacing the one derived from the item names.
   * Text only: the items, their value and the cost are what issuing and the rules read, and a
   * label never changes them. Cleared whenever the reward is swapped.
   */
  label?: string;
}

export interface ReferralStep {
  n: number;
  V: number;
  cap: number;
  o: RewardOption;
  name: string;
}

export interface TierGift {
  birthday?: RewardOption;
}

/** Everything the engine produces. Persist it whole, with the catalogue and answers. */
export interface Program {
  engineVersion: string;
  configVersion: string;
  catalog: ClassifiedItem[];
  est: Estimates;
  lad: Ladder;
  chosen: ChosenReward[];
  /** `label`: as on ChosenReward. Cleared whenever the recurring reward is re-picked. */
  rec: { every: number; o: RewardOption; label?: string };
  gifts: Record<TierCode, TierGift>;
  /**
   * Benefits the centre wrote itself, per tier (founders' E2E item 27). Shown after the ones the
   * engine derives from its rules; they are text only and change nothing at runtime, which is
   * why the rule-backed ones (multiplier, discount, events) are not editable.
   */
  customBenefits?: Partial<Record<TierCode, string[]>>;
  perks: { kinds: string[]; pool: Candidate[]; dias: ClassifiedItem[] };
  refLad: ReferralStep[];
  /** Progress granted to a referred client when they join. */
  welcome: number;
  /** How the programme bent to fit the catalogue. Informational, not errors. */
  adapt: string[];
  /** Real problems the centre must resolve before approving. Blocking. */
  review: string[];
  guarantees: Array<[string, boolean]>;
  totalCost: number;
  perkCost: number;
  costPct: number;
  diamondReal: number;
  /** Progress euros actually required at each milestone, after tier multipliers. */
  realTh: Record<number, number>;
}

/** Returned instead of a Program when the catalogue cannot support one. */
export interface EngineError {
  error: string;
  catalog: ClassifiedItem[];
  est?: Estimates;
}

export type EngineResult = Program | EngineError;

export const isEngineError = (result: EngineResult): result is EngineError =>
  (result as EngineError).error !== undefined;
