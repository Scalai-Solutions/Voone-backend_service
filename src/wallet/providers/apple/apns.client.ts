import { connect, constants, type ClientHttp2Session } from "node:http2";

import type { AppleWalletCertificates } from "../../../config/apple-wallet.config";

/**
 * The APNs transport, kept behind an interface so the refresh channel can be tested
 * without a socket and without Apple's certificate.
 */
export interface ApnsClient {
  /** Sends one wake-up. Never throws for a rejection Apple reports — that is a result. */
  send(deviceToken: string, topic: string): Promise<ApnsResult>;
  close(): Promise<void>;
}

export interface ApnsResult {
  /** HTTP status APNs answered with. 200 is delivered-to-APNs, not delivered-to-device. */
  status: number;
  /** APNs' machine-readable reason, e.g. "Unregistered", "BadDeviceToken". */
  reason?: string;
}

/**
 * Pass updates only exist in production.
 *
 * Apple's sandbox host accepts these pushes and silently never delivers them, which is a
 * uniquely expensive failure: everything looks correct — 200s in the log, no errors — and
 * the passes simply never refresh. There is deliberately no way to point this at sandbox.
 */
export const APNS_HOST = "https://api.push.apple.com";

/** A dead device token. The registration should be forgotten rather than retried. */
export const isDeadToken = (result: ApnsResult): boolean =>
  result.status === 410 ||
  (result.status === 400 &&
    (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"));

/**
 * APNs over HTTP/2, authenticated with the Pass Type ID certificate.
 *
 * Certificate auth rather than a .p8 token key, deliberately. Apple accepts either, but
 * the certificate that signs the passes is the same credential APNs will take — so there
 * is no second secret to create, deploy, rotate and keep in step, and one renewal covers
 * both signing and pushing. A .p8 would be a separate expiry to forget about.
 *
 * The session is long-lived and lazily opened: APNs explicitly wants connections reused,
 * and opening one per push is both slow and a good way to get throttled.
 */
export class Http2ApnsClient implements ApnsClient {
  private session: ClientHttp2Session | null = null;

  constructor(
    private readonly certificates: AppleWalletCertificates,
    private readonly host: string = APNS_HOST,
    private readonly requestTimeoutMs = 10_000
  ) {}

  private open(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }

    const session = connect(this.host, {
      cert: this.certificates.signerCert,
      key: this.certificates.signerKey,
      passphrase: this.certificates.signerKeyPassphrase
    });

    // Without this an otherwise idle process keeps the event loop alive on a socket it is
    // not using, which stops the worker shutting down cleanly.
    session.unref();

    // A connection-level error must not become an unhandled rejection. Dropping the
    // reference is enough: the next send opens a fresh session.
    session.on("error", () => {
      if (this.session === session) this.session = null;
    });
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });

    this.session = session;
    return session;
  }

  async send(deviceToken: string, topic: string): Promise<ApnsResult> {
    const session = this.open();

    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      const settle = (result: ApnsResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let request;

      try {
        request = session.request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
          // Sent even though a PassKit-only certificate makes it optional: it costs
          // nothing and it is required the moment the certificate gains another
          // capability, which is not a failure anyone wants to debug later.
          "apns-topic": topic,
          // A pass update is worth waking the device for, and coalescing is safe —
          // the payload carries no information, so a dropped duplicate loses nothing.
          "apns-priority": "10",
          // Let APNs hold it for a day. A phone that is off overnight still gets the
          // refresh; beyond that the device's own periodic poll will catch up.
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 86_400)
        });
      } catch {
        // The session died between open() and request().
        this.session = null;
        return settle({ status: 0, reason: "SessionUnavailable" });
      }

      request.setTimeout(this.requestTimeoutMs, () => {
        request.close(constants.NGHTTP2_CANCEL);
        settle({ status: 0, reason: "Timeout" });
      });

      let status = 0;
      let body = "";

      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("error", (error: Error) => settle({ status: 0, reason: error.message }));
      request.on("end", () => {
        // 200 has an empty body; every rejection carries {"reason": "..."}.
        let reason: string | undefined;

        if (body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            reason = body.slice(0, 120);
          }
        }

        settle({ status, reason });
      });

      // The payload is an empty JSON dictionary. Apple is specific about this: a pass
      // push carries no content, it only says "something with this pass type changed".
      // Anything else here is rejected on the device rather than by APNs, which is why
      // it looks like it worked.
      request.end("{}");
    });
  }

  async close(): Promise<void> {
    const session = this.session;

    this.session = null;

    if (!session || session.closed || session.destroyed) return;

    await new Promise<void>((resolve) => session.close(() => resolve()));
  }
}
