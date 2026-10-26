export interface AppErrorOptions {
  statusCode: number;
  code: string;
  /**
   * Whether `message` is safe to return to the caller. Validation detail is; anything
   * derived from certificates or key material is not.
   */
  expose: boolean;
  cause?: unknown;
  /**
   * Whether whoever raised it has already logged it, or it needs no log at all (an
   * unconfigured feature). The error handler logs a 5xx AppError once; this stops it
   * repeating a line the origin wrote, so one failure is one error line.
   */
  logged?: boolean;
}

export abstract class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;
  readonly logged: boolean;

  protected constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });

    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.expose = options.expose;
    this.logged = options.logged ?? false;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
