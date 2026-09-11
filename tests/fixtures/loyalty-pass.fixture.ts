import { LoyaltyPassData } from "../../src/wallet/engine/wallet-pass.types";

/** Mirrors the AURÉA example the marketing site uses, so the two stay comparable. */
export const aureaGoldPass: LoyaltyPassData = {
  serialNumber: "voone-member-000123",
  redemptionCode: "MFRGGZDFMZTWQ2LKNNWG23Q",
  tier: "gold",
  tierName: "Gold",
  clinic: { name: "AURÉA", tagline: "CLINIC CLUB" },
  member: { fullName: "Verónica Navarro", memberSince: "2026" },
  balance: { points: 1250, creditCents: 24000, currency: "EUR" },
  reward: {
    description: "Hydrafacial a 250 pts · te faltan 2 visitas",
    progressPercent: 83
  }
};
