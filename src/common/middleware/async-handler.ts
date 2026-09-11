import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 only catches synchronous throws — Layer.prototype.handle_request wraps the
 * handler in a plain try/catch and ignores a returned promise. A rejection therefore
 * never reaches the error handler: next is not called, no response is written, and the
 * request hangs until the proxy times out. On an unauthenticated endpoint that is a
 * connection-pool exhaustion vector, so every async route must go through here.
 */
export const asyncHandler =
  (handler: AsyncRequestHandler): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
