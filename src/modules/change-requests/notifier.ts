import type { ChangeRequestStatus } from "@prisma/client";

import type { ChangeRequestDetail, MessageRecord } from "./service";

/** Who made a status change. */
export type StatusChangedBy = "CLINIC" | "VOONE";

/**
 * What happens around a ticket besides storing it: today nothing, later email.
 *
 * Every hook is called AFTER the change is committed, and awaited, but a rejection is caught
 * and logged by the service: the ticket is the record, a notification is a courtesy, and a
 * mail outage must never lose or fail a ticket. An implementation records its own outcome
 * (emailSentAt / lastEmailError).
 *
 * `request` is the whole ticket as stored after the change, thread included, with the clinic.
 */
export interface ChangeRequestNotifier {
  /** A clinic opened a ticket. */
  onCreated(request: ChangeRequestDetail): Promise<void>;
  /**
   * A clinic user wrote in the thread. `reopenedFrom` is the status the ticket had when this
   * message reopened it, otherwise undefined. A reopen that comes with a message is reported
   * here only; onStatusChanged does not also fire for it.
   */
  onOwnerReply(
    request: ChangeRequestDetail,
    message: MessageRecord,
    reopenedFrom?: ChangeRequestStatus
  ): Promise<void>;
  /** Voone wrote in the thread. Never changes the status. */
  onAdminReply(request: ChangeRequestDetail, message: MessageRecord): Promise<void>;
  /**
   * The status moved: an admin transition, or a clinic reopen with no message. `changedBy` tells a mail template whether to write to the clinic or to Voone.
   */
  onStatusChanged(
    request: ChangeRequestDetail,
    previousStatus: ChangeRequestStatus,
    changedBy: StatusChangedBy
  ): Promise<void>;
}

/** The default: tickets work, nobody is told. */
export const noopChangeRequestNotifier: ChangeRequestNotifier = {
  onCreated: async () => {},
  onOwnerReply: async () => {},
  onAdminReply: async () => {},
  onStatusChanged: async () => {}
};
