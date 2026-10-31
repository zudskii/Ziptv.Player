/** A group chosen for entries to land in, or a new one to create first. */
export type GroupChoice = { type: 'none' } | { type: 'group'; groupId: string } | { type: 'new'; name: string };

export const NO_GROUP: GroupChoice = { type: 'none' };

/** Whether a choice can be submitted as it is (a new group needs a name). */
export const isChoiceReady = (choice: GroupChoice): boolean => choice.type !== 'new' || choice.name.trim().length > 0;
