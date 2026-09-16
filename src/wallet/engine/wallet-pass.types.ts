import { z } from "zod";

import { loyaltyPassDataSchema, passTemplateSchema } from "./wallet-pass.schema";

// Shared types for pass data, independent of provider.
export type PassTemplate = z.infer<typeof passTemplateSchema>;

export type LoyaltyPassData = z.infer<typeof loyaltyPassDataSchema>;

export interface BuiltPass {
  buffer: Buffer;
  fileName: string;
  contentType: "application/vnd.apple.pkpass";
  serialNumber: string;
}
