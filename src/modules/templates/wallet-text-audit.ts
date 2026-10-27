import { CARD_TEXT_MAX_LENGTH } from "../../wallet/engine/card-text";

export interface WalletTextRow {
  clinicId: string;
  benefitsText: string | null;
  infoText: string | null;
}

export interface OverlongWalletTexts {
  benefitsOver: number;
  infoOver: number;
  clinics: Array<{ clinicId: string; benefits: boolean; info: boolean }>;
}

/**
 * Which templates carry a text the card cannot hold. Returns counts and clinic ids only: the
 * texts are the clinic's own copy and have no business in a terminal or a log.
 */
export const findOverlongWalletTexts = (rows: WalletTextRow[]): OverlongWalletTexts => {
  const report: OverlongWalletTexts = { benefitsOver: 0, infoOver: 0, clinics: [] };

  for (const row of rows) {
    const benefits = (row.benefitsText?.length ?? 0) > CARD_TEXT_MAX_LENGTH;
    const info = (row.infoText?.length ?? 0) > CARD_TEXT_MAX_LENGTH;

    if (benefits) report.benefitsOver += 1;
    if (info) report.infoOver += 1;
    if (benefits || info) report.clinics.push({ clinicId: row.clinicId, benefits, info });
  }

  return report;
};
