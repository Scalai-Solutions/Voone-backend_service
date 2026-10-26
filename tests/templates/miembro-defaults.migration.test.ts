import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WALLET_BENEFITS_TEXT } from "../../src/modules/templates/default-voone-template";

/**
 * Runs the migration's SQL against rows in a transaction that is always rolled back, so
 * the local database is left exactly as it was found.
 */
const db = new PrismaClient();
const sql = readFileSync(
  join(__dirname, "../../prisma/migrations/20261026093000_miembro_defaults/migration.sql"),
  "utf8"
);

const OLD_BENEFITS =
  "Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales.";
const OWNER_BENEFITS = "Ventajas exclusivas para socias, con un café de cortesía.";

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

describe("migration miembro_defaults", () => {
  it("rewrites default rows and leaves owner-edited text and labels alone", async () => {
    let clinics: Record<string, { benefitsText: string; infoText: string; tierLabel: string }> = {};
    let voone: Record<string, { benefitsText: string | null; tierLabel: string }> = {};

    await db
      .$transaction(async (tx) => {
        const preset = await tx.templatePreset.findFirstOrThrow();
        const stamp = Date.now();
        const make = async (
          key: string,
          fields: { benefitsText: string; tierLabel: string; infoText?: string }
        ) => {
          const clinic = await tx.clinic.create({
            data: { slug: `mig-${key}-${stamp}`, name: key, addressLine: "x", pincode: "1" }
          });

          await tx.clinicTemplate.create({
            data: {
              clinicId: clinic.id,
              presetId: preset.id,
              programName: "Club",
              hexBackgroundColor: "#30221f",
              pointsLabel: "Puntos",
              infoText: "Presenta tu pase en recepción antes del pago para sumar puntos.",
              ...fields
            }
          });

          return clinic.id;
        };

        const ids = {
          oldDefault: await make("old-default", {
            benefitsText: OLD_BENEFITS,
            tierLabel: "Miembro Gold"
          }),
          ownerEdited: await make("owner-edited", {
            benefitsText: OWNER_BENEFITS,
            tierLabel: "Oro de la casa",
            infoText: "Texto propio de la clínica."
          })
        };

        const voone1 = (id: string, benefitsText: string, tierLabel: string) => ({
          id,
          name: id,
          programName: "Club",
          hexBackgroundColor: "#30221f",
          pointsLabel: "Puntos",
          tierLabel,
          benefitsText
        });

        await tx.vooneTemplate.createMany({
          data: [
            voone1("v-old", OLD_BENEFITS, "Miembro Gold"),
            voone1("v-owner", OWNER_BENEFITS, "Oro de la casa")
          ]
        });

        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        const rows = await tx.clinicTemplate.findMany({
          where: { clinicId: { in: Object.values(ids) } }
        });

        clinics = Object.fromEntries(
          Object.entries(ids).map(([key, id]) => {
            const found = rows.find((r) => r.clinicId === id)!;

            return [
              key,
              {
                benefitsText: found.benefitsText,
                infoText: found.infoText,
                tierLabel: found.tierLabel
              }
            ];
          })
        );
        voone = Object.fromEntries(
          (await tx.vooneTemplate.findMany({ where: { id: { in: ["v-old", "v-owner"] } } })).map(
            (r) => [r.id, { benefitsText: r.benefitsText, tierLabel: r.tierLabel }]
          )
        );

        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(clinics.oldDefault.benefitsText).toBe(DEFAULT_WALLET_BENEFITS_TEXT);
    expect(clinics.oldDefault.tierLabel).toBe("Nivel");
    expect(clinics.ownerEdited).toEqual({
      benefitsText: OWNER_BENEFITS,
      infoText: "Texto propio de la clínica.",
      tierLabel: "Oro de la casa"
    });
    expect(voone["v-old"]).toEqual({
      benefitsText: DEFAULT_WALLET_BENEFITS_TEXT,
      tierLabel: "Nivel"
    });
    expect(voone["v-owner"]).toEqual({ benefitsText: OWNER_BENEFITS, tierLabel: "Oro de la casa" });
  });
});
