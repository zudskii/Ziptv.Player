# ZIPTV Vendor Feed — contract v1

The format a licensed content provider uses to deliver its catalogue and the rights that come
with it to ZIPTV. One format for every vendor: ZIPTV writes one adapter, a vendor writes one
endpoint. A vendor that already has its own API can be reached through a small translator that
produces this document; ZIPTV keeps no vendor-specific code in the sync.

Reference implementation (vendor side): `apps/server/src/test/reference-vendor-feed.ts`.
Parser (ZIPTV side): `apps/server/src/infrastructure/operator/vendor-feed-adapter.ts`.

## Transport

- `GET <feed url>` over **HTTPS** (plain HTTP is accepted only outside production).
- Optional `Authorization: Bearer <token>` — the token is part of the provider's credentials in
  the ZIPTV console and is stored encrypted.
- Incremental: ZIPTV sends `?since=<cursor>` with the cursor of the last feed it applied. The
  vendor answers with the changes since then (`"full": false`) or, when it cannot (unknown or
  expired cursor), with a complete snapshot (`"full": true`). The first request has no `since`.
- Body: JSON, UTF-8, at most 64 MB, at most 100 000 channels and 100 000 VOD items.

## Signature

Every response is signed with **Ed25519** over the exact bytes of the body (after any
`Content-Encoding` is removed):

```
X-Ziptv-Signature: keyId=<key id>, sig=<base64 signature>
```

The vendor hands its public key(s) to the operator out of band (base64 of the 32 raw bytes, or a
PEM `PUBLIC KEY` block), together with a key id. Several keys may be configured at once, so a key
can be rotated without downtime: sign with the new key once the operator has added it.

ZIPTV refuses the **whole feed** — and changes nothing — when:

| code | when |
|---|---|
| `signature_missing` | no `X-Ziptv-Signature` header |
| `signature_invalid` | unknown key id, or the signature does not match the body |
| `wrong_provider` | `provider.id` is not the slug the operator configured |
| `unsupported_version` | `version` is not `1` |
| `stale_feed` | `generatedAt` is in the future (more than 5 min), older than 7 days, or older than the last feed applied (a replayed snapshot cannot roll rights back) |
| `malformed` | the document itself does not follow this contract |

An invalid **item** (a channel without a stream, a right with an unknown territory, a duplicate id)
is skipped and reported in the sync journal (`items_skipped`); the rest of the feed applies.

## Document

```jsonc
{
  "version": 1,
  "provider": { "id": "acme-media" },           // = the provider slug in the ZIPTV console
  "generatedAt": "2026-11-05T10:00:00Z",
  "cursor": "opaque-string",                   // returned as ?since= next time
  "full": true,                                // true: complete snapshot; false: changes only
  "channels": [Channel],
  "vod": [Vod],
  "packages": [Package],
  "deleted": { "channels": ["id"], "vod": ["id"], "packages": ["id"] },  // incremental only
  "epg": { "xmltvUrls": ["https://…/guide.xml.gz"] }
}
```

In a full snapshot, everything not listed is gone. In an incremental feed, an item that is listed
replaces the previous version completely (send all of its fields, including all of its rights).

### Channel

```jsonc
{
  "id": "news-24",                 // stable, unique within the vendor
  "name": "News 24",
  "tvgId": "news24.ge",            // optional: matches XMLTV and helps automatic matching
  "logo": "https://…/logo.png",
  "groups": ["News"],
  "stream": { "url": "https://cdn…/news/master.m3u8", "headers": { "Referer": "…" } },
  "catchup": { "days": 7, "mode": "shift", "template": null },   // optional archive
  "rights": [Right],               // omitted = the feed says nothing; the operator's own grants decide
  "packages": ["basic"]
}
```

`catchup.mode`: `shift` (`?utc=&lutc=`), `append`, `flussonic`, `xc` (Xtream-style timeshift path,
given as `template`).

### Vod

```jsonc
{
  "id": "m-1001",
  "type": "movie",                 // or "series"
  "title": "The Heist",
  "year": 1999,
  "genres": ["Action", "Crime"],   // any language; ZIPTV maps them to its canonical genres
  "poster": "https://…",
  "plot": "…",
  "durationSecs": 6000,
  "rating": 7.4,                   // 0–10
  "stream": { "url": "https://…/m-1001.m3u8" },   // movies only
  "episodes": [ { "id": "e1", "season": 1, "episode": 1, "title": "Pilot", "durationSecs": 2700, "stream": { "url": "…" } } ],
  "rights": [Right],
  "packages": ["basic"]
}
```

### Right

```jsonc
{
  "territories": ["GE", "AM"],     // ISO 3166-1 alpha-2, or "*" for worldwide
  "devices": ["web", "mobile", "tv", "stb"],
  "models": ["subscription", "fast", "b2b"],
  "start": "2026-01-01T00:00:00Z",
  "end": null,                     // null = open-ended
  "catchupDays": 7,                // 0–30; 0 = live only
  "maxQuality": "hd"               // "sd" | "hd" | "fhd" | "uhd" | null (no limit)
}
```

### Package

```jsonc
{ "id": "basic", "name": "Basic", "description": "…" }
```

Membership is declared on the items (`packages` on channels and VOD). Packages are stored for the
commercial catalogue (Phase 17); this contract does not set prices.

## What ZIPTV does with it

- **Channels** go through the same ingestion as every provider: matched to a master channel by
  `tvgId` / name aliases, otherwise queued for review in the console.
- **Rights** (Mode A, vendor-managed): for every matched channel, the vendor's rights become rights
  grants of origin `feed`, kept exactly in step with the latest feed (added, unchanged, or revoked
  — revocation stops running viewings). The operator's own grants (origin `manual`) stay; a manual
  grant wider than the vendor licenses is listed under the provider's *conflicts*.
  Mode B (ingest only) = omit `rights`: the operator's grants alone decide.
- **Quality limit**: when the grant that lets a viewer watch has `maxQuality`, the stream proxy
  removes taller HLS variants from master playlists before the player sees them. Non-HLS feeds
  with a quality limit are not offered (the limit could not be enforced).
- **Movies, series, packages** are stored (Phase 17 decides how they are sold).
- Every sync, refused feed and skipped item is written to the provider's **sync journal**.
