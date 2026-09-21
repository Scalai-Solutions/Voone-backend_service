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
