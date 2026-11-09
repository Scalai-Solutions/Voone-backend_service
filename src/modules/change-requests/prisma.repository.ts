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
  StatusChange,
  StatusChangeResult,
  StatusPatch
} from "./service";
import type { ChangeRequestStatus } from "@prisma/client";

const CLINIC = { select: { id: true, name: true, slug: true } } as const;

const CLOSED: ChangeRequestStatus[] = ["RESOLVED", "REJECTED"];

/**
 * Closing writes the resolution note into the thread too, in the same transaction, as the
 * resolver's own message. A reopen clears the note from the ticket, and this keeps it.
 */
const closingMessage = (patch: StatusPatch): NewMessage | null =>
  CLOSED.includes(patch.status) && patch.resolutionNote && patch.resolvedByEmail && patch.resolvedAt
    ? {
        authorKind: "VOONE",
        authorEmail: patch.resolvedByEmail,
        body: patch.resolutionNote,
        createdAt: patch.resolvedAt
      }
    : null;

/** One lock per clinic: creates and reopens queue on it, so the cap is counted and applied in turn. */
const lockClinic = (tx: Prisma.TransactionClient, clinicId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`change-requests:${clinicId}`}))`;

const UNRESOLVED: ChangeRequestStatus[] = ["OPEN", "IN_PROGRESS"];

/**
 * `contains` hands the text to LIKE as is, so `%` and `_` would be wildcards (a search for "%"
 * would match everything). Escape them and the escape character itself.
 */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const json = (value: Record<string, unknown> | undefined) =>
  value === undefined ? undefined : (value as Prisma.InputJsonValue);

export class PrismaChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly db: PrismaClient) {}

  async createWithinLimit(
    data: NewChangeRequest,
    limit: number,
    dedupeWithinMs: number
  ): Promise<{ record: ChangeRequestRecord; duplicate: boolean } | null> {
    return this.db.$transaction(async (tx) => {
      await lockClinic(tx, data.clinicId);

      // A client retry (a double click, a replayed request) sends the same ticket again: answer
      // with the one already stored instead of a twin.
      const twin = await tx.changeRequest.findFirst({
        where: {
          clinicId: data.clinicId,
          createdByEmail: data.createdByEmail,
          type: data.type,
          title: data.title,
          reason: data.reason,
          createdAt: { gte: new Date(data.createdAt.getTime() - dedupeWithinMs) }
        },
        orderBy: { createdAt: "desc" },
        include: { clinic: CLINIC }
      });

      if (twin) return { record: twin, duplicate: true };

      const unresolved = await tx.changeRequest.count({
        where: { clinicId: data.clinicId, status: { in: UNRESOLVED } }
      });

      if (unresolved >= limit) return null;

      const record = await tx.changeRequest.create({
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

      return { record, duplicate: false };
    });
  }

  async createApplied<T>(
    data: NewChangeRequest,
    work: (db: PrismaClient) => Promise<{ result: T; note: string }>
  ): Promise<{ record: ChangeRequestRecord; result: T }> {
    return this.db.$transaction(
      async (tx) => {
        // The same lock a create takes, so a centre's changes (and tickets) queue in turn.
        await lockClinic(tx, data.clinicId);

        // The treatment and bono services only use model delegates, which a transaction client has.
        const { result, note } = await work(tx as unknown as PrismaClient);

        const record = await tx.changeRequest.create({
          data: {
            clinicId: data.clinicId,
            type: data.type,
            targetRef: json(data.targetRef),
            title: data.title,
            reason: data.reason,
            proposed: json(data.proposed),
            createdByEmail: data.createdByEmail,
            createdByRole: data.createdByRole,
            createdAt: data.createdAt,
            status: "RESOLVED",
            resolvedAt: data.createdAt,
            resolvedByEmail: data.createdByEmail,
            resolutionNote: note,
            appliedAt: data.createdAt,
            appliedByEmail: data.createdByEmail,
            autoApproved: true
          },
          include: { clinic: CLINIC }
        });

        return { record, result };
      },
      { timeout: 30_000, maxWait: 15_000 }
    );
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
          { title: { contains: escapeLike(filter.q), mode: "insensitive" } },
          { clinic: { name: { contains: escapeLike(filter.q), mode: "insensitive" } } }
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

  async changeStatus(id: string, change: StatusChange): Promise<StatusChangeResult> {
    return this.db.$transaction(async (tx) => {
      if (change.openLimit !== undefined) {
        // A move that puts a ticket back among the unresolved counts against the cap, so it
        // takes the same clinic lock a create does and counts inside the same transaction.
        const ticket = await tx.changeRequest.findUnique({
          where: { id },
          select: { clinicId: true }
        });

        if (!ticket) return { kind: "stale" as const };

        await lockClinic(tx, ticket.clinicId);

        const unresolved = await tx.changeRequest.count({
          where: { clinicId: ticket.clinicId, status: { in: UNRESOLVED } }
        });

        if (unresolved >= change.openLimit) return { kind: "limit" as const };
      }

      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: change.from },
        data: change.patch
      });

      if (count !== 1) return { kind: "stale" as const };

      const wrote = change.message ?? closingMessage(change.patch);
      const message = wrote
        ? await tx.changeRequestMessage.create({ data: { requestId: id, ...wrote } })
        : null;

      return { kind: "ok" as const, message };
    });
  }

  async appendMessage(id: string, message: NewMessage): Promise<MessageRecord | null> {
    return this.db.$transaction(async (tx) => {
      if ((await tx.changeRequest.count({ where: { id } })) === 0) return null;

      return tx.changeRequestMessage.create({ data: { requestId: id, ...message } });
    });
  }

  async applyAtomically<T>(
    id: string,
    work: (db: PrismaClient) => Promise<{ result: T; patch: StatusPatch }>
  ): Promise<T | null> {
    return this.db.$transaction(async (tx) => {
      // Takes the row lock and checks the status and the applied mark in one statement: a
      // concurrent apply waits here, then finds the ticket resolved and gets a count of 0.
      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: { in: UNRESOLVED }, appliedAt: null },
        data: { updatedAt: new Date() }
      });

      if (count !== 1) return null;

      // The treatment and bono services only use model delegates, which a transaction client has.
      const { result, patch } = await work(tx as unknown as PrismaClient);

      await tx.changeRequest.update({
        where: { id },
        data: { ...patch, appliedAt: patch.resolvedAt, appliedByEmail: patch.resolvedByEmail }
      });

      const note = closingMessage(patch);

      if (note) await tx.changeRequestMessage.create({ data: { requestId: id, ...note } });

      return result;
    });
  }

  async linkProgram(id: string, programId: string): Promise<ChangeRequestStatus | null> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.changeRequest.findUnique({
        where: { id },
        select: { status: true }
      });

      if (!current || !UNRESOLVED.includes(current.status)) return null;

      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: current.status },
        data: {
          programId,
          ...(current.status === "OPEN" ? { status: "IN_PROGRESS" as const } : {})
        }
      });

      return count === 1 ? current.status : null;
    });
  }

  findUnresolvedByProgram(clinicId: string, programId: string): Promise<ChangeRequestRecord[]> {
    return this.db.changeRequest.findMany({
      where: { clinicId, programId, status: { in: UNRESOLVED } },
      include: { clinic: CLINIC },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
  }
}
