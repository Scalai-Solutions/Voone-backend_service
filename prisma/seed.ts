import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

// `prisma db seed` loads .env itself, but this keeps `tsx prisma/seed.ts` working too.
// src/config/env.ts is deliberately not imported: it throws without REDIS_URL, PORT and
// FRONTEND_URL, none of which are needed to write two rows.
dotenv.config();

const prisma = new PrismaClient();

/**
 * Slugs are URLs printed on physical posters, so they are written down here rather than
 * derived from `name`. Renaming a clinic must never silently invalidate its QR code.
 */
const CLINICS = [
  { slug: "aurea", name: "AURÉA", tagline: "CLINIC CLUB" },
  { slug: "lumiere", name: "LUMIÈRE", tagline: "MEDICAL BEAUTY" }
];

const main = async () => {
  for (const clinic of CLINICS) {
    // Upsert so the seed is safe to re-run, and safe for `prisma migrate reset`.
    await prisma.clinic.upsert({
      where: { slug: clinic.slug },
      update: { name: clinic.name, tagline: clinic.tagline },
      create: clinic
    });
  }

  console.log(`Seeded ${CLINICS.length} clinics.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
