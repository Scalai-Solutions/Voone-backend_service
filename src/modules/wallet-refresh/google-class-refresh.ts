import { OnboardingProgramStatus, WalletProviderType, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../infrastructure/database/prisma-client";
import { programTemplateFor } from "../../wallet/engine/program-template";
import { PrismaWalletSyncRepository } from "../../wallet/prisma-wallet-sync.repository";
import { createGoogleWalletProvider } from "../../wallet/providers/google";
import type { GoogleWalletProvider } from "../../wallet/providers/google/google-wallet.provider";

/**
 * Re-PATCHes the Google classes a clinic's cards belong to.
 *
 * Saving a template calls `provisionProgram`, which returns a class that is already recorded
 * without touching Google, so a change to the class itself (a template edit, or a new row in the
 * card layout shipped with a release) never reached a class that existed. This is the path that
 * does, for one clinic after a save or for every clinic from the one-off script.
 *
 * Non-fatal by construction: a refresh that fails is logged by error name and clinic id (never the
 * message, which can carry a provider payload) and the next class is still tried.
 */

export interface GoogleClassRefreshResult {
  /** Recorded Google classes in scope. */
  found: number;
  refreshed: number;
  failed: number;
}

export interface GoogleClassRefreshOptions {
  /** Every clinic when omitted. */
  clinicId?: string;
  /** False reports what would be done and writes nothing. */
  apply: boolean;
  prisma?: PrismaClient;
  provider?: GoogleWalletProvider;
}

export const refreshGoogleClasses = async ({
  clinicId,
  apply,
  prisma = defaultPrisma,
  provider = createGoogleWalletProvider(new PrismaWalletSyncRepository(prisma))
}: GoogleClassRefreshOptions): Promise<GoogleClassRefreshResult> => {
  const result: GoogleClassRefreshResult = { found: 0, refreshed: 0, failed: 0 };

  if (!provider.isConfigured()) return result;

  const classes = await prisma.walletClass.findMany({
    where: {
      provider: WalletProviderType.GOOGLE,
      ...(clinicId ? { clinicTemplate: { clinicId } } : {})
    },
    include: {
      clinicTemplate: {
        include: {
          clinic: {
            include: {
              // Whether the programme owns the benefits text: id only, in the same query.
              onboardingPrograms: {
                where: { status: OnboardingProgramStatus.ACTIVO },
                take: 1,
                select: { id: true }
              }
            }
          }
        }
      }
    }
  });

  result.found = classes.length;

  for (const walletClass of classes) {
    if (!apply) continue;

    try {
      await provider.refreshClass(programTemplateFor(walletClass.clinicTemplate), {
        provider: WalletProviderType.GOOGLE,
        externalId: walletClass.externalClassId
      });
      result.refreshed += 1;
    } catch (error) {
      result.failed += 1;
      console.error("[wallet] could not refresh a Google class", {
        clinicId: walletClass.clinicTemplate.clinicId,
        error: error instanceof Error ? error.name : "unknown"
      });
    }
  }

  return result;
};
