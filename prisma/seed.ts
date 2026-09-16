import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const presets = [
  { name: "Classic Gold", hexBackgroundColor: "#ead0bd" },
  { name: "Modern Dark", hexBackgroundColor: "#2a2e35" },
  { name: "Fresh Mint", hexBackgroundColor: "#d8efe3" }
];

async function main() {
  for (const preset of presets) {
    await prisma.templatePreset.upsert({
      where: { name: preset.name },
      update: { hexBackgroundColor: preset.hexBackgroundColor },
      create: preset
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });