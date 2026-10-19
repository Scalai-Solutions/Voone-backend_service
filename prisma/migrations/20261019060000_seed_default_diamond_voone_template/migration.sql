-- Seed the default Voone template shown in Admin > Template Designs and onboarding.
-- It is a reusable starting point; clinics can still override labels, images, and links
-- before their Wallet class is provisioned.
INSERT INTO "VooneTemplate" (
  "id",
  "presetId",
  "name",
  "description",
  "programName",
  "hexBackgroundColor",
  "logoUrl",
  "heroImageUrl",
  "pointsLabel",
  "tierLabel",
  "benefitsText",
  "infoText",
  "buttons",
  "textModules",
  "createdAt",
  "updatedAt"
)
SELECT
  '00000000-0000-4000-8000-0000000d0001',
  preset."id",
  'Club Diamante',
  'Default premium Google Wallet loyalty card with dark styling, hero image, and Spanish labels.',
  'Club Diamante',
  '#30221f',
  'https://i.ibb.co/C5qhWHMk/Whats-App-Image-2026-08-31-at-12-18-49-PM-1.jpg',
  'https://i.ibb.co/Hfy7XNtb/Gemini-Generated-Image-viollgviollgviol.png',
  'Puntos',
  'Nivel',
  'Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales.',
  'Presenta tu pase en recepción antes del pago para sumar puntos.',
  '[{"label":"Website","url":"https://voone.ai","description":"Website","primary":false},{"label":"Schedule Appointment","url":"https://voone.app","description":"Schedule an appointment","primary":true}]'::jsonb,
  '[{"label":"Benefits","value":"Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales."},{"label":"Information","value":"Presenta tu pase en recepción antes del pago para sumar puntos."}]'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "TemplatePreset" AS preset
WHERE preset."name" = 'Modern Dark'
ON CONFLICT ("id") DO NOTHING;
