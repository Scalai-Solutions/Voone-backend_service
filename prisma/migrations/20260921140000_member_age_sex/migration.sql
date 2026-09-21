-- Age and sex on the sign-up form, for the segmentation the dashboard needs.
--
-- Both nullable and neither backfilled. Members who signed up before this have no answer
-- and there is no honest way to invent one — which is the argument for adding the fields
-- early rather than late: every day without them is another cohort that can never be
-- segmented.
--
-- Year of birth rather than an age. An age is wrong within a year of being stored and
-- nothing in the system would ever correct it.
--
-- Sex is ordinary personal data, not an Art. 9 special category. It is still new data the
-- privacy notice did not cover, so clinics default to a new notice version from here on;
-- existing members keep the version they were actually shown, which is the point of
-- snapshotting it per member.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "birthYear" INTEGER,
ADD COLUMN     "sex" TEXT;

-- AlterTable
ALTER TABLE "Clinic" ALTER COLUMN "privacyPolicyVersion" SET DEFAULT 'v2';
