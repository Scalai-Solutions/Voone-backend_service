import type { PrismaClient } from "@prisma/client";

import type { ChangeRequestMailStore } from "./email.notifier";

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

  async recordSent(requestId: string, at: Date): Promise<void> {
    await this.db.changeRequest.updateMany({
      where: { id: requestId },
      data: { emailSentAt: at, lastEmailError: null }
    });
  }

  async recordError(requestId: string, error: string): Promise<void> {
    await this.db.changeRequest.updateMany({
      where: { id: requestId },
      data: { lastEmailError: error }
    });
  }
}
