-- The public site moves from voone.ai to voone.es (voone.ai stays as a redirect). The seeded
-- default template stores its "Web" button as JSON, so bring that row in line. It matches the
-- current default EXACTLY: a template whose buttons an admin has edited is never touched.
UPDATE "VooneTemplate"
SET "buttons" = '[{"label":"Web","url":"https://voone.es","description":"Web","primary":false},{"label":"Reservar cita","url":"https://voone.app","description":"Reservar cita","primary":true}]'::jsonb
WHERE "buttons" = '[{"label":"Web","url":"https://voone.ai","description":"Web","primary":false},{"label":"Reservar cita","url":"https://voone.app","description":"Reservar cita","primary":true}]'::jsonb;
