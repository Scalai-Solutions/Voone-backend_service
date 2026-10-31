/**
 * Read-only report on the automated wallet notifications (every event in the automation catalog):
 * clinic settings, past automation sends with per-delivery outcomes, and the candidate
 * pool for upcoming sends. SELECT-only; never writes, never prints secrets.
 *
 *   npm run notify:report
 */
import dotenv from "dotenv";

import { resolveAutomations } from "../src/modules/notifications/automations/automation-settings.service";
import { AUTOMATION_NOTIFICATION_TYPES } from "../src/modules/notifications/automations/catalog";

import { MemberBonoStatus, PrismaClient, WalletSyncStatus } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

const AUTOMATION_TYPES = [...AUTOMATION_NOTIFICATION_TYPES];
const DAYS_TO_SCAN = 7;

const monthDay = (date: Date): string =>
  `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const main = async (): Promise<void> => {
  const clinics = await prisma.clinic.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      notificationSettings: { select: { marketingEnabled: true } },
      automations: {
        select: { event: true, enabled: true, header: true, body: true, notify: true }
      }
    },
    orderBy: { createdAt: "asc" }
  });

  console.log("=== Automation settings per clinic ===");
  for (const clinic of clinics) {
    const automations = resolveAutomations(clinic.automations);
    const states = Object.entries(automations)
      .map(
        ([event, value]) =>
          `${event}=${value.enabled ? "on" : "off"}${value.notify ? "" : " (silent)"}`
      )
      .join(", ");

    console.log(
      `${clinic.name}: ${states}, marketing=${clinic.notificationSettings?.marketingEnabled === false ? "off" : "on"}`
    );
  }

  console.log("\n=== Past automation notifications (last 90 days, newest first) ===");
  const notifications = await prisma.notification.findMany({
    where: {
      type: { in: AUTOMATION_TYPES },
      createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000) }
    },
    select: {
      id: true,
      clinicId: true,
      type: true,
      status: true,
      notify: true,
      createdAt: true,
      clinic: { select: { name: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { notificationId: { in: notifications.map((n) => n.id) } },
    select: { notificationId: true, status: true, errorCode: true, provider: true }
  });

  if (notifications.length === 0) {
    console.log("(none found — the automations have never fired, or the cron is not running)");
  }
  for (const n of notifications) {
    const mine = deliveries.filter((d) => d.notificationId === n.id);
    const byStatus = new Map<string, number>();
    for (const d of mine) {
      const key = d.errorCode ? `${d.status}/${d.errorCode}` : d.status;
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }
    const summary = [...byStatus.entries()].map(([key, count]) => `${key}: ${count}`).join(", ");
    console.log(
      `${n.createdAt.toISOString().slice(0, 10)} ${n.clinic.name} [${n.type}] status=${n.status} push=${n.notify ? "yes" : "no"} deliveries: ${mine.length} (${summary || "none"})`
    );
  }

  console.log(`\n=== Birthday candidates, next ${DAYS_TO_SCAN} days ===`);
  const window = new Set<string>();
  for (let offset = 0; offset < DAYS_TO_SCAN; offset += 1) {
    window.add(monthDay(new Date(Date.now() + offset * 24 * 60 * 60 * 1_000)));
  }
  for (const clinic of clinics) {
    const members = await prisma.member.findMany({
      where: { clinicId: clinic.id, erasedAt: null, birthDate: { not: null } },
      select: {
        id: true,
        name: true,
        consentMarketing: true,
        birthDate: true,
        walletObjects: { select: { status: true } }
      }
    });
    const bornToday = members.filter((m) => m.birthDate && window.has(monthDay(m.birthDate)));
    const eligible = bornToday.filter(
      (m) => m.consentMarketing && m.walletObjects.some((w) => w.status === WalletSyncStatus.SYNCED)
    );
    const noConsent = bornToday.filter((m) => !m.consentMarketing).length;
    const noPass = bornToday.filter(
      (m) =>
        m.consentMarketing && !m.walletObjects.some((w) => w.status === WalletSyncStatus.SYNCED)
    ).length;
    if (bornToday.length === 0) continue;
    console.log(
      `${clinic.name}: ${bornToday.length} birthday(s) — will send: ${eligible.map((m) => m.name).join(", ") || "none"}; skipped: ${noConsent} no consent, ${noPass} no synced pass`
    );
  }

  console.log("\n=== Bono candidates (next send: 1st of next month) ===");
  for (const clinic of clinics) {
    const members = await prisma.member.findMany({
      where: {
        clinicId: clinic.id,
        erasedAt: null,
        bonos: { some: { status: MemberBonoStatus.ACTIVE } }
      },
      select: {
        name: true,
        walletObjects: { select: { provider: true, status: true } }
      }
    });
    const eligible = members.filter((m) =>
      m.walletObjects.some((w) => w.status === WalletSyncStatus.SYNCED)
    );
    const noPass = members.length - eligible.length;
    console.log(
      `${clinic.name}: ${members.length} member(s) with an active bono — will send: ${eligible.length}; skipped (no synced pass): ${noPass}`
    );
  }

  await prisma.$disconnect();
};

void main().catch((error) => {
  console.error("notify:report failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
