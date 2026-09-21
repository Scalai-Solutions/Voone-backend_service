import { z } from "zod";

import { MEMBER_NAME_MAX, MEMBER_NAME_MIN, cleanMemberName, isPlausibleName } from "./member-name";
import { normalizeSpanishMobile } from "./phone-es";

/**
 * Lowercase, hyphen-separated, no leading, trailing or doubled hyphen. Rejects path
 * traversal, uppercase (Postgres unique is case-sensitive, and a slug is typed off a
 * poster), and Cyrillic homoglyphs before any of it reaches a query.
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

const NAME_INVALID = "Introduce tu nombre y apellidos";
const NAME_TOO_LONG = "El nombre es demasiado largo";

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

    // Mandatory field, free value. Membership itself rests on performance of a contract,
    // so requiring `true` here would condition sign-up on marketing consent — which is the
    // bundling GDPR Art 7(4) forbids. Requiring the field is what proves the member made
    // an affirmative choice rather than that we assumed one on their behalf.
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
     * Year of birth, not an age.
     *
     * An age is wrong within a year of being stored and nothing here would ever correct
     * it, so the form asks for a year and the dashboard derives the age when it needs
     * one. Optional: the field is new, and refusing a sign-up over it would cost a
     * member to gain a demographic.
     *
     * The bounds are sanity, not policy — 120 years back, and nothing in the future.
     * Anyone genuinely younger than the lower bound is a data-protection question for
     * the clinic, not a validation one for this form.
     */
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
    consentSource: signupSourceSchema.optional()
  })
  // Flattened here rather than in the service so the parsed value is already shaped like
  // the row it becomes, and the raw submission cannot be dropped by a forgetful caller.
  .transform(({ name, phone, email, birthYear, sex, consentMarketing, consentSource }) => ({
    name,
    email,
    phone: phone.e164,
    phoneRaw: phone.raw,
    phoneRegionAssumed: phone.regionAssumed,
    birthYear,
    sex,
    consentMarketing,
    consentSource
  }));

export type MembershipSignupInput = z.infer<typeof membershipSignupSchema>;
