-- Client-facing Spanish uses the neutral "miembro" instead of "socia", and the default tier
-- label is "Nivel" (not "Miembro Gold"). Stored template rows copied the old defaults, so
-- bring those rows in line. Every statement matches the OLD default by exact equality: a text
-- or label an owner has edited is never touched. infoText needs no change (its default has no
-- gendered wording).
UPDATE "ClinicTemplate"
SET "benefitsText" = 'Ventajas exclusivas para miembros, prioridad de reserva y recompensas especiales.'
WHERE "benefitsText" = 'Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales.';

UPDATE "ClinicTemplate"
SET "tierLabel" = 'Nivel'
WHERE "tierLabel" = 'Miembro Gold';

UPDATE "VooneTemplate"
SET "benefitsText" = 'Ventajas exclusivas para miembros, prioridad de reserva y recompensas especiales.'
WHERE "benefitsText" = 'Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales.';

UPDATE "VooneTemplate"
SET "tierLabel" = 'Nivel'
WHERE "tierLabel" = 'Miembro Gold';

-- The seeded default template also stores its link buttons and text modules as JSON. Rewrite
-- each only while it is still exactly the seeded value.
UPDATE "VooneTemplate"
SET "buttons" = '[{"label":"Web","url":"https://voone.ai","description":"Web","primary":false},{"label":"Reservar cita","url":"https://voone.app","description":"Reservar cita","primary":true}]'::jsonb
WHERE "buttons" = '[{"label":"Website","url":"https://voone.ai","description":"Website","primary":false},{"label":"Schedule Appointment","url":"https://voone.app","description":"Schedule an appointment","primary":true}]'::jsonb;

UPDATE "VooneTemplate"
SET "textModules" = '[{"label":"Beneficios","value":"Ventajas exclusivas para miembros, prioridad de reserva y recompensas especiales."},{"label":"Información","value":"Presenta tu pase en recepción antes del pago para sumar puntos."}]'::jsonb
WHERE "textModules" = '[{"label":"Benefits","value":"Ventajas exclusivas para socias, prioridad de reserva y recompensas especiales."},{"label":"Information","value":"Presenta tu pase en recepción antes del pago para sumar puntos."}]'::jsonb;
