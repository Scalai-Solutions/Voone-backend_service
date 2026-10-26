import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  BORROWED_DEFAULT_HERO_IMAGE_URL,
  BORROWED_DEFAULT_LOGO_URL
} from "../../src/modules/templates/default-voone-template";

/**
 * Runs the migration's SQL against rows in a transaction that is always rolled back, so
 * the local database is left exactly as it was found.
 */
const db = new PrismaClient();
const sql = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20261026092000_clear_borrowed_default_images/migration.sql"
  ),
  "utf8"
);

class Rollback extends Error {}

const row = (id: string, logoUrl: string | null, heroImageUrl: string | null) => ({
  id,
  name: id,
  programName: "Club Prueba",
  hexBackgroundColor: "#30221f",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  logoUrl,
  heroImageUrl
});

afterAll(async () => {
  await db.$disconnect();
});

describe("migration clear_borrowed_default_images", () => {
  it("clears only the two borrowed URLs on VooneTemplate rows and leaves ClinicTemplate rows alone", async () => {
    let seen: Record<string, { logoUrl: string | null; heroImageUrl: string | null }> = {};
    let clinicTemplateLogo: string | null = null;

    await db
      .$transaction(async (tx) => {
        await tx.vooneTemplate.createMany({
          data: [
            row("borrowed", BORROWED_DEFAULT_LOGO_URL, BORROWED_DEFAULT_HERO_IMAGE_URL),
            row("own", "https://clinica.example/logo.png", "https://clinica.example/hero.png"),
            row("same-host", "https://i.ibb.co/own1234/logo.png", null),
            row("empty", null, null)
          ]
        });

        const preset = await tx.templatePreset.findFirstOrThrow();
        const clinic = await tx.clinic.create({
          data: { slug: `mig-${Date.now()}`, name: "Centro Mig", addressLine: "x", pincode: "1" }
        });

        await tx.clinicTemplate.create({
          data: {
            clinicId: clinic.id,
            presetId: preset.id,
            programName: "Club",
            hexBackgroundColor: "#30221f",
            logoUrl: BORROWED_DEFAULT_LOGO_URL,
            pointsLabel: "Puntos",
            tierLabel: "Nivel",
            benefitsText: "Ventajas exclusivas.",
            infoText: "Presenta tu pase."
          }
        });

        for (const statement of sql
          .split(";")
          .map((part) =>
            part
              .split("\n")
              .filter((line) => !line.trim().startsWith("--"))
              .join("\n")
              .trim()
          )
          .filter(Boolean)) {
          await tx.$executeRawUnsafe(statement);
        }

        const rows = await tx.vooneTemplate.findMany({
          where: { id: { in: ["borrowed", "own", "same-host", "empty"] } }
        });

        seen = Object.fromEntries(
          rows.map((r) => [r.id, { logoUrl: r.logoUrl, heroImageUrl: r.heroImageUrl }])
        );
        clinicTemplateLogo = (
          await tx.clinicTemplate.findUniqueOrThrow({ where: { clinicId: clinic.id } })
        ).logoUrl;

        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(seen.borrowed).toEqual({ logoUrl: null, heroImageUrl: null });
    expect(seen.own).toEqual({
      logoUrl: "https://clinica.example/logo.png",
      heroImageUrl: "https://clinica.example/hero.png"
    });
    expect(seen["same-host"].logoUrl).toBe("https://i.ibb.co/own1234/logo.png");
    expect(clinicTemplateLogo).toBe(BORROWED_DEFAULT_LOGO_URL);
  });
});
