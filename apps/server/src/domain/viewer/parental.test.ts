import { describe, expect, it } from 'vitest';

import { isTrivialPin, isValidPin, normaliseLocks } from './parental.js';

describe('parental PIN', () => {
  it('accepts 4–8 digits and refuses the guessable ones', () => {
    for (const pin of ['4826', '73190', '58213907']) expect(isValidPin(pin) && !isTrivialPin(pin)).toBe(true);
    for (const pin of ['123', '123456789', '12a4', ' 4826']) expect(isValidPin(pin)).toBe(false);
    for (const pin of ['0000', '7777', '1234', '4321', '345678', '9876']) expect(isTrivialPin(pin)).toBe(true);
    expect(isTrivialPin('1357')).toBe(false);
  });

  it('normalises lock lists (trimmed, unique, display names)', () => {
    expect(
      normaliseLocks(
        [{ sourceId: 's', group: ' News ' }, { sourceId: 's', group: 'News' }, { sourceId: 's', group: '  ' }],
        [{ sourceId: 'operator', key: 'c1', name: '' }, { sourceId: 'operator', key: 'c1', name: 'Dup' }],
      ),
    ).toEqual({ lockedGroups: [{ sourceId: 's', group: 'News' }], lockedChannels: [{ sourceId: 'operator', key: 'c1', name: 'c1' }] });
  });
});
