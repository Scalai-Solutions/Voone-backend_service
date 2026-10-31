import type { PrismaClient } from "@prisma/client";

import { config } from "../../../config/env";
import type { AutomationDispatchService } from "./dispatch.service";
import { NotificationDispatcher } from "./dispatcher";
import { BirthdayTrigger } from "./triggers/birthday.trigger";
import { BonoInactiveTrigger } from "./triggers/bono-inactive.trigger";
import { ReferralPromoTrigger } from "./triggers/referral-promo.trigger";
import { ReviewRequestTrigger } from "./triggers/review-request.trigger";
import type { ScheduledTrigger } from "./triggers/types";

/** The scheduled automations. Register a new trigger here and nowhere else. */
export const buildScheduledTriggers = (prisma: PrismaClient): ScheduledTrigger[] => [
  new BirthdayTrigger(prisma),
  ...(config.BONO_REMINDER_CRON_ENABLED ? [new BonoInactiveTrigger(prisma)] : []),
  new ReviewRequestTrigger(prisma),
  new ReferralPromoTrigger(prisma, config.REFERRAL_PUSH_DAY_OF_MONTH)
];

export const buildNotificationDispatcher = (
  prisma: PrismaClient,
  sender: AutomationDispatchService
): NotificationDispatcher =>
  new NotificationDispatcher(prisma, sender, buildScheduledTriggers(prisma));
