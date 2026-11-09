/**
 * The engine settings of the partners' original programme: Plata three visits in, three rewards
 * before it, every level at least half as dear again as the last, and never a repeated gift to
 * put the best Bronce reward first ("keep-order").
 *
 * The engine has since been tuned on purpose (see P in engine.config.ts and tuning.test.ts). A
 * suite whose subject is something other than the shape of the ladder, or that checks the
 * algorithm against the guide's published numbers, pins these settings with
 *
 *   vi.mock("<path>/src/modules/onboarding/engine.config", referenceTuningMock);
 *
 * so its expectations keep meaning what they say. The tuned defaults are asserted in
 * tuning.test.ts.
 */
export const REFERENCE_TUNING = {
  premiosFirstTramo: 3,
  minGrowth: 1.5,
  visitsSilver: 3,
  bronceLead: "keep-order"
} as const;

export const referenceTuningMock = async (
  importOriginal: () => Promise<typeof import("../../src/modules/onboarding/engine.config")>
) => {
  const actual = await importOriginal();

  return { ...actual, P: { ...actual.P, ...REFERENCE_TUNING } };
};
