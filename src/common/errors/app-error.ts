export interface AppErrorOptions {
  statusCode: number;
  code: string;
  /**
   * Whether `message` is safe to return to the caller. Validation detail is; anything
   * derived from certificates or key material is not.
   */
  expose: boolean;
  cause?: unknown;
}

export abstract class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  protected constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });

    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.expose = options.expose;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
