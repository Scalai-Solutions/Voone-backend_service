import { WalletProviderType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AutomationDispatchService } from "../../../src/modules/notifications/automations/dispatch.service";

interface Setup {
  settings?: Record<string, unknown> | null;
  automations?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  queued?: string[];
}

const build = ({ settings = {}, automations = [], members = [], queued = ["d1"] }: Setup = {}) => {
  const created: Array<Record<string, unknown>> = [];
  const memberQueries: Array<{ where: Record<string, unknown> }> = [];
  const enqueued: string[] = [];
  const prisma = {
    clinic: {
      findUnique: async () => ({ name: "Clínica Sol", notificationSettings: settings, automations })
    },
    member: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        memberQueries.push(args);
        return members;
      }
    },
    notification: { upsert: async () => ({ id: "n1" }) },
    notificationDelivery: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        created.push(...data);
        return { count: data.length };
      },
      findMany: async () => queued.map((id) => ({ id }))
    },
    notificationAuditLog: { create: vi.fn(async () => undefined) }
  };
  const service = new AutomationDispatchService(prisma as never, {
    enqueueDelivery: async (id: string) => void enqueued.push(id)
  });

  return { service, created, memberQueries, enqueued, prisma };
};

const lucia = {
  id: "m1",
  name: "Lucía Pérez",
  walletObjects: [{ provider: WalletProviderType.GOOGLE }, { provider: WalletProviderType.APPLE }]
};

describe("AutomationDispatchService", () => {
  it("renders each member's text from the catalog defaults and queues their deliveries", async () => {
    const { service, created, enqueued } = build({
      settings: { marketingEnabled: true, googleReviewUrl: "https://g.page/r/abc" },
      automations: [
        {
          event: "REVIEW_REQUEST",
          enabled: true,
          header: "¿Qué tal en {clinic_name}?",
          body: "Hola {first_name}: {google_maps_link}",
          notify: true
        }
      ],
      members: [lucia]
    });

    const result = await service.dispatch({
      clinicId: "c1",
      event: "REVIEW_REQUEST",
      idempotencyKey: "review:c1:2026-11-01",
      recipients: [{ memberId: "m1" }]
    });

    expect(result).toMatchObject({ notificationId: "n1", recipients: 1, deliveriesCreated: 2 });
    expect(created.map((d) => [d.provider, d.header, d.body])).toEqual([
      ["GOOGLE", "¿Qué tal en Clínica Sol?", "Hola Lucía: https://g.page/r/abc"],
      ["APPLE", "¿Qué tal en Clínica Sol?", "Hola Lucía: https://g.page/r/abc"]
    ]);
    expect(enqueued).toEqual(["d1"]);
  });

  it("does nothing for an event the clinic has switched off", async () => {
    const { service, created } = build({
      automations: [{ event: "BIRTHDAY", enabled: false, header: "h", body: "b", notify: true }],
      members: [lucia]
    });

    const result = await service.dispatch({
      clinicId: "c1",
      event: "BIRTHDAY",
      idempotencyKey: "k",
      recipients: [{ memberId: "m1" }]
    });

    expect(result.skipped).toBe("DISABLED");
    expect(created).toEqual([]);
  });

  it("refuses to send the review request until the clinic has set its Google link", async () => {
    const { service, created } = build({
      settings: { marketingEnabled: true, googleReviewUrl: null },
      automations: [
        { event: "REVIEW_REQUEST", enabled: true, header: "h", body: "b", notify: true }
      ],
      members: [lucia]
    });

    const result = await service.dispatch({
      clinicId: "c1",
      event: "REVIEW_REQUEST",
      idempotencyKey: "k",
      recipients: [{ memberId: "m1" }]
    });

    expect(result.skipped).toBe("MISSING_CLINIC_VALUE");
    expect(created).toEqual([]);
  });

  it("asks for marketing consent on marketing events but not on service messages", async () => {
    const marketing = build({
      settings: { marketingEnabled: true, referralRewardText: "10 € de descuento" },
      automations: [
        { event: "REFERRAL_PROMO", enabled: true, header: "h", body: "b", notify: true }
      ],
      members: [lucia]
    });
    await marketing.service.dispatch({
      clinicId: "c1",
      event: "REFERRAL_PROMO",
      idempotencyKey: "k",
      recipients: [{ memberId: "m1" }]
    });
    expect(marketing.memberQueries[0].where.consentMarketing).toBe(true);

    const service = build({ members: [lucia] });
    await service.service.dispatch({
      clinicId: "c1",
      event: "BONO_INACTIVE",
      idempotencyKey: "k",
      recipients: [{ memberId: "m1" }]
    });
    expect(service.memberQueries[0].where).not.toHaveProperty("consentMarketing");
  });

  it("is off for marketing events when the clinic's marketing switch is off", async () => {
    const { service } = build({ settings: { marketingEnabled: false }, members: [lucia] });

    const result = await service.dispatch({
      clinicId: "c1",
      event: "BIRTHDAY",
      idempotencyKey: "k",
      recipients: [{ memberId: "m1" }]
    });

    expect(result.skipped).toBe("MARKETING_OFF");
  });

  it("fills per-send values such as the new tier", async () => {
    const { service, created } = build({ members: [lucia] });

    await service.dispatch({
      clinicId: "c1",
      event: "TIER_UPGRADE",
      idempotencyKey: "tier:m1:Oro",
      recipients: [{ memberId: "m1", values: { new_tier: "Oro", benefits_summary: "descuentos" } }]
    });

    expect(created[0].header).toBe("¡Enhorabuena! Has subido al nivel Oro 🏆");
    expect(created[0].body).toContain("como: descuentos.");
  });

  it("re-queues leftover deliveries even when there are no new recipients", async () => {
    const { service, enqueued } = build({ members: [], queued: ["left-over"] });

    await service.dispatch({
      clinicId: "c1",
      event: "BONO_INACTIVE",
      idempotencyKey: "k",
      recipients: []
    });

    expect(enqueued).toEqual(["left-over"]);
  });
});
