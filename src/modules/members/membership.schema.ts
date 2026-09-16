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
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

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
    consentMarketing: z.boolean("Indica si aceptas recibir comunicaciones comerciales")
  })
  // Flattened here rather than in the service so the parsed value is already shaped like
  // the row it becomes, and the raw submission cannot be dropped by a forgetful caller.
  .transform(({ name, phone, consentMarketing }) => ({
    name,
    phone: phone.e164,
    phoneRaw: phone.raw,
    phoneRegionAssumed: phone.regionAssumed,
    consentMarketing
  }));

export type MembershipSignupInput = z.infer<typeof membershipSignupSchema>;
