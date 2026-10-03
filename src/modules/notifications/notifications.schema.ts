import { z } from "zod";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "actionUrl must use https"
  });

export const notificationMessageSchema = z.object({
  header: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(500),
  actionUrl: httpsUrl.optional(),
  notify: z.boolean(),
  scheduledAt: z.coerce.date().optional()
});

export const notificationSegmentSchema = z.object({
  tier: z.string().trim().min(1).max(80).optional(),
  inactiveDays: z.number().int().positive().max(3650).optional(),
  lastVisitBefore: z.coerce.date().optional(),
  categoryNotVisited: z.string().trim().min(1).max(120).optional()
});

export const segmentNotificationSchema = notificationMessageSchema.extend({
  segment: notificationSegmentSchema
});

export const notificationListQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  cursor: z.string().trim().min(1).optional()
});

export const notificationSettingsSchema = z.object({
  notifyOnCredit: z.enum(["NEVER", "MILESTONE_AND_TIER", "ALWAYS"]),
  marketingEnabled: z.boolean()
});

export const clinicLocationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
});

export const clinicLocationsSchema = z.object({
  locations: z.array(clinicLocationSchema).max(10)
});

export type NotificationMessageInput = z.infer<typeof notificationMessageSchema>;
export type SegmentNotificationInput = z.infer<typeof segmentNotificationSchema>;
export type NotificationSegmentInput = z.infer<typeof notificationSegmentSchema>;
export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;
export type ClinicLocationInput = z.infer<typeof clinicLocationSchema>;
