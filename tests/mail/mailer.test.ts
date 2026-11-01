import { describe, expect, it } from "vitest";

import { escapeHtml, MailError, SendGridMailer, singleLine } from "../../src/modules/mail/mailer";

const message = { to: "a@x.test", subject: "Hola", text: "t", html: "<p>t</p>" };

const fakeFetch = (status: number, calls: Array<{ url: string; init: RequestInit }> = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });

    return new Response("secret body naming a@x.test", { status });
  }) as unknown as typeof fetch;

describe("SendGridMailer", () => {
  it("throws a short code when it is not configured, without calling out", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];

    for (const options of [{}, { apiKey: "k" }, { fromEmail: "f@x.test" }]) {
      const error = await new SendGridMailer({ ...options, fetch: fakeFetch(202, calls) })
        .send(message)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MailError);
      expect((error as MailError).code).toBe("SENDGRID_NOT_CONFIGURED");
    }
    expect(calls).toHaveLength(0);
  });

  it("posts one personalization per recipient so nobody sees the others", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];

    await new SendGridMailer({
      apiKey: "k",
      fromEmail: "f@x.test",
      fetch: fakeFetch(202, calls)
    }).send({ ...message, to: ["a@x.test", "b@x.test"], subject: "Uno\r\nBcc: evil@x.test" });
    const body = JSON.parse(String(calls[0]!.init.body));

    expect(calls[0]!.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(body.personalizations).toEqual([
      { to: [{ email: "a@x.test" }] },
      { to: [{ email: "b@x.test" }] }
    ]);
    expect(body.from).toEqual({ email: "f@x.test", name: "Voone" });
    expect(body.subject).toBe("Uno Bcc: evil@x.test");
    expect(body.content.map((c: { type: string }) => c.type)).toEqual(["text/plain", "text/html"]);
  });

  it("throws only the status on a non-2xx, never the response body", async () => {
    const error = await new SendGridMailer({
      apiKey: "k",
      fromEmail: "f@x.test",
      fetch: fakeFetch(401)
    })
      .send(message)
      .catch((e: unknown) => e);

    expect((error as MailError).code).toBe("SENDGRID_HTTP_401");
    expect(JSON.stringify(error)).not.toContain("secret");
    expect((error as Error).message).not.toContain("a@x.test");
  });

  it("maps a network failure to a short code", async () => {
    const error = await new SendGridMailer({
      apiKey: "k",
      fromEmail: "f@x.test",
      fetch: (async () => {
        throw new Error("ECONNRESET to a@x.test");
      }) as unknown as typeof fetch
    })
      .send(message)
      .catch((e: unknown) => e);

    expect((error as MailError).code).toBe("SENDGRID_NETWORK");
    expect((error as Error).message).not.toContain("a@x.test");
  });
});

describe("escaping helpers", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;"
    );
  });

  it("collapses line breaks for header values", () => {
    expect(singleLine("a\r\nb\nc ")).toBe("a b c");
  });
});
