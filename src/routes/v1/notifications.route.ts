import { Router, type Request } from "express";
import type { ZodType } from "zod";

import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import { config } from "../../config/env";
import {
  NotificationForbiddenError,
  NotificationValidationError
} from "../../modules/notifications/notification.errors";
import type { NotificationActor, NotificationService } from "../../modules/notifications/notification.service";
import {
  clinicLocationsSchema,
  notificationListQuerySchema,
  notificationMessageSchema,
  notificationSettingsSchema,
  segmentNotificationSchema
} from "../../modules/notifications/notifications.schema";

export interface NotificationsRouterDeps {
  notifications: NotificationService;
}

const parse = <T>(schema: ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new NotificationValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }

  return parsed.data;
};

const actorFrom = (req: Request): NotificationActor => {
  const role = req.get("x-voone-role")?.trim().toUpperCase();
  const clinicId = req.get("x-voone-clinic-id")?.trim();
  const userId = req.get("x-voone-user-id")?.trim();

  if (!role) {
    throw new NotificationForbiddenError("Missing staff session role");
  }

  return { role, clinicId, userId };
};

const idempotencyKey = (req: Request): string | undefined =>
  req.get("Idempotency-Key")?.trim() || undefined;

const serializeNotification = (notification: { id: string; status: string }) => ({
  notificationId: notification.id,
  status: notification.status
});

export const createNotificationsRouter = (deps: NotificationsRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);

  router.post(
    "/clinics/:clinicId/notifications/broadcast",
    requireStaff,
    asyncHandler(async (req, res) => {
      const input = parse(notificationMessageSchema, req.body);
      const notification = await deps.notifications.broadcast(
        req.params.clinicId,
        input,
        actorFrom(req),
        idempotencyKey(req)
      );

      res.status(202).json(serializeNotification(notification));
    })
  );

  router.post(
    "/clinics/:clinicId/notifications/segment",
    requireStaff,
    asyncHandler(async (req, res) => {
      const input = parse(segmentNotificationSchema, req.body);
      const notification = await deps.notifications.segment(
        req.params.clinicId,
        input,
        actorFrom(req),
        idempotencyKey(req)
      );

      res.status(202).json(serializeNotification(notification));
    })
  );

  router.post(
    "/members/:memberId/notifications",
    requireStaff,
    asyncHandler(async (req, res) => {
      const input = parse(notificationMessageSchema.omit({ scheduledAt: true }), req.body);
      const notification = await deps.notifications.single(
        req.params.memberId,
        input,
        actorFrom(req),
        idempotencyKey(req)
      );

      res.status(202).json(serializeNotification(notification));
    })
  );

  router.get(
    "/clinics/:clinicId/notifications",
    requireStaff,
    asyncHandler(async (req, res) => {
      const filters = parse(notificationListQuerySchema, req.query);

      res.json(await deps.notifications.list(req.params.clinicId, filters, actorFrom(req)));
    })
  );

  router.get(
    "/notifications/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.notifications.get(req.params.id, actorFrom(req)));
    })
  );

  router.delete(
    "/notifications/:id",
    requireStaff,
    asyncHandler(async (req, res) => {
      await deps.notifications.delete(req.params.id, actorFrom(req));

      res.status(204).send();
    })
  );

  router.get(
    "/members/:memberId/notification-quota",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.notifications.quotaForMember(req.params.memberId, actorFrom(req)));
    })
  );

  router.get(
    "/clinics/:clinicId/notification-settings",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json(await deps.notifications.getSettings(req.params.clinicId, actorFrom(req)));
    })
  );

  router.put(
    "/clinics/:clinicId/notification-settings",
    requireStaff,
    asyncHandler(async (req, res) => {
      const input = parse(notificationSettingsSchema, req.body);

      res.json(await deps.notifications.updateSettings(req.params.clinicId, input, actorFrom(req)));
    })
  );

  router.get(
    "/clinics/:clinicId/geo-locations",
    requireStaff,
    asyncHandler(async (req, res) => {
      res.json({
        locations: await deps.notifications.getLocations(req.params.clinicId, actorFrom(req)),
        note: "Nearby alerts are shown by Google Wallet; text and timing are not configurable."
      });
    })
  );

  router.put(
    "/clinics/:clinicId/geo-locations",
    requireStaff,
    asyncHandler(async (req, res) => {
      const input = parse(clinicLocationsSchema, req.body);

      res.json({
        locations: await deps.notifications.setLocations(
          req.params.clinicId,
          input.locations,
          actorFrom(req)
        ),
        note: "Nearby alerts are shown by Google Wallet; text and timing are not configurable."
      });
    })
  );

  return router;
};