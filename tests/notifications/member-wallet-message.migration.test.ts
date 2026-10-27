import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Re-runs the migration's SQL in a transaction that is always rolled back: the table is
 * dropped first (Postgres DDL is transactional), so the local database ends exactly as it
 * began.
 */
const db = new PrismaClient();
const sql = readFileSync(
  join(__dirname, "../../prisma/migrations/20261027090000_member_wallet_message/migration.sql"),
  "utf8"
);

class Rollback extends Error {}

const statements = sql
  .split(";")
  .map((part) =>
    part
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim()
  )
  .filter(Boolean);

afterAll(async () => {
  await db.$disconnect();
});

describe("migration member_wallet_message", () => {
  it("touches only the MemberWalletMessage table", () => {
    for (const statement of statements) {
      expect(statement).toMatch(/MemberWalletMessage/);
    }
  });

  it("creates a table keyed by member that cascades with the member", async () => {
    let afterInsert = 0;
    let afterDuplicate = "";
    let afterCascade = -1;

    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe('DROP TABLE "MemberWalletMessage"');

        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        const clinic = await tx.clinic.create({
          data: { slug: `mig-wm-${Date.now()}`, name: "x", addressLine: "x", pincode: "1" }
        });
        const member = await tx.member.create({
          data: {
            clinicId: clinic.id,
            name: "Miembro",
            consentMarketing: false,
            consentSource: "staff_entry"
          }
        });
        const message = {
          memberId: member.id,
          header: "Título",
          body: "cuerpo",
          sentAt: new Date("2026-10-27T10:00:00Z")
        };

        await tx.memberWalletMessage.create({ data: message });
        afterInsert = await tx.memberWalletMessage.count({ where: { memberId: member.id } });

        // One row per member: the primary key refuses a second.
        await tx.$executeRawUnsafe("SAVEPOINT duplicate");
        try {
          await tx.memberWalletMessage.create({ data: message });
        } catch (error) {
          afterDuplicate = error instanceof Error ? error.message : String(error);
        }
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT duplicate");

        await tx.$executeRawUnsafe('DELETE FROM "Member" WHERE "id" = $1', member.id);
        afterCascade = await tx.memberWalletMessage.count({ where: { memberId: member.id } });

        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(afterInsert).toBe(1);
    expect(afterDuplicate).toMatch(/Unique constraint|duplicate/i);
    expect(afterCascade).toBe(0);
  });
});
