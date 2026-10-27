import type { Program } from "./engine.types";

/**
 * The texts a centre may edit on a draft, applied to a programme.
 *
 * Only words move. A referral step keeps its threshold and items, a perk keeps its kind and
 * pool (the runtime's rules read `perk.kind`, never the text), and a reward keeps its items: its
 * title is an optional label that `rewardTitle` prefers over the one derived from the item names.
 *
 * Pure and all-or-nothing: it returns a new programme, or the first refusal and no programme at
 * all, so a request with one bad index stores none of its edits.
 */
export interface TextEdits {
  /** `index` is the position in the referral ladder, 0-based, as the screen lists it. */
  referral?: Array<{ index: number; name: string }>;
  /** `milestone` is the ladder step number (`n`) of a perk row. */
  perks?: Array<{ milestone: number; name?: string; desc?: string }>;
  /** `milestone` is the ladder step number (`n`) of a reward row. `null` clears the label. */
  rewards?: Array<{ milestone: number; label: string | null }>;
  /** The one reward that repeats after Diamante. `null` clears the label. */
  recurring?: { label: string | null };
}

export type TextsResult = { ok: true; program: Program } | { ok: false; reason: string };

const fail = (reason: string): TextsResult => ({ ok: false, reason });

export const applyTexts = (program: Program, edits: TextEdits): TextsResult => {
  const next = structuredClone(program);

  for (const { index, name } of edits.referral ?? []) {
    const step = next.refLad[index];

    if (!step) return fail("No existe ese paso del programa de referidos.");

    step.name = name;
  }

  for (const { milestone, name, desc } of edits.perks ?? []) {
    const perk = next.lad.ms.find((m) => m.n === milestone && m.type === "ventaja")?.perk;

    if (!perk) return fail("No existe esa ventaja en el programa.");

    if (name !== undefined) perk.name = name;
    if (desc !== undefined) perk.desc = desc;
  }

  for (const { milestone, label } of edits.rewards ?? []) {
    const reward = next.chosen.find((c) => c.m.n === milestone && c.m.type === "premio");

    if (!reward) return fail("Ese hito no tiene un premio cuyo texto se pueda cambiar.");

    if (label === null) delete reward.label;
    else reward.label = label;
  }

  if (edits.recurring) {
    if (edits.recurring.label === null) delete next.rec.label;
    else next.rec.label = edits.recurring.label;
  }

  return { ok: true, program: next };
};
