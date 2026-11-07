import { describe, expect, it } from 'vitest';

import type { ProviderRecord } from '../../application/ports/operator.js';
import { ReferenceVendorFeed } from '../../test/reference-vendor-feed.js';
import { Ed25519FeedSignatures } from '../crypto/feed-signatures.js';
import { VendorFeedAdapter, type VendorFeedError } from './vendor-feed-adapter.js';

const vendor = new ReferenceVendorFeed('acme');
const provider = (patch: Partial<ProviderRecord> = {}) =>
  ({ id: 'p1', slug: 'acme', name: 'Acme', type: 'vendor_feed', config: { publicKeys: [{ id: vendor.keyId, key: vendor.publicKey }] }, feed: { cursor: null, generatedAt: null }, ...patch }) as ProviderRecord;
const signatures = new Ed25519FeedSignatures();
const adapter = new VendorFeedAdapter({ upstream: { fetchBytes: async () => Promise.reject(new Error('not used')) }, signatures, openLocator: () => null });
const parse = (since: string | null = null, target = provider()) => {
  const { body, signature } = vendor.signed(since);
  return adapter.parse(target, body, signature);
};
const right = { territories: ['GE'], devices: ['web'], models: ['subscription'], start: '2026-01-01T00:00:00Z', maxQuality: 'hd' };

describe('Ed25519 feed signatures', () => {
  it('accepts raw base64 and PEM keys, nothing else', () => {
    expect(signatures.isPublicKey(vendor.publicKey)).toBe(true);
    expect(signatures.isPublicKey('not a key')).toBe(false);
    expect(signatures.isPublicKey(Buffer.alloc(31).toString('base64'))).toBe(false);
  });
});

describe('vendor feed adapter', () => {
  vendor.upsert('channels', { id: 'news', name: 'News 24', tvgId: 'news.ge', stream: { url: 'https://cdn.example/news/master.m3u8' }, rights: [right], packages: ['basic'] });
  vendor.upsert('channels', { id: 'bad', name: 'Bad Rights', stream: { url: 'https://cdn.example/bad.m3u8' }, rights: [{ ...right, territories: ['Georgia'] }] });
  vendor.upsert('channels', { id: 'nostream', name: 'No Stream' });
  vendor.upsert('vod', { id: 'm1', type: 'movie', title: 'Heist', year: 1999, genres: ['Action'], stream: { url: 'https://cdn.example/m1.mp4' }, rights: [right], packages: ['basic'] });
  vendor.upsert('vod', { id: 's1', type: 'series', title: 'Show', episodes: [{ id: 'e1', season: 1, episode: 1, title: 'Pilot', stream: { url: 'https://cdn.example/e1.m3u8' } }] });
  vendor.upsert('packages', { id: 'basic', name: 'Basic' });

  it('parses a signed snapshot; invalid items are skipped and reported, the rest applies', () => {
    const delta = parse();
    expect(delta.full).toBe(true);
    expect(delta.channels.map((channel) => channel.externalId)).toEqual(['news']);
    expect(delta.channels[0]).toMatchObject({ kind: 'hls', tvgId: 'news.ge', rights: [{ territories: ['GE'], devices: ['web'], maxQuality: 'hd', catchupDays: 0 }] });
    expect(delta.vod.map((item) => [item.externalId, item.type, item.episodes.length])).toEqual([
      ['m1', 'movie', 0],
      ['s1', 'series', 1],
    ]);
    expect(delta.packages).toEqual([{ externalId: 'basic', name: 'Basic', description: null, channelIds: ['news'], vodIds: ['m1'] }]);
    expect(delta.issues.map((issue) => issue.path).sort()).toEqual(['channels[1].rights[0]', 'channels[2]']);
  });

  it('sends only the changes after a cursor, with deletions', () => {
    const cursor = vendor.cursor;
    vendor.remove('vod', 's1');
    vendor.upsert('channels', { id: 'sport', name: 'Sport', stream: { url: 'https://cdn.example/sport.m3u8' } });
    const delta = parse(cursor);
    expect(delta.full).toBe(false);
    expect(delta.channels.map((channel) => channel.externalId)).toEqual(['sport']);
    expect(delta.channels[0]!.rights).toBeNull(); // the feed says nothing about its rights
    expect(delta.deleted.vod).toEqual(['s1']);
  });

  it('refuses unsigned, wrongly signed, tampered or foreign feeds as a whole', () => {
    const refused = (mode: ReferenceVendorFeed['signing']) => {
      vendor.signing = mode;
      try {
        return (() => {
          try {
            parse();
            return null;
          } catch (error) {
            return error as VendorFeedError;
          }
        })();
      } finally {
        vendor.signing = 'valid';
      }
    };
    expect(refused('none')?.code).toBe('signature_missing');
    expect(refused('wrong-key')?.code).toBe('signature_invalid');
    expect(refused('tampered')?.code).toBe('signature_invalid');
    expect(() => parse(null, provider({ config: { publicKeys: [{ id: 'other', key: vendor.publicKey }] } }))).toThrow(/not configured/);
    expect(() => parse(null, provider({ slug: 'someone-else' }))).toThrow(/for provider "acme"/);
  });
});
