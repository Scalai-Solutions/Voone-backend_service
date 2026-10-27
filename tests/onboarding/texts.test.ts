import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { textsSchema } from "../../src/modules/onboarding/onboarding.schema";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { swapReward } from "../../src/modules/onboarding/swap";
import { applyTexts } from "../../src/modules/onboarding/texts";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The texts a centre may edit on a draft: referral names, perk name and description, the label
 * of a milestone reward and of the recurring reward.
 *
 * Pure tests. Generated names are pinned by the other onboarding suites, so these only check
 * what is new: that an override reaches BOTH views the same way, that nothing but text changes,
 * and that a swap cannot leave a stale label behind.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const fresh = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const ok = (program: Program, edits: Parameters<typeof applyTexts>[1]): Program => {
  const result = applyTexts(program, edits);

  if (!result.ok) throw new Error(result.reason);

  return result.program;
};

const perkMilestone = (p: Program) => p.lad.ms.find((m) => m.type === "ventaja" && m.perk)!;

describe("applyTexts", () => {
  it("overwrites a referral name and leaves its items and threshold alone", () => {
    const p = fresh();
    const next = ok(p, { referral: [{ index: 1, name: "Sesión de cortesía" }] });

    expect(next.refLad[1].name).toBe("Sesión de cortesía");
    expect(next.refLad[1].o).toEqual(p.refLad[1].o);
    expect(next.refLad[1].n).toBe(p.refLad[1].n);
    expect(next.refLad[0].name).toBe(p.refLad[0].name);
  });

  it("overwrites a perk's name and description but never its kind", () => {
    const p = fresh();
    const m = perkMilestone(p);
    const next = ok(p, { perks: [{ milestone: m.n, name: "Ventaja nueva", desc: "Texto nuevo" }] });
    const after = next.lad.ms.find((x) => x.n === m.n)!.perk!;

    expect(after.name).toBe("Ventaja nueva");
    expect(after.desc).toBe("Texto nuevo");
    expect(after.kind).toBe(m.perk!.kind);
    expect(after.pool).toEqual(m.perk!.pool);
  });

  it("changes only the field given for a perk", () => {
    const p = fresh();
    const m = perkMilestone(p);
    const next = ok(p, { perks: [{ milestone: m.n, desc: "Solo descripción" }] });
    const after = next.lad.ms.find((x) => x.n === m.n)!.perk!;

    expect(after.name).toBe(m.perk!.name);
    expect(after.desc).toBe("Solo descripción");
  });

  it("sets and clears the label of a reward and of the recurring reward", () => {
    const p = fresh();
    const first = p.chosen[0].m.n;
    const labelled = ok(p, {
      rewards: [{ milestone: first, label: "Mi premio" }],
      recurring: { label: "Mi recurrente" }
    });

    expect(labelled.chosen[0].label).toBe("Mi premio");
    expect(labelled.rec.label).toBe("Mi recurrente");

    const cleared = ok(labelled, {
      rewards: [{ milestone: first, label: null }],
      recurring: { label: null }
    });

    expect(cleared.chosen[0].label).toBeUndefined();
    expect(cleared.rec.label).toBeUndefined();
  });

  it("does not touch the programme it was given", () => {
    const p = fresh();
    const snapshot = JSON.stringify(p);

    ok(p, { referral: [{ index: 0, name: "X" }], recurring: { label: "Y" } });

    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("refuses an unknown referral step, perk or reward milestone, in Spanish", () => {
    const p = fresh();
    const tierUp = p.lad.ms.find((m) => m.type === "nivel")!.n;
    const refusals = [
      applyTexts(p, { referral: [{ index: 99, name: "X" }] }),
      applyTexts(p, { perks: [{ milestone: 9999, name: "X" }] }),
      applyTexts(p, { perks: [{ milestone: tierUp, name: "X" }] }),
      applyTexts(p, { rewards: [{ milestone: 9999, label: "X" }] }),
      applyTexts(p, { rewards: [{ milestone: perkMilestone(p).n, label: "X" }] })
    ];

    for (const r of refusals) {
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toMatch(/^No existe|^Ese hito/);
    }
  });
});

describe("the title is computed once", () => {
  const withEveryText = (p: Program): Program =>
    ok(p, {
      referral: p.refLad.map((_, index) => ({ index, name: `Referido ${index}` })),
      perks: p.lad.ms
        .filter((m) => m.type === "ventaja" && m.perk)
        .map((m) => ({ milestone: m.n, name: `Ventaja ${m.n}`, desc: `Desc ${m.n}` })),
      rewards: p.chosen.map((c) => ({ milestone: c.m.n, label: `Premio ${c.m.n}` })),
      recurring: { label: "Recurrente propio" }
    });

  const titlesFrom = (p: Program) => {
    const view = programView(p);
    const shown = presentProgram(p);

    return {
      viewRewards: view.milestones.filter((m) => m.issue).map((m) => [m.n, m.issue!.title]),
      shownRewards: shown.ladder
        .filter((m) => m.reward || m.perk)
        .map((m) => [m.n, m.reward?.name ?? m.perk!.name]),
      viewRecurring: view.recurring.title,
      shownRecurring: shown.recurring.name,
      viewReferral: view.referral.map((r) => r.title),
      shownReferral: shown.referrals.map((r) => r.name)
    };
  };

  it("gives the same title in the runtime view and the centre view when generated", () => {
    const t = titlesFrom(fresh());

    expect(t.viewRewards).toEqual(t.shownRewards);
    expect(t.viewRecurring).toBe(t.shownRecurring);
    expect(t.viewReferral).toEqual(t.shownReferral);
  });

  it("gives the same title in both views when every text has been edited", () => {
    const edited = withEveryText(fresh());
    const t = titlesFrom(edited);

    expect(t.viewRewards).toEqual(t.shownRewards);
    expect(t.viewRecurring).toBe("Recurrente propio");
    expect(t.shownRecurring).toBe("Recurrente propio");
    expect(t.viewReferral[0]).toBe("Referido 0");
    expect(t.shownReferral[0]).toBe("Referido 0");
    expect(t.viewRewards.every(([, title]) => String(title).match(/^(Premio|Ventaja) /))).toBe(
      true
    );
  });

  it("keeps the edited description in both views", () => {
    const edited = withEveryText(fresh());
    const m = perkMilestone(edited);
    const issue = programView(edited).milestones.find((x) => x.n === m.n)!.issue!;
    const shown = presentProgram(edited).ladder.find((x) => x.n === m.n)!;

    expect(issue.kind === "VENTAJA" && issue.detail.description).toBe(`Desc ${m.n}`);
    expect(shown.perk!.description).toBe(`Desc ${m.n}`);
  });

  it("falls back to the item names when a label is cleared", () => {
    const p = fresh();
    const cleared = ok(withEveryText(p), {
      rewards: p.chosen.map((c) => ({ milestone: c.m.n, label: null })),
      recurring: { label: null }
    });

    expect(presentProgram(cleared).recurring.name).toBe(presentProgram(p).recurring.name);
    expect(programView(cleared).recurring.title).toBe(programView(p).recurring.title);
    const premios = (q: Program) =>
      programView(q)
        .milestones.filter((m) => m.issue?.kind === "PREMIO")
        .map((m) => m.issue!.title);

    expect(premios(cleared)).toEqual(premios(p));
  });

  it("keeps what the rules read intact: reward items and values, perk kind and pool", () => {
    const p = fresh();
    const edited = withEveryText(p);
    const rules = (view: ReturnType<typeof programView>) =>
      view.milestones.map((m) => {
        const d = m.issue?.detail;

        if (!d) return null;

        return "items" in d ? d : { perk: d.perk, pool: d.pool };
      });

    expect(rules(programView(edited))).toEqual(rules(programView(p)));
  });
});

describe("a swap drops the label of what it replaced", () => {
  it("clears the label of the swapped reward and keeps the others", () => {
    const p = fresh();
    const labelled = ok(p, {
      rewards: [
        { milestone: 7, label: "Antes" },
        { milestone: 17, label: "Se queda" }
      ]
    });
    const swapped = swapReward(labelled, ANSWERS, 7, 0);

    expect(swapped.ok).toBe(true);

    const next = (swapped as { program: Program }).program;

    expect(next.chosen.find((c) => c.m.n === 7)!.label).toBeUndefined();
    expect(next.chosen.find((c) => c.m.n === 17)!.label).toBe("Se queda");
    expect(presentProgram(next).ladder.find((m) => m.n === 7)!.reward!.name).not.toBe("Antes");
  });

  it("clears the recurring label when the recurring reward is re-picked", () => {
    const p = fresh();
    const labelled = ok(p, { recurring: { label: "Recurrente propio" } });
    const next = (swapReward(labelled, ANSWERS, 22, 0) as { program: Program }).program;

    expect(next.rec.label).toBeUndefined();
  });

  it("keeps the recurring label when a middle reward is swapped", () => {
    const labelled = ok(fresh(), { recurring: { label: "Recurrente propio" } });
    const next = (swapReward(labelled, ANSWERS, 17, 0) as { program: Program }).program;

    expect(next.rec.label).toBe("Recurrente propio");
  });
});

describe("textsSchema", () => {
  const bad = (body: unknown) => textsSchema.safeParse(body).success;

  it("accepts a normal edit and trims it", () => {
    const parsed = textsSchema.parse({ referral: [{ index: 0, name: "  Hola  " }] });

    expect(parsed.referral![0].name).toBe("Hola");
  });

  it("refuses empty, blank, over-long, control characters and nothing at all", () => {
    expect(bad({ referral: [{ index: 0, name: "   " }] })).toBe(false);
    expect(bad({ referral: [{ index: 0, name: "x".repeat(121) }] })).toBe(false);
    expect(bad({ referral: [{ index: 0, name: "a\u0000b" }] })).toBe(false);
    expect(bad({ referral: [{ index: 0, name: "a\nb" }] })).toBe(false);
    expect(bad({ rewards: [{ milestone: 1, label: "" }] })).toBe(false);
    expect(bad({ perks: [{ milestone: 3 }] })).toBe(false);
    expect(bad({})).toBe(false);
  });

  it("allows 120 characters in a name and 200 in a description, and null to clear a label", () => {
    expect(bad({ referral: [{ index: 0, name: "x".repeat(120) }] })).toBe(true);
    expect(bad({ perks: [{ milestone: 3, desc: "x".repeat(200) }] })).toBe(true);
    expect(bad({ perks: [{ milestone: 3, desc: "x".repeat(201) }] })).toBe(false);
    expect(bad({ rewards: [{ milestone: 1, label: null }] })).toBe(true);
    expect(bad({ recurring: { label: null } })).toBe(true);
  });
});
