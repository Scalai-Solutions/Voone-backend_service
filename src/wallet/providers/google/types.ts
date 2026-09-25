export interface LoyaltyClassInput {
  issuerName: string;
  classId: string;
  programName: string;
  hexBackgroundColor: string;
  logoUrl: string;
  heroImageUrl: string;
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

export type LoyaltyObjectState = "ACTIVE" | "INACTIVE";

export interface LoyaltyObjectInput {
  objectId: string;
  classId: string;
  accountName: string;
  accountId: string;
  memberSince?: string;
  loyaltyPointsLabel: string;
  loyaltyPointsBalance: number;
  tier?: string;
  state?: LoyaltyObjectState;
}

export type LoyaltyObjectPatch = Partial<
  Pick<LoyaltyObjectInput, "loyaltyPointsBalance" | "tier" | "state">
> & {
  message?: {
    header: string;
    body: string;
  };
};
