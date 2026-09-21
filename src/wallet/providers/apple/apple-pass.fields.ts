import { LoyaltyCard } from "../../engine/loyalty-card";
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
 * Fields with no backing column are omitted rather than filled with placeholders, so a
 * member with no credit or reward yet gets a card that is simply shorter, not wrong.
 *
 * `changeMessage` is inert until a Wallet Web Service exists, but costs nothing now and
 * makes the eventual push-update change a one-liner.
 *
 * Note on ClinicTemplate: `pointsLabel` and `tierLabel` are read here as field *labels*,
 * matching their names. The frontend's starter data puts value-like text in `tierLabel`
 * ("Miembro Gold"), so this reading needs confirming against the clinic-template code.
 */
export const buildStoreCardFields = (data: LoyaltyCard): StoreCardFields => {
  const headerFields: PassField[] = [];
  const secondaryFields: PassField[] = [
    { key: "member", label: PASS_LABELS.member, value: data.member.fullName }
  ];
  const auxiliaryFields: PassField[] = [];
  const backFields: PassField[] = [
    { key: "program", label: PASS_LABELS.program, value: data.template.programName }
  ];

  if (data.tier) {
    headerFields.push({
      key: "tier",
      label: data.template.tierLabel,
      value: data.tier,
      textAlignment: "PKTextAlignmentRight",
      changeMessage: PASS_LABELS.tierChangeMessage
    });
  }

  if (data.credit) {
    secondaryFields.push({
      key: "credit",
      label: PASS_LABELS.credit,
      // Apple renders currency from a unit amount, not cents.
      value: data.credit.cents / 100,
      currencyCode: data.credit.currency,
      textAlignment: "PKTextAlignmentRight"
    });
  }

  if (data.reward) {
    auxiliaryFields.push(
      { key: "reward", label: PASS_LABELS.reward, value: data.reward.description },
      {
        key: "progress",
        label: PASS_LABELS.progress,
        // Apple's percent formatter multiplies by 100, so it wants a fraction.
        value: data.reward.progressPercent / 100,
        numberStyle: "PKNumberStylePercent",
        textAlignment: "PKTextAlignmentRight"
      }
    );
  }

  if (data.template.benefitsText) {
    backFields.push({
      key: "benefits",
      label: PASS_LABELS.benefits,
      value: data.template.benefitsText
    });
  }

  if (data.template.infoText) {
    backFields.push({ key: "info", label: PASS_LABELS.info, value: data.template.infoText });
  }

  if (data.member.memberSince) {
    backFields.push({
      key: "memberSince",
      label: PASS_LABELS.memberSince,
      value: data.member.memberSince
    });
  }

  // Readable fallbacks for reception when the barcode will not scan.
  backFields.push(
    { key: "redemptionCode", label: PASS_LABELS.redemptionCode, value: data.redemptionCode },
    { key: "serialNumber", label: PASS_LABELS.serialNumber, value: data.serialNumber }
  );

  return {
    headerFields,
    primaryFields: [
      {
        key: "points",
        label: data.template.pointsLabel,
        value: data.points,
        numberStyle: "PKNumberStyleDecimal",
        changeMessage: PASS_LABELS.pointsChangeMessage
      }
    ],
    secondaryFields,
    auxiliaryFields,
    backFields
  };
};
