import cors from "cors";
import express, { ErrorRequestHandler, RequestHandler } from "express";

import { isAppError } from "./common/errors/app-error";
import { config } from "./config/env";
import { v1Router } from "./routes/v1";

export const buildApp = () => {
  const app = express();

  // Nothing should advertise the framework; for a JSON API this is most of what a
  // security-header package would add.
  app.disable("x-powered-by");

  // A two field form needs nothing near body-parser's 100kb default, and parsing
  // attacker-chosen JSON synchronously on an unauthenticated endpoint is a free CPU
  // amplifier.
  app.use(express.json({ limit: "8kb" }));

  // body-parser rejects a bad body with an http-errors object carrying a 4xx status:
  // 400 for malformed JSON, 413 for one over the limit, 415 for an encoding it cannot
  // read. Mounted here, immediately after the parser, so all of them are reported as the
  // client's mistake rather than falling through to the 500 at the bottom of the stack —
  // which would also log a full stack trace for what is routine abuse traffic.
  const bodyParserErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
    const code = typeof status === "number" ? status : undefined;

    if (code === undefined || code < 400 || code >= 500) {
      next(error);

      return;
    }

    if (code === 413) {
      res.status(413).json({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });

      return;
    }

    res.status(code).json({ code: "BAD_REQUEST", message: "Invalid request body" });
  };

  app.use(bodyParserErrorHandler);
  app.use(
    cors({
      origin: config.FRONTEND_URL
    })
  );

  app.use("/api/v1", v1Router);

  const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({ message: "Not found" });
  };

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    // Raw error messages are never returned: certificate and signing failures carry file
    // paths and crypto detail that must not reach a caller. Only errors that explicitly
    // mark themselves safe to expose have their message sent.
    if (isAppError(error)) {
      if (!error.expose) {
        console.error(error);
      }

      res.status(error.statusCode).json({
        code: error.code,
        message: error.expose ? error.message : "Internal server error"
      });

      return;
    }

    console.error(error);

    res.status(500).json({ message: "Internal server error" });
  };

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
