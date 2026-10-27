/**
 * The longest benefits / info text a card can carry.
 *
 * ONE constant for three places that must agree: the card schema's max, every template write
 * schema, and the assembler's clip. They used to disagree (templates took 1200, the card 500),
 * and a text of 501-1200 characters made assemble() throw, which stopped every card of that
 * clinic syncing — points included.
 *
 * The unit is UTF-16 units, because that is what zod's string max counts. Counting code points
 * here would let 500 emoji (1000 units) through validation and then fail the card.
 */
export const CARD_TEXT_MAX_LENGTH = 500;

export const CARD_TEXT_TOO_LONG_MESSAGE = `Máximo ${CARD_TEXT_MAX_LENGTH} caracteres`;

/**
 * Fits a text into the card, cutting with an ellipsis. Texts saved before the limit was lowered
 * keep working: the clinic's card shows the start of the text instead of failing to sync.
 *
 * Counted in UTF-16 units (see above) but never cut inside a surrogate pair, so an emoji is
 * kept whole or dropped whole.
 */
export const clipCardText = (text: string, max: number = CARD_TEXT_MAX_LENGTH): string => {
  if (text.length <= max) return text;

  let end = max - 1;
  const last = text.charCodeAt(end - 1);

  // A cut right after a high surrogate would leave half an emoji.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;

  return `${text.slice(0, end)}…`;
};
