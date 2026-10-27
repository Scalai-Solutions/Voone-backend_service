/**
 * The last clinic message as it is printed on a card.
 *
 * Apple has no free-form push: the message travels in a pass field whose changeMessage fires
 * when the value changes. Two consequences shape this file:
 *
 *  - the date prefix comes from the STORED send time, never from the clock. Rebuilding the
 *    pass (every sync, every device fetch) must give byte-identical text or each rebuild
 *    would notify again; and the prefix is what makes the same words sent on two days two
 *    different values, so the second send still notifies.
 *  - the date is the Europe/Madrid one. The container runs UTC and a message sent at 00:30
 *    in Madrid is still "yesterday" there.
 */
export const CARD_MESSAGE_MAX_LENGTH = 300;

const CARD_MESSAGE_TIME_ZONE = "Europe/Madrid";

// Spelled out rather than taken from Intl: ICU versions disagree on "sep"/"sept." and on a
// trailing full stop, and this text is compared byte for byte against what the phone holds.
const MONTHS_ES = [
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
] as const;

const madridDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: CARD_MESSAGE_TIME_ZONE,
  day: "numeric",
  month: "numeric"
});

export interface StoredCardMessage {
  header: string;
  body: string;
  sentAt: Date;
}

export const formatCardMessage = ({ header, body, sentAt }: StoredCardMessage): string => {
  const parts = madridDay.formatToParts(sentAt);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const text = `${day} ${MONTHS_ES[month - 1]} · ${header}: ${body}`;

  // By code point, so an emoji is never cut in half.
  const characters = Array.from(text);

  return characters.length > CARD_MESSAGE_MAX_LENGTH
    ? `${characters
        .slice(0, CARD_MESSAGE_MAX_LENGTH - 1)
        .join("")
        .trimEnd()}…`
    : text;
};
