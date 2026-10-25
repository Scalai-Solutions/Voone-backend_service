import { AppError } from "./app-error";

/**
 * No template with that id, or one that belongs to a different clinic.
 *
 * The two are deliberately one answer. A 403 for someone else's template would confirm the
 * id is real, and ids are the only thing standing between one clinic and another's card
 * design. Not exposed: the id is ours.
 */
export class TemplateNotFoundError extends AppError {
  constructor(templateId: string) {
    super(`Template "${templateId}" not found`, {
      statusCode: 404,
      code: "TEMPLATE_NOT_FOUND",
      expose: false
    });
  }
}
