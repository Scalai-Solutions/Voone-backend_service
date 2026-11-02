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
  appliedAt: Date | null;
  appliedByEmail: string | null;
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

export interface StatusChange {
  from: ChangeRequestStatus;
  patch: StatusPatch;
  /** Written with the move, in the same transaction. */
  message?: NewMessage;
  /** Refuse ("limit") if the clinic already has this many unresolved tickets. */
  openLimit?: number;
}

export type StatusChangeResult =
  { kind: "ok"; message: MessageRecord | null } | { kind: "stale" } | { kind: "limit" };

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
   * in which case it returns null. Under one lock per clinic, so concurrent creates and
   * reopens cannot overshoot the limit. If the same person already filed the same ticket (type,
   * title, reason) within `dedupeWithinMs`, that one is returned with `duplicate: true` and
   * nothing is written: a retried request, not a second ticket.
   */
  createWithinLimit(
    data: NewChangeRequest,
    limit: number,
    dedupeWithinMs: number
  ): Promise<{ record: ChangeRequestRecord; duplicate: boolean } | null>;
  countUnresolved(clinicId: string): Promise<number>;
  /** With `clinicId`, only a ticket of that clinic: another clinic's id is simply absent. */
  find(id: string, clinicId?: string): Promise<ChangeRequestDetail | null>;
  /** Newest first, ties by id, strictly after the cursor; up to `limit + 1` rows. */
  list(filter: ListFilter): Promise<ChangeRequestListRow[]>;
  /**
   * Moves the ticket only if it is still in `from` ("stale" otherwise, so a decision made on an
   * old view never overwrites a newer one), writing `message` in the same transaction. A move
   * to RESOLVED or REJECTED also writes its resolution note into the thread, as the resolver's
   * message, so a later reopen (which clears the note from the ticket) loses nothing. With
   * `openLimit`, the clinic's unresolved count is checked under the clinic lock first ("limit").
   */
  changeStatus(id: string, change: StatusChange): Promise<StatusChangeResult>;
  /** Adds a message to the thread. Null when the ticket does not exist. */
  appendMessage(id: string, message: NewMessage): Promise<MessageRecord | null>;
  /**
   * Links the ticket to a programme and moves OPEN to IN_PROGRESS, only while it is
   * unresolved. Returns the status it had, or null when it was closed (or moved) meanwhile.
   */
  linkProgram(id: string, programId: string): Promise<ChangeRequestStatus | null>;
  /** The clinic's OPEN or IN_PROGRESS tickets linked to the programme. */
  findUnresolvedByProgram(clinicId: string, programId: string): Promise<ChangeRequestRecord[]>;
  /**
   * The apply step, in one transaction: takes the ticket only if it is OPEN or IN_PROGRESS and
   * has never been applied, runs `work` with a transaction-bound client, then writes the patch
   * `work` returns, marks the ticket applied (appliedAt / appliedByEmail, never cleared) and
   * writes the resolution note into the thread. Null when the ticket was closed or already
   * applied. If `work` throws, nothing is kept, the ticket included.
   */
  applyAtomically<T>(
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
  /** When an admin applied the change; never cleared, even by a reopen. Admin-only. */
  appliedAt: string | null;
  appliedByEmail: string | null;
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
  /**
   * True on a SERVICE_ADD with no category at a centre that files treatments under categories:
   * apply needs a `categoryId` then.
   */
  needsCategory: boolean;
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
  appliedAt: iso(record.appliedAt),
  appliedByEmail: record.appliedByEmail,
  programId: record.programId,
  emailSentAt: iso(record.emailSentAt),
  lastEmailError: record.lastEmailError,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString()
});

const adminDetail = (
  detail: ChangeRequestDetail,
  catalogueImpact: string[] | null,
  needsCategory: boolean
): AdminRequestDetail => ({
  ...adminView(detail),
  catalogueImpact,
  needsCategory,
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
  /**
   * Where notifications run. By default they are fire-and-forget after the commit: the request
   * never waits for mail. Tests pass `(task) => task` to await them before asserting.
   */
  background?: (task: Promise<void>) => void | Promise<void>;
}

/** A ticket filed again with the same type, title and reason by the same person within this is a retry. */
export const DEDUPE_WINDOW_MS = 60 * 1000;

export interface ApplyOptions {
  /** The resolution note; default "Applied: <summary>". */
  note?: string;
  /** The category for a SERVICE_ADD that has none, at a centre that files treatments under categories. */
  categoryId?: string;
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
const STALE_MESSAGE_EN = "The request changed in the meantime. Reload it and try again.";
const alreadyClosed = (
  message = "This request is already resolved or rejected, so it cannot be applied."
) => new ChangeRequestConflictError("CHANGE_REQUEST_ALREADY_CLOSED", message);
const alreadyApplied = () =>
  new ChangeRequestConflictError(
    "CHANGE_REQUEST_ALREADY_APPLIED",
    "This request was already applied; applying it again would repeat the change. Resolve or reject it by hand instead."
  );
const NOTE_REQUIRED_MESSAGE = "A resolution note is required.";

export class ChangeRequestService {
  private readonly notifier: ChangeRequestNotifier;
  private readonly now: () => Date;
  private readonly changes?: CatalogueChanges;
  private readonly programs?: ProgramDrafts;
  private readonly background: (task: Promise<void>) => void | Promise<void>;

  constructor(
    private readonly repo: ChangeRequestRepository,
    options: ChangeRequestServiceOptions = {}
  ) {
    this.notifier = options.notifier ?? noopChangeRequestNotifier;
    this.now = options.now ?? (() => new Date());
    this.changes = options.changes;
    this.programs = options.programs;
    this.background = options.background ?? (() => {});
  }

  /* ---- the clinic's side ---- */

  async create(
    clinicId: string,
    actor: ClinicActor,
    input: ChangeRequestInput
  ): Promise<OwnerRequestView> {
    const now = this.now();
    const created = await this.repo.createWithinLimit(
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
      OPEN_LIMIT,
      DEDUPE_WINDOW_MS
    );

    if (!created) throw new ChangeRequestLimitError(OPEN_LIMIT);

    // A retry of a ticket just filed gets the stored one back, and nobody is told twice.
    if (!created.duplicate) {
      const detail = await this.repo.find(created.record.id);

      if (detail) await this.notify("onCreated", () => this.notifier.onCreated(detail));
    }

    return ownerView(created.record, now);
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
    const draft: NewMessage = {
      authorKind: "CLINIC",
      authorEmail: actor.email,
      body,
      createdAt: now
    };
    let message: MessageRecord | null;

    if (reopenFrom) {
      this.requireInsideWindow(ticket, now);
      message = await this.reopen(id, reopenFrom, draft);
    } else {
      message = await this.repo.appendMessage(id, draft);
    }

    if (!message) throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);

    const after = await this.requireForClinic(clinicId, id);

    // A reply that reopens is reported once, as the reply (it says what it reopened from), so
    // a mail hook does not write twice for one action.
    await this.notify("onOwnerReply", () => this.notifier.onOwnerReply(after, message, reopenFrom));

    return ownerDetail(after, now);
  }

  /**
   * Puts a closed ticket back to OPEN, with a message if given, counting against the clinic's
   * cap under the clinic lock. Returns the message written (null without one).
   */
  private async reopen(
    id: string,
    from: ChangeRequestStatus,
    message?: NewMessage
  ): Promise<MessageRecord | null> {
    const result = await this.repo.changeStatus(id, {
      from,
      patch: { status: "OPEN", resolvedAt: null, resolvedByEmail: null, resolutionNote: null },
      message,
      openLimit: OPEN_LIMIT
    });

    if (result.kind === "limit") throw new ChangeRequestLimitError(OPEN_LIMIT);

    if (result.kind === "stale") {
      throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE);
    }

    return result.message;
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

    const previous = ticket.status;
    const written = await this.reopen(
      id,
      previous,
      message === undefined
        ? undefined
        : { authorKind: "CLINIC", authorEmail: actor.email, body: message, createdAt: now }
    );
    const after = await this.requireForClinic(clinicId, id);

    if (written) {
      await this.notify("onOwnerReply", () => this.notifier.onOwnerReply(after, written, previous));
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

  /** What the admin comparison needs of a ticket: which clinic, and what it asks for. 404 when missing. */
  async adminFlagSubject(
    id: string
  ): Promise<{ clinicId: string; type: string; targetRef: unknown; proposed: unknown }> {
    const { clinicId, type, targetRef, proposed } = await this.requireAny(id);

    return { clinicId, type, targetRef, proposed };
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
        `A request cannot move from ${previous} to ${update.status}.`
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

    const result = await this.repo.changeStatus(id, {
      from: previous,
      patch,
      // Only a closed ticket going back to OPEN adds to the unresolved count.
      openLimit: isClosed(previous) ? OPEN_LIMIT : undefined
    });

    if (result.kind === "limit") throw new ChangeRequestLimitError(OPEN_LIMIT, "en");

    if (result.kind === "stale") {
      throw new ChangeRequestConflictError("CHANGE_REQUEST_STALE", STALE_MESSAGE_EN);
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

    if (!message) throw new ChangeRequestNotFoundError("en");

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
  async adminApply(
    id: string,
    actor: AdminActor,
    options: ApplyOptions = {}
  ): Promise<ApplyResult> {
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

    // Checked before the status: a reopened ticket is open again but was already applied.
    if (ticket.appliedAt) throw alreadyApplied();

    if (isClosed(ticket.status)) throw alreadyClosed();

    if (options.categoryId !== undefined && ticket.type !== "SERVICE_ADD") {
      throw new ChangeRequestValidationError(
        "A category can only be given when applying a SERVICE_ADD request."
      );
    }

    const previous = ticket.status;
    const now = this.now();

    // Read-only and before the transaction: if a read fails inside a Postgres transaction the
    // whole transaction is aborted, and a warning must never be able to break an apply. The
    // treatment about to be removed still exists at this point, so rewards using it are found.
    const warnings = await changes
      .impact(ticket, { applied: true })
      .then((found) => found ?? [])
      .catch(() => []);

    const done = await this.repo.applyAtomically(id, async (db) => {
      const applied = await changes.apply(db, ticket, { categoryId: options.categoryId });

      return {
        result: applied,
        patch: {
          status: "RESOLVED" as const,
          resolvedAt: now,
          resolvedByEmail: actor.email,
          resolutionNote: options.note?.trim() || `Applied: ${applied.summary}`
        }
      };
    });

    if (!done) {
      // Someone got there between the read above and the transaction.
      const latest = await this.requireAny(id);

      throw latest.appliedAt ? alreadyApplied() : alreadyClosed();
    }

    const after = await this.requireAny(id);

    await this.notify("onStatusChanged", () =>
      this.notifier.onStatusChanged(after, previous, "VOONE")
    );

    return { request: await this.withImpact(after), applied: done, warnings };
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
      const moved = await this.repo.changeStatus(ticket.id, {
        from: ticket.status,
        patch: {
          status: "RESOLVED",
          resolvedAt: now,
          resolvedByEmail: actor.email,
          resolutionNote: text
        }
      });

      // A ticket someone else moved meanwhile is theirs; skip it rather than overwrite.
      if (moved.kind === "ok") done.push({ id: ticket.id, previous: ticket.status });
    }

    // N mails are not the response's business: one background task sends them in turn.
    if (done.length > 0) {
      await this.background(
        (async () => {
          for (const { id, previous } of done) {
            const after = await this.repo.find(id).catch(() => null);

            if (after) {
              await this.attempt("onStatusChanged", () =>
                this.notifier.onStatusChanged(after, previous, "VOONE")
              );
            }
          }
        })()
      );
    }

    return { resolved: done.map((entry) => entry.id) };
  }

  /* ---- shared ---- */

  private async withImpact(detail: ChangeRequestDetail): Promise<AdminRequestDetail> {
    const changes = this.changes;

    if (!changes) return adminDetail(detail, null, false);

    const [impact, needsCategory] = await Promise.all([
      changes.impact(detail).catch(() => null),
      changes.needsCategory(detail).catch(() => false)
    ]);

    return adminDetail(detail, impact, needsCategory);
  }

  private async requireForClinic(clinicId: string, id: string): Promise<ChangeRequestDetail> {
    const ticket = await this.repo.find(id, clinicId);

    if (!ticket) throw new ChangeRequestNotFoundError();

    return ticket;
  }

  private async requireAny(id: string): Promise<ChangeRequestDetail> {
    const ticket = await this.repo.find(id);

    if (!ticket) throw new ChangeRequestNotFoundError("en");

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

  /**
   * Hooks run after the commit and can never fail the request: the work is started here, errors
   * are caught and logged, and `background` decides whether anyone waits for it (nobody, unless
   * a test says so).
   */
  private async notify(hook: string, call: () => Promise<void>): Promise<void> {
    await this.background(this.attempt(hook, call));
  }

  private async attempt(hook: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      console.error(
        `[change-requests] notifier ${hook} failed: ${error instanceof Error ? error.name : "Error"}`
      );
    }
  }
}

export type { StatusChangedBy };
