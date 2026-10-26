-- The seeded default Voone template shipped with two images borrowed from a single client
-- (the Sapphira pilot). They are no longer a default for anyone, so clear them from the
-- seeded template rows, and only where they still hold exactly those URLs: a template an
-- admin has since pointed at a real image keeps it.
--
-- ClinicTemplate rows are deliberately NOT touched. Live clinics that carry one of these
-- images are flagged in the admin list (usesDefaultLogo) for staff to fix, not silently
-- changed under a card members may already hold.
UPDATE "VooneTemplate"
SET "logoUrl" = NULL
WHERE "logoUrl" = 'https://i.ibb.co/C5qhWHMk/Whats-App-Image-2026-08-31-at-12-18-49-PM-1.jpg';

UPDATE "VooneTemplate"
SET "heroImageUrl" = NULL
WHERE "heroImageUrl" = 'https://i.ibb.co/Hfy7XNtb/Gemini-Generated-Image-viollgviollgviol.png';
