import { join } from 'node:path';

import { findHardcodedText } from '@ziptv/i18n/lint';
import { describe, expect, it } from 'vitest';

describe('screens', () => {
  it('show no text that bypasses the translations (ka / en / ru)', () => {
    const root = join(process.cwd(), 'src'); // vitest runs in the app's folder
    expect(findHardcodedText(root).map(({ file, line, text }) => `${file}:${line} ${text}`)).toEqual([]);
  });
});
