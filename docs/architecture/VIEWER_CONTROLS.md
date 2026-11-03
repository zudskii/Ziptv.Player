# Catch-up, Multi-view and parental controls (Phase 10)

**Gate:** locked content is not handed out by any endpoint without the PIN.

## Catch-up

### Archive addresses (10.1)

`domain/catalog/catchup-url.ts` builds the archive URL of a past programme from the channel's
stream URL and its `catchup` attributes (TiviMate / Kodi IPTV Simple conventions):

| Mode | Archive URL |
| --- | --- |
| `default` | `catchup-source` is the URL (absolute, or relative to the stream) |
| `append` | `catchup-source` appended to the stream URL (default `?utc={utc}&lutc={lutc}`), merged into its query |
| `shift` (`timeshift=`, `tvg-rec=`) | `utc=…&lutc=…` added to the stream query |
| `flussonic` | `…/index.m3u8` → `…/index-{utc}-{duration}.m3u8`; `…/mpegts` or `.ts` → `…/timeshift_abs-{utc}.ts` |
| `xtream` | `/timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-MM}/{id}.ts`, start in the **panel's time zone** (`server_info.timezone`, recorded at sync) |

Placeholders: `{utc}` `{start}` `{utcend}` `{end}` `{lutc}` `{now}` `{timestamp}` `{duration}`
`{duration:N}` `{offset:N}` `{Y}{m}{d}{H}{M}{S}` and `{utc:FMT}`-style formats (UTC), with or
without a leading `$`. An unknown placeholder (e.g. `{catchup-id}`) makes the archive unplayable
rather than guessing.

A programme can be replayed when it **has ended**, **started inside the archive window** and is
**at most 12 h** long (`catchupProblem`). Programme times are those the viewer sees (with the
profile's EPG time shift, which corrects the guide).

### BYO catch-up (10.2)

`POST /playback` with `{ type: 'catchup', sourceId, key, start, end }`: same visibility and
parental rules as the channel; the archive URL is built server-side; with `STREAM_DELIVERY=proxy`
it is proxied like any stream. The plan carries the guide's programme (title, description) when
there is one.

Client: ▶ Watch in the mini guide, in the TV Guide's programme dialog and on programme search
results; the archive opens at `/live/:sourceId/:key?at=…&until=…` (deep-linkable) with a "Back to
live" bar.

**Exported playlists (`proxied`)** now keep catch-up: the entry gets `catchup="default"` and a
`catchup-source` pointing to `/api/v1/media/archive/<token>?utc={utc}&utcend={utcend}`. The
encrypted token holds the live stream and its catch-up rules and is bound to the export link; the
server checks the window, builds the provider URL and redirects into the stream proxy. Revoking
the link stops it.

### Licensed (operator) catch-up (10.3)

Catch-up is licensed separately from live:

* `rights_grants.catchup_days` (0 = live only; set in the console grant dialog, part of the
  four-eyes request and its summary);
* `provider_streams.catchup` — the provider's archive (from the M3U attributes / Xtream
  `tv_archive`, with the panel time zone);
* a viewer may replay a programme aired at `t` only under grants that cover them **now** *and*
  covered the broadcast at `t` (the archive never reaches back before the licence began), within
  `catchup_days`, and within each feed's own archive (`catchupGrants`);
* the viewing is a **playback session** like a live one (`archive: {start, end}`): device,
  entitlement (the package's business model must be covered by a catch-up grant), stream slot,
  heartbeats; heartbeats re-check catch-up rights, so revoking the grant ends it.

`OperatorChannelDto.catchupDays` = licensed × provider archive for this viewer;
`GET /operator/channels/:id/schedule` flags the past programmes that can be replayed (the operator
guide keeps 7 days back).

## Multi-view (10.4)

`/multiview`: up to four players (2×2). Each tile is a full player; only the focused tile is heard
and takes the keyboard (`1`–`4` or a click moves the focus).

* Licensed channels: one **playback session** per tile — the plan's simultaneous-stream limit
  applies as on separate devices.
* The subscriber's own **Xtream accounts**: a lease per viewing on `max_connections`
  (`SourceConnections`). The holder is the viewing; a player moving to another channel sends
  `replaces` so its previous connection is freed first; heartbeats renew, `stop` releases, a silent
  viewing expires after 2 minutes. The next player over the limit gets
  `409 CONCURRENCY_LIMIT {reason: 'source_connections'}` instead of a provider error mid-play.

## Parental controls (10.5)

* **One PIN per account** (4–8 digits, not a repeated digit or straight run), scrypt-hashed.
  5 wrong PINs in a row (counted atomically) lock it for 15 minutes — a right PIN is refused while
  locked. Set / changed / removed / locked PINs produce a security notification.
* **Rules per profile** (`PUT /me/parental/rules`, PIN required, never from a kids profile): hide
  adult; locked groups and channels — of a BYO source, or of the licensed catalog
  (`sourceId: 'operator'`, group = category name, key = channel id).
* **Unlock**: `POST /me/parental/unlock {pin}` → a token (`X-Unlock-Token` or `unlockToken`),
  HMAC-signed, valid `PARENTAL_UNLOCK_MINUTES` (15), bound to the account, the device session,
  the profile and the PIN version (a random value per PIN, so a removed-and-reset PIN never revives
  old tokens). The client keeps it for the tab only.
* **Where it is enforced** (server, through the request's `Viewer`): live lists (locked flag),
  VOD lists, details, search, Home, EPG, My List, playback plans (BYO, catch-up) and operator
  playback sessions (`PARENTAL_LOCKED` without a valid token). An operator viewing checks the lock
  when it starts; heartbeats do not need the short-lived token.
* **Kids profiles are strict**: adult and locked content is filtered out — never shown as locked
  (VOD queries exclude locked groups in SQL so pages stay right); the PIN never unlocks content
  there; the PIN and rules cannot be changed there; sources, guides, playlists and purchases are
  read-only / refused; account notices (billing, security) are not shown there.
* **Profiles on a device** (`POST /profiles/:id/access {pin?}`):
  * a **PIN-protected profile** opens only with the PIN; the device session remembers it
    (`sessions.open_profile_id`);
  * entering a **kids profile** holds the device there (`sessions.kids_lock_profile_id`): without
    `X-Profile-Id` the server answers as the kids profile, any other profile answers
    `403 PIN_REQUIRED {reason: 'kids_lock'}` until the PIN is given; changing a profile's kind or
    protection, deleting a profile, and adding one from a held device need the PIN.
  * Profile routes are account-level (they work before a profile is open).
* **Export links** play outside the app (no profile, no locks): with a PIN set, creating one
  needs an unlock token.
* Removing the PIN removes the locks, profile protection and device kids locks with it.

## Notifications and player (10.6, 10.7)

* Notification center: grouped by day, all / unread, dismiss, "clear read"
  (`DELETE /notifications`); warnings and errors arriving while the app is open pop up as a toast.
* Player: `I` picture in picture, `C` subtitles, `0`–`9` jump (recordings, catch-up), `?`
  shortcuts overview; quality menu shows what Auto picked; Media Session API (OS media controls,
  headset keys, the PiP window).

## Known limits

| Limit | Plan |
| --- | --- |
| Locked channels still show their names, logos and guide titles to grown-up profiles (marked locked); only kids profiles hide them | Per-rule "hide instead of lock" option if asked for |
| A kids profile's own Continue Watching / history keeps an item that was locked after it was watched (title only; it does not play) | Filter by key on read |
| Existing export links (made before the PIN was set) keep working until revoked | Revoke export links when the first PIN is set (decision for product) |
| BYO connection leases are best-effort (a viewing paused for > 2 min frees its connection) | — |
| Partner revenue counts catch-up minutes like live minutes | Separate catch-up rates per contract (Phase 11) |
