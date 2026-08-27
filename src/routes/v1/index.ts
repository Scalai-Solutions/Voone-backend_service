import { Router } from "express";

import { healthRouter } from "./health.route";

export const v1Router = Router();

v1Router.use(healthRouter);
