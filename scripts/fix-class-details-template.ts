/**
 * One-off: append the messages items (class.messages, object.messages) to
 * detailsTemplateOverride.detailsItemInfos on existing Google loyalty classes, so
 * TEXT_AND_NOTIFY messages render on the pass details view.
 *
 *   npm run class:fix-details                                # dry-run, all SYNCED classes
 *   npm run class:fix-details -- --classId <id>              # dry-run, one class (repeatable)
 *   npm run class:fix-details -- --apply [--classId <id>...] # write
 *
 * Only classTemplateInfo is PATCHed (plus reviewStatus "UNDER_REVIEW", exactly as
 * createOrUpdateClass/setClassLocations send it). No other class field is touched.
 * SELECT-only Prisma access; no database writes.
 */
import dotenv from "dotenv";

import { PrismaClient, WalletProviderType, WalletSyncStatus } from "@prisma/client";

import { getAuthenticatedClient } from "../src/wallet/providers/google/client";
import {
  MESSAGE_DETAILS_FIELD_PATHS,
  toTemplateItem
} from "../src/wallet/providers/google/classService";

dotenv.config();

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const requestedClassIds: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--classId" && args[index + 1]) {
    requestedClassIds.push(args[index + 1]);
    index += 1;
  }
}

interface DetailsItemInfo {
  item?: { firstValue?: { fields?: Array<{ fieldPath?: string }> } };
}

interface GoogleClassView {
  reviewStatus?: string;
  classTemplateInfo?: {
    cardTemplateOverride?: unknown;
    listTemplateOverride?: unknown;
    detailsTemplateOverride?: { detailsItemInfos?: DetailsItemInfo[] };
  };
}

interface ClassTarget {
  clinicName: string;
  classId: string;
}

const fieldPathOf = (item: DetailsItemInfo): string =>
  item.item?.firstValue?.fields?.[0]?.fieldPath ?? "";

const resolveClasses = async (): Promise<ClassTarget[]> => {
  if (requestedClassIds.length > 0) {
    return requestedClassIds.map((classId) => ({ clinicName: "(--classId)", classId }));
  }

  const rows = await prisma.walletClass.findMany({
    where: { provider: WalletProviderType.GOOGLE, status: WalletSyncStatus.SYNCED },
    select: {
      externalClassId: true,
      clinicTemplate: { select: { clinic: { select: { name: true } } } }
    }
  });

  return rows
    .filter((row) => !row.externalClassId.includes("tpl_test_"))
    .map((row) => ({
      clinicName: row.clinicTemplate.clinic.name,
      classId: row.externalClassId
    }));
};

const report = (
  target: ClassTarget,
  reviewStatus: string,
  beforeCount: number,
  afterCount: number,
  status: string
): void => {
  console.log(
    `${target.clinicName} | ${target.classId} | ${reviewStatus} | items before: ${beforeCount} | items after: ${afterCount} | ${status}`
  );
};

const fixClass = async (target: ClassTarget): Promise<boolean> => {
  const client = getAuthenticatedClient();
  const classPath = `/loyaltyClass/${encodeURIComponent(target.classId)}`;

  const before = await client.requestWithResponse<GoogleClassView>(classPath);
  if (before.status !== 200) {
    report(target, "(unknown)", 0, 0, `FAILED (GET ${before.status} ${before.statusText})`);
    return false;
  }

  const reviewStatus = before.body.reviewStatus ?? "(unknown)";
  const existingItems =
    before.body.classTemplateInfo?.detailsTemplateOverride?.detailsItemInfos ?? [];
  const existingPaths = existingItems.map(fieldPathOf);
  const missingPaths = MESSAGE_DETAILS_FIELD_PATHS.filter((path) => !existingPaths.includes(path));

  if (missingPaths.length === 0) {
    report(target, reviewStatus, existingItems.length, existingItems.length, "OK (already has messages items)");
    return true;
  }

  const afterItems = [
    ...existingItems,
    ...missingPaths.map((fieldPath) => ({ item: toTemplateItem(fieldPath) }))
  ];

  if (!apply) {
    report(target, reviewStatus, existingItems.length, afterItems.length, "DRY-RUN (would PATCH)");
    return true;
  }

  // PATCH only classTemplateInfo (the GET's own template info with messages items
  // appended) plus reviewStatus "UNDER_REVIEW", exactly as createOrUpdateClass and
  // setClassLocations send it. Nothing else is copied from the GET response.
  const patchBody = {
    reviewStatus: "UNDER_REVIEW",
    classTemplateInfo: {
      ...(before.body.classTemplateInfo?.cardTemplateOverride
        ? { cardTemplateOverride: before.body.classTemplateInfo.cardTemplateOverride }
        : {}),
      ...(before.body.classTemplateInfo?.listTemplateOverride
        ? { listTemplateOverride: before.body.classTemplateInfo.listTemplateOverride }
        : {}),
      detailsTemplateOverride: { detailsItemInfos: afterItems }
    }
  };

  const patch = await client.requestWithResponse<unknown>(classPath, {
    method: "PATCH",
    body: patchBody
  });
  if (patch.status !== 200) {
    report(
      target,
      reviewStatus,
      existingItems.length,
      afterItems.length,
      `FAILED (PATCH ${patch.status} ${patch.statusText})`
    );
    return false;
  }

  const after = await client.requestWithResponse<GoogleClassView>(classPath);
  if (after.status !== 200) {
    report(
      target,
      reviewStatus,
      existingItems.length,
      afterItems.length,
      `FAILED (verify GET ${after.status} ${after.statusText})`
    );
    return false;
  }

  const verifiedPaths = (
    after.body.classTemplateInfo?.detailsTemplateOverride?.detailsItemInfos ?? []
  ).map(fieldPathOf);
  const ok = MESSAGE_DETAILS_FIELD_PATHS.every((path) => verifiedPaths.includes(path));

  report(
    target,
    reviewStatus,
    existingItems.length,
    verifiedPaths.length,
    ok ? "OK" : "FAILED (messages items missing after PATCH)"
  );

  return ok;
};

const main = async (): Promise<void> => {
  const classes = await resolveClasses();

  if (classes.length === 0) {
    console.log("No classes to fix.");
    return;
  }

  console.log(apply ? "APPLY: PATCHing classTemplateInfo" : "DRY-RUN (pass --apply to write)");

  let failures = 0;
  for (const target of classes) {
    if (!(await fixClass(target))) failures += 1;
  }

  await prisma.$disconnect();

  if (failures > 0) process.exitCode = 1;
};

void main().catch((error) => {
  console.error("class:fix-details failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
