import { AppError } from "./app-error";

/** Signing material is missing, malformed, or internally inconsistent. */
export class WalletConfigurationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 503, code: "WALLET_NOT_CONFIGURED", expose: false, cause });
  }
}

/** The caller supplied loyalty data that does not satisfy the pass schema. */
export class WalletPassDataError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 422, code: "WALLET_PASS_DATA_INVALID", expose: true, cause });
  }
}

/** Building or signing the pass bundle failed. */
export class WalletPassSigningError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 500, code: "WALLET_PASS_SIGNING_FAILED", expose: false, cause });
  }
}

/**
 * A provider rejected or could not receive an update.
 *
 * 502 rather than 500: the failure is downstream, and the distinction is what tells an
 * operator to look at Apple or Google rather than at us. Never exposed — the cause can
 * carry a provider payload, and those have been known to echo member data back.
 */
export class WalletSyncError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { statusCode: 502, code: "WALLET_SYNC_FAILED", expose: false, cause });
  }
}

export type WalletNotificationErrorCode =
  "QUOTA_EXCEEDED" | "NOT_FOUND" | "AUTH_ERROR" | "TRANSIENT" | "NOT_IMPLEMENTED";

export class WalletNotificationError extends AppError {
  constructor(message: string, code: WalletNotificationErrorCode, cause?: unknown) {
    const statusCode =
      code === "QUOTA_EXCEEDED"
        ? 429
        : code === "NOT_FOUND"
          ? 404
          : code === "AUTH_ERROR"
            ? 502
            : code === "NOT_IMPLEMENTED"
              ? 501
              : 503;

    super(message, { statusCode, code: `WALLET_NOTIFICATION_${code}`, expose: false, cause });
  }
}

export class WalletNotificationQuotaExceededError extends WalletNotificationError {
  constructor(message = "Google Wallet notification quota exceeded", cause?: unknown) {
    super(message, "QUOTA_EXCEEDED", cause);
  }
}

export class WalletNotificationNotFoundError extends WalletNotificationError {
  constructor(message = "Wallet notification target was not found", cause?: unknown) {
    super(message, "NOT_FOUND", cause);
  }
}

export class WalletNotificationAuthError extends WalletNotificationError {
  constructor(message = "Wallet provider rejected notification credentials", cause?: unknown) {
    super(message, "AUTH_ERROR", cause);
  }
}

export class WalletNotificationTransientError extends WalletNotificationError {
  constructor(message = "Wallet notification provider temporarily failed", cause?: unknown) {
    super(message, "TRANSIENT", cause);
  }
}

export class WalletNotificationNotImplementedError extends WalletNotificationError {
  constructor(message = "Wallet notification method is not implemented", cause?: unknown) {
    super(message, "NOT_IMPLEMENTED", cause);
  }
}
