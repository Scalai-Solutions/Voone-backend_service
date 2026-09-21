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

/**
 * What makes a pass updatable.
 *
 * A .pkpass without these two fields is a snapshot: the device never calls back, so the
 * points on it stay frozen at the moment it was issued. With them, the device registers
 * itself and fetches a new version whenever it is told to.
 *
 * The URL is baked into the signed file and cannot be changed afterwards — a pass on a
 * member's phone calls that host forever — so it has to be a permanent hostname before
 * the first real pass is issued, never a deploy-scoped one.
 */
export interface PassUpdateBinding {
  webServiceUrl: string;
  /** Per-pass bearer secret the device returns on every web service call. */
  authenticationToken: string;
}

/**
 * Contract for turning a provider-independent loyalty card into a pass file.
 *
 * `updates` is optional because a pass is still valid without it, just frozen — which is
 * what a preview wants. A real issue always supplies it.
 */
export interface PassBuilder {
  build(card: LoyaltyCard, updates?: PassUpdateBinding): Promise<BuiltPass>;
}
