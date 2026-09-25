import cors from "cors";
import express, { ErrorRequestHandler, RequestHandler } from "express";
import path from "node:path";

import { isAppError } from "./common/errors/app-error";
import { config } from "./config/env";
import { v1Router } from "./routes/v1";

export const buildApp = () => {
  const app = express();

  app.use(express.json());
  app.use(
    cors({
      origin: config.FRONTEND_URL
    })
  );

  app.use(express.static(path.resolve(process.cwd(), "public")));
  app.use("/api/v1", v1Router);

  const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({ message: "Not found" });
  };

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (isAppError(error)) {
      if (!error.expose) {
        console.error(`[${error.code}] ${error.message}`);
      }

      res.status(error.statusCode).json({
        code: error.code,
        message: error.expose ? error.message : "Internal server error"
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Internal server error";

    res.status(500).json({ message });
  };

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
