import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { MemberDirectoryService } from "../../src/modules/members/member-directory.service";

/**
 * Erasure overwrites the member row in place, so the cascade on MemberWalletMessage never
 * fires: the last clinic message sent to the member has to be deleted explicitly.
 */
describe("member erasure", () => {
  it("deletes the member's stored wallet message with the rest of their data", async () => {
    const deleted: string[] = [];
    const op = (table: string) => ({
      deleteMany: async ({ where }: { where: { memberId: string } }) => {
        deleted.push(`${table}:${where.memberId}`);
        return { count: 1 };
      }
    });
    const prisma = {
      member: {
        findFirst: async () => ({ id: "m-1", walletObjects: [] }),
        updateMany: async () => ({ count: 1 })
      },
      memberBono: op("memberBono"),
      passClaim: op("passClaim"),
      walletObject: op("walletObject"),
      memberWalletMessage: op("memberWalletMessage"),
      $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations)
    } as unknown as PrismaClient;

    await new MemberDirectoryService(prisma, () => new Set()).delete({
      clinicId: "c-1",
      memberId: "m-1",
      revokeCard: async () => true
    } as never);

    expect(deleted).toContain("memberWalletMessage:m-1");
  });
});
