import { AutomationEvent, NotificationType } from "@prisma/client";

/** Clinic-level values an automation can depend on; stored on ClinicNotificationSettings. */
export type ClinicVariableKey = "googleReviewUrl" | "referralRewardText";

export type TemplateVariable =
  | "first_name"
  | "clinic_name"
  | "google_maps_link"
  | "referral_reward"
  | "new_tier"
  | "benefits_summary";

export interface AutomationDefinition {
  event: AutomationEvent;
  /** The Notification.type rows of this automation are stored under. */
  notificationType: NotificationType;
  /** Shown to clinic staff. */
  label: string;
  description: string;
  /** Variables the copy may use; any other {name} is rejected on save. */
  variables: readonly TemplateVariable[];
  /** Marketing sends need consent and the clinic's marketing switch; service messages do not. */
  marketing: boolean;
  /** Clinic settings that must be filled in before the automation can be switched on. */
  requires?: ClinicVariableKey;
  /** Default copy and switch for a clinic that has never edited this automation. */
  defaults: { enabled: boolean; header: string; body: string; notify: boolean };
}

/**
 * The single source of truth for automated messages. Defaults, validation, the settings API,
 * the dispatcher registry's lookups and the frontend cards all derive from this list, so a new
 * event is one entry here plus (for a scheduled one) one trigger file.
 */
export const AUTOMATION_CATALOG: readonly AutomationDefinition[] = [
  {
    event: AutomationEvent.BIRTHDAY,
    notificationType: NotificationType.BIRTHDAY,
    label: "Cumpleaños",
    description: "Felicita a tus clientes el día de su cumpleaños.",
    variables: ["first_name", "clinic_name"],
    marketing: true,
    defaults: {
      enabled: true,
      header: "¡Feliz cumpleaños!",
      body: "¡Feliz cumpleaños! Disfruta de un 10% de descuento en nuestros servicios. Esperamos verte pronto.",
      notify: true
    }
  },
  {
    event: AutomationEvent.BONO_INACTIVE,
    notificationType: NotificationType.BONO_REMINDER,
    label: "Recordatorio de bonos",
    description: "Avisa a quien lleva 30 días sin usar las sesiones de su bono.",
    variables: ["first_name", "clinic_name"],
    marketing: false,
    defaults: {
      enabled: true,
      header: "¡No olvides tu tratamiento! 💆‍♀️",
      body: "Hola {first_name}, hace un mes que no usas las sesiones de tu bono en {clinic_name}. Recuerda que la constancia es la clave para obtener los mejores resultados. ¡Reserva tu próxima sesión hoy!",
      notify: true
    }
  },
  {
    event: AutomationEvent.REVIEW_REQUEST,
    notificationType: NotificationType.REVIEW_REQUEST,
    label: "Reseña en Google",
    description: "Pide una valoración en Google tras la segunda visita.",
    variables: ["first_name", "clinic_name", "google_maps_link"],
    marketing: true,
    requires: "googleReviewUrl",
    defaults: {
      enabled: false,
      header: "¿Qué tal tu experiencia en {clinic_name}? ⭐",
      body: "¡Hola {first_name}! Gracias por confiar de nuevo en nosotros. Tu opinión es fundamental para seguir mejorando. ¿Nos dejarías una valoración de 5 estrellas en Google? {google_maps_link}",
      notify: true
    }
  },
  {
    event: AutomationEvent.REFERRAL_PROMO,
    notificationType: NotificationType.REFERRAL_PROMO,
    label: "Programa de referidos",
    description: "Cada mes, recuerda a tus clientes activos que pueden compartir su código.",
    variables: ["first_name", "clinic_name", "referral_reward"],
    marketing: true,
    requires: "referralRewardText",
    defaults: {
      enabled: false,
      header: "¡Comparte la experiencia y gana! 🎁",
      body: "¡Hola {first_name}! Recuerda que por cada amigo o familiar que venga de tu parte, ambos recibiréis {referral_reward}. ¡Comparte tu código de referido desde la app y empieza a sumar ventajas!",
      notify: true
    }
  },
  {
    event: AutomationEvent.TIER_UPGRADE,
    notificationType: NotificationType.TIER,
    label: "Subida de nivel",
    description: "Celebra al instante cuando un cliente sube de nivel.",
    variables: ["first_name", "clinic_name", "new_tier", "benefits_summary"],
    marketing: false,
    defaults: {
      enabled: true,
      header: "¡Enhorabuena! Has subido al nivel {new_tier} 🏆",
      body: "¡Felicidades, {first_name}! Has alcanzado el nivel {new_tier}. A partir de hoy disfrutas de ventajas exclusivas como: {benefits_summary}. ¡Gracias por confiar en nosotros!",
      notify: true
    }
  }
];

const BY_EVENT = new Map(AUTOMATION_CATALOG.map((definition) => [definition.event, definition]));

export const automationDefinition = (event: AutomationEvent): AutomationDefinition => {
  const definition = BY_EVENT.get(event);

  if (!definition) throw new Error(`Unknown automation event ${event}`);

  return definition;
};

/** Notification types written by automations, for reporting. */
export const AUTOMATION_NOTIFICATION_TYPES: readonly NotificationType[] = AUTOMATION_CATALOG.map(
  (definition) => definition.notificationType
);
