import { Router } from "express";

import { adminClinicsRouter } from "./admin-clinics.route";
import { clinicsRouter } from "./clinics.route";
import { healthRouter } from "./health.route";
import { membersRouter } from "./members.route";
import { templatesRouter } from "./templates.route";
import { walletTestRouter } from "./wallet-test.route";

export const v1Router = Router();

v1Router.use(healthRouter);
v1Router.use(clinicsRouter);
v1Router.use(adminClinicsRouter);
v1Router.use(membersRouter);
v1Router.use(templatesRouter);

if (process.env.NODE_ENV !== "production") {
  v1Router.use(walletTestRouter);
}
