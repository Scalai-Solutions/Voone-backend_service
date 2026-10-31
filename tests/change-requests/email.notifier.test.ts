import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailChangeRequestNotifier } from "../../src/modules/change-requests/email.notifier";
import { PrismaChangeRequestMailStore } from "../../src/modules/change-requests/prisma.mail-store";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { ChangeRequestService } from "../../src/modules/change-requests/service";
import { MailError, type MailMessage, type Mailer } from "../../src/modules/mail/mailer";

/**
 * The notifier end to end: the real service, repository and mail store on the database, a
 * fake mailer. Slugs are unique to this file (vitest runs files in parallel on one database).
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-mail-a", "test-cr-mail-b", "test-cr-mail-c"];
const SUPPORT = "support@voone.test";
const EVIL = "<script>alert(1)</script>";

let a: Clinic;
let b: Clinic;
let c: Clinic;

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failure?: Error;

  async send(message: MailMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push(message);
  }
}

const mailer = new FakeMailer();
const clock = new Date("2026-06-01T10:00:00.000Z");

const build = (supportEmail: string | null = SUPPORT) =>
  new ChangeRequestService(new PrismaChangeRequestRepository(db), {
    notifier: new EmailChangeRequestNotifier({
      mailer,
      store: new PrismaChangeRequestMailStore(db),
      supportEmail: supportEmail ?? undefined,
      frontendUrl: "https://app.voone.test/",
      now: () => clock
    }),
    now: () => clock
  });

const owner = { email: "dueno@a.test", role: "OWNER" as const };
const admin = { email: "admin@voone.test" };

const wipe = async () => {
  await db.changeRequest.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@mail-test.invalid" } } });
};

beforeAll(async () => {
  const make = (slug: string, name: string, billingEmail?: string) =>
    db.clinic.upsert({
      where: { slug },
      update: { name, billingEmail: billingEmail ?? null },
      create: { slug, name, addressLine: "Calle Prueba 3", pincode: "28001", billingEmail }
    });

  a = await make("test-cr-mail-a", `Clínica <b>Alfa</b> & Co`);
  b = await make("test-cr-mail-b", "Clinica Beta", "facturas@mail-test.invalid");
  c = await make("test-cr-mail-c", "Clinica Gamma");
});

beforeEach(async () => {
  mailer.sent = [];
  mailer.failure = undefined;
  await wipe();
  await db.user.createMany({
    data: [
      { email: "uno@mail-test.invalid", role: "OWNER", clinicId: a.id },
      { email: "dos@mail-test.invalid", role: "OWNER", clinicId: a.id },
      { email: "gerente@mail-test.invalid", role: "MANAGER", clinicId: a.id },
      { email: "otro@mail-test.invalid", role: "OWNER", clinicId: b.id }
    ]
  });
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

const row = (id: string) => db.changeRequest.findUniqueOrThrow({ where: { id } });

const create = async (service: ChangeRequestService, clinic: Clinic = a, title = EVIL) => {
  const ticket = await service.create(clinic.id, owner, {
    type: "OTHER",
    title,
    reason: `Por favor <img src=x onerror=alert(1)> & más`
  } as never);

  mailer.sent = [];

  return ticket;
};

describe("mail to Voone", () => {
  it("a new ticket mails the support address in English with escaped content and the admin link", async () => {
    const service = build();
    const ticket = await service.create(a.id, owner, {
      type: "OTHER",
      title: EVIL,
      reason: `Razón <img src=x onerror=alert(1)> & más`
    } as never);

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;

    expect(mail.to).toEqual([SUPPORT]);
    expect(mail.subject).toContain("New change request");
    expect(mail.text).toContain(EVIL);
    expect(mail.text).toContain(`https://app.voone.test/admin/customer-care/${ticket.id}`);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>Alfa");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.html).toContain("Clínica");
    expect(mail.html).toContain("&lt;b&gt;Alfa&lt;/b&gt; &amp; Co");
    expect(mail.html).toContain(`href="https://app.voone.test/admin/customer-care/${ticket.id}"`);
    const stored = await row(ticket.id);

    expect(stored.emailSentAt?.toISOString()).toBe(clock.toISOString());
    expect(stored.lastEmailError).toBeNull();
  });

  it("a clinic reply mails Voone, once, even when it reopens the ticket", async () => {
    const service = build();
    const ticket = await create(service);

    await service.replyAsClinic(a.id, ticket.id, owner, `Respuesta ${EVIL}`);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toEqual([SUPPORT]);
    expect(mailer.sent[0]!.html).not.toContain("<script>");

    await service.adminSetStatus(ticket.id, admin, { status: "RESOLVED", resolutionNote: "Hecho" });
    mailer.sent = [];
    await service.replyAsClinic(a.id, ticket.id, owner, "Sigue fallando");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toEqual([SUPPORT]);
    expect(mailer.sent[0]!.subject.toLowerCase()).toContain("reopened");
    expect(mailer.sent[0]!.text).toContain("Sigue fallando");
  });

  it("a reopen without a message mails Voone", async () => {
    const service = build();
    const ticket = await create(service);

    await service.adminSetStatus(ticket.id, admin, { status: "REJECTED", resolutionNote: "No" });
    mailer.sent = [];
    await service.reopenAsClinic(a.id, ticket.id, owner);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toEqual([SUPPORT]);
    expect(mailer.sent[0]!.subject.toLowerCase()).toContain("reopened");
  });

  it("skips Voone mail and records the reason when VOONE_SUPPORT_EMAIL is not set", async () => {
    const service = build(null);
    const ticket = await create(service);

    await service.replyAsClinic(a.id, ticket.id, owner, "Hola");
    expect(mailer.sent).toHaveLength(0);
    expect((await row(ticket.id)).lastEmailError).toBe("VOONE_SUPPORT_EMAIL not set");
    expect((await row(ticket.id)).emailSentAt).toBeNull();

    // Clinic-bound mail does not depend on it.
    await service.adminReply(ticket.id, admin, "Respuesta");
    expect(mailer.sent).toHaveLength(1);
    expect((await row(ticket.id)).lastEmailError).toBeNull();
  });
});

describe("mail to the clinic", () => {
  it("an admin reply mails every OWNER user of the clinic, in Spanish, with the dashboard link", async () => {
    const service = build();
    const ticket = await create(service);

    await service.adminReply(ticket.id, admin, `Hola <b>equipo</b> & ${EVIL}`);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;

    // Both owners, not the manager, not another clinic's owner.
    expect([...(mail.to as string[])].sort()).toEqual([
      "dos@mail-test.invalid",
      "uno@mail-test.invalid"
    ]);
    expect(mail.subject).toContain("Voone ha respondido");
    expect(mail.text).toContain(`https://app.voone.test/dashboard/requests/${ticket.id}`);
    expect(mail.html).toContain(`href="https://app.voone.test/dashboard/requests/${ticket.id}"`);
    expect(mail.html).not.toContain("<b>equipo");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;b&gt;equipo&lt;/b&gt; &amp; &lt;script&gt;");
    expect((await row(ticket.id)).emailSentAt).not.toBeNull();
  });

  it("falls back to the billing email when the clinic has no OWNER user", async () => {
    const service = build();
    const ticket = await create(service, b);

    await db.user.deleteMany({ where: { clinicId: b.id } });
    await service.adminReply(ticket.id, admin, "Hola");
    expect(mailer.sent[0]!.to).toEqual(["facturas@mail-test.invalid"]);
  });

  it("records NO_RECIPIENT when there is neither an owner nor a billing email", async () => {
    const service = build();
    const ticket = await create(service, c);

    await service.adminReply(ticket.id, admin, "Hola");
    expect(mailer.sent).toHaveLength(0);
    expect((await row(ticket.id)).lastEmailError).toBe("NO_RECIPIENT");
  });

  it.each([
    ["IN_PROGRESS", undefined, "en curso"],
    ["RESOLVED", "Lo hemos cambiado <b>ya</b>", "resuelta"],
    ["REJECTED", "No es posible & punto", "rechazada"]
  ] as const)(
    "a Voone status change to %s tells the owners in Spanish",
    async (status, note, word) => {
      const service = build();
      const ticket = await create(service);

      await service.adminSetStatus(ticket.id, admin, { status, resolutionNote: note });
      expect(mailer.sent).toHaveLength(1);
      const mail = mailer.sent[0]!;

      expect(mail.to).toHaveLength(2);
      expect(mail.subject).toContain(word);
      expect(mail.text).toContain(word);
      expect(mail.text).toContain(`https://app.voone.test/dashboard/requests/${ticket.id}`);
      expect(mail.html).not.toContain("<script>");
      if (note) {
        expect(mail.text).toContain(note);
        expect(mail.html).not.toContain("<b>ya");
      }
    }
  );

  it("an admin reopen tells the owners it is open again", async () => {
    const service = build();
    const ticket = await create(service);

    await service.adminSetStatus(ticket.id, admin, { status: "RESOLVED", resolutionNote: "Hecho" });
    mailer.sent = [];
    await service.adminSetStatus(ticket.id, admin, { status: "OPEN" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain("reabierto");
  });
});

describe("failure handling", () => {
  it("swallows a mail failure, keeps the ticket and records only a short code", async () => {
    const service = build();

    mailer.failure = new MailError("SENDGRID_HTTP_503");
    const ticket = await service.create(a.id, owner, {
      type: "OTHER",
      title: "Una duda",
      reason: "Necesito ayuda."
    } as never);
    const stored = await row(ticket.id);

    expect(stored.lastEmailError).toBe("SENDGRID_HTTP_503");
    expect(stored.emailSentAt).toBeNull();

    mailer.failure = undefined;
    await service.adminReply(ticket.id, admin, "Hola");
    const after = await row(ticket.id);

    expect(after.lastEmailError).toBeNull();
    expect(after.emailSentAt).not.toBeNull();
  });

  it("records a bare error name for an unexpected failure, never its message", async () => {
    const service = build();

    mailer.failure = new TypeError("connect to dueno@a.test failed");
    const ticket = await service.create(a.id, owner, {
      type: "OTHER",
      title: "Una duda",
      reason: "Necesito ayuda."
    } as never);

    expect((await row(ticket.id)).lastEmailError).toBe("TypeError");
  });
});
