import { LoyaltyPassData } from "../../src/wallet/engine/wallet-pass.types";

/**
 * Mirrors the AURÉA example the marketing site uses, with the template values the
 * frontend's "signature glow" starter carries, so the two stay comparable.
 *
 * `credit` and `reward` are absent on purpose: no column backs them, so this is the shape
 * a real member actually has today.
 */
export const aureaGoldPass: LoyaltyPassData = {
  serialNumber: "voone-member-000123",
  redemptionCode: "MFRGGZDFMZTWQ2LKNNWG23Q",
  tier: "Gold",
  clinic: { name: "AURÉA" },
  member: { fullName: "Verónica Navarro", memberSince: "2026" },
  points: 1250,
  template: {
    programName: "Clinic Club",
    backgroundColor: "#f1dccd",
    pointsLabel: "Saldo Beauty",
    tierLabel: "Nivel",
    benefitsText: "Acceso exclusivo a tratamientos, eventos y ofertas de socia.",
    infoText: "Presenta este pase en recepción para acumular puntos."
  }
};

/** A member with everything optional filled in, for the fields that only appear then. */
export const fullyPopulatedPass: LoyaltyPassData = {
  ...aureaGoldPass,
  credit: { cents: 24000, currency: "EUR" },
  reward: { description: "Hydrafacial a 250 pts · te faltan 2 visitas", progressPercent: 83 }
};

/** The minimum a brand new member has: no tier, no credit, no reward, no join year. */
export const brandNewMemberPass: LoyaltyPassData = {
  serialNumber: "voone-member-000999",
  redemptionCode: "GEZDGNBVGY3TQOJQGEZDGNA",
  clinic: { name: "AURÉA" },
  member: { fullName: "Nueva Socia" },
  points: 0,
  template: {
    programName: "Clinic Club",
    backgroundColor: "#f1dccd",
    pointsLabel: "Saldo Beauty",
    tierLabel: "Nivel"
  }
};
