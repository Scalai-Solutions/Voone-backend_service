/**
 * The one place a reward's title is decided.
 *
 * Both views of a programme (the runtime's `programView` and the centre's `presentProgram`) title
 * a reward, and the title is what a member sees and what is snapshotted into MemberReward.title
 * when it is issued. They must never disagree, so neither computes it: the centre's own label
 * wins when it wrote one, then the name of a special reward (double points, a surprise, a free
 * text), otherwise the item names joined with " y ".
 */
export const itemsTitle = (items: Array<{ name: string }>): string =>
  items.map((i) => i.name).join(" y ");

export const rewardTitle = (reward: {
  o: { items: Array<{ name: string }> };
  label?: string;
  special?: { name: string };
}): string => reward.label ?? reward.special?.name ?? itemsTitle(reward.o.items);

/** A tier's birthday gift as a member reads it: the centre's free text, else the item names. */
export const birthdayTitle = (gift: {
  birthday?: { items: Array<{ name: string }> };
  birthdayName?: string;
}): string | undefined =>
  gift.birthday ? (gift.birthdayName ?? itemsTitle(gift.birthday.items)) : undefined;
