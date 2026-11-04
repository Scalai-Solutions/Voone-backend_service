import { AutomationEvent, type PrismaClient } from "@prisma/client";

import type { AutomationRecipient } from "../dispatch.service";
import { birthdayGiftFor, loadActiveProgram } from "../member-rewards";
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
      select: { id: true, birthDate: true, tier: true }
    });
    const todays = members.filter(
      ({ birthDate }) =>
        birthDate !== null &&
        birthDate.getUTCMonth() + 1 === today.month &&
        birthDate.getUTCDate() === today.day
    );

    if (todays.length === 0) return [];

    // The gift is the one the live programme assigns to the member's tier, read at send time.
    const program = await loadActiveProgram(this.prisma, clinicId);

    return todays.map(({ id, tier }) => ({
      memberId: id,
      values: { birthday_gift: birthdayGiftFor(program, tier) }
    }));
  }
}
