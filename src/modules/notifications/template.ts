/** Matches {variable_name}; the name is limited so stray braces in free text are left alone. */
const PLACEHOLDER = /\{([a-z_]+)\}/g;

export type TemplateValues = Readonly<Record<string, string>>;

/** The {names} a template uses, in order of first appearance. */
export const templateVariables = (template: string): string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]))
];

/** The names in `template` that are not in `allowed` (used to reject typos on save). */
export const unknownVariables = (template: string, allowed: readonly string[]): string[] =>
  templateVariables(template).filter((name) => !allowed.includes(name));

/**
 * Fills {name} placeholders. A name with no value renders as an empty string rather than
 * leaving "{name}" visible on a member's phone; callers refuse to send when a required value
 * is missing, so this is only the last line of defence.
 */
export const renderTemplate = (template: string, values: TemplateValues): string =>
  template
    .replace(PLACEHOLDER, (_match, name: string) => values[name] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** "María José López" -> "María". Empty when the name is blank. */
export const firstName = (fullName: string | null | undefined): string =>
  (fullName ?? "").trim().split(/\s+/)[0] ?? "";

const BARE_URL = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/**
 * Google Wallet message bodies carry links as `<a href="...">text</a>`; a bare URL is not
 * reliably tappable. Wraps each bare URL (keeping sentence punctuation outside the link). Text
 * that already contains an anchor is left exactly as written.
 */
export const linkifyForGoogle = (text: string): string =>
  /<a\s/i.test(text)
    ? text
    : text.replace(BARE_URL, (match) => {
        const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
        const url = trailing ? match.slice(0, -trailing.length) : match;

        return `<a href="${url}">${url}</a>${trailing}`;
      });
