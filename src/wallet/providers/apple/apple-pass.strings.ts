/**
 * Labels the clinic template does not supply. `pointsLabel` and `tierLabel` come from
 * ClinicTemplate, so they are deliberately absent here.
 *
 * Spanish strings double as their own localization keys: an unmatched locale falls back to
 * the key, which is already the correct Spanish text, so no default `.lproj` is needed.
 */
export const PASS_LABELS = {
  member: "MIEMBRO",
  credit: "SALDO",
  reward: "PRÓXIMA RECOMPENSA",
  // Short on purpose: it labels a cell on a four-across row, where "NEXT REWARD" is cut to "NEXT REW…".
  remaining: "FALTAN",
  progress: "PROGRESO",
  program: "PROGRAMA",
  benefits: "BENEFICIOS",
  // Replaces BENEFICIOS for a member of a clinic on a programme: the value starts with the tier's
  // name, so the label itself stays static and translatable.
  tierBenefits: "BENEFICIOS DE TU NIVEL",
  info: "INFORMACIÓN",
  memberSince: "MIEMBRO DESDE",
  redemptionCode: "CÓDIGO DE CANJE",
  memberCode: "NÚMERO DE MIEMBRO",
  serialNumber: "NÚMERO DE PASE",
  memberNo: "N.º DE MIEMBRO",
  book: "RESERVAR CITA",
  website: "WEB",
  pointsChangeMessage: "Tu saldo ahora es %@",
  tierChangeMessage: "Ahora eres nivel %@",
  lastMessage: "ÚLTIMO MENSAJE",
  rewards: "REGALOS",
  availableRewards: "RECOMPENSAS DISPONIBLES",
  boost: "PUNTOS DOBLES",
  referral: "RECOMIENDA",
  rewardsChangeMessage: "Tus regalos disponibles: %@",
  // The bare format: the lock-screen notification is the field's own value, which already
  // carries the date, the title and the text of the clinic's message.
  messageChangeMessage: "%@"
} as const;

export const PASS_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    MIEMBRO: "MEMBER",
    SALDO: "BALANCE",
    "PRÓXIMA RECOMPENSA": "NEXT REWARD",
    FALTAN: "TO GO",
    PROGRESO: "PROGRESS",
    PROGRAMA: "PROGRAMME",
    BENEFICIOS: "BENEFITS",
    "BENEFICIOS DE TU NIVEL": "YOUR TIER BENEFITS",
    INFORMACIÓN: "INFORMATION",
    "MIEMBRO DESDE": "MEMBER SINCE",
    "CÓDIGO DE CANJE": "REDEMPTION CODE",
    "NÚMERO DE MIEMBRO": "MEMBER NUMBER",
    "NÚMERO DE PASE": "PASS NUMBER",
    "N.º DE MIEMBRO": "MEMBER NO.",
    "RESERVAR CITA": "BOOK AN APPOINTMENT",
    WEB: "WEBSITE",
    "Tu saldo ahora es %@": "Your balance is now %@",
    "Ahora eres nivel %@": "You are now %@ tier",
    "ÚLTIMO MENSAJE": "LAST MESSAGE",
    REGALOS: "GIFTS",
    "RECOMPENSAS DISPONIBLES": "AVAILABLE REWARDS",
    "PUNTOS DOBLES": "DOUBLE POINTS",
    RECOMIENDA: "REFER A FRIEND",
    "Tus regalos disponibles: %@": "Your available gifts: %@",
    "%@": "%@"
  }
};
