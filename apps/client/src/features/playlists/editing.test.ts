import { describe, expect, it } from 'vitest';

import { buildEntryPatch, formFromEntry } from './entry-form';
import { moveItem } from './reorder';

const entry = { name: 'Euronews', number: 7, tvgId: 'euro.1', logo: 'http://logo.example/e.png' };

describe('buildEntryPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildEntryPatch(entry, formFromEntry(entry))).toEqual({ patch: null, errors: {} });
  });

  it('sends only what was edited', () => {
    expect(buildEntryPatch(entry, { ...formFromEntry(entry), name: '  Euronews HD ' }).patch).toEqual({ name: 'Euronews HD' });
    expect(buildEntryPatch(entry, { ...formFromEntry(entry), number: '12' }).patch).toEqual({ number: 12 });
  });

  it('clears optional fields when they are blanked', () => {
    expect(buildEntryPatch(entry, { name: 'Euronews', number: '', tvgId: ' ', logo: '' }).patch).toEqual({ number: null, tvgId: null, logo: null });
  });

  it('sets fields that were empty', () => {
    const bare = { name: 'X', number: null, tvgId: null, logo: null };
    expect(buildEntryPatch(bare, { name: 'X', number: '5', tvgId: 'x.1', logo: 'https://l.example/x.png' }).patch).toEqual({ number: 5, tvgId: 'x.1', logo: 'https://l.example/x.png' });
    expect(buildEntryPatch(bare, formFromEntry(bare)).patch).toBeNull();
  });

  it('refuses what the server would refuse, field by field', () => {
    const base = formFromEntry(entry);
    expect(buildEntryPatch(entry, { ...base, name: '   ' }).errors.name).toBeDefined();
    expect(buildEntryPatch(entry, { ...base, name: 'x'.repeat(301) }).errors.name).toBeDefined();
    for (const number of ['0', '-3', '1.5', 'abc', '100000']) expect(buildEntryPatch(entry, { ...base, number }).errors.number, number).toBeDefined();
    for (const logo of ['javascript:alert(1)', 'ftp://x/y.png', 'not a url', 'data:image/png;base64,AAAA']) expect(buildEntryPatch(entry, { ...base, logo }).errors.logo, logo).toBeDefined();
    const bad = buildEntryPatch(entry, { name: '', number: '0', tvgId: 'x'.repeat(201), logo: 'nope' });
    expect(bad.patch).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(['logo', 'name', 'number', 'tvgId']);
  });
});

describe('moveItem', () => {
  it('moves an item one place', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('leaves the order alone at the ends and for unknown items, without mutating', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(list, 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(list, 'z', 1)).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
