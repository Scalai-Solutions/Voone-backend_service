import { AutomationEvent, OnboardingProgramStatus, type PrismaClient } from "@prisma/client";

import type { Program } from "../../../onboarding/engine.types";
import { itemsTitle } from "../../../onboarding/reward-title";
import { tierKeyOf } from "../../../onboarding/runtime/rules";
import type { AutomationRecipient } from "../dispatch.service";
import type { ScheduledTrigger, TriggerContext } from "./types";

/**
 * For a member with no gift to name: a clinic without a programme, or a tier the programme gave
 * no birthday gift. Never empty, so a copy using {birthday_gift} still reads as a sentence.
 */
export const BIRTHDAY_GIFT_FALLBACK = "un detalle especial en tu próxima visita";

/** The birthday gift the live programme assigns to a member's tier; nobody picks it by hand. */
export const birthdayGiftFor = (program: Program | null, tier: string | null): string => {
  // A member not yet placed in a tier is in the first one.
  const gift = program?.gifts[tierKeyOf(tier) ?? "bronce"]?.birthday;

  return gift ? itemsTitle(gift.items) : BIRTHDAY_GIFT_FALLBACK;
};

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
    const birthdays = members.filter(
      ({ birthDate }) =>
        birthDate !== null &&
        birthDate.getUTCMonth() + 1 === today.month &&
        birthDate.getUTCDate() === today.day
    );

    if (birthdays.length === 0) return [];

    // Newest first, as the card assembler reads it, should two ACTIVO programmes ever exist.
    const programme = await this.prisma.onboardingProgram.findFirst({
      where: { clinicId, status: OnboardingProgramStatus.ACTIVO },
      orderBy: { version: "desc" },
      select: { output: true }
    });
    const program = (programme?.output ?? null) as unknown as Program | null;

    return birthdays.map(({ id, tier }) => ({
      memberId: id,
      values: { birthday_gift: birthdayGiftFor(program, tier) }
    }));
  }
}
