import { LoyaltyCard } from "./loyalty-card";

/**
 * A distributable pass file.
 *
 * Apple-shaped, deliberately: a .pkpass is a signed file the device downloads, whereas
 * Google's equivalent is a save link to an object that already lives on Google's servers.
 * The two are not the same artifact, so this is not yet the shared return type it looks
 * like — the `InstallArtifact` union that covers both replaces it when the provider ports
 * land. Kept here, next to the only interface that returns it, rather than in a file
 * claiming to hold provider-neutral types.
 */
export interface BuiltPass {
  buffer: Buffer;
  fileName: string;
  contentType: "application/vnd.apple.pkpass";
  serialNumber: string;
}

/** Contract for turning a provider-independent loyalty card into a pass file. */
export interface PassBuilder {
  build(card: LoyaltyCard): Promise<BuiltPass>;
}
