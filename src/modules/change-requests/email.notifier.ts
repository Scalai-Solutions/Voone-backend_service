import type { ChangeRequestStatus } from "@prisma/client";

import { escapeHtml, MailError, singleLine, type Mailer } from "../mail/mailer";
import type { ChangeRequestNotifier, StatusChangedBy } from "./notifier";
import type { ChangeRequestDetail, MessageRecord } from "./service";

export type Audience = "voone" | "owners";

/** What the notifier needs from storage: who to write to, and where to note the outcome. */
export interface ChangeRequestMailStore {
  /** The clinic's OWNER users' emails, else its billing email, else none. */
  ownerEmails(clinicId: string): Promise<string[]>;
  /** `kind` is the audience of the mail; a success only clears an error of the same kind. */
  recordSent(requestId: string, at: Date, kind: Audience): Promise<void>;
  recordError(requestId: string, error: string, kind: Audience): Promise<void>;
}

export interface EmailNotifierOptions {
  mailer: Mailer;
  store: ChangeRequestMailStore;
  /** Where Voone's own mail goes. Unset: Voone-side mail is skipped and recorded. */
  supportEmail?: string;
  /** Base of the links in the mails. */
  frontendUrl: string;
  now?: () => Date;
}

/** What `lastEmailError` holds when Voone-side mail is skipped for want of an address. */
export const SUPPORT_EMAIL_UNSET = "VOONE_SUPPORT_EMAIL not set";
export const NO_RECIPIENT = "NO_RECIPIENT";

interface Mail {
  subject: string;
  /** Lines of plain text. */
  text: string[];
  /** Paragraph pieces already escaped by the builder helpers below. */
  html: string[];
}

/** Plain words for the owner, who does not read enum names. */
const STATUS_WORDS: Record<ChangeRequestStatus, string> = {
  OPEN: "reabierta",
  IN_PROGRESS: "en curso",
  RESOLVED: "resuelta",
  REJECTED: "rechazada"
};

const OWNER_SUBJECTS: Record<ChangeRequestStatus, (title: string) => string> = {
  OPEN: (title) => `Tu solicitud "${title}" se ha reabierto`,
  IN_PROGRESS: (title) => `Tu solicitud "${title}" está en curso`,
  RESOLVED: (title) => `Tu solicitud "${title}" está resuelta`,
  REJECTED: (title) => `Tu solicitud "${title}" ha sido rechazada`
};

const p = (value: string): string => `<p>${escapeHtml(value)}</p>`;
/** Free text keeps its line breaks. */
const block = (value: string): string => `<p>${escapeHtml(value).replace(/\r?\n/g, "<br>")}</p>`;
const link = (url: string, label: string): string =>
  `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;

/** A bare, storable name for a failure: MailError's code, else the error class. */
const errorName = (error: unknown): string => {
  if (error instanceof MailError) return error.code;

  return (error instanceof Error ? error.name : "Error").slice(0, 80);
};

/**
 * Tells people about tickets by email. Best-effort by construction: every hook catches
 * everything, notes the outcome on the ticket (`emailSentAt`, or `lastEmailError` holding only
 * a short name, never a response body or an address) and never rethrows, so the ticket is
 * never lost or failed because of mail. `emailSentAt` is the latest success; `lastEmailError`
 * stays until a later mail of the SAME kind (Voone-side or clinic-side) succeeds, so a success
 * to the clinic does not hide a failure to Voone.
 *
 * Voone-side mail (a new ticket, a clinic's reply or reopen) is in English and goes to
 * `supportEmail`. Clinic-side mail (a Voone reply or status change) is in Spanish and goes to
 * the clinic's OWNER users, else its billing email.
 *
 * A clinic reply that reopens a ticket is one mail, from onOwnerReply: the service does not
 * also call onStatusChanged for it.
 */
export class EmailChangeRequestNotifier implements ChangeRequestNotifier {
  private readonly now: () => Date;
  private readonly base: string;

  constructor(private readonly options: EmailNotifierOptions) {
    this.now = options.now ?? (() => new Date());
    this.base = options.frontendUrl.replace(/\/+$/, "");
  }

  async onCreated(request: ChangeRequestDetail): Promise<void> {
    await this.deliver(
      request,
      "voone",
      this.vooneMail(
        request,
        "New change request",
        [["Requested by", `${request.createdByEmail} (${request.createdByRole})`]],
        request.reason
      )
    );
  }

  async onOwnerReply(
    request: ChangeRequestDetail,
    message: MessageRecord,
    reopenedFrom?: ChangeRequestStatus
  ): Promise<void> {
    const mail = this.vooneMail(
      request,
      reopenedFrom ? "Reply and reopened ticket" : "Reply from clinic",
      [
        ["From", message.authorEmail],
        ...(reopenedFrom ? [["Reopened from", reopenedFrom] as [string, string]] : [])
      ],
      message.body
    );

    await this.deliver(request, "voone", mail);
  }

  async onAdminReply(request: ChangeRequestDetail, message: MessageRecord): Promise<void> {
    await this.deliver(request, "owners", {
      subject: `Voone ha respondido a tu solicitud "${request.title}"`,
      text: [
        `Voone ha respondido a tu solicitud "${request.title}":`,
        "",
        message.body,
        "",
        `Verla y responder: ${this.ownerUrl(request)}`
      ],
      html: [
        p(`Voone ha respondido a tu solicitud "${request.title}":`),
        block(message.body),
        link(this.ownerUrl(request), "Ver la solicitud y responder")
      ]
    });
  }

  async onStatusChanged(
    request: ChangeRequestDetail,
    previousStatus: ChangeRequestStatus,
    changedBy: StatusChangedBy
  ): Promise<void> {
    if (changedBy === "CLINIC") {
      await this.deliver(
        request,
        "voone",
        this.vooneMail(
          request,
          "Ticket reopened by clinic",
          [["Reopened from", previousStatus]],
          undefined
        )
      );

      return;
    }

    const word = STATUS_WORDS[request.status];
    const note =
      request.resolutionNote && (request.status === "RESOLVED" || request.status === "REJECTED")
        ? request.resolutionNote
        : undefined;

    await this.deliver(request, "owners", {
      subject: OWNER_SUBJECTS[request.status](request.title),
      text: [
        `Tu solicitud "${request.title}" está ahora ${word}.`,
        ...(note ? ["", `Nota de Voone: ${note}`] : []),
        "",
        `Verla: ${this.ownerUrl(request)}`
      ],
      html: [
        p(`Tu solicitud "${request.title}" está ahora ${word}.`),
        ...(note ? [block(`Nota de Voone: ${note}`)] : []),
        link(this.ownerUrl(request), "Ver la solicitud")
      ]
    });
  }

  /* ---- internals ---- */

  private ownerUrl(request: ChangeRequestDetail): string {
    return `${this.base}/dashboard/requests/${request.id}`;
  }

  private adminUrl(request: ChangeRequestDetail): string {
    return `${this.base}/admin/customer-care/${request.id}`;
  }

  private vooneMail(
    request: ChangeRequestDetail,
    lead: string,
    extra: Array<[string, string]>,
    body: string | undefined
  ): Mail {
    const facts: Array<[string, string]> = [
      ["Clinic", request.clinic.name],
      ["Type", request.type],
      ["Title", request.title],
      ...extra
    ];
    const url = this.adminUrl(request);

    return {
      subject: `${lead}: ${request.clinic.name} - ${request.title}`,
      text: [
        ...facts.map(([label, value]) => `${label}: ${value}`),
        ...(body ? ["", body] : []),
        "",
        `Open it: ${url}`
      ],
      html: [
        ...facts.map(
          ([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`
        ),
        ...(body ? [block(body)] : []),
        link(url, "Open the ticket")
      ]
    };
  }

  private async deliver(
    request: ChangeRequestDetail,
    audience: Audience,
    mail: Mail
  ): Promise<void> {
    try {
      const recipients = await this.recipients(request, audience);

      if (typeof recipients === "string") {
        await this.record(request.id, audience, { error: recipients });

        return;
      }

      await this.options.mailer.send({
        to: recipients,
        subject: singleLine(mail.subject),
        text: mail.text.join("\n"),
        html: mail.html.join("")
      });
      await this.record(request.id, audience, { sentAt: this.now() });
    } catch (error) {
      await this.record(request.id, audience, { error: errorName(error) });
    }
  }

  /** The addresses to write to, or the reason there are none. */
  private async recipients(
    request: ChangeRequestDetail,
    audience: Audience
  ): Promise<string[] | string> {
    if (audience === "voone") {
      return this.options.supportEmail ? [this.options.supportEmail] : SUPPORT_EMAIL_UNSET;
    }

    const owners = await this.options.store.ownerEmails(request.clinicId);

    return owners.length > 0 ? owners : NO_RECIPIENT;
  }

  private async record(
    requestId: string,
    audience: Audience,
    outcome: { sentAt: Date } | { error: string }
  ): Promise<void> {
    try {
      if ("sentAt" in outcome)
        await this.options.store.recordSent(requestId, outcome.sentAt, audience);
      else await this.options.store.recordError(requestId, outcome.error, audience);
    } catch (error) {
      // The outcome is a courtesy too; log the class only, never a message that may name a row.
      console.error(`[change-requests] could not record mail outcome: ${errorName(error)}`);
    }
  }
}
