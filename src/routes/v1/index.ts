import { Router } from "express";

import { clinicsRouter } from "./clinics.route";
import { healthRouter } from "./health.route";
import { membersRouter } from "./members.route";

export const v1Router = Router();

v1Router.use(healthRouter);
v1Router.use(clinicsRouter);
v1Router.use(membersRouter);
