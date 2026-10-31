import { AutomationEvent, type PrismaClient } from "@prisma/client";

import type { AutomationRecipient } from "../dispatch.service";
import type { ScheduledTrigger, TriggerContext } from "./types";

export class BirthdayTrigger implements ScheduledTrigger {
  readonly event = AutomationEvent.BIRTHDAY;

  constructor(private readonly prisma: PrismaClient) {}

  isDue(): boolean {
    return true;
  }

  idempotencyKey(clinicId: string, today: { dateKey: string }): string {
    return `birthday:${clinicId}:${today.dateKey}`;
  }

  async findRecipients({ clinicId, today }: TriggerContext): Promise<AutomationRecipient[]> {
    const members = await this.prisma.member.findMany({
      where: { clinicId, erasedAt: null, birthDate: { not: null } },
      select: { id: true, birthDate: true }
    });

    return members
      .filter(
        ({ birthDate }) =>
          birthDate !== null &&
          birthDate.getUTCMonth() + 1 === today.month &&
          birthDate.getUTCDate() === today.day
      )
      .map(({ id }) => ({ memberId: id }));
  }
}
