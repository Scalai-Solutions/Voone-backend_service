import { WalletPassDataError } from "../../common/errors/wallet.errors";
import { WalletPlatform, getPassBuilder } from "../wallet.factory";
import { loyaltyPassDataSchema } from "./wallet-pass.schema";
import { BuiltPass } from "./wallet-pass.types";

/** Provider-independent orchestration: validate the data, then delegate to a builder. */
export class WalletPassEngine {
  async createPass(platform: WalletPlatform, data: unknown): Promise<BuiltPass> {
    const parsed = loyaltyPassDataSchema.safeParse(data);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new WalletPassDataError(`Invalid loyalty pass data: ${details}`);
    }

    return getPassBuilder(platform).build(parsed.data);
  }

  updatePass(): never {
    throw new Error("Not implemented");
  }

  deletePass(): never {
    throw new Error("Not implemented");
  }
}

export const walletPassEngine = new WalletPassEngine();
