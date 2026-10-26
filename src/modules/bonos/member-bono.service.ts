import { MemberBonoStatus, type PrismaClient } from "@prisma/client";

import { BonoConflictError, BonoNotFoundError } from "../../common/errors/bono.errors";
import { MemberNotFoundError } from "../../common/errors/membership.errors";

/**
 * The bonos a member holds, and the one action staff may take on one besides consuming a
 * session (which the visit service owns, inside its transaction).
 */

export interface MemberBonoRow {
  id: string;
  planId: string | null;
  name: string;
  pricePerSessionEuro: number;
  totalSessions: number;
  sessionsUsed: number;
  /** How many the member has left, 0 for a finished bono. */
  remaining: number;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  startedAt: string;
  cancelledAt: string | null;
}

const bonoRow = (bono: {
  id: string;
  planId: string | null;
  name: string;
  pricePerSessionCents: number;
  totalSessions: number;
  sessionsUsed: number;
  status: MemberBonoStatus;
  startedAt: Date;
  cancelledAt: Date | null;
}): MemberBonoRow => ({
  id: bono.id,
  planId: bono.planId,
  name: bono.name,
  pricePerSessionEuro: bono.pricePerSessionCents / 100,
  totalSessions: bono.totalSessions,
  sessionsUsed: bono.sessionsUsed,
  remaining: Math.max(0, bono.totalSessions - bono.sessionsUsed),
  status: bono.status,
  startedAt: bono.startedAt.toISOString(),
  cancelledAt: bono.cancelledAt?.toISOString() ?? null
});

/** A member's bonos, active first, with how far through each they are. */
export const listForMember = async (
  prisma: PrismaClient,
  clinicId: string,
  memberId: string
): Promise<MemberBonoRow[]> => {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clinicId, erasedAt: null },
    select: { id: true }
  });

  if (!member) throw new MemberNotFoundError(memberId);

  const bonos = await prisma.memberBono.findMany({
    where: { clinicId, memberId },
    orderBy: [{ status: "asc" }, { startedAt: "desc" }]
  });

  return bonos.map(bonoRow);
};

/**
 * Cancel a bono the member will not finish. The sessions already consumed stay recorded —
 * they were real visits — but the pack stops being offered and stops counting as active for
 * the reminder segment.
 */
export const cancelMemberBono = async (
  prisma: PrismaClient,
  clinicId: string,
  memberId: string,
  bonoId: string
): Promise<MemberBonoRow> => {
  const bono = await prisma.memberBono.findFirst({ where: { id: bonoId, clinicId, memberId } });

  if (!bono) throw new BonoNotFoundError();

  if (bono.status !== MemberBonoStatus.ACTIVE) {
    throw new BonoConflictError("Ese bono ya no está activo.");
  }

  return bonoRow(
    await prisma.memberBono.update({
      where: { id: bono.id },
      data: { status: MemberBonoStatus.CANCELLED, cancelledAt: new Date() }
    })
  );
};
