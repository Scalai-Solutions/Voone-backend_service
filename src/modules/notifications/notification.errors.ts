import { AppError } from "../../common/errors/app-error";

export class NotificationValidationError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 400, code: "NOTIFICATION_VALIDATION_FAILED", expose: true });
  }
}

export class NotificationForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, { statusCode: 403, code: "NOTIFICATION_FORBIDDEN", expose: true });
  }
}

export class NotificationNotFoundError extends AppError {
  constructor(message = "Notification not found") {
    super(message, { statusCode: 404, code: "NOTIFICATION_NOT_FOUND", expose: true });
  }
}

export class NotificationRateLimitError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 429, code: "NOTIFICATION_RATE_LIMITED", expose: true });
  }
}