import { LoyaltyPassData } from "../../engine/wallet-pass.types";
import { PASS_LABELS } from "./apple-pass.strings";
import { PassField } from "./passkit";

export interface StoreCardFields {
  headerFields: PassField[];
  primaryFields: PassField[];
  secondaryFields: PassField[];
  auxiliaryFields: PassField[];
  backFields: PassField[];
}

/**
 * Maps loyalty data onto a storeCard's five field slots.
 *
 * Every `key` must be unique across all five arrays: a PassType keeps one shared key pool
 * and throws when a duplicate is pushed.
 *
 * `changeMessage` is inert until a Wallet Web Service exists, but costs nothing now and
 * makes the eventual push-update change a one-liner.
 */
export const buildStoreCardFields = (data: LoyaltyPassData): StoreCardFields => ({
  headerFields: [
    {
      key: "points",
      label: PASS_LABELS.points,
      value: data.balance.points,
      numberStyle: "PKNumberStyleDecimal",
      textAlignment: "PKTextAlignmentRight",
      changeMessage: PASS_LABELS.pointsChangeMessage
    }
  ],
  primaryFields: [
    {
      key: "balance",
      label: PASS_LABELS.balance,
      // Apple renders currency from a unit amount, not cents.
      value: data.balance.creditCents / 100,
      currencyCode: data.balance.currency,
      changeMessage: PASS_LABELS.balanceChangeMessage
    }
  ],
  secondaryFields: [
    { key: "member", label: PASS_LABELS.member, value: data.member.fullName },
    {
      key: "tier",
      label: PASS_LABELS.tier,
      value: data.tierName,
      textAlignment: "PKTextAlignmentRight",
      changeMessage: PASS_LABELS.tierChangeMessage
    }
  ],
  auxiliaryFields: [
    { key: "reward", label: PASS_LABELS.reward, value: data.reward.description },
    {
      key: "progress",
      label: PASS_LABELS.progress,
      // Apple's percent formatter multiplies by 100, so it wants a fraction.
      value: data.reward.progressPercent / 100,
      numberStyle: "PKNumberStylePercent",
      textAlignment: "PKTextAlignmentRight"
    }
  ],
  backFields: [
    {
      key: "clinic",
      label: PASS_LABELS.clinic,
      value: `${data.clinic.name} · ${data.clinic.tagline}`
    },
    { key: "memberSince", label: PASS_LABELS.memberSince, value: data.member.memberSince },
    // Readable fallbacks for reception when the barcode will not scan.
    { key: "redemptionCode", label: PASS_LABELS.redemptionCode, value: data.redemptionCode },
    { key: "serialNumber", label: PASS_LABELS.serialNumber, value: data.serialNumber }
  ]
});
