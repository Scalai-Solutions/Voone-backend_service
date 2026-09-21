import { BuiltPass, LoyaltyPassData } from "./wallet-pass.types";

// Contract for turning provider-independent loyalty data into a distributable pass file.
export interface PassBuilder {
  build(data: LoyaltyPassData): Promise<BuiltPass>;
}
