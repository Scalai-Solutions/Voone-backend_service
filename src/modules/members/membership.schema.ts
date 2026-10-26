import { z } from "zod";

import { MEMBER_NAME_MAX, MEMBER_NAME_MIN, cleanMemberName, isPlausibleName } from "./member-name";
import { normalizeSpanishMobile } from "./phone-es";

/**
 * A slug ARRIVING from a poster, which is a different question from a slug being created.
 *
 * Deliberately still permissive: lowercase, hyphen-separated, up to 64 characters. New
 * clinics get a five-character slug (see newClinicSlugSchema), but the clinics
 * provisioned before that have long ones printed on posters hanging in their waiting
 * rooms. Narrowing this schema to five would 404 every one of those.
 *
 * So this one only ever widens. It rejects path traversal, uppercase (Postgres unique is
 * case-sensitive, and a slug is typed off a poster) and Cyrillic homoglyphs before any of
 * it reaches a query — nothing about length.
 */
export const clinicSlugSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    // Surfaces to an operator in the provisioning form. Zod's default dumps the pattern,
    // which is noise to someone typing a clinic name; when this schema only ever saw slugs
    // from a URL the message was never read by anyone.
    "Usa minúsculas, números y guiones (por ejemplo: clinica-nova)"
  );

/**
 * A slug being CREATED for a new clinic. Exactly five characters, and the authority.
 *
 * It is printed on a QR poster and typed off that poster by hand, so length is the whole
 * point: `voone.ai/alta/k7m2q` can be read across a reception desk and
 * `voone.ai/alta/clinica-aurea` cannot.
 *
 * No hyphens, because a separator inside five characters only costs legibility. The
 * alphabet is wider than the generator's — the generator avoids i/l/o/0/1 so its output
 * survives being read aloud, but an operator who deliberately types one of those for a
 * clinic that wants a recognisable slug is making a choice, not a mistake, and nothing
 * downstream cares.
 */
export const newClinicSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9]{5}$/,
    "El identificador debe tener exactamente 5 caracteres: minúsculas y números (por ejemplo: k7m2q)"
  );

/** Kept in step with SignupSource in membership.service.ts. */
export const signupSourceSchema = z.enum(
  ["qr_signup", "staff_entry"],
  // Spanish like every other message on this endpoint, and deliberately does not list the
  // accepted values: no member ever sees this — the field is set by code, not typed — so
  // there is nobody to help, and the enum is the shape of an internal surface.
  "Origen de alta no válido"
);

/**
 * Kept in step with the options the sign-up form renders.
 *
 * Not a database enum: "prefiero no decirlo" must be answerable, and widening a Postgres
 * enum is a migration — a poor reason to leave a member unable to answer honestly.
 */
export const memberSexSchema = z.enum(
  ["mujer", "hombre", "otro", "prefiero_no_decirlo"],
  "Selecciona una opción válida"
);

export type MemberSex = z.infer<typeof memberSexSchema>;

/**
 * Read once at module load rather than per request. A process running across New Year
 * would reject that year's birthdays until restart, which is a trade worth naming: the
 * alternative is a clock read on every sign-up to move a sanity bound by one.
 */
const CURRENT_YEAR = new Date().getUTCFullYear();

/**
 * The youngest member the programme accepts. Enforced wherever a full date of birth
 * arrives, so the public form's gate and the API's cannot drift apart. birthYear (a bare
 * year from the old form) cannot prove an exact age and is left alone.
 */
const MIN_MEMBER_AGE = 16;

const NAME_INVALID = "Introduce tu nombre y apellidos";
const NAME_TOO_LONG = "El nombre es demasiado largo";
const BIRTH_DATE_REQUIRED_MESSAGE = "Introduce tu fecha de nacimiento.";
const SEX_REQUIRED_MESSAGE = "Selecciona una opción.";
const MARKETING_CONSENT_REQUIRED_MESSAGE =
  "Debes aceptar recibir novedades y ofertas para unirte.";
const UNDERAGE_MESSAGE = "Debes tener al menos 16 años para unirte.";

/**
 * A YYYY-MM-DD string to a UTC Date, refusing impossible, future and under-16 dates.
 *
 * Shared by the sign-up schema and the member editor so the age gate cannot drift between
 * the two surfaces that collect a date of birth.
 */
export const birthDateFromInput = (
  value: string,
  ctx: { addIssue: (issue: { code: "custom"; message: string }) => void }
): Date => {
  const date = new Date(`${value}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const normalized = date.toISOString().slice(0, 10);

  if (
    normalized !== value ||
    year < CURRENT_YEAR - 120 ||
    year > CURRENT_YEAR ||
    date.getTime() > Date.now()
  ) {
    ctx.addIssue({ code: "custom", message: "Introduce una fecha de nacimiento válida" });

    return z.NEVER;
  }

  // Read per request rather than once at module load: 16 years is a moving boundary the
  // CURRENT_YEAR sanity bound deliberately freezes, but one day of error at the age gate
  // would wrongly refuse a member on their birthday.
  const sixteenYearsAgo = new Date();
  sixteenYearsAgo.setUTCFullYear(sixteenYearsAgo.getUTCFullYear() - MIN_MEMBER_AGE);

  if (date > sixteenYearsAgo) {
    ctx.addIssue({ code: "custom", message: UNDERAGE_MESSAGE });

    return z.NEVER;
  }

  return date;
};

/**
 * The sign-up form contract. Messages are Spanish because the form renders them verbatim;
 * the machine-readable half is the error `code` on the thrown AppError.
 *
 * Normalization lives here rather than in the service so that no caller can forget it:
 * the parsed output is already canonical and the raw strings cannot reach the database.
 */
export const membershipSignupSchema = z
  .object({
    name: z
      .string(NAME_INVALID)
      // Bounded before cleaning so a megabyte of whitespace is rejected, not normalized.
      .max(200, NAME_TOO_LONG)
      .transform(cleanMemberName)
      .superRefine((name, ctx) => {
        if (name.length > MEMBER_NAME_MAX) {
          ctx.addIssue({ code: "custom", message: NAME_TOO_LONG });

          return;
        }

        if (name.length < MEMBER_NAME_MIN || !isPlausibleName(name)) {
          ctx.addIssue({ code: "custom", message: NAME_INVALID });
        }
      }),

    phone: z
      .string("Introduce tu número de móvil")
      .max(32, "El número de teléfono es demasiado largo")
      .transform((value, ctx) => {
        const normalized = normalizeSpanishMobile(value);

        if (normalized === null) {
          ctx.addIssue({ code: "custom", message: "Introduce un móvil español válido" });

          return z.NEVER;
        }

        return normalized;
      }),

    // Mandatory field. The value stays free in the schema because staff cannot give
    // consent on a client's behalf; the public sign-up route requires `true` (2026-10
    // product decision, see qrSignupRequirementMissing). That does condition sign-up on
    // marketing consent — the GDPR Art 7(4) bundling the original design avoided — and is
    // the clinic's call to make, recorded here so the tension is not lost.
    //
    // Never z.coerce.boolean(): it turns the string "false" into true and fabricates
    // consent for every member whose form serializes booleans as strings.
    /**
     * Optional additional contact. The phone is the identity — it is what the unique index
     * and the programme's SMS depend on — so an email never replaces it, only supplements
     * it. Lowercased because addresses are case-insensitive in practice and storing two
     * spellings of one address would defeat any future lookup.
     */
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, "El email es demasiado largo")
      .pipe(z.string().email("Introduce un email válido"))
      .optional(),

    consentMarketing: z.boolean("Indica si aceptas recibir comunicaciones comerciales"),

    /**
     * Acceptance of the processing of personal data, ticked by the person on the QR form. Optional
     * in the schema because staff-entered members are not asked; the public sign-up route refuses
     * a submission without it (founders' E2E item 44).
     */
    acceptedPrivacy: z.boolean().optional(),

    /**
     * Full date of birth, captured going forward so age can be derived accurately.
     * Optional in the schema because staff entry does not ask for it; the public sign-up
     * route requires it (see qrSignupRequirementMissing) and refuses anyone under 16.
     * birthYear remains accepted only for older clients and is converted to a fallback.
     */
    birthDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Introduce una fecha de nacimiento válida")
      .transform(birthDateFromInput)
      .optional(),

    birthYear: z.coerce
      .number("Introduce un año de nacimiento válido")
      .int("Introduce un año de nacimiento válido")
      .min(CURRENT_YEAR - 120, "Introduce un año de nacimiento válido")
      .max(CURRENT_YEAR, "El año de nacimiento no puede estar en el futuro")
      .optional(),

    /**
     * Self-declared, from a small set that includes declining to answer.
     *
     * "prefer not to say" is a first-class answer rather than an absent field: a member
     * who chose not to say is a different fact from one who was never asked, and
     * segmentation that conflates them would quietly under-count.
     */
    sex: memberSexSchema.optional(),

    /**
     * How the member was collected. Optional over HTTP, where the route supplies the
     * default, and never defaulted in the service — a member entered at reception by
     * staff must not be recorded as having signed themselves up through the QR form,
     * because that is the difference between consent the member gave and consent
     * recorded on their behalf.
     *
     * Spoofable, like everything else on an unauthenticated endpoint: a caller can claim
     * either value for a row they are creating anyway. It becomes trustworthy when the
     * staff surface gets authentication, and is honest for legitimate callers meanwhile.
     */
    consentSource: signupSourceSchema.optional(),

    /**
     * The five-character code of the member who recommended this one.
     *
     * Deliberately lenient: it is trimmed and length-bounded and nothing more, because it is
     * never an error. A mistyped or unknown code is ignored silently at sign-up, both so it
     * cannot cost someone their membership and so the response cannot be used to find out
     * which codes exist.
     */
    referredByCode: z.string().trim().max(10).optional()
  })
  // Flattened here rather than in the service so the parsed value is already shaped like
  // the row it becomes, and the raw submission cannot be dropped by a forgetful caller.
  .transform(
    ({
      name,
      phone,
      email,
      birthDate,
      birthYear,
      sex,
      consentMarketing,
      acceptedPrivacy,
      consentSource,
      referredByCode
    }) => ({
      name,
      email,
      phone: phone.e164,
      phoneRaw: phone.raw,
      phoneRegionAssumed: phone.regionAssumed,
      birthDate,
      birthYear: birthDate ? birthDate.getUTCFullYear() : birthYear,
      sex,
      consentMarketing,
      // Only present when ticked, so the parsed shape stays what it was for staff-entered members.
      ...(acceptedPrivacy === true ? { acceptedPrivacy: true } : {}),
      consentSource,
      // Only present when given, so the parsed shape stays what it was for everyone else.
      ...(referredByCode ? { referredByCode } : {})
    })
  );

export type MembershipSignupInput = z.infer<typeof membershipSignupSchema>;

/**
 * A person signing themselves up through the QR form has to accept the processing of their data
 * before a pass exists (founders' E2E item 44). Staff-entered members are not asked: staff cannot
 * accept on someone's behalf, and that provenance is recorded separately.
 */
export const PRIVACY_REQUIRED_MESSAGE =
  "Debes aceptar el tratamiento de tus datos personales para unirte.";

export const privacyAcceptanceMissing = (
  input: { acceptedPrivacy?: boolean },
  source: "qr_signup" | "staff_entry"
): boolean => source === "qr_signup" && !input.acceptedPrivacy;

/**
 * What the QR form asks that the staff form does not (2026-10 product decision): the
 * member fills in everything up front, so a self sign-up is refused over the first
 * missing requirement. Staff entry is exempt — staff cannot tick a consent box or answer
 * a demographic on the client's behalf.
 */
export const qrSignupRequirementMissing = (
  input: { birthDate?: Date; sex?: MemberSex; consentMarketing?: boolean },
  source: "qr_signup" | "staff_entry"
): string | null => {
  if (source !== "qr_signup") return null;
  if (!input.birthDate) return BIRTH_DATE_REQUIRED_MESSAGE;
  if (!input.sex) return SEX_REQUIRED_MESSAGE;
  if (input.consentMarketing !== true) return MARKETING_CONSENT_REQUIRED_MESSAGE;

  return null;
};

/**
 * Editing a member. Every field is optional — absent means unchanged — and `null` clears
 * where the column allows it. It shares the sign-up pipelines (name cleaning, the phone
 * normalizer, the 16-and-over gate) so the two surfaces cannot drift.
 *
 * Consent fields and provenance are deliberately absent: staff cannot consent on a
 * client's behalf, and how a member was collected is a fact about their sign-up, not an
 * editable preference.
 */
export const memberUpdateSchema = z
  .object({
    name: z
      .string(NAME_INVALID)
      .max(200, NAME_TOO_LONG)
      .transform(cleanMemberName)
      .superRefine((name, ctx) => {
        if (name.length > MEMBER_NAME_MAX) {
          ctx.addIssue({ code: "custom", message: NAME_TOO_LONG });

          return;
        }

        if (name.length < MEMBER_NAME_MIN || !isPlausibleName(name)) {
          ctx.addIssue({ code: "custom", message: NAME_INVALID });
        }
      })
      .optional(),
    phone: z
      .string("Introduce tu número de móvil")
      .max(32, "El número de teléfono es demasiado largo")
      .transform((value, ctx) => {
        const normalized = normalizeSpanishMobile(value);

        if (normalized === null) {
          ctx.addIssue({ code: "custom", message: "Introduce un móvil español válido" });

          return z.NEVER;
        }

        return normalized;
      })
      .nullish(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, "El email es demasiado largo")
      .pipe(z.string().email("Introduce un email válido"))
      .nullish(),
    birthDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Introduce una fecha de nacimiento válida")
      .transform(birthDateFromInput)
      .nullish(),
    sex: memberSexSchema.nullish()
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.phone !== undefined ||
      patch.email !== undefined ||
      patch.birthDate !== undefined ||
      patch.sex !== undefined,
    { message: "No hay nada que cambiar" }
  );

export type MemberUpdateInput = z.infer<typeof memberUpdateSchema>;
