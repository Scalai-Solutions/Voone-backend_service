import { type PrismaClient } from "@prisma/client";

import { BonoNotFoundError, BonoValidationError } from "../../common/errors/bono.errors";
import { bonoSessionCents } from "../onboarding/runtime/rules";
import {
  createBonoPlanSchema,
  updateBonoPlanSchema,
  type CreateBonoPlanInput,
  type UpdateBonoPlanInput
} from "./bono.schema";

/**
 * A centre's bono plans: name, the pack's TOTAL price, and its session count.
 *
 * Plans are edited by the owner (during onboarding, or later from the treatments editor).
 * Member bonos snapshot the plan when they start, so nothing here rewrites history: editing
 * a plan changes what the NEXT bono looks like, never one a member is part-way through.
 */

const toCents = (euro: number): number => Math.round(euro * 100);

export interface BonoPlanRow {
  id: string;
  name: string;
  /** Euros, as the editor typed them. */
  pricePerSessionEuro: number;
  totalSessions: number;
  /** Derived, never stored: what the whole pack costs. */
  totalEuro: number;
  active: boolean;
  /** How many members hold a bono from this plan, including finished ones. */
  issuedCount: number;
}

const planRow = (plan: {
  id: string;
  name: string;
  pricePerSessionCents: number;
  totalSessions: number;
  active: boolean;
  _count?: { issued: number };
}): BonoPlanRow => ({
  id: plan.id,
  name: plan.name,
  pricePerSessionEuro: plan.pricePerSessionCents / 100,
  totalSessions: plan.totalSessions,
  totalEuro: (plan.pricePerSessionCents * plan.totalSessions) / 100,
  active: plan.active,
  issuedCount: plan._count?.issued ?? 0
});

const parse = <T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }, input: unknown): T => {
  const parsed = schema.safeParse(input);

  if (!parsed.success || parsed.data === undefined) {
    throw new BonoValidationError("Datos del bono no válidos.");
  }

  return parsed.data;
};

/** Every plan, active first, for the editor and the pickers (which filter on `active`). */
export const listPlans = async (prisma: PrismaClient, clinicId: string): Promise<BonoPlanRow[]> => {
  const plans = await prisma.bonoPlan.findMany({
    where: { clinicId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { issued: true } } }
  });

  return plans.map(planRow);
};

export const createPlan = async (
  prisma: PrismaClient,
  clinicId: string,
  input: CreateBonoPlanInput
): Promise<BonoPlanRow> => {
  const data = parse(createBonoPlanSchema, input);

  return planRow(
    await prisma.bonoPlan.create({
      data: {
        clinicId,
        name: data.name,
        // Total ÷ sessions, rounded once: a session may be a cent off, exactly as the
        // legacy free-text package rule has always allowed.
        pricePerSessionCents: bonoSessionCents(toCents(data.priceEuro), data.totalSessions),
        totalSessions: data.totalSessions
      },
      include: { _count: { select: { issued: true } } }
    })
  );
};

const scopedPlan = async (prisma: PrismaClient, clinicId: string, id: string) => {
  const plan = await prisma.bonoPlan.findFirst({ where: { id, clinicId } });

  if (!plan) throw new BonoNotFoundError();

  return plan;
};

export const updatePlan = async (
  prisma: PrismaClient,
  clinicId: string,
  id: string,
  patch: UpdateBonoPlanInput
): Promise<BonoPlanRow> => {
  const data = parse(updateBonoPlanSchema, patch);
  const plan = await scopedPlan(prisma, clinicId, id);

  // A change to the price or the session count re-derives the per-session figure, so the
  // two can never drift apart. Untouched fields are left exactly as they are.
  const totalCents =
    data.priceEuro !== undefined
      ? toCents(data.priceEuro)
      : plan.pricePerSessionCents * plan.totalSessions;
  const sessions = data.totalSessions ?? plan.totalSessions;

  return planRow(
    await prisma.bonoPlan.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...((data.priceEuro !== undefined || data.totalSessions !== undefined) && {
          pricePerSessionCents: bonoSessionCents(totalCents, sessions)
        }),
        ...(data.totalSessions !== undefined && { totalSessions: data.totalSessions }),
        ...(data.active !== undefined && { active: data.active })
      },
      include: { _count: { select: { issued: true } } }
    })
  );
};

/**
 * Deleting a plan no member has ever used removes it outright. One that HAS been issued is
 * retired instead (active=false): the members who hold its bonos keep their snapshot, and
 * the plan stops appearing in the pickers — the history stays explicable.
 */
export const removePlan = async (
  prisma: PrismaClient,
  clinicId: string,
  id: string
): Promise<{ status: "deleted" | "retired" }> => {
  await scopedPlan(prisma, clinicId, id);

  const issued = await prisma.memberBono.count({ where: { planId: id } });

  if (issued === 0) {
    await prisma.bonoPlan.delete({ where: { id } });

    return { status: "deleted" };
  }

  await prisma.bonoPlan.update({ where: { id }, data: { active: false } });

  return { status: "retired" };
};
