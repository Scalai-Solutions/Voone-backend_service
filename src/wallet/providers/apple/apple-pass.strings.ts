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
  // Short on purpose: it labels a cell on a four-across row, where "NEXT REWARD" is cut to "NEXT REW…".
  remaining: "FALTAN",
  progress: "PROGRESO",
  program: "PROGRAMA",
  benefits: "BENEFICIOS",
  info: "INFORMACIÓN",
  memberSince: "SOCIA DESDE",
  redemptionCode: "CÓDIGO DE CANJE",
  memberCode: "NÚMERO DE SOCIA",
  serialNumber: "NÚMERO DE PASE",
  memberNo: "N.º DE SOCIA",
  book: "RESERVAR CITA",
  website: "WEB",
  pointsChangeMessage: "Tu saldo ahora es %@",
  tierChangeMessage: "Ahora eres nivel %@"
} as const;

export const PASS_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    SOCIA: "MEMBER",
    SALDO: "BALANCE",
    "PRÓXIMA RECOMPENSA": "NEXT REWARD",
    FALTAN: "TO GO",
    PROGRESO: "PROGRESS",
    PROGRAMA: "PROGRAMME",
    BENEFICIOS: "BENEFITS",
    INFORMACIÓN: "INFORMATION",
    "SOCIA DESDE": "MEMBER SINCE",
    "CÓDIGO DE CANJE": "REDEMPTION CODE",
    "NÚMERO DE SOCIA": "MEMBER NUMBER",
    "NÚMERO DE PASE": "PASS NUMBER",
    "N.º DE SOCIA": "MEMBER NO.",
    "RESERVAR CITA": "BOOK AN APPOINTMENT",
    WEB: "WEBSITE",
    "Tu saldo ahora es %@": "Your balance is now %@",
    "Ahora eres nivel %@": "You are now %@ tier"
  }
};
