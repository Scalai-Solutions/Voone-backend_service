import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WALLET_BUTTONS } from "../../src/modules/templates/default-voone-template";

/** Runs the migration's SQL inside a transaction that is always rolled back. */
const db = new PrismaClient();
const sql = readFileSync(
  join(__dirname, "../../prisma/migrations/20261124120000_default_template_voone_es/migration.sql"),
  "utf8"
);

const OLD_BUTTONS = [
  { label: "Web", url: "https://voone.ai", description: "Web", primary: false },
  { label: "Reservar cita", url: "https://voone.app", description: "Reservar cita", primary: true }
];
const OWNER_BUTTONS = [
  { label: "Web", url: "https://clinica-propia.example", description: "Web", primary: false }
];

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

describe("migration default_template_voone_es", () => {
  it("moves the seeded default's website button and leaves an edited template alone", async () => {
    let rows: Record<string, unknown> = {};

    await db
      .$transaction(async (tx) => {
        const base = {
          programName: "Club",
          hexBackgroundColor: "#30221f",
          pointsLabel: "Puntos",
          tierLabel: "Nivel"
        };

        await tx.vooneTemplate.createMany({
          data: [
            { id: "es-old", name: "es-old", buttons: OLD_BUTTONS, ...base },
            { id: "es-owner", name: "es-owner", buttons: OWNER_BUTTONS, ...base }
          ]
        });

        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        const found = await tx.vooneTemplate.findMany({
          where: { id: { in: ["es-old", "es-owner"] } }
        });

        rows = Object.fromEntries(found.map((row) => [row.id, row.buttons]));

        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(rows["es-old"]).toEqual(DEFAULT_WALLET_BUTTONS);
    expect(rows["es-owner"]).toEqual(OWNER_BUTTONS);
  });
});
