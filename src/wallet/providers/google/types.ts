export interface LoyaltyClassInput {
  issuerName: string;
  classId: string;
  programName: string;
  hexBackgroundColor: string;
  logoUrl?: string;
  heroImageUrl?: string;
  homepageUrl: string;
  accountNameLabel?: string;
  accountIdLabel?: string;
  heroImageDescription?: string;
  // The class template maps shared details through the "benefits" and "info" module IDs.
  textModules?: LoyaltyTextModuleInput[];
  linkModules?: LoyaltyLinkModuleInput[];
  appLink?: LoyaltyAppLinkInput;
  rewardsTierLabel?: string;
  rewardsTier?: string;
  /** Where Google posts "pass saved / deleted" events for this class. */
  callbackUrl?: string;
}

export interface LoyaltyTextModuleInput {
  id?: string;
  header: string;
  body: string;
}

export interface LoyaltyLinkModuleInput {
  tag: string;
  url: string;
  description?: string;
}

export interface LoyaltyAppLinkInput {
  displayText: string;
  url: string;
  description?: string;
}

export interface LoyaltyMerchantLocationInput {
  name: string;
  latitude: number;
  longitude: number;
}

export interface LoyaltyMessageInput {
  id: string;
  header: string;
  body: string;
  notify: boolean;
}

export type LoyaltyObjectState = "ACTIVE" | "INACTIVE";

/** The rewards a member can redeem now: how many, and the text listing them. */
export interface LoyaltyRewardsInput {
  count: number;
  text: string;
}

/** The text of the member's tier benefits, from the clinic's live programme. */
export interface LoyaltyTierBenefitsInput {
  text: string;
}

/** The text of a per-member module that exists only while it has something to say. */
export interface LoyaltyOptionalModuleInput {
  text: string;
}

export interface LoyaltyObjectInput {
  objectId: string;
  classId: string;
  accountName: string;
  /** The member number shown on the card, and under the barcode. */
  accountId: string;
  /** What the QR encodes, when it is not the shown number (the long redemption code). */
  barcodeValue?: string;
  memberSince?: string;
  loyaltyPointsLabel: string;
  loyaltyPointsBalance: number;
  tierLabel?: string;
  tier?: string;
  state?: LoyaltyObjectState;
  /** Absent for a clinic with no programme: the object then carries no rewards parts at all. */
  rewards?: LoyaltyRewardsInput;
  /** Absent for a clinic with no live programme: the object then carries no such module. */
  tierBenefits?: LoyaltyTierBenefitsInput;
  /** Absent when no x2 is pending: the object then carries no `boost` module. */
  boost?: LoyaltyOptionalModuleInput;
  /** Absent when the member has no next reward: the card then shows "Ver beneficios". */
  nextReward?: LoyaltyOptionalModuleInput;
  /** Absent when the card has no referral share: the object then carries no `referral` module. */
  referral?: LoyaltyReferralInput;
  /** Absent when the member has no movements yet: the object then carries no `history` module. */
  history?: LoyaltyOptionalModuleInput;
}

/** The referral module's text, and the sign-up link as a tappable link on the pass. */
export interface LoyaltyReferralInput {
  text: string;
  url: string;
}

export type LoyaltyObjectPatch = Partial<
  Pick<
    LoyaltyObjectInput,
    "loyaltyPointsBalance" | "tier" | "state" | "rewards" | "accountId" | "barcodeValue"
  >
> & {
  /** The module's text; `null` REMOVES a stale module (a card with no tier benefits). */
  tierBenefits?: LoyaltyTierBenefitsInput | null;
  /** The module's text; `null` REMOVES a stale module (nothing pending any more). */
  boost?: LoyaltyOptionalModuleInput | null;
  /** The module's text; `null` REMOVES a stale module (no next reward any more). */
  nextReward?: LoyaltyOptionalModuleInput | null;
  /** The module and link; `null` REMOVES both (the card no longer has a share link). */
  referral?: LoyaltyReferralInput | null;
  /** The module's text; `null` REMOVES a stale module (no movements any more). */
  history?: LoyaltyOptionalModuleInput | null;
  notify?: boolean;
};
