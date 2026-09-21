/**
 * Labels the clinic template does not supply. `pointsLabel` and `tierLabel` come from
 * ClinicTemplate, so they are deliberately absent here.
 *
 * Spanish strings double as their own localization keys: an unmatched locale falls back to
 * the key, which is already the correct Spanish text, so no default `.lproj` is needed.
 */
export const PASS_LABELS = {
  member: "SOCIA",
  credit: "SALDO",
  reward: "PRÓXIMA RECOMPENSA",
  progress: "PROGRESO",
  program: "PROGRAMA",
  benefits: "BENEFICIOS",
  info: "INFORMACIÓN",
  memberSince: "SOCIA DESDE",
  redemptionCode: "CÓDIGO DE CANJE",
  serialNumber: "NÚMERO DE PASE",
  pointsChangeMessage: "Tu saldo ahora es %@",
  tierChangeMessage: "Ahora eres nivel %@"
} as const;

export const PASS_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    SOCIA: "MEMBER",
    SALDO: "BALANCE",
    "PRÓXIMA RECOMPENSA": "NEXT REWARD",
    PROGRESO: "PROGRESS",
    PROGRAMA: "PROGRAMME",
    BENEFICIOS: "BENEFITS",
    INFORMACIÓN: "INFORMATION",
    "SOCIA DESDE": "MEMBER SINCE",
    "CÓDIGO DE CANJE": "REDEMPTION CODE",
    "NÚMERO DE PASE": "PASS NUMBER",
    "Tu saldo ahora es %@": "Your balance is now %@",
    "Ahora eres nivel %@": "You are now %@ tier"
  }
};
