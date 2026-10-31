# ZIPTV — დეტალური Roadmap (ქრონოლოგიურად)

ბაზა: `Ziptv.Player-phase5` (PostgreSQL · Kysely · Express 5 · React 19).
წყაროები: `docs/architecture/ENTERPRISE_BLUEPRINT.md` + თავდაპირველი Personal Streaming Hub სპეციფიკაცია.

## წესები ყველა ფაზისთვის

- ჯერ ფუნქციონალი; ინტეგრაციები (გადახდა, CDN, DRM, vendor-ები) პორტის უკან, fake/in-memory ადაპტერით. რეალური ინტეგრაციები — ფაზა 11.
- ფაზა მთავრდება მხოლოდ თუ მწვანეა: `eslint`, `typecheck`, `build`, server + client ტესტები PostgreSQL-ზე, ბრაუზერში გავლა.
- მიწოდება: მხოლოდ შეცვლილი ფაილები (+ წაშლილების სია).
- **მოდელი**: **Opus** = Claude Opus 5.5 (არქიტექტურა, უსაფრთხოება, state machine, მიგრაციები); **Sonnet** = Sonnet 5.5 (ეკრანები, CRUD, ტესტები, დოკუმენტები); **Haiku** = Haiku 4.5 (მექანიკური ცვლილებები). არჩევანი რისკის მიხედვითაა და ბენჩმარკით არ დამიმტკიცებია.

## ფაზების რუკა

| # | ფაზა | მოდელი |
|---|---|---|
| 0 | კომერციული დასტური (პარალელური, არა-კოდი) | Sonnet |
| 1 | უსაფრთხოება P0 ✅ | Opus |
| 2 | Enterprise საფუძველი ✅ | Opus + Sonnet |
| 3 | EPG ✅ | Opus + Sonnet |
| 4 | Xtream + VOD მოდელი ✅ | Opus |
| 5 | მაყურებლის გამოცდილება | Sonnet + Opus |
| 6 | Master Catalog და კონტენტ-ოპერაციები | Opus |
| 7 | Stream Health და Failover | Opus |
| 8 | Commerce და Playback Authorization | Opus |
| 9 | Admin Console | Sonnet |
| 10 | Catch-up, Multi-view, Parental | Sonnet + Opus |
| 11 | რეალური ინტეგრაციები | Opus + Sonnet |
| 12 | Pilot Hardening | Opus + დამოუკიდებელი review |
| 13 | Scale | — |

---

## ფაზა 0 — კომერციული დასტური (შენ + იურისტი, პარალელურად)

კოდი არ არის, მაგრამ ხელშეკრულებები თვეობით იწელება, ამიტომ ახლავე იწყება. ჩემგან: შაბლონები.

- 0.1 გადაწყვეტილებები: საწყისი ტერიტორია (მხოლოდ საქართველო / ერთი EU ქვეყანა), ბიზნესმოდელი (B2C / FAST / B2B), რეალური ერთდროული მაყურებლების სამიზნე (100 / 1 000 / 10 000), მიწოდების რეჟიმი (A: vendor-managed, B: ZIPTV-managed).
- 0.2 RFQ პაკეტი SoFast / MwareTV / Zattoo-სთვის — Blueprint §3-ის 10 სავალდებულო ველი. *(Sonnet: წერილის შაბლონი)*
- 0.3 Rights matrix — CSV სქემა, რომელიც პირდაპირ იტვირთება `rights_grants`-ში (არხი × ტერიტორია × მოწყობილობა × ბიზნესმოდელი × ვადა). *(Sonnet)*
- 0.4 ტექნიკური trial: წერილობითი ნებართვა, საცდელი feed-ები, 24–72 საათიანი დაკვირვება.
- 0.5 იურისტის დასკვნა: ZIPTV-ის იურიდიული მოდელი (OTT თუ retransmission), საქართველოს კომუნიკაციების კომისიის ავტორიზაცია, გადასახადები, მომხმარებლის დაცვა.
- 0.6 Unit economics ცხრილი: CDN ტრაფიკი, ლიცენზია, minimum guarantee, DRM, გადახდის საკომისიო, support. *(Sonnet)*
- **Gate:** არსებობს მინიმუმ 50 არხი წერილობითი უფლებით და მუშა trial feed-ით.

## ფაზა 1 — უსაფრთხოება P0 (ZP-ENT-02) · **Opus** · ✅ დასრულდა

> **სტატუსი:** 1.1–1.11 გაკეთებულია. დეტალები და დარჩენილი ხარვეზები: `docs/architecture/THREAT_MODEL.md`.
> გადატანილია: playback session/heartbeat-ზე მიბმა (ფაზა 8, `LeaseStore` უკვე მზადაა), DASH-ის proxy (ფაზა 11),
> catch-up `proxied` export-ში (ფაზა 10), dev-dependency-ების major განახლება (vitest 5, tailwind 4).

მიზანი: არცერთ კლიენტთან არ მიდის provider-ის URL, პაროლი ან header.

- 1.1 **CI გაძლიერება.** `ci.yml`-ში PostgreSQL service-ით სრული ტესტები, `npm audit`, secret scan, migration smoke.
- 1.2 **Playback grant-ის ახალი დიზაინი.** `media-token.ts` ახლა base64url-ით ხელმოწერილ JSON-ს შეიცავს (`u`, `h`). ორი რეჟიმი:
  - *BYO* (მომხმარებლის საკუთარი წყარო): ტოკენი AES-256-GCM-ით დაშიფრული (არსებული `secret-cipher` + HKDF ახალი purpose-ით);
  - *Operator*: გაუმჭვირვალე 128-bit grant id, მისი მნიშვნელობა მხოლოდ სერვერზე (Redis/PG), მიბმული user + device + session-ზე.
  ტრეიდოფი: დაშიფრული ტოკენი stateless-ია (მარტივად მასშტაბირდება), მაგრამ მისი გაუქმება შეუძლებელია ვადამდე; grant id გაუქმდება მაშინვე, მაგრამ მეხსიერება/კითხვა სჭირდება.
- 1.3 **Manifest/segment rewriting** (`hls-rewriter.ts`) ბავშვი-grant-ებით, მოკლე TTL-ით; ტოკენის განახლება გრძელი live ყურებისთვის (ახლა ნაგულისხმევი TTL 6 საათია).
- 1.4 **`plan.ts` delivery policy.** დაემატოს `deliveryPolicy: 'byo' | 'operator'`; operator რეჟიმში `direct` candidate არასდროს აიგება.
- 1.5 **Playlist export.** დარჩეს მხოლოდ BYO წყაროებისთვის; operator კატალოგისთვის გამორთული (ტესტით).
- 1.6 **გაუქმება.** grant მოწმდება ყოველ მოთხოვნაზე სესიის სტატუსთან (მზადება ფაზა 8-ის concurrency-სთვის).
- 1.7 **Shared-state პორტები:** `RateLimitStore`, `Cache`, `LeaseStore` — in-memory + Redis (ioredis) ადაპტერები; Redis `docker-compose`-ში; cache invalidation pub/sub-ით (ახლა `MemoryCache` რეპლიკებს შორის არ სინქრონიზდება).
- 1.8 **Auth throttling** shared store-ზე (ახლა process-local), ანგარიშზე და IP-ზე.
- 1.9 **გაჟონვის ტესტი:** ავტომატური ტესტი, რომელიც ყველა API პასუხსა და ლოგში ეძებს upstream host-ს, username-ს, password-ს, token-ის ფრაგმენტებს.
- 1.10 **Hardening:** CSP/CORS/headers გადასინჯვა, SSRF ტესტები (private IP, redirect, DNS rebinding), body ზომები.
- 1.11 `docs/architecture/THREAT_MODEL.md`.
- **Gate:** გაჟონვის ტესტი მწვანეა; operator რეჟიმში არცერთი პასუხი არ შეიცავს upstream მისამართს; ორ რეპლიკაზე rate limit ერთობლივად მუშაობს.

## ფაზა 2 — Enterprise საფუძველი (ZP-ENT-04 ნაწილი) · ✅ დასრულდა

> **სტატუსი:** 2.1–2.9 გაკეთებულია. გადაწყვეტილებები: staff ანგარიშები ცალკეა subscriber-ებისგან; კონსოლი ცალკე listener-ზეა (`ADMIN_PORT`); worker = იგივე build `ROLE=worker`-ით (ცალკე `apps/worker` პაკეტი composition root-ს გააორმაგებდა); recovery codes ჯერ არ არის — დაკარგული authenticator-ის აღდგენა სხვა SUPER_ADMIN-ის ან CLI `recover`-ის გზით.

- 2.1 **მიგრაცია 0005:** როლების გაფართოება (`SUPER_ADMIN`, `CONTENT_MANAGER`, `NOC_OPERATOR`, `SUPPORT_AGENT`, `FINANCE`, `VIEW_ONLY`), `permissions` მატრიცა. *(Opus)*
- 2.2 **RBAC middleware** `requirePermission(...)`, deny-by-default. ტესტი, რომელიც ამოწმებს, რომ ყველა `/admin` route-ს აქვს დეკლარირებული permission. *(Opus)*
- 2.3 **Audit log:** `admin_audit_logs` (actor, action, target, before/after hash, IP, დრო); append-only (DB trigger UPDATE/DELETE-ს კრძალავს), hash-chain tamper-evident-ობისთვის. *(Opus)*
- 2.4 **Admin ავტორიზაცია:** ცალკე სესიები მოკლე TTL-ით, TOTP MFA, ცალკე origin, გამკაცრებული rate limit. *(Opus)*
- 2.5 **`apps/worker`:** ცალკე შესასრულებელი ფაილი არსებული `JobRunner`-ით; `ROLE=api|worker|all`; compose-ში ცალკე სერვისი. *(Opus)*
- 2.6 **`apps/admin` ჩონჩხი:** Vite + React, login, MFA, layout, როლზე დამოკიდებული ნავიგაცია, ზოგადი ცხრილი/ფილტრი კომპონენტები. *(Sonnet)*
- 2.7 **Secret reference** აბსტრაქცია (`secret_ref`): ახლა env/დაშიფრული ველი, მოგვიანებით secrets manager. *(Opus)*
- 2.8 **Transactional outbox** ცხრილი + dispatcher (ბილინგის გვერდითი ეფექტებისთვის). *(Opus)*
- 2.9 CI: admin/worker build და ტესტები. *(Sonnet)*
- **Gate:** ადმინის API უფლების გარეშე ყველაფერს უარყოფს; ყოველი admin write აუდიტშია; worker დამოუკიდებლად გადის.

## ფაზა 3 — EPG (ZP-ENT-05) · ✅ დასრულდა

> **სტატუსი:** 3.1–3.9 და 3.11 გაკეთებულია (Mongo ხაზიდან გადმოტანილი დომენი/პარსერი/UI, PostgreSQL-ზე ახალი persistence). 3.10: ძრავა time shift-ს უჭერს მხარს, პარამეტრის UI Settings-თან ერთად (5.10). ცნობილი ხარვეზები: `stop`-ის გარეშე პროგრამები იგნორირდება; ძიება `LIKE`-ზეა (pg_trgm — ფაზა 5.9).

Mongo ხაზიდან გადმოდის ბაზისგან დამოუკიდებელი კოდი და ტესტები; persistence ახლიდან იწერება Kysely-ზე.

- 3.1 **სქემა:** `epg_guides`, `epg_channels`, `epg_programmes`, `epg_mappings`; ინდექსები (`channel_id, start_at`), პროგრამების ფანჯრის გასუფთავება. *(Opus)*
- 3.2 **XMLTV downloader:** gzip magic-bytes, ზომის ლიმიტი, timeouts, `UpstreamClient`-ის SSRF პოლიტიკა. *(Opus)*
- 3.3 **SAX პარსერი** (htmlparser2): ნებისმიერი encoding, მუდმივი მეხსიერება, პროლოგის ბუფერი. *(Opus, პორტი)*
- 3.4 **დომენი:** XMLTV დროის პარსინგი, now/next, პროგრესი, matcher (ხელით mapping > tvg-id > სახელი), ტესტები. *(Opus, პორტი)*
- 3.5 **Guide generations:** ახალი თაობის ჩაწერა და ატომური გადართვა (CAS ტრანზაქციაში), ძველის წაშლა. *(Opus)*
- 3.6 **Linker:** `noopEpgLinker`-ის ჩანაცვლება; playlist-ის `url-tvg` და Xtream `xmltv.php` ავტომატურად მიება წყაროს; link-ის ცვლილებისას relink. *(Opus)*
- 3.7 **`epg-sync` worker:** 3 საათი, lease-ებით. *(Opus)*
- 3.8 **API:** `/epg/now`, `/epg/channels/:sourceId/:key`, `/epg/guide`, `/epg/search`, guides CRUD, mapping. *(Opus)*
- 3.9 **კლიენტი:** არხის სტრიქონი (LIVE now + პროგრესი + Next), now card, mini guide, programme dialog, TV Guide grid (virtualized, now line, sticky არხის სვეტი), guide manager, ხელით mapping dialog. *(Sonnet)*
- 3.10 **დროის სარტყელი** და EPG time shift პარამეტრი. *(Opus)*
- 3.11 "EPG unavailable" UX; live დაკვრა EPG-ის გარეშე ნორმალურად მუშაობს. *(Sonnet)*
- **Gate:** now/next ჩანს; ხელით mapping ერთ guide sync-ში ააქტიურებს არხს.

## ფაზა 4 — Xtream + VOD მოდელი · ✅ დასრულდა

> **სტატუსი:** 4.1–4.5, 4.7–4.9 გაკეთებულია. `XtreamProvider` (`player_api.php`, სიები თანმიმდევრულად — მეხსიერებაში ერთი სია), ანგარიშის სტატუსი, ეპიზოდები ზარმაცად (`get_series_info` პირველ გახსნაზე → იმავე revision-ში ინახება), stream URL-ები playback-ის დროს (`ProviderStreamUrls`), `GET /vod/:sourceId/series/:key`, M3U → Xtream გადაყვანა (ჯერ API-ს შემოწმება, გასაღებები უცვლელი), ყალბი Xtream panel-ის e2e და lab. 4.6: M3U კლასიფიკაცია უკვე არსებობდა (`classify.ts`), ცვლილება არ დასჭირდა. timeshift ბილდერი მზადაა, catch-up-ის დაკვრა — ფაზა 10. Movies/Series გვერდები — ფაზა 5.6.

- 4.1 **კატალოგის გაფართოება live-ის მიღმა:** `movies`, `series`, `episodes`, ვერსიული (revision) კატალოგი. *(Opus)*
- 4.2 **`XtreamClient`:** `player_api.php` — ავტორიზაცია, live/VOD/series კატეგორიები და სიები, `get_series_info` (ეპიზოდები ზარმაცად), `user_info`. *(Opus)*
- 4.3 **Provider რეგისტრაცია** `container.ts`-ში და ანგარიშის სტატუსის გადაყვანა (`auth_failed`, `expired`, trial, connections). *(Opus)*
- 4.4 **URL ბილდერები:** live, movie, series, timeshift; `StreamUrlResolver`. *(Opus)*
- 4.5 **M3U პანელის Xtream-ად გადაყვანა** (xtreamCandidate შემოთავაზება). *(Sonnet)*
- 4.6 M3U VOD კლასიფიკაციის (ფილმი / სერიალი / ეპიზოდი) გაფართოება არსებულ `domain/catalog/classify.ts`-ზე. *(Opus)*
- 4.7 ეპიზოდების ზარმაცი ჩატვირთვა და ქეში. *(Opus)*
- 4.8 შეცდომების რუკა: Authentication failed, Playlist expired, Source unavailable, Unsupported format. *(Sonnet)*
- 4.9 ტესტები ყალბ Xtream origin-ზე (Mongo ხაზის lab-ის გადმოტანა). *(Sonnet)*
- **Gate:** Xtream წყარო მთლიანად სინქრონდება (live + movies + series) და უკრავს.

## ფაზა 5 — მაყურებლის გამოცდილება

- 5.1 **პროფილები:** სქემა, ლიმიტი, `X-Profile-Id`; არსებული `viewer-resolver` გაფართოება. *(Opus)*
- 5.2 **user-state სქემა:** `list_items` (My List), `progress` (Continue Watching), `history` (ცალკე), უნიკალურობა profile + content ref-ზე. *(Opus)*
- 5.3 **რეალური `PlaybackObserver`** (ახლა `noop`): ივენთებიდან progress/history, ზღვრები (დასაწყისი/დასრულება). *(Opus)*
- 5.4 **`GET /home`:** Continue Watching, Live Now, Favorites, Recently Watched, Sports Live, Movies, Series, Recently Added; ქეში. *(Opus)*
- 5.5 **Home გვერდი:** სექციები, ცარიელი მდგომარეობები, ნაწილობრივი მონაცემები. *(Sonnet)*
- 5.6 **Movies და Series გვერდები:** ჯგუფები, სორტირება, დეტალები, სეზონები/ეპიზოდები, ზარმაცი მეტამონაცემები. *(Sonnet)*
- 5.7 **VOD player:** resume, შემდეგი ეპიზოდი, აუდიო/სუბტიტრების არჩევა. *(Sonnet)*
- 5.8 **My List, History** გვერდები; Continue Watching-ის მართვა. *(Sonnet)*
- 5.9 **გაერთიანებული ძიება:** არხები, პროგრამები, ფილმები, სერიალები, ეპიზოდები; PostgreSQL `pg_trgm` + full-text. *(Opus)*
- 5.10 **Settings:** General, Playback, Sources, EPG, Appearance (Dark/Light/System), Data & Storage, About. *(Sonnet)*
- 5.11 2.x ლოკალური ფავორიტების იმპორტი; onboarding-ის დახვეწა. *(Sonnet)*
- 5.12 საბოლოო ნავიგაცია: Home · Live TV · TV Guide · Movies · Series · My List · History · Sources · Settings. *(Haiku/Sonnet)*
- **Gate:** progress sync-ებს გადარჩება (სტაბილური გასაღებები); წყაროს წაშლა წმენდს მის user-state-ს.

## ფაზა 6 — Master Catalog და კონტენტ-ოპერაციები (ZP-ENT-03)

დღეს არხი მომხმარებლის წყაროს ეკუთვნის; ოპერატორს ერთიანი კატალოგი სჭირდება.

- 6.1 **სქემა:** `providers`, `provider_credentials` (`secret_ref`), `channel_master`, `channel_feeds`, `channel_aliases`, კატეგორიები/ქვეყნები/ენები. *(Opus)*
- 6.2 **`ProviderAdapter` პორტი:** `listChannels`, `resolveFeed`, `getEpg`, `health`; ადაპტერები: M3U/Xtream (ლიცენზირებული feed), Mock. *(Opus)*
- 6.3 **Ingestion + dedup:** provider sync → კანდიდატი არხები → კანონიკური ID (სახელის ნორმალიზაცია, tvg-id, ხელით merge) → review რიგი. *(Opus)*
- 6.4 **Rights:** `rights_grants` (ტერიტორია, მოწყობილობა, ბიზნესმოდელი, ვადა, კონტრაქტი). ინვარიანტი: აქტიური grant-ის გარეშე feed არ უკრავს. *(Opus)*
- 6.5 **Lineups:** ბაზრის მიხედვით, არხების ნომრები და რიგი. *(Opus)*
- 6.6 **Viewer API:** `GET /operator/channels?country&package`; BYO წყაროები პარალელურად ინარჩუნებს მუშაობას. *(Opus)*
- 6.7 ფავორიტები და სიები `channel_master.id`-ს ეყრდნობა. *(Opus)*
- 6.8 BYO → operator გადასვლის სტრატეგია. *(Opus)*
- 6.9 Admin API კატალოგისთვის (ყოველი write აუდიტში). *(Sonnet)*
- **Gate:** ერთი channelId-ს ორი ავტორიზებული feed აქვს; უფლებების გარეშე არხი არ ჩანს.

## ფაზა 7 — Stream Health და Failover (ZP-ENT-06)

- 7.1 `stream_probe_results` (დროითი სერია, retention/partition). *(Opus)*
- 7.2 **Probe ტიპები:** manifest (ასაკი, `EXT-X-MEDIA-SEQUENCE` პროგრესი), სეგმენტის ჩამოტვირთვა, `ffprobe` დეკოდის ნიმუში (იშვიათად), TTFB. HTTP 200 საკმარისი არაა. *(Opus)*
- 7.3 **სტატუსების state machine:** HEALTHY / UNHEALTHY / GEO_BLOCKED / NOT_ENTITLED / MAINTENANCE / PROVIDER_OUTAGE / UNKNOWN, hysteresis-ით. *(Opus)*
- 7.4 **Probe fleet:** worker-ები, provider-ზე rate limit, მინიმუმ ორი გეოგრაფია (კონფიგურაციით). *(Opus)*
- 7.5 **კლიენტის playback telemetry** → feed ჯანმრთელობა. *(Opus)*
- 7.6 **Failover:** მხოლოდ იმავე master არხის, უფლებით დაშვებულ backup-ზე; ზღვრები, cooldown, ოპერატორის override, ჟურნალი. *(Opus)*
- 7.7 **Incidents და alert-ები** (email/Slack/webhook ადაპტერი), acknowledge. *(Sonnet)*
- 7.8 **BYO წყაროების health** (Online / Slow / Unstable / Offline), ფრთხილი probing. *(Opus)*
- 7.9 მეტრიკების endpoint-ები (Prometheus). *(Sonnet)*
- **Gate:** primary → backup გადართვა ჟურნალით და ხელით override-ით.

## ფაზა 8 — Commerce და Playback Authorization (ZP-ENT-07/08/09)

- 8.1 **სქემა:** `packages`, `package_channels`, `subscriptions`, `entitlements`, `devices`, `playback_sessions`, `payment_events`, `invoices`. *(Opus)*
- 8.2 **Subscription state machine** (trialing → active → past_due → grace → canceled/expired), სუფთა დომენი + სრული ტესტები. *(Opus)*
- 8.3 **Entitlement engine:** წვდომა = აქტიური გამოწერა ∧ პაკეტი ∧ rights(ტერიტორია, მოწყობილობა) ∧ დაუბლოკავი. *(Opus)*
- 8.4 **Geo:** IP → ქვეყანა პორტი (fake + მოგვიანებით რეალური). *(Opus)*
- 8.5 **მოწყობილობები:** რეგისტრაცია, ლიმიტი, გაუქმება. *(Opus)*
- 8.6 **Concurrency manager:** ატომური lease (Redis Lua, PG fallback), heartbeat, ვადა, ლიმიტი გამოწერაზე. *(Opus)*
- 8.7 **`POST /operator/playback/sessions`** Blueprint §8-ის 7 ნაბიჯით + heartbeat + `DELETE`. *(Opus)*
- 8.8 **გადახდის პორტი + fake processor:** idempotent webhook (`payment_events` უნიკალური), სტატუსის გადამოწმება, reconciliation job, outbox. წვდომა არასდროს გაიცემა მხოლოდ success-გვერდზე დაბრუნებით. *(Opus)*
- 8.9 ტრიალი, გაუქმება, განახლება, დაბრუნება. *(Opus)*
- 8.10 **კლიენტი:** გეგმების გვერდი, checkout გადამისამართება, ანგარიში/მოწყობილობები, "ლიმიტი ამოიწურა" UX. *(Sonnet)*
- 8.11 **Bypass ტესტები:** ვადაგასული გამოწერა, მეორე მოწყობილობა, არასწორი ქვეყანა, გაუქმებული grant. *(Opus)*
- **Gate:** აქტიური entitlement-ის გარეშე ნაკადი არ გაიცემა; concurrency/geo არ გვერდავდება.

## ფაზა 9 — Admin Console

ყველა ეკრანი ეყრდნობა ფაზა 2-ის RBAC-ს; ბრაუზერის ტესტი თითო როლზე.

- 9.1 Overview (აქტიური მაყურებლები, ჯანმრთელი არხები, შემოსავალი)
- 9.2 Channels (დუბლიკატები, კატეგორიები, ლოგოები, primary/backup)
- 9.3 Providers (კონტრაქტი, SLA, health, ხარჯი)
- 9.4 Live Monitoring (probe ისტორია, failover, ხელით გადართვა)
- 9.5 Subscribers & Billing (მომხმარებელი, გამოწერა, გადახდა, მოწყობილობა, გაგრძელება)
- 9.6 Packages & Rights (four-eyes დამტკიცება უფლებებსა და ფასებზე)
- 9.7 EPG (დაფარვა, გამოტოვებული გრაფიკები, mapping)
- 9.8 Support & Incidents
- 9.9 Audit & Security
- 9.10 Finance & Partner Reporting (MRR, churn, ლიცენზიარის მიხედვით)
- **მოდელი:** Sonnet; four-eyes ლოგიკა (9.6) Opus-ის review-ით.

## ფაზა 10 — Catch-up, Multi-view, Parental

- 10.1 **Catch-up ტემპლეიტები:** `catchup`, `catchup-source`, Xtream timeshift; `{utc}`, `{start}`, `{duration}` და ა.შ. *(Opus)*
- 10.2 **▶ Watch** მინი-გიდში, TV Guide-ში, ძიებაში; ხელმისაწვდომობა `catchupDays`-ით. *(Sonnet)*
- 10.3 catch-up-ის entitlement შემოწმება. *(Opus)*
- 10.4 **Multi-view 2×2:** ფილები, აუდიოს ფოკუსი, თითო ფილა concurrency lease-ს იყენებს. *(Sonnet)*
- 10.5 **Parental:** scrypt-ით ჰეშირებული PIN, კატეგორიების/არხების/adult-ის ბლოკი, unlock token TTL-ით, **სერვერზე აღსრულება** სიებში, ძიებაში, Home-ში, playback-ში; kids პროფილი. *(Opus)*
- 10.6 Notifications center-ის დახვეწა. *(Sonnet)*
- 10.7 Player UX: PiP, კლავიატურა, ხარისხის არჩევა. *(Sonnet)*
- **Gate:** დაბლოკილი კონტენტი არცერთი endpoint-იდან არ გაიცემა PIN-ის გარეშე.

## ფაზა 11 — რეალური ინტეგრაციები

ყველა ინტეგრაცია წინა ფაზების პორტებს ავსებს; გადამოწმება sandbox-ით.

- 11.1 **TBC E-Commerce** (checkout + recurring; recurring ბანკთან შესათანხმებელია). *(Opus)*
- 11.2 **Bank of Georgia** Payment Manager. *(Opus)*
- 11.3 **CDN signed URL** ადაპტერი (მაგ. token auth / signed cookies), origin დაცვა. *(Opus)*
- 11.4 **DRM:** Widevine / FairPlay ლიცენზიის გაცემა და EME ინტეგრაცია კლიენტში, თუ კონტრაქტი მოითხოვს. *(Opus)*
- 11.5 **Vendor feed ადაპტერები** ხელმოწერილი კონტრაქტის ფორმატით (SoFast და სხვ.). *(Opus)*
- 11.6 **QoE telemetry:** კლიენტის ივენთები + OpenTelemetry + Grafana დაფები. *(Sonnet)*
- 11.7 Email/SMS პროვაიდერები. *(Sonnet)*
- 11.8 Secrets manager. *(Opus)*
- **Gate:** sandbox გადახდა ქმნის entitlement-ს; დაკვრა მხოლოდ CDN-ის ხელმოწერილი მისამართით.

## ფაზა 12 — Pilot Hardening (ZP-ENT-11)

- 12.1 დატვირთვის ტესტები (k6): API, playback start, heartbeat.
- 12.2 Failover game-day.
- 12.3 Backup / PITR აღდგენის რეპეტიცია.
- 12.4 Blue/green, migration rollback staging-ზე.
- 12.5 `infra/terraform`.
- 12.6 Runbook-ები (`docs/runbooks`).
- 12.7 უსაფრთხოების review: დამოუკიდებელი გავლა, SAST, dependency CVE.
- 12.8 Pilot KPI დაფა: ხელმისაწვდომობა ≥ 99.5%, play start ≥ 99%, p95 პირველი კადრი < 5 წმ, rebuffer < 1% — ესენი სამიზნეებია და არა მიღწეული შედეგები.
- 12.9 პერსონალური მონაცემების შენახვის ვადები.
- 12.10 Support პროცედურები და on-call.
- **მოდელი:** Opus; უსაფრთხოებისა და ბილინგის review სხვა მოდელის/სესიის მიერ, რომ ავტორი თავის თავს არ ამოწმებდეს.

## ფაზა 13 — Scale

Smart TV / Android TV / მობილური, დამატებითი ტერიტორიები, პრემიუმისთვის DRM, 1 000+ არხის შეთანხმებული კატალოგი. იწყება მხოლოდ მაშინ, როცა 0–12 დადასტურებულია.

---

## ცნობილი ხარვეზები მიღებულ კოდში (გადამოწმებული)

- `media-token.ts`: ხელმოწერილია, მაგრამ არა დაშიფრული — upstream URL და headers იკითხება.
- `plan.ts`: `direct` upstream candidate-ს ანიჭებს უპირატესობას.
- `container.ts`: `noopEpgLinker`; დარეგისტრირებულია მხოლოდ M3U provider-ი.
- admin როლი `users.role`-ში არსებობს, route-ებზე კი არ მოწმდება.
- cache და rate limit process-local-ია (მრავალრეპლიკიანი გარემოსთვის არ ვარგა).

## Mongo ხაზიდან გადმოსატანი (ბაზისგან დამოუკიდებელი)

`domain/epg/*`, XMLTV პარსერი, Xtream URL ბილდერები, catch-up ტემპლეიტები, ყალბი origin-ის lab და მათი ტესტები. Mongo რეპოზიტორიები არ გადმოდის.
