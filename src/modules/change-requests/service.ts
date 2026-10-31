import type {
  ChangeRequestAuthorKind,
  ChangeRequestStatus,
  ChangeRequestType
} from "@prisma/client";

import {
  ChangeRequestConflictError,
  ChangeRequestLimitError,
  ChangeRequestNotFoundError,
  ChangeRequestValidationError
} from "../../common/errors/change-request.errors";
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

const adminDetail = (detail: ChangeRequestDetail): AdminRequestDetail => ({
  ...adminView(detail),
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
const NOTE_REQUIRED_MESSAGE = "Escribe una nota de resolución.";

export class ChangeRequestService {
  private readonly notifier: ChangeRequestNotifier;
  private readonly now: () => Date;

  constructor(
    private readonly repo: ChangeRequestRepository,
    options: ChangeRequestServiceOptions = {}
  ) {
    this.notifier = options.notifier ?? noopChangeRequestNotifier;
    this.now = options.now ?? (() => new Date());
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
    return adminDetail(await this.requireAny(id));
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

    return adminDetail(after);
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

    return adminDetail(after);
  }

  /* ---- shared ---- */

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
