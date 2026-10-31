import { Prisma, type PrismaClient } from "@prisma/client";

import type {
  ChangeRequestDetail,
  ChangeRequestListRow,
  ChangeRequestRecord,
  ChangeRequestRepository,
  ListFilter,
  MessageRecord,
  NewChangeRequest,
  NewMessage,
  StatusPatch
} from "./service";
import type { ChangeRequestStatus } from "@prisma/client";

const CLINIC = { select: { id: true, name: true, slug: true } } as const;

const REOPEN: StatusPatch = {
  status: "OPEN",
  resolvedAt: null,
  resolvedByEmail: null,
  resolutionNote: null
};

const UNRESOLVED: ChangeRequestStatus[] = ["OPEN", "IN_PROGRESS"];

const json = (value: Record<string, unknown> | undefined) =>
  value === undefined ? undefined : (value as Prisma.InputJsonValue);

export class PrismaChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly db: PrismaClient) {}

  async createWithinLimit(
    data: NewChangeRequest,
    limit: number
  ): Promise<ChangeRequestRecord | null> {
    return this.db.$transaction(async (tx) => {
      // One lock per clinic, held to the end of the transaction: two creates for the same
      // clinic queue here, so the count below is the count the insert is checked against.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`change-requests:${data.clinicId}`}))`;

      const unresolved = await tx.changeRequest.count({
        where: { clinicId: data.clinicId, status: { in: UNRESOLVED } }
      });

      if (unresolved >= limit) return null;

      return tx.changeRequest.create({
        data: {
          clinicId: data.clinicId,
          type: data.type,
          targetRef: json(data.targetRef),
          title: data.title,
          reason: data.reason,
          proposed: json(data.proposed),
          createdByEmail: data.createdByEmail,
          createdByRole: data.createdByRole,
          createdAt: data.createdAt
        },
        include: { clinic: CLINIC }
      });
    });
  }

  countUnresolved(clinicId: string): Promise<number> {
    return this.db.changeRequest.count({ where: { clinicId, status: { in: UNRESOLVED } } });
  }

  async find(id: string, clinicId?: string): Promise<ChangeRequestDetail | null> {
    return this.db.changeRequest.findFirst({
      where: { id, ...(clinicId ? { clinicId } : {}) },
      include: {
        clinic: CLINIC,
        messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
      }
    });
  }

  async list(filter: ListFilter): Promise<ChangeRequestListRow[]> {
    const and: Prisma.ChangeRequestWhereInput[] = [];

    if (filter.cursor) {
      and.push({
        OR: [
          { createdAt: { lt: filter.cursor.createdAt } },
          { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } }
        ]
      });
    }

    if (filter.q) {
      and.push({
        OR: [
          { title: { contains: filter.q, mode: "insensitive" } },
          { clinic: { name: { contains: filter.q, mode: "insensitive" } } }
        ]
      });
    }

    const rows = await this.db.changeRequest.findMany({
      where: {
        ...(filter.clinicId ? { clinicId: filter.clinicId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(and.length > 0 ? { AND: and } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit + 1,
      include: {
        clinic: CLINIC,
        _count: { select: { messages: true } },
        messages: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 }
      }
    });

    return rows.map(({ _count, messages, ...row }) => ({
      ...row,
      messageCount: _count.messages,
      lastMessageAt: messages[0]?.createdAt ?? null
    }));
  }

  async transition(id: string, from: ChangeRequestStatus, patch: StatusPatch): Promise<boolean> {
    const { count } = await this.db.changeRequest.updateMany({
      where: { id, status: from },
      data: patch
    });

    return count === 1;
  }

  async appendMessage(
    id: string,
    message: NewMessage,
    reopenFrom?: ChangeRequestStatus
  ): Promise<MessageRecord | null> {
    return this.db.$transaction(async (tx) => {
      if (reopenFrom) {
        const { count } = await tx.changeRequest.updateMany({
          where: { id, status: reopenFrom },
          data: REOPEN
        });

        if (count !== 1) return null;
      } else if ((await tx.changeRequest.count({ where: { id } })) === 0) {
        return null;
      }

      return tx.changeRequestMessage.create({
        data: {
          requestId: id,
          authorKind: message.authorKind,
          authorEmail: message.authorEmail,
          body: message.body,
          createdAt: message.createdAt
        }
      });
    });
  }

  async resolveAtomically<T>(
    id: string,
    work: (db: PrismaClient) => Promise<{ result: T; patch: StatusPatch }>
  ): Promise<T | null> {
    return this.db.$transaction(async (tx) => {
      // Takes the row lock and checks the status in one statement: a concurrent apply waits
      // here, then finds the ticket resolved and gets a count of 0.
      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: { in: UNRESOLVED } },
        data: { updatedAt: new Date() }
      });

      if (count !== 1) return null;

      // The treatment and bono services only use model delegates, which a transaction client has.
      const { result, patch } = await work(tx as unknown as PrismaClient);

      await tx.changeRequest.update({ where: { id }, data: patch });

      return result;
    });
  }
}
