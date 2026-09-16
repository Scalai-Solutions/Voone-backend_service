import { Router } from "express";

import { healthRouter } from "./health.route";
import { templatesRouter } from "./templates.route";
import { walletTestRouter } from "./wallet-test.route";

export const v1Router = Router();

v1Router.use(healthRouter);
v1Router.use(templatesRouter);

if (process.env.NODE_ENV !== "production") {
  v1Router.use(walletTestRouter);
}
