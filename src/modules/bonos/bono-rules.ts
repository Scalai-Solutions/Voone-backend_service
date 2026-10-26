/**
 * Pure rules for consuming a bono, kept out of the service so they can be tested without a
 * database. The service owns the transaction; these decide what the transaction must do.
 */

export interface BonoTerms {
  totalSessions: number;
  sessionsUsed: number;
}

/** The 1-based session a visit will record: one past however many are used. */
export const nextBonoSession = (bono: BonoTerms): number => bono.sessionsUsed + 1;

/** Whether a session number is inside the pack at all. */
export const sessionFits = (bono: BonoTerms, session: number): boolean =>
  session >= 1 && session <= bono.totalSessions;

/**
 * The status the bono holds once this session is recorded. COMPLETED exactly when the last
 * session is consumed — never before (a session left is a session to sell) and never after
 * (nothing transitions it back).
 */
export const statusAfterSession = (bono: BonoTerms, session: number): "ACTIVE" | "COMPLETED" =>
  session >= bono.totalSessions ? "COMPLETED" : "ACTIVE";

/** Sessions a member still has once this session is recorded. */
export const remainingAfterSession = (bono: BonoTerms, session: number): number =>
  Math.max(0, bono.totalSessions - session);

export interface BonoOutcomeView {
  id: string;
  name: string;
  /** 1-based, what the member is on: "sesión 3 de 5". */
  session: number;
  total: number;
  remaining: number;
  status: "ACTIVE" | "COMPLETED";
}

/** The visit outcome's bono block, from the terms and the session just recorded. */
export const bonoOutcome = (
  bono: { id: string; name: string } & BonoTerms,
  session: number
): BonoOutcomeView => ({
  id: bono.id,
  name: bono.name,
  session,
  total: bono.totalSessions,
  remaining: remainingAfterSession(bono, session),
  status: statusAfterSession(bono, session)
});
