import type { Request } from "express";
import { z } from "zod";

import { ChangeRequestForbiddenError } from "../../common/errors/change-request.errors";
import type { AdminActor, ClinicActor } from "./service";

/**
 * Who is calling, as the frontend says. The backend cannot check a session: the staff key
 * proves only that the request came from the Voone app, which sets `x-actor` (the session's
 * email) and `x-actor-role` (its role) itself. The frontend enforces the same rules before it
 * calls, so these checks are the second lock, not the first.
 */

const email = z.string().max(254).email();

const roleOf = (request: Request): string =>
  request.header("x-actor-role")?.trim().toUpperCase() ?? "";

const emailOf = (request: Request, locale: "es" | "en"): string => {
  const parsed = email.safeParse(request.header("x-actor")?.trim());

  if (!parsed.success) {
    throw new ChangeRequestForbiddenError(
      locale === "es"
        ? "Falta el usuario que realiza la acción."
        : "The acting user (x-actor) is missing."
    );
  }

  return parsed.data;
};

const clinicRoleOf = (request: Request): "OWNER" | "MANAGER" => {
  const role = roleOf(request);

  if (role !== "OWNER" && role !== "MANAGER") throw new ChangeRequestForbiddenError();

  return role;
};

/**
 * Owners and managers use tickets for their own centre; nobody else on the clinic side does.
 * For reads: the role alone, because the app sends `x-actor` on writes only.
 */
export const requireClinicReader = (request: Request): void => {
  clinicRoleOf(request);
};

/** For writes: the role and the person, who is recorded on what they write. */
export const clinicActorOf = (request: Request): ClinicActor => {
  const role = clinicRoleOf(request);

  return { email: emailOf(request, "es"), role };
};

const requireAdminRole = (request: Request): void => {
  if (roleOf(request) !== "VOONE_ADMIN") {
    throw new ChangeRequestForbiddenError("Only Voone admins can manage change requests.");
  }
};

/** Only Voone's own admins act on the admin side. For reads: the role alone. */
export const requireAdminReader = (request: Request): void => {
  requireAdminRole(request);
};

/** For writes: the role and the admin's email, recorded as who resolved or replied. */
export const adminActorOf = (request: Request): AdminActor => {
  requireAdminRole(request);

  return { email: emailOf(request, "en") };
};
