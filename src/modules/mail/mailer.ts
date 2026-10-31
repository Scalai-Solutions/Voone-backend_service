/**
 * Sending mail, behind a port.
 *
 * The real implementation talks to SendGrid over `fetch` (no SDK), the way
 * sendPasswordSetupEmail does, and throws a MailError on missing configuration or a
 * non-2xx answer. Callers that must not fail because of mail (tickets) catch it and record
 * `error.code`: a short name, never a response body, which can echo the recipient or the
 * message.
 */

export interface MailMessage {
  /** One address or several; each recipient gets their own copy, so none sees the others. */
  to: string | string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** A failed send. `code` is safe to store and to log: SENDGRID_NOT_CONFIGURED, SENDGRID_HTTP_<status>, SENDGRID_NETWORK. */
export class MailError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MailError";
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Every value interpolated into mail HTML goes through this, URLs in attributes included. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/** A header value is one line: a stray line break would let a value start a new header. */
export const singleLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

export interface SendGridMailerOptions {
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export class SendGridMailer implements Mailer {
  constructor(private readonly options: SendGridMailerOptions) {}

  async send(message: MailMessage): Promise<void> {
    const { apiKey, fromEmail } = this.options;

    if (!apiKey || !fromEmail) throw new MailError("SENDGRID_NOT_CONFIGURED");

    const recipients = Array.isArray(message.to) ? message.to : [message.to];

    let response: Response;

    try {
      response = await (this.options.fetch ?? fetch)("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: recipients.map((email) => ({ to: [{ email }] })),
          from: { email: fromEmail, name: this.options.fromName ?? "Voone" },
          subject: singleLine(message.subject),
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html }
          ]
        })
      });
    } catch {
      throw new MailError("SENDGRID_NETWORK");
    }

    if (!response.ok) throw new MailError(`SENDGRID_HTTP_${response.status}`);
  }
}

/** The generic helper: sends one message through the given mailer. */
export const sendMail = (mailer: Mailer, message: MailMessage): Promise<void> =>
  mailer.send(message);
