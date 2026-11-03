# Operator master catalog (ZP-ENT-03)

ZIPTV runs two catalogs side by side:

| | BYO (bring your own) | Operator |
| --- | --- | --- |
| Who adds channels | the subscriber (M3U / Xtream source) | staff, from licensed providers |
| Identity of a channel | `(source_id, key)`, changes per source | `channel_master.id`, stable across providers |
| Visibility | everything in the user's source | only what an active **rights grant** covers |
| Delivery | direct or proxy (`STREAM_DELIVERY`) | **always proxy** — upstreams never reach a client |
| User state | My List / history keyed by source | favourites / history keyed by `channel_master.id` |

Nothing in the BYO path changed; both coexist in the same account and profile.

## Model

```
providers ── provider_credentials (secret_ref: env:ZIPTV_SECRET_* or enc:…)
    └── provider_streams          (what a provider offers; the review queue)
           └── channel_feeds ── channel_master ── channel_aliases (dedup keys)
                                     ├── rights_grants   (territory × device × model × time × contract)
                                     └── lineup_channels ── lineups (per market, numbered)
```

* One stream feeds at most one master channel (`UNIQUE provider_stream_id`); an alias key points at
  one channel (`PRIMARY KEY (kind, key)`); a lineup number is unique within its lineup.
* Several feeds per channel = primary + backups, ordered by `priority` (lower first). Playback
  offers every playable feed as a candidate, so the player falls back without a new request.

## Ingestion and dedup

```
provider sync (worker, lease per provider)
  → adapter.listChannels()           M3U / Xtream / Mock
  → upsert provider_streams          new · seen · gone (not seen this sync)
  → match by alias:  tvg-id  ▶  normalised name   → matched, feed created (priority = max + 10)
  → otherwise pending in the review queue, with a suggested channel (word-prefix name search)
```

Aliases are created only by staff decisions (create a channel, match a stream, add a name), so
automatic matching **recognises** curated channels — it never invents one. The review queue decides:
*create* (new master channel from the stream; its keys become aliases), *match* (to an existing
channel; keys added), or *ignore*. Duplicates found later are merged: everything of the merged
channel — aliases, feeds, grants, lineup places, favourites, history — moves to the survivor.
Concurrency: review decisions lock the stream row; the sync worker only auto-attaches streams that
are still `pending`, and a feed is created at most once per stream (`ON CONFLICT DO NOTHING`), so a
console decision taken during a sync always wins. Deleting a feed marks its stream `ignored` (not
`pending`), otherwise its aliases would re-attach it on the next sync; it can be matched again from
the review queue.

## Rights (the invariant)

A channel is listed and playable for a viewer only while an active grant covers the viewer's
**country**, **device class** and the current time (`endAt` exclusive). No grant → not listed, and
`POST /playback` answers `403 NOT_ENTITLED` with `reason`: `territory`, `device` or `not_licensed`.

* The country is decided by the server: `OPERATOR_COUNTRY_HEADER` (a header the edge always
  overwrites, e.g. Cloudflare `cf-ipcountry`), else `OPERATOR_DEFAULT_COUNTRY`. Clients cannot pass
  one; an unknown country only matches worldwide (`*`) grants.
* The device class (`web`, `mobile`, `tv`, `stb`) is declared by the client. It is a contractual
  distinction, not a security boundary; device attestation belongs to Phase 8.
* Business model (`subscription`, `fast`, `b2b`) is stored on grants and checked once Commerce
  (Phase 8) knows the viewer's package.
* Revoking a grant hides the channel within the snapshot cache (≤ 60 s, cleared immediately on
  every console write, across instances via the invalidation bus). Already issued stream tokens
  live until their TTL — the same rule as session revocation.

## BYO → operator migration strategy (6.8)

1. **Coexistence.** Subscribers keep their own sources; operator channels appear in **Channels**
   as soon as the operator carries anything licensed for their market. A user without sources
   lands on Channels instead of onboarding.
2. **Recognition, not copying.** `POST /operator/favorites/import-from-my-list` maps channels on
   the user's My List to master channels with the same alias keys used for ingestion (tvg-id, then
   normalised name). Only channels visible to the user (rights) are added; it is idempotent.
3. **Stable identity going forward.** Operator favourites and history reference
   `channel_master.id`, so provider changes, merges and feed swaps never break user state.
4. **No silent rewrite of BYO data.** BYO list items stay as they are; a later phase can hide BYO
   duplicates of operator channels in the UI once the operator offer is complete for a market.

## Console API (`/admin/v1`, all writes audited)

| Area | Endpoints | Permission |
| --- | --- | --- |
| Providers | `GET/POST /providers`, `PATCH /providers/:id`, `POST /providers/:id/credential`, `POST /providers/:id/sync`, `GET /providers/:id/health` | `providers:read/write` |
| Review | `GET /streams?providerId&status`, `POST /streams/:id/review` (`match`/`create`/`ignore`) | `catalog:read/write` |
| Channels | `GET/POST /categories`, `GET/POST /channels`, `GET/PATCH /channels/:id`, `POST /channels/:id/merge` | `catalog:read/write` |
| Feeds | `PATCH/DELETE /feeds/:id` (priority, enable/disable) | `catalog:write` |
| Rights | `POST /channels/:id/grants`, `POST /grants/:id/revoke` | `rights:write` |
| Lineups | `GET/POST /lineups`, `GET/PATCH /lineups/:id` (entries replace the numbering) | `catalog:read/write` |

Credentials are given either as a reference (`{ "secretRef": "env:ZIPTV_SECRET_NAME" }`) or as the
connection itself (`{ "connection": { "url" } }` / `{ "server", "username", "password" }`), which
is sealed with `DATA_ENCRYPTION_KEY` and never returned or written to the audit log. Mock providers
(channel list typed into the console) are for development and are refused in production unless
`OPERATOR_ALLOW_MOCK_PROVIDERS=true`.

## Open items

* EPG for master channels (provider XMLTV → `channel_master`) — with Phase 7/11 integrations.
* Packages / entitlements narrowing grants by business model — Phase 8.
* Console screens for all of the above — Phase 9 (the API is complete).
* Per-feed health and automatic failover ordering — Phase 7.
