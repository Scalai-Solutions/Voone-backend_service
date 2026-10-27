import { describe, expect, it } from "vitest";

import { CARD_MESSAGE_MAX_LENGTH, formatCardMessage } from "../../src/wallet/engine/card-message";

describe("formatCardMessage", () => {
  it("renders `<d MMM> · <header>: <body>` with a Spanish month", () => {
    expect(
      formatCardMessage({
        header: "Título",
        body: "cuerpo",
        sentAt: new Date("2026-10-27T10:00:00Z")
      })
    ).toBe("27 oct · Título: cuerpo");
  });

  it("uses the Europe/Madrid date, not the UTC one, near midnight", () => {
    // 23:30 UTC on 26 Oct is 00:30 on the 27th in Madrid (UTC+1 after the clock change); 22:30 UTC
    // on 31 Jul is 00:30 on 1 Aug (UTC+2 in summer).
    expect(
      formatCardMessage({
        header: "H",
        body: "B",
        sentAt: new Date("2026-10-26T23:30:00Z")
      })
    ).toBe("27 oct · H: B");
    expect(
      formatCardMessage({
        header: "H",
        body: "B",
        sentAt: new Date("2026-07-31T22:30:00Z")
      })
    ).toBe("1 ago · H: B");
  });

  it("never prints a leading zero and abbreviates every month in Spanish", () => {
    const months = [
      "ene",
      "feb",
      "mar",
      "abr",
      "may",
      "jun",
      "jul",
      "ago",
      "sep",
      "oct",
      "nov",
      "dic"
    ];

    months.forEach((month, index) => {
      const sentAt = new Date(Date.UTC(2026, index, 5, 12));

      expect(formatCardMessage({ header: "H", body: "B", sentAt })).toBe(`5 ${month} · H: B`);
    });
  });

  it("is stable: the same stored message gives the same text every time", () => {
    const message = { header: "H", body: "B", sentAt: new Date("2026-10-27T10:00:00Z") };

    expect(formatCardMessage(message)).toBe(formatCardMessage({ ...message }));
  });

  it("gives a different text for the same words sent on a different day", () => {
    const base = { header: "H", body: "B" };

    expect(formatCardMessage({ ...base, sentAt: new Date("2026-10-27T10:00:00Z") })).not.toBe(
      formatCardMessage({ ...base, sentAt: new Date("2026-10-28T10:00:00Z") })
    );
  });

  it("caps the text at 300 characters, ending in an ellipsis", () => {
    const text = formatCardMessage({
      header: "H".repeat(60),
      body: "b".repeat(500),
      sentAt: new Date("2026-10-27T10:00:00Z")
    });

    expect(CARD_MESSAGE_MAX_LENGTH).toBe(300);
    // UTF-16 units, the unit the card schema's max(300) counts.
    expect(text).toHaveLength(300);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith("27 oct · ")).toBe(true);
  });

  it("counts UTF-16 units, so an emoji-heavy message never exceeds what the schema allows", () => {
    for (const emojis of [100, 150, 400]) {
      const text = formatCardMessage({
        header: "H",
        body: "😀".repeat(emojis),
        sentAt: new Date("2026-10-27T10:00:00Z")
      });

      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  it("steps back one unit when the cut would land inside a surrogate pair", () => {
    // "27 oct · H: " is 12 units. 286 x's make 298; the emoji then spans units 298-299, so a cut
    // after 299 units would keep only its high half.
    const insidePair = formatCardMessage({
      header: "H",
      body: `${"x".repeat(286)}😀😀`,
      sentAt: new Date("2026-10-27T10:00:00Z")
    });

    expect(insidePair).toBe(`27 oct · H: ${"x".repeat(286)}…`);
    expect(insidePair).toHaveLength(299);

    // 287 x's: the cut falls cleanly between the text and the first emoji.
    const clean = formatCardMessage({
      header: "H",
      body: `${"x".repeat(287)}😀😀`,
      sentAt: new Date("2026-10-27T10:00:00Z")
    });

    expect(clean).toBe(`27 oct · H: ${"x".repeat(287)}…`);
    expect(clean).toHaveLength(300);
  });

  it("does not cut an emoji in half when truncating", () => {
    const text = formatCardMessage({
      header: "H",
      body: "😀".repeat(400),
      sentAt: new Date("2026-10-27T10:00:00Z")
    });

    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text.endsWith("…")).toBe(true);
  });
});
