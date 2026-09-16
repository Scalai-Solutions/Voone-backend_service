import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

// `prisma db seed` loads .env itself, but this keeps `tsx prisma/seed.ts` working too.
// src/config/env.ts is deliberately not imported: it throws without REDIS_URL, PORT and
// FRONTEND_URL, none of which are needed to write seed rows.
dotenv.config();

const prisma = new PrismaClient();

const presets = [
  { name: "Classic Gold", hexBackgroundColor: "#ead0bd" },
  { name: "Modern Dark", hexBackgroundColor: "#2a2e35" },
  { name: "Fresh Mint", hexBackgroundColor: "#d8efe3" }
];

/**
 * The two demo clinics from the marketing site, each with the template the public sign-up
 * page reads its branding from. Without a template a clinic cannot render that page at all,
 * so seeding one without the other would leave a clinic that 404s.
 *
 * Slugs are written down rather than derived from the name: they are URLs printed on
 * physical posters, and renaming a clinic must never invalidate its QR code.
 */
const clinics = [
  {
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
  for (const preset of presets) {
    await prisma.templatePreset.upsert({
      where: { name: preset.name },
      update: { hexBackgroundColor: preset.hexBackgroundColor },
      create: preset
    });
  }

  for (const { slug, name, addressLine, pincode, preset, template } of clinics) {
    const { id: presetId } = await prisma.templatePreset.findUniqueOrThrow({
      where: { name: preset },
      select: { id: true }
    });

    const clinic = await prisma.clinic.upsert({
      where: { slug },
      update: { name, addressLine, pincode },
      create: { slug, name, addressLine, pincode }
    });

    await prisma.clinicTemplate.upsert({
      where: { clinicId: clinic.id },
      update: { ...template, presetId },
      create: { ...template, presetId, clinicId: clinic.id }
    });
  }

  console.log(`Seeded ${presets.length} presets and ${clinics.length} clinics with templates.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
