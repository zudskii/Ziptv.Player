import { describe, expect, it } from 'vitest';

import { normalizeChannelName } from '../shared/text.js';
import { buildGuideIndex, episodeLabel, isCatchupAvailable, matchChannel, nowAndNext, parseXmltvTime, programmeProgress, retentionWindow } from './epg.js';

const at = (iso: string) => new Date(iso);

describe('XMLTV time', () => {
  it('parses offsets, missing seconds/offset and rejects junk', () => {
    expect(parseXmltvTime('20261001143000 +0400')?.toISOString()).toBe('2026-10-01T10:30:00.000Z');
    expect(parseXmltvTime('20261001143000 -0130')?.toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(parseXmltvTime('202610011430')?.toISOString()).toBe('2026-10-01T14:30:00.000Z');
    expect(parseXmltvTime('20261001143000Z')?.toISOString()).toBe('2026-10-01T14:30:00.000Z');
    expect(parseXmltvTime('yesterday')).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
  });
});

describe('programmes', () => {
  const list = [
    { start: at('2026-10-01T12:00:00Z'), stop: at('2026-10-01T14:00:00Z'), title: 'A' },
    { start: at('2026-10-01T14:00:00Z'), stop: at('2026-10-01T16:00:00Z'), title: 'B' },
    { start: at('2026-10-01T16:00:00Z'), stop: at('2026-10-01T16:30:00Z'), title: 'C' },
  ];

  it('finds now and next (and next after a gap)', () => {
    expect(nowAndNext(list, at('2026-10-01T15:00:00Z'))).toMatchObject({ now: { title: 'B' }, next: { title: 'C' } });
    expect(nowAndNext(list, at('2026-10-01T11:00:00Z'))).toMatchObject({ now: null, next: { title: 'A' } });
    expect(nowAndNext(list, at('2026-10-01T17:00:00Z'))).toEqual({ now: null, next: null });
  });

  it('computes progress and archive availability', () => {
    expect(programmeProgress(list[0]!, at('2026-10-01T13:30:00Z'))).toBe(0.75);
    const now = at('2026-10-03T00:00:00Z');
    expect(isCatchupAvailable(list[0]!, 3, now)).toBe(true);
    expect(isCatchupAvailable(list[0]!, 1, now)).toBe(false);
    expect(isCatchupAvailable(list[0]!, null, now)).toBe(false);
    expect(isCatchupAvailable(list[1]!, 3, at('2026-10-01T15:00:00Z'))).toBe(false); // still on air
  });

  it('labels episodes (onscreen first, zero-based xmltv_ns otherwise)', () => {
    expect(episodeLabel([{ system: 'xmltv_ns', value: '1.4.' }, { system: 'onscreen', value: 'S2 E5' }])).toBe('S2 E5');
    expect(episodeLabel([{ system: 'xmltv_ns', value: '1.4/10.0/1' }])).toBe('S2 E5');
    expect(episodeLabel([{ system: 'xmltv_ns', value: '.11.' }])).toBe('E12');
    expect(episodeLabel([])).toBeNull();
  });

  it('keeps the archive window behind and N days ahead', () => {
    const window = retentionWindow(at('2026-10-10T00:00:00Z'), 3, 7);
    expect(window.from.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(retentionWindow(at('2026-10-10T00:00:00Z'), 0, 7).from.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('channel matching', () => {
  const own = buildGuideIndex('own', [
    { id: 'BBCOne.uk', names: ['BBC One'] },
    { id: 'sport1.ge', names: ['Sport 1'] },
  ]);
  const manualGuide = buildGuideIndex('extra', [
    { id: 'bbc1-alt', names: ['BBC One HD'] },
    { id: 'Rustavi2.ge', names: [] },
  ]);
  const target = (tvgId: string | null, name: string, xtreamEpgId: string | null = null) => ({ key: 'k', tvgId, xtreamEpgId, nameKey: normalizeChannelName(name) });

  it('prefers manual mapping, then tvg-id (case-insensitive), then name — in guide priority order', () => {
    expect(matchChannel(target('bbcone.UK', 'Whatever'), undefined, [own, manualGuide])).toEqual({ guideId: 'own', epgChannelId: 'BBCOne.uk', match: 'tvg-id' });
    expect(matchChannel(target(null, 'UK: BBC One FHD'), undefined, [own, manualGuide])).toEqual({ guideId: 'own', epgChannelId: 'BBCOne.uk', match: 'name' });
    expect(matchChannel(target(null, 'BBC One'), { guideId: 'extra', epgChannelId: 'bbc1-alt' }, [own, manualGuide])).toEqual({
      guideId: 'extra',
      epgChannelId: 'bbc1-alt',
      match: 'manual',
    });
    expect(matchChannel(target(null, 'Sport'), undefined, [own])).toBeNull();
  });

  it('uses the Xtream epg_channel_id and ids as names when display-names are missing', () => {
    expect(matchChannel(target(null, 'x', 'sport1.ge'), undefined, [own])).toMatchObject({ epgChannelId: 'sport1.ge', match: 'tvg-id' });
    expect(matchChannel(target(null, 'Rustavi 2 HD'), undefined, [own, manualGuide])).toEqual({ guideId: 'extra', epgChannelId: 'Rustavi2.ge', match: 'name' });
  });

  it('ignores a manual mapping to a channel that no longer exists in the guide', () => {
    expect(matchChannel(target('sport1.ge', 'Sport 1'), { guideId: 'own', epgChannelId: 'gone' }, [own])).toMatchObject({ match: 'tvg-id' });
  });
});
