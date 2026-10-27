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

/**
 * "27 oct": the Madrid calendar day of an instant, in the card's Spanish month abbreviations.
 *
 * `months` lets a caller with a house style of its own (the rewards line writes "sept") reuse the
 * Europe/Madrid day arithmetic without changing what the message text, which is compared byte for
 * byte against the phone, prints.
 */
export const formatMadridDayMonth = (at: Date, months: readonly string[] = MONTHS_ES): string => {
  const parts = madridDay.formatToParts(at);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);

  return `${day} ${months[month - 1]}`;
};

export interface StoredCardMessage {
  header: string;
  body: string;
  sentAt: Date;
}

export const formatCardMessage = ({ header, body, sentAt }: StoredCardMessage): string => {
  const text = `${formatMadridDayMonth(sentAt)} · ${header}: ${body}`;

  // Counted in UTF-16 units, the unit the card schema's max(300) counts: capping by code points
  // let an emoji-heavy message through here and then fail validation in assemble(), which would
  // break every later sync of that member.
  if (text.length <= CARD_MESSAGE_MAX_LENGTH) return text;

  let end = CARD_MESSAGE_MAX_LENGTH - 1;
  const last = text.charCodeAt(end - 1);

  // A cut right after a high surrogate would leave half an emoji.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;

  return `${text.slice(0, end).trimEnd()}…`;
};
