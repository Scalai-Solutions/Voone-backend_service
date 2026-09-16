import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

// `prisma db seed` loads .env itself, but this keeps `tsx prisma/seed.ts` working too.
// src/config/env.ts is deliberately not imported: it throws without REDIS_URL, PORT and
// FRONTEND_URL, none of which are needed to write seed rows.
dotenv.config();

const prisma = new PrismaClient();

/**
 * The two demo clinics from the marketing site, each with the template the public sign-up
 * page reads its branding from. Without a template a clinic cannot render that page at all,
 * so seeding one without the other would leave a clinic that 404s.
 *
 * Development data only. TemplatePreset rows moved to a migration, because they are
 * reference data every environment needs; these clinics are fictional and deliberately do
 * not follow them into production.
 *
 * The ids are fixed rather than generated. A dashboard running without real authentication
 * uses a mock session, which has to name a clinic somehow — and with random ids it named
 * one that did not exist, so every template write failed. That failure was invisible while
 * the API client fell back to mock data on error; it is visible now, which is why these are
 * pinned. Real sessions carry the id from the user record and never read these.
 *
 * Slugs are written down rather than derived from the name: they are URLs printed on
 * physical posters, and renaming a clinic must never invalidate its QR code.
 */
const clinics = [
  {
    id: "00000000-0000-4000-8000-0000000a0001",
    slug: "aurea",
    name: "AURÉA",
    addressLine: "Calle de Serrano 21",
    pincode: "28001",
    preset: "Classic Gold",
    template: {
      programName: "AURÉA Clinic Club",
      hexBackgroundColor: "#ead0bd",
      pointsLabel: "Puntos",
      tierLabel: "Nivel",
      benefitsText: "Acumula puntos en cada visita y canjéalos por tratamientos.",
      infoText: "Presenta tu pase en recepción para sumar puntos."
    }
  },
  {
    id: "00000000-0000-4000-8000-0000000a0002",
    slug: "lumiere",
    name: "LUMIÈRE",
    addressLine: "Avinguda Diagonal 440",
    pincode: "08037",
    preset: "Modern Dark",
    template: {
      programName: "LUMIÈRE Medical Beauty",
      hexBackgroundColor: "#2a2e35",
      pointsLabel: "Puntos",
      tierLabel: "Categoría",
      benefitsText: "Ventajas exclusivas para socias y acceso anticipado a novedades.",
      infoText: "Muestra tu pase al pagar para registrar la visita."
    }
  }
];

const main = async () => {
  // Upserts throughout, so the seed is safe to re-run and safe for `prisma migrate reset`.
  for (const { id, slug, name, addressLine, pincode, preset, template } of clinics) {
    const { id: presetId } = await prisma.templatePreset.findUniqueOrThrow({
      where: { name: preset },
      select: { id: true }
    });

    const clinic = await prisma.clinic.upsert({
      where: { slug },
      update: { name, addressLine, pincode },
      create: { id, slug, name, addressLine, pincode }
    });

    await prisma.clinicTemplate.upsert({
      where: { clinicId: clinic.id },
      update: { ...template, presetId },
      create: { ...template, presetId, clinicId: clinic.id }
    });
  }

  console.log(`Seeded ${clinics.length} demo clinics with templates.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
