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
