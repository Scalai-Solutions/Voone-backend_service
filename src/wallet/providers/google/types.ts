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

export interface LoyaltyObjectInput {
  objectId: string;
  classId: string;
  accountName: string;
  accountId: string;
  memberSince?: string;
  loyaltyPointsLabel: string;
  loyaltyPointsBalance: number;
  tierLabel?: string;
  tier?: string;
  state?: LoyaltyObjectState;
  /** Absent for a clinic with no programme: the object then carries no rewards parts at all. */
  rewards?: LoyaltyRewardsInput;
}

export type LoyaltyObjectPatch = Partial<
  Pick<LoyaltyObjectInput, "loyaltyPointsBalance" | "tier" | "state" | "rewards">
> & {
  notify?: boolean;
};
