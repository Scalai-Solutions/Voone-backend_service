/**
 * Spanish labels double as their own localization keys: an unmatched locale falls back to
 * the key, which is already the correct Spanish text, so no default `.lproj` is needed.
 */
export const PASS_LABELS = {
  points: "PUNTOS",
  balance: "BEAUTY BALANCE",
  member: "SOCIA",
  tier: "NIVEL",
  reward: "PRÓXIMA RECOMPENSA",
  progress: "PROGRESO",
  clinic: "CLÍNICA",
  memberSince: "SOCIA DESDE",
  redemptionCode: "CÓDIGO DE CANJE",
  serialNumber: "NÚMERO DE PASE",
  pointsChangeMessage: "Tienes %@ puntos",
  balanceChangeMessage: "Tu Beauty Balance es %@",
  tierChangeMessage: "Ahora eres nivel %@"
} as const;

export const PASS_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    PUNTOS: "POINTS",
    SOCIA: "MEMBER",
    NIVEL: "TIER",
    "PRÓXIMA RECOMPENSA": "NEXT REWARD",
    PROGRESO: "PROGRESS",
    CLÍNICA: "CLINIC",
    "SOCIA DESDE": "MEMBER SINCE",
    "CÓDIGO DE CANJE": "REDEMPTION CODE",
    "NÚMERO DE PASE": "PASS NUMBER",
    "Tienes %@ puntos": "You have %@ points",
    "Tu Beauty Balance es %@": "Your Beauty Balance is %@",
    "Ahora eres nivel %@": "You are now %@ tier"
  }
};
