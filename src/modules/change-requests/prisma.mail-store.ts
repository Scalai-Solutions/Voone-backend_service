import type { PrismaClient } from "@prisma/client";

import type { Audience, ChangeRequestMailStore } from "./email.notifier";

export class PrismaChangeRequestMailStore implements ChangeRequestMailStore {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The clinic's OWNER users; with none, the clinic's billing email; with neither, nobody
   * (the caller records that). Manager and staff accounts are not written to.
   */
  async ownerEmails(clinicId: string): Promise<string[]> {
    const owners = await this.db.user.findMany({
      where: { clinicId, role: "OWNER" },
      select: { email: true },
      orderBy: { createdAt: "asc" }
    });

    if (owners.length > 0) return [...new Set(owners.map((owner) => owner.email))];

    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { billingEmail: true }
    });
    const billing = clinic?.billingEmail?.trim();

    return billing ? [billing] : [];
  }

  /**
   * Raw SQL, not `update`: Prisma would bump `updatedAt`, which the owner sees as the ticket's
   * last change, and a mail outcome is not one.
   */
  async recordSent(requestId: string, at: Date, kind: Audience): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "ChangeRequest"
      SET "emailSentAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
          "lastEmailError" = CASE WHEN "lastEmailErrorKind" IS NULL OR "lastEmailErrorKind" = ${kind}
            THEN NULL ELSE "lastEmailError" END,
          "lastEmailErrorKind" = CASE WHEN "lastEmailErrorKind" IS NULL OR "lastEmailErrorKind" = ${kind}
            THEN NULL ELSE "lastEmailErrorKind" END
      WHERE "id" = ${requestId}`;
  }

  async recordError(requestId: string, error: string, kind: Audience): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "ChangeRequest"
      SET "lastEmailError" = ${error}, "lastEmailErrorKind" = ${kind}
      WHERE "id" = ${requestId}`;
  }
}
