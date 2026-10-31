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

const emailOf = (request: Request): string => {
  const parsed = email.safeParse(request.header("x-actor")?.trim());

  if (!parsed.success) {
    throw new ChangeRequestForbiddenError("Falta el usuario que realiza la acción.");
  }

  return parsed.data;
};

/** Owners and managers write tickets for their own centre; nobody else on the clinic side does. */
export const clinicActorOf = (request: Request): ClinicActor => {
  const role = roleOf(request);

  if (role !== "OWNER" && role !== "MANAGER") throw new ChangeRequestForbiddenError();

  return { email: emailOf(request), role };
};

/** Only Voone's own admins act on the admin side. */
export const adminActorOf = (request: Request): AdminActor => {
  if (roleOf(request) !== "VOONE_ADMIN") throw new ChangeRequestForbiddenError();

  return { email: emailOf(request) };
};
