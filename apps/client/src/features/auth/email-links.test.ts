import { describe, expect, it } from 'vitest';

import { tokenFromFragment } from './email-links';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

describe('tokenFromFragment', () => {
  it('reads the token of an email link', () => {
    expect(TOKEN).toHaveLength(43);
    expect(tokenFromFragment(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it('refuses anything that is not exactly a token: missing, short, long, extra parameters, other keys', () => {
    for (const bad of ['', '#', '#token=', `#token=${TOKEN.slice(1)}`, `#token=${TOKEN}x`, `#token=${TOKEN}&x=1`, `#other=${TOKEN}`, TOKEN, `?token=${TOKEN}`, `#token=${TOKEN.slice(0, 42)}!`]) {
      expect(tokenFromFragment(bad), bad).toBeNull();
    }
  });
});
