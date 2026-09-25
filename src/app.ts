import cors from "cors";
import express, { RequestHandler } from "express";
import path from "node:path";

import { errorHandler } from "./common/middleware/error-handler";
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
