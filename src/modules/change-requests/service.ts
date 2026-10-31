import type {
  ChangeRequestAuthorKind,
  ChangeRequestStatus,
  ChangeRequestType,
  PrismaClient
} from "@prisma/client";

import {
  ChangeRequestConflictError,
  ChangeRequestLimitError,
  ChangeRequestNotFoundError,
  ChangeRequestValidationError,
  ProgrammeNotFoundError
} from "../../common/errors/change-request.errors";
import { APPLICABLE_TYPES, type AppliedChange, type CatalogueChanges } from "./catalogue-changes";
import type { ProgramDrafts } from "./program-drafts";
import {
  noopChangeRequestNotifier,
  type ChangeRequestNotifier,
  type StatusChangedBy
} from "./notifier";
import { encodeCursor, type ChangeRequestInput, type ListCursor } from "./schema";

/**
 * Change requests ("tickets"): a centre asks Voone to change what the owner cannot edit
 * directly, and Voone answers in a thread and resolves it by hand.
 *
 * The service owns the rules: who may do what, the status table, the reopen window and the
 * open-ticket cap. Persistence sits behind ChangeRequestRepository (the Prisma one lives in
 * prisma.repository.ts), and whatever happens around a ticket (email, later) behind
 * ChangeRequestNotifier, so neither leaks into the rules.
 */

/** A clinic may have at most this many OPEN or IN_PROGRESS tickets at once. */
export const OPEN_LIMIT = 20;
/** How long after resolution a clinic may reopen a ticket, or reply to it. */
export const REOPEN_WINDOW_DAYS = 14;
export const REOPEN_WINDOW_MS = REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The transitions an admin may make. A closed ticket can only go back to OPEN. */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ChangeRequestStatus, readonly ChangeRequestStatus[]>
> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "REJECTED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "REJECTED"],
  RESOLVED: ["OPEN"],
  REJECTED: ["OPEN"]
};

const isClosed = (status: ChangeRequestStatus): boolean =>
  status === "RESOLVED" || status === "REJECTED";

/* ---- records, as the repository returns them ---- */

export interface ClinicRef {
  id: string;
  name: string;
  slug: string;
}

export interface ChangeRequestRecord {
  id: string;
  clinicId: string;
  clinic: ClinicRef;
  type: ChangeRequestType;
  targetRef: unknown;
  title: string;
  reason: string;
  proposed: unknown;
  status: ChangeRequestStatus;
  createdByEmail: string;
  createdByRole: string;
  resolvedByEmail: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  programId: string | null;
  emailSentAt: Date | null;
  lastEmailError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  requestId: string;
  authorKind: ChangeRequestAuthorKind;
  authorEmail: string;
  body: string;
  createdAt: Date;
}

export interface ChangeRequestDetail extends ChangeRequestRecord {
  /** Oldest first. */
  messages: MessageRecord[];
}

export interface ChangeRequestListRow extends ChangeRequestRecord {
  messageCount: number;
  lastMessageAt: Date | null;
}

export interface NewChangeRequest {
  clinicId: string;
  type: ChangeRequestType;
  targetRef?: Record<string, unknown>;
  title: string;
  reason: string;
  proposed?: Record<string, unknown>;
  createdByEmail: string;
  createdByRole: string;
  createdAt: Date;
}

export interface NewMessage {
  authorKind: ChangeRequestAuthorKind;
  authorEmail: string;
  body: string;
  createdAt: Date;
}

/** The fields a status change writes. Every transition to OPEN passes the three as null. */
export interface StatusPatch {
  status: ChangeRequestStatus;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
  resolutionNote: string | null;
}

export interface ListFilter {
  clinicId?: string;
  status?: ChangeRequestStatus;
  type?: ChangeRequestType;
  /** Case-insensitive, against the title and the clinic's name. */
  q?: string;
  cursor?: ListCursor;
  /** Rows wanted; the repository returns up to one more so the service can tell if there is a next page. */
  limit: number;
}

export interface ChangeRequestRepository {
  /**
   * Creates the ticket unless the clinic already has `limit` that are OPEN or IN_PROGRESS,
   * in which case it returns null. The check and the insert are one atomic step, so
   * concurrent creates cannot overshoot the limit.
   */
  createWithinLimit(data: NewChangeRequest, limit: number): Promise<ChangeRequestRecord | null>;
  countUnresolved(clinicId: string): Promise<number>;
  /** With `clinicId`, only a ticket of that clinic: another clinic's id is simply absent. */
  find(id: string, clinicId?: string): Promise<ChangeRequestDetail | null>;
  /** Newest first, ties by id, strictly after the cursor; up to `limit + 1` rows. */
  list(filter: ListFilter): Promise<ChangeRequestListRow[]>;
  /**
   * Moves the ticket only if it is still in `from`; false when it was not (someone else got
   * there first), so a stale decision never overwrites a newer one.
   */
  transition(id: string, from: ChangeRequestStatus, patch: StatusPatch): Promise<boolean>;
  /**
   * Adds a message and, with `reopenFrom`, reopens the ticket in the same transaction, but
   * only if it is still in that status. Null when it was not, and nothing is written.
   */
  appendMessage(
    id: string,
    message: NewMessage,
    reopenFrom?: ChangeRequestStatus
  ): Promise<MessageRecord | null>;
  /**
   * In one transaction: takes the ticket only if it is still OPEN or IN_PROGRESS, runs `work`
   * with a transaction-bound client, then writes the patch `work` returns. Null when the ticket
   * was already closed. If `work` throws, nothing is kept, the ticket included.
   */
  /**
   * Links the ticket to a programme and moves OPEN to IN_PROGRESS, only while it is
   * unresolved. Returns the status it had, or null when it was closed (or moved) meanwhile.
   */
  linkProgram(id: string, programId: string): Promise<ChangeRequestStatus | null>;
  /** The clinic's OPEN or IN_PROGRESS tickets linked to the programme. */
  findUnresolvedByProgram(clinicId: string, programId: string): Promise<ChangeRequestRecord[]>;
  resolveAtomically<T>(
    id: string,
    work: (db: PrismaClient) => Promise<{ result: T; patch: StatusPatch }>
  ): Promise<T | null>;
}

/* ---- views: what each audience may see ---- */

/** A message as the clinic sees it. Voone staff emails never leave the admin side. */
export interface OwnerMessageView {
  id: string;
  authorKind: ChangeRequestAuthorKind;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

export interface OwnerRequestView {
  id: string;
  type: ChangeRequestType;
  targetRef: unknown;
  title: string;
  reason: string;
  proposed: unknown;
  status: ChangeRequestStatus;
  createdByEmail: string;
  createdByRole: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** When a closed ticket stops being reopenable; null if it is not closed or already past. */
  reopenableUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerListItem extends OwnerRequestView {
  messageCount: number;
  lastMessageAt: string | null;
}

export interface OwnerRequestDetail extends OwnerRequestView {
  messages: OwnerMessageView[];
}

export interface AdminMessageView {
  id: string;
  authorKind: ChangeRequestAuthorKind;
  authorEmail: string;
  body: string;
  createdAt: string;
}

export interface AdminRequestView {
  id: string;
  clinicId: string;
  clinic: ClinicRef;
  type: ChangeRequestType;
  targetRef: unknown;
  title: string;
  reason: string;
  proposed: unknown;
  status: ChangeRequestStatus;
  createdByEmail: string;
  createdByRole: string;
  resolvedByEmail: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  programId: string | null;
  emailSentAt: string | null;
  lastEmailError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminListItem extends AdminRequestView {
  messageCount: number;
  lastMessageAt: string | null;
}

export interface AdminRequestDetail extends AdminRequestView {
  messages: AdminMessageView[];
  /**
   * What the change does to the clinic's active programme (open service tickets only): null
   * when there is nothing to say.
   */
  catalogueImpact: string[] | null;
}

export interface DraftResult {
  request: AdminRequestDetail;
  programId: string;
}

export interface ApplyResult {
  request: AdminRequestDetail;
  applied: AppliedChange;
  warnings: string[];
}

export interface Page<T> {
  items: T[];
  /** Pass it back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

const reopenableUntil = (record: ChangeRequestRecord, now: Date): string | null => {
  if (!isClosed(record.status) || !record.resolvedAt) return null;

  const until = record.resolvedAt.getTime() + REOPEN_WINDOW_MS;

  return now.getTime() <= until ? new Date(until).toISOString() : null;
};

const ownerView = (record: ChangeRequestRecord, now: Date): OwnerRequestView => ({
  id: record.id,
  type: record.type,
  targetRef: record.targetRef,
  title: record.title,
  reason: record.reason,
  proposed: record.proposed,
  status: record.status,
  createdByEmail: record.createdByEmail,
  createdByRole: record.createdByRole,
  resolvedAt: iso(record.resolvedAt),
  resolutionNote: record.resolutionNote,
  reopenableUntil: reopenableUntil(record, now),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString()
});

const ownerDetail = (detail: ChangeRequestDetail, now: Date): OwnerRequestDetail => ({
  ...ownerView(detail, now),
  messages: detail.messages.map((message) => ({
    id: message.id,
    authorKind: message.authorKind,
    authorEmail: message.authorKind === "CLINIC" ? message.authorEmail : null,
    body: message.body,
    createdAt: message.createdAt.toISOString()
  }))
});

const adminView = (record: ChangeRequestRecord): AdminRequestView => ({
  id: record.id,
  clinicId: record.clinicId,
  clinic: record.clinic,
  type: record.type,
  targetRef: record.targetRef,
  title: record.title,
  reason: record.reason,
  proposed: record.proposed,
  status: record.status,
  createdByEmail: record.createdByEmail,
  createdByRole: record.createdByRole,
  resolvedByEmail: record.resolvedByEmail,
  resolvedAt: iso(record.resolvedAt),
  resolutionNote: record.resolutionNote,
  programId: record.programId,
  emailSentAt: iso(record.emailSentAt),
  lastEmailError: record.lastEmailError,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString()
});

const adminDetail = (
  detail: ChangeRequestDetail,
  catalogueImpact: string[] | null
): AdminRequestDetail => ({
  ...adminView(detail),
  catalogueImpact,
  messages: detail.messages.map((message) => ({
    id: message.id,
    authorKind: message.authorKind,
    authorEmail: message.authorEmail,
    body: message.body,
    createdAt: message.createdAt.toISOString()
  }))
});

/* ---- the service ---- */

/** Who is writing on the clinic's side. The role has already been checked by the caller. */
export interface ClinicActor {
  email: string;
  role: "OWNER" | "MANAGER";
}

export interface AdminActor {
  email: string;
}

export interface ChangeRequestServiceOptions {
  notifier?: ChangeRequestNotifier;
  /** The clock, injectable so the reopen window is testable at its boundary. */
  now?: () => Date;
  /** Applies service and bono tickets and reports their effect on the live programme. */
  changes?: CatalogueChanges;
  /** Starts programme drafts from REWARD and LEVEL tickets. */
  programs?: ProgramDrafts;
}

export interface ClinicListQuery {
  status?: ChangeRequestStatus;
  cursor?: ListCursor;
  limit: number;
}

export interface AdminListQuery extends ClinicListQuery {
  clinicId?: string;
  type?: ChangeRequestType;
  q?: string;
}

export interface StatusUpdate {
  status: ChangeRequestStatus;
  resolutionNote?: string;
}

const WINDOW_CLOSED_MESSAGE = `Esta solicitud se cerró hace más de ${REOPEN_WINDOW_DAYS} días y ya no se puede reabrir. Crea una nueva solicitud.`;
const NOT_CLOSED_MESSAGE = "Esta solicitud ya está abierta.";
const STALE_MESSAGE =
  "La solicitud ha cambiado mientras la editabas. Recárgala e inténtalo de nuevo.";
const alreadyClosed = (
  message = "This request is already resolved or rejected, so it cannot be applied."
) => new ChangeRequestConflictError("CHANGE_REQUEST_ALREADY_CLOSED", message);
const NOTE_REQUIRED_MESSAGE = "Escribe una nota de resolución.";

export class ChangeRequestService {
  private readonly notifier: ChangeRequestNotifier;
  private readonly now: () => Date;
  private readonly changes?: CatalogueChanges;
  private readonly programs?: ProgramDrafts;

  constructor(
    private readonly repo: ChangeRequestRepository,
    options: ChangeRequestServiceOptions = {}
  ) {
    this.notifier = options.notifier ?? noopChangeRequestNotifier;
    this.now = options.now ?? (() => new Date());
    this.changes = options.changes;
    this.programs = options.programs;
  }

  /* ---- the clinic's side ---- */

  async create(
    clinicId: string,
    actor: ClinicActor,
    input: ChangeRequestInput
  ): Promise<OwnerRequestView> {
    const now = this.now();
    const record = await this.repo.createWithinLimit(
      {
        clinicId,
        type: input.type,
        targetRef: input.targetRef,
        title: input.title,
        reason: input.reason,
        proposed: input.proposed,
        createdByEmail: actor.email,
        createdByRole: actor.role,
        createdAt: now
      },
      OPEN_LIMIT
    );

    if (!record) throw new ChangeRequestLimitError(OPEN_LIMIT);

    const detail = await this.repo.find(record.id);

    if (detail) await this.notify("onCreated", () => this.notifier.onCreated(detail));

    return ownerView(record, now);
  }

  async listForClinic(clinicId: string, query: ClinicListQuery): Promise<Page<OwnerListItem>> {
    const now = this.now();
    const page = this.page(await this.repo.list({ ...query, clinicId }), query.limit);

    return {
      items: page.items.map((row) => ({
        ...ownerView(row, now),
        messageCount: row.messageCount,
        lastMessageAt: iso(row.lastMessageAt)
      })),
      nextCursor: page.nextCursor
    };
  }

  async getForClinic(clinicId: string, id: string): Promise<OwnerRequestDetail> {
    return ownerDetail(await this.requireForClinic(clinicId, id), this.now());
  }

  async replyAsClinic(
    clinicId: string,
    id: string,
    actor: ClinicActor,
    body: string
  ): Promise<OwnerRequestDetail> {
    const ticket = await this.requireForClinic(clinicId, id);
    const now = this.now();
    const reopenFrom = isClosed(ticket.status) ? ticket.status : undefined;

    if (reopenFrom) {
      this.requireInsideWindow(ticket, now);
      await this.requireRoomToReopen(clinicId);
    }

    const message = await this.repo.appendMessage(
      id,
      { authorKind: "CLINIC", authorEmail: actor.email, body, createdAt: now },
      reopenFrom
    );

    if (!message) throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);

    const after = await this.requireForClinic(clinicId, id);

    // A reply that reopens is reported once, as the reply (it says what it reopened from), so
    // a mail hook does not write twice for one action.
    await this.notify("onOwnerReply", () => this.notifier.onOwnerReply(after, message, reopenFrom));

    return ownerDetail(after, now);
  }

  async reopenAsClinic(
    clinicId: string,
    id: string,
    actor: ClinicActor,
    message?: string
  ): Promise<OwnerRequestDetail> {
    const ticket = await this.requireForClinic(clinicId, id);
    const now = this.now();

    if (!isClosed(ticket.status)) {
      throw new ChangeRequestConflictError("CHANGE_REQUEST_NOT_CLOSED", NOT_CLOSED_MESSAGE);
    }

    this.requireInsideWindow(ticket, now);
    await this.requireRoomToReopen(clinicId);

    const previous = ticket.status;
    let written: MessageRecord | null = null;

    if (message !== undefined) {
      written = await this.repo.appendMessage(
        id,
        { authorKind: "CLINIC", authorEmail: actor.email, body: message, createdAt: now },
        previous
      );

      if (!written) throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);
    } else if (!(await this.repo.transition(id, previous, REOPEN_PATCH))) {
      throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);
    }

    const after = await this.requireForClinic(clinicId, id);

    if (written) {
      const sent = written;

      await this.notify("onOwnerReply", () => this.notifier.onOwnerReply(after, sent, previous));
    } else {
      await this.notify("onStatusChanged", () =>
        this.notifier.onStatusChanged(after, previous, "CLINIC")
      );
    }

    return ownerDetail(after, now);
  }

  /* ---- Voone's side ---- */

  async adminList(query: AdminListQuery): Promise<Page<AdminListItem>> {
    const page = this.page(await this.repo.list(query), query.limit);

    return {
      items: page.items.map((row) => ({
        ...adminView(row),
        messageCount: row.messageCount,
        lastMessageAt: iso(row.lastMessageAt)
      })),
      nextCursor: page.nextCursor
    };
  }

  async adminGet(id: string): Promise<AdminRequestDetail> {
    return this.withImpact(await this.requireAny(id));
  }

  async adminSetStatus(
    id: string,
    actor: AdminActor,
    update: StatusUpdate
  ): Promise<AdminRequestDetail> {
    const ticket = await this.requireAny(id);
    const previous = ticket.status;

    if (!ALLOWED_TRANSITIONS[previous].includes(update.status)) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_INVALID_TRANSITION",
        `No se puede pasar la solicitud de ${previous} a ${update.status}.`
      );
    }

    const closing = isClosed(update.status);
    const note = update.resolutionNote?.trim() ?? "";

    if (closing && note === "") {
      throw new ChangeRequestValidationError(NOTE_REQUIRED_MESSAGE);
    }

    const patch: StatusPatch = closing
      ? {
          status: update.status,
          resolvedAt: this.now(),
          resolvedByEmail: actor.email,
          resolutionNote: note
        }
      : { status: update.status, resolvedAt: null, resolvedByEmail: null, resolutionNote: null };

    if (!(await this.repo.transition(id, previous, patch))) {
      throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);
    }

    const after = await this.requireAny(id);

    await this.notify("onStatusChanged", () =>
      this.notifier.onStatusChanged(after, previous, "VOONE")
    );

    return this.withImpact(after);
  }

  async adminReply(id: string, actor: AdminActor, body: string): Promise<AdminRequestDetail> {
    await this.requireAny(id);

    const message = await this.repo.appendMessage(id, {
      authorKind: "VOONE",
      authorEmail: actor.email,
      body,
      createdAt: this.now()
    });

    if (!message) throw new ChangeRequestNotFoundError();

    const after = await this.requireAny(id);

    await this.notify("onAdminReply", () => this.notifier.onAdminReply(after, message));

    return this.withImpact(after);
  }

  /**
   * Makes the change a SERVICE_* or BONO ticket asks for, through the same treatment and bono
   * services the owner used to call, and resolves the ticket, as one transaction: if the change
   * is refused the ticket stays open, and a second apply is a 409 because the first resolved it.
   * Never blocked by the programme: a warning is information, not a veto.
   */
  async adminApply(id: string, actor: AdminActor, note?: string): Promise<ApplyResult> {
    const changes = this.changes;

    if (!changes) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_NOT_APPLICABLE",
        "Applying requests is not available."
      );
    }

    const ticket = await this.requireAny(id);

    if (!APPLICABLE_TYPES.has(ticket.type)) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_NOT_APPLICABLE",
        `Requests of type ${ticket.type} cannot be applied automatically.`
      );
    }

    if (isClosed(ticket.status)) throw alreadyClosed();

    const previous = ticket.status;
    const now = this.now();
    const done = await this.repo.resolveAtomically(id, async (db) => {
      // Before the change, so a treatment about to be removed can still be found.
      const warnings = (await changes.impact(ticket, { db, applied: true })) ?? [];
      const applied = await changes.apply(db, ticket);

      return {
        result: { applied, warnings },
        patch: {
          status: "RESOLVED" as const,
          resolvedAt: now,
          resolvedByEmail: actor.email,
          resolutionNote: note?.trim() || `Applied: ${applied.summary}`
        }
      };
    });

    if (!done) throw alreadyClosed();

    const after = await this.requireAny(id);

    await this.notify("onStatusChanged", () =>
      this.notifier.onStatusChanged(after, previous, "VOONE")
    );

    return { request: await this.withImpact(after), ...done };
  }

  /**
   * Starts the programme change a REWARD or LEVEL ticket asks for: reuses the clinic's draft or
   * clones its ACTIVE programme into one (never pre-applying the proposed values; the admin
   * edits the draft), links it to the ticket and moves OPEN to IN_PROGRESS.
   */
  async adminDraft(id: string): Promise<DraftResult> {
    const programs = this.programs;

    if (!programs) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_NOT_APPLICABLE",
        "Programme drafts are not available."
      );
    }

    const ticket = await this.requireAny(id);

    if (ticket.type !== "REWARD" && ticket.type !== "LEVEL") {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_NOT_APPLICABLE",
        "Only REWARD and LEVEL requests can start a programme draft."
      );
    }

    if (isClosed(ticket.status))
      throw alreadyClosed("This request is already resolved or rejected.");

    let programId = await programs.draftProgramId(ticket.clinicId);

    if (!programId) {
      const active = await programs.activeProgramId(ticket.clinicId);

      if (!active) {
        throw new ChangeRequestConflictError(
          "CHANGE_REQUEST_NO_PROGRAMME",
          "This clinic has no active programme and no draft to work from."
        );
      }

      try {
        programId = await programs.cloneDraft(ticket.clinicId, active);
      } catch (error) {
        // Two simultaneous clones: the loser finds the winner's draft and uses it.
        programId = await programs.draftProgramId(ticket.clinicId);

        if (!programId) throw error;
      }
    }

    const previous = await this.repo.linkProgram(id, programId);

    if (!previous) throw alreadyClosed("This request is already resolved or rejected.");

    const after = await this.requireAny(id);

    if (previous === "OPEN") {
      await this.notify("onStatusChanged", () =>
        this.notifier.onStatusChanged(after, "OPEN", "VOONE")
      );
    }

    return { request: await this.withImpact(after), programId };
  }

  /**
   * After the admin publishes a draft: resolves every open ticket linked to that programme,
   * with one note. Only for the ACTIVE programme, since a draft is not yet an answer.
   */
  async adminResolveLinked(
    clinicId: string,
    programId: string,
    actor: AdminActor,
    note: string
  ): Promise<{ resolved: string[] }> {
    const text = note.trim();

    if (text === "") throw new ChangeRequestValidationError(NOTE_REQUIRED_MESSAGE);

    const programs = this.programs;

    if (!programs) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_NOT_APPLICABLE",
        "Programme drafts are not available."
      );
    }

    const status = await programs.statusOf(clinicId, programId);

    if (!status) throw new ProgrammeNotFoundError();

    if (status !== "ACTIVO") {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_PROGRAMME_NOT_ACTIVE",
        "Only the published (active) programme's tickets can be resolved; publish the draft first."
      );
    }

    const now = this.now();
    const done: Array<{ id: string; previous: ChangeRequestStatus }> = [];

    for (const ticket of await this.repo.findUnresolvedByProgram(clinicId, programId)) {
      const moved = await this.repo.transition(ticket.id, ticket.status, {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedByEmail: actor.email,
        resolutionNote: text
      });

      // A ticket someone else moved meanwhile is theirs; skip it rather than overwrite.
      if (moved) done.push({ id: ticket.id, previous: ticket.status });
    }

    for (const { id, previous } of done) {
      const after = await this.repo.find(id);

      if (after) {
        await this.notify("onStatusChanged", () =>
          this.notifier.onStatusChanged(after, previous, "VOONE")
        );
      }
    }

    return { resolved: done.map((entry) => entry.id) };
  }

  /* ---- shared ---- */

  private async withImpact(detail: ChangeRequestDetail): Promise<AdminRequestDetail> {
    return adminDetail(detail, this.changes ? await this.changes.impact(detail) : null);
  }

  private async requireForClinic(clinicId: string, id: string): Promise<ChangeRequestDetail> {
    const ticket = await this.repo.find(id, clinicId);

    if (!ticket) throw new ChangeRequestNotFoundError();

    return ticket;
  }

  private async requireAny(id: string): Promise<ChangeRequestDetail> {
    const ticket = await this.repo.find(id);

    if (!ticket) throw new ChangeRequestNotFoundError();

    return ticket;
  }

  private requireInsideWindow(ticket: ChangeRequestRecord, now: Date): void {
    // A closed ticket always has resolvedAt; without it there is nothing to measure from, so
    // refuse rather than guess.
    if (!ticket.resolvedAt || now.getTime() - ticket.resolvedAt.getTime() > REOPEN_WINDOW_MS) {
      throw new ChangeRequestConflictError(
        "CHANGE_REQUEST_REOPEN_WINDOW_CLOSED",
        WINDOW_CLOSED_MESSAGE
      );
    }
  }

  /** A reopen makes a ticket count against the cap again, so it is held to it. */
  private async requireRoomToReopen(clinicId: string): Promise<void> {
    if ((await this.repo.countUnresolved(clinicId)) >= OPEN_LIMIT) {
      throw new ChangeRequestLimitError(OPEN_LIMIT);
    }
  }

  private page<T extends ChangeRequestListRow>(
    rows: T[],
    limit: number
  ): { items: T[]; nextCursor: string | null } {
    const items = rows.slice(0, limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null
    };
  }

  /** Hooks run after the commit and can never fail the request. */
  private async notify(hook: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      console.error(`[change-requests] notifier ${hook} failed`, error);
    }
  }
}

const REOPEN_PATCH: StatusPatch = {
  status: "OPEN",
  resolvedAt: null,
  resolvedByEmail: null,
  resolutionNote: null
};

export type { StatusChangedBy };
