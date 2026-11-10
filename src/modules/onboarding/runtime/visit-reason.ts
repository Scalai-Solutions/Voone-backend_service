/**
 * The ledger's reason for a visit credit, and the one place that reads a name back out of it.
 *
 * Reception picks what was paid for from the catalogue, and the credit's `reason` records it as
 * `Visita de pago: <names>` (or `Sesión de bono: <bono>`). The card's history shows that name, so
 * the writer and the reader share these prefixes and cannot drift apart. Only the exact prefix is
 * read: a manual adjustment's reason is a staff note and is never treated as a name.
 */
export const PAYMENT_REASON_PREFIX = "Visita de pago: ";
export const BONO_REASON_PREFIX = "Sesión de bono: ";

/** What reception recorded for a visit credit, or undefined when it recorded no name. */
export const treatmentNameOf = (reason: string | null | undefined): string | undefined => {
  if (!reason) return undefined;

  for (const prefix of [PAYMENT_REASON_PREFIX, BONO_REASON_PREFIX]) {
    if (reason.startsWith(prefix)) return reason.slice(prefix.length).trim() || undefined;
  }

  return undefined;
};
