/**
 * The one place a reward's title is decided.
 *
 * Both views of a programme (the runtime's `programView` and the centre's `presentProgram`) title
 * a reward, and the title is what a member sees and what is snapshotted into MemberReward.title
 * when it is issued. They must never disagree, so neither computes it: the centre's own label
 * wins when it wrote one, otherwise the item names joined with " y ".
 */
export const itemsTitle = (items: Array<{ name: string }>): string =>
  items.map((i) => i.name).join(" y ");

export const rewardTitle = (reward: {
  o: { items: Array<{ name: string }> };
  label?: string;
}): string => reward.label ?? itemsTitle(reward.o.items);
