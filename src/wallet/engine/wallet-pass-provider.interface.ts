import { WalletProviderType } from "@prisma/client";

import { CardTemplate, LoyaltyCard } from "./loyalty-card";

/**
 * The contract every wallet provider implements, and nothing more.
 *
 * Everything here is meaningful to both Apple and Google. Anything true of only one of
 * them lives on its own interface — see PassDeviceRegistry — so that no adapter is ever
 * forced to stub a method it does not mean. A stub that throws would break substitution:
 * a caller holding a WalletPassProvider must be able to call anything this contract
 * promises without knowing which provider it holds.
 */
export interface WalletPassProvider {
  readonly provider: WalletProviderType;

  /**
   * Whether this provider has everything it needs to work.
   *
   * The registry asks before registering, which is what lets the Apple adapter ship to
   * production before its signing certificate exists: unconfigured, it simply never
   * registers and no business code carries an `if apple`.
   */
  isConfigured(): boolean;

  /** Create or update the clinic-level programme this provider issues cards against. */
  provisionProgram(template: ProgramTemplate): Promise<ProgramRef>;

  /** Issue one member's card, returning both our handle on it and how to install it. */
  issueCard(card: LoyaltyCard, program: ProgramRef): Promise<IssuedCard>;

  /**
   * Make the card's current state authoritative and propagate it as far as this provider
   * can reach.
   *
   * The reach genuinely differs and this contract does not pretend otherwise. For Google
   * this call *is* the update: the object lives on Google's servers and a PATCH is the
   * whole story. For Apple it only republishes the pass and asks the device to come and
   * fetch it, because an Apple pass is a file that already left the building. The Apple
   * adapter owns that second hop internally.
   */
  syncCard(ref: CardRef, card: LoyaltyCard): Promise<void>;

  /** Void a card, e.g. after erasure. Idempotent: revoking twice is not an error. */
  revokeCard(ref: CardRef): Promise<void>;
}

/**
 * The clinic-level programme a card belongs to, in provider-neutral terms.
 *
 * Deliberately not a Prisma row: the port must not drag the database schema across the
 * boundary, or every adapter would need to know how templates are stored.
 */
export interface ProgramTemplate {
  /** The ClinicTemplate this mirrors. Ours, not the provider's. */
  templateId: string;
  clinicName: string;
  template: CardTemplate;
}

/** Our handle on a provider-side programme. `externalId` is that provider's own id. */
export interface ProgramRef {
  provider: WalletProviderType;
  externalId: string;
}

/** Our handle on one member's card with one provider. Mirrors a WalletObject row. */
export interface CardRef {
  provider: WalletProviderType;
  externalId: string;
  memberId: string;
}

/**
 * How a member actually gets the card onto their phone.
 *
 * A discriminated union rather than a common return type, because the two providers hand
 * back genuinely different things: Google gives a signed link to an object that already
 * exists on its servers, Apple gives a signed file the device downloads. Flattening that
 * into one shape would mean inventing a fake URL or an empty buffer for whichever half
 * did not apply. Callers switch on `kind` once, at the HTTP boundary.
 */
export type InstallArtifact =
  | { kind: "link"; url: string }
  | { kind: "file"; buffer: Buffer; fileName: string; contentType: string };

export interface IssuedCard {
  ref: CardRef;
  install: InstallArtifact;
}
