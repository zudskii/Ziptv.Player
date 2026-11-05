# ZIPTV — დეტალური Roadmap (ქრონოლოგიურად)

ბაზა: `Ziptv.Player-phase5` (PostgreSQL · Kysely · Express 5 · React 19).
წყაროები: `docs/architecture/ENTERPRISE_BLUEPRINT.md` + თავდაპირველი Personal Streaming Hub სპეციფიკაცია.

## წესები ყველა ფაზისთვის

- ჯერ ფუნქციონალი; ინტეგრაციები (გადახდა, CDN, DRM, vendor-ები) პორტის უკან, fake/in-memory ადაპტერით. რეალური ინტეგრაციები — ფაზები 16–20.
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
| 5 | მაყურებლის გამოცდილება ✅ | Sonnet + Opus |
| 6 | Master Catalog და კონტენტ-ოპერაციები ✅ | Opus |
| 7 | Stream Health და Failover ✅ | Opus |
| 8 | Commerce და Playback Authorization ✅ | Opus |
| 9 | Admin Console ✅ | Sonnet |
| 10 | Catch-up, Multi-view, Parental ✅ | Sonnet + Opus |
| 11 | ნავიგაცია და ავტორიზაციის flow ✅ | Opus + Sonnet |
| 12 | მრავალენოვნება (ka / en / ru) ✅ | Sonnet + Opus |
| 13 | UX დახმარება: tooltip-ები, ტუტორიალები | Sonnet |
| 14 | პროფილები: საკუთარი ბიბლიოთეკა | Opus + Sonnet |
| 15 | ფილმების/სერიალების ფილტრები | Sonnet + Opus |
| 16 | კონტენტის პროვაიდერის საფუძველი | Opus |
| 17 | გეგმები, პაკეტები, entitlement-ები | Opus |
| 18 | მრავალი გადახდის სისტემა | Opus |
| 19 | CDN მიწოდება | Opus + Sonnet |
| 20 | DRM, playback რეჟიმები, attestation | Opus |
| 21 | Pilot Hardening | Opus + დამოუკიდებელი review |
| 22 | Scale | — |

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
> გადატანილია: playback session/heartbeat-ზე მიბმა (ფაზა 8, `LeaseStore` უკვე მზადაა), DASH-ის proxy (ფაზა 19),
> catch-up `proxied` export-ში (ფაზა 10 ✅), dev-dependency-ების major განახლება (vitest 5, tailwind 4).

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

## ფაზა 5 — მაყურებლის გამოცდილება · ✅ დასრულდა

> **სტატუსი:** 5.1–5.12 გაკეთებულია. პროფილები (ლიმიტი 5, `X-Profile-Id`, Kids → adult დამალულია), `list_items` / `progress` / `history` (`0007-viewer`), რეალური `WatchObserver` (watch time სერვერზე ითვლება, reconnect იმავე history ჩანაწერს აგრძელებს), `GET /home`, Movies/Series (overview, კატეგორიები, სორტირება, დეტალები, resume), VOD player (seek, resume, audio/subtitles, შემდეგი ეპიზოდი autoplay-ით), My List, History, ძიება `pg_trgm`-ით (არხები, ფილმები, სერიალები, პროგრამები), Settings (General, Playback, Appearance, TV guide, Profiles, Data & Storage), ლოკალური ფავორიტების ერთჯერადი იმპორტი, სრული ნავიგაცია. Gate შემოწმებულია e2e-ით: progress sync-ს გადარჩება, წყაროს წაშლა user-state-ს შლის. ღია საკითხები: ძიება სახელის სიტყვის დასაწყისზეა (full-text აღწერებზე — მოგვიანებით); ეპიზოდების ცალკე ძიება contract-ში არ არის; პროფილის PIN — ფაზა 10.

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

## ფაზა 6 — Master Catalog და კონტენტ-ოპერაციები (ZP-ENT-03) · ✅ დასრულდა

> **სტატუსი:** 6.1–6.9 გაკეთებულია (`0008-operator-catalog`). პროვაიდერები credential-ით `secret_ref`-ის მიღმა (`env:` ან დაშიფრული `enc:`), `ProviderAdapter` (M3U / Xtream / Mock; Mock production-ში გამორთულია), provider sync worker lease-ით → `provider_streams` review რიგი → alias-ებით ავტო-მატჩი (tvg-id ▶ ნორმალიზებული სახელი, მხოლოდ კურირებული არხებისთვის), ხელით create/match/ignore და merge. `rights_grants` (ტერიტორია × მოწყობილობა × ბიზნესმოდელი × ვადა × კონტრაქტი) — ქვეყანას სერვერი წყვეტს (edge header / default), არა კლიენტი; grant-ის გარეშე არხი არ ჩანს და `403 NOT_ENTITLED`. Lineups ნომრებით. Viewer API `GET /operator/channels`, ოპერატორის playback ყოველთვის proxy-თ, ყველა feed კანდიდატად (primary → backup). ფავორიტები/ისტორია `channel_master.id`-ზე; BYO My List-დან იმპორტი alias-ებით. Admin API — ყოველი write აუდიტში. კლიენტი: **Channels** გვერდი (ნავიგაციაში მხოლოდ მაშინ ჩანს, როცა არხები არსებობს). Gate შემოწმებულია e2e-ით და lab-ში (M3U + Xtream → ერთ არხს ორი feed; უფლების გარეშე არ ჩანს). სტრატეგია: `docs/architecture/OPERATOR_CATALOG.md`. ღია საკითხები: master არხების EPG (ფაზა 7/11); `package`/ბიზნესმოდელის შემოწმება — ფაზა 8 (Commerce); console ეკრანები — ფაზა 9; device class კლიენტის მიერ დეკლარირებულია (არა უსაფრთხოების საზღვარი).

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

## ფაზა 7 — Stream Health და Failover (ZP-ENT-06) · ✅ დასრულდა

> **სტატუსი:** 7.1–7.9 გაკეთებულია (`0009-stream-health`). Probe fleet რეგიონებით (`PROBE_REGION`), lease-ით და provider-ზე fleet-wide ლიმიტით; probe: playlist → ყველაზე იაფი variant → ბოლო სეგმენტი (+ init) → `ffprobe` (მხოლოდ stdin), TTFB; გაყინული live playlist (sequence არ მოძრაობს) = failure, თუნდაც 200 იყოს. რეგიონის state machine hysteresis-ით (fail/recover N ზედიზედ), საერთო სტატუსი რეგიონების კონსენსუსით (HEALTHY / UNHEALTHY / GEO_BLOCKED / NOT_ENTITLED / MAINTENANCE / PROVIDER_OUTAGE / UNKNOWN). Failover მხოლოდ იმავე master არხის feed-ებზე: გაფუჭებისას მაშინვე, fail-back cooldown-ის შემდეგ, ოპერატორის pin (override), ყველაფერი `failover_events` ჟურნალში და console-ის აუდიტში. Incidents (feed / channel_down / provider_outage) + alert-ები outbox-ით (HMAC-ხელმოწერილი webhook, Slack, email), acknowledge/resolve. კლიენტის telemetry (session-ზე მიბმული ტოკენით) feed-ს მხოლოდ ხელახლა ამოწმებინებს, თავად არასდროს რთავს. BYO წყაროები: Online / Slow / Unstable / Offline (ნაკადს არ ხსნის). Prometheus `/metrics` (token). Gate შემოწმებულია e2e-ით და lab-ში რეალური ffprobe-ით (primary down → backup 8 წამში, მაყურებელი აგრძელებს ყურებას, ხელით pin/unpin ჟურნალით). სტრატეგია: `docs/architecture/STREAM_HEALTH.md`. ღია: probe ცხრილის partitioning — ფაზა 22; console ეკრანები — ფაზა 9; provider-ზე probe slot-ის დიდ კატალოგზე capacity planning (დოკუმენტში).

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

## ფაზა 8 — Commerce და Playback Authorization (ZP-ENT-07/08/09) · ✅ დასრულდა

> **სტატუსი:** 8.1–8.11 გაკეთებულია (`0010-commerce`). `OPERATOR_ACCESS=subscription` (ნაგულისხმევი): ოპერატორის არხი = დაუბლოკავი ანგარიში ∧ rights (ქვეყანა, მოწყობილობა, დრო) ∧ (FAST ან აქტიური entitlement პაკეტზე, რომელშიც არხია და რომლის business model-ს grant ფარავს); `rights` რეჟიმი = ფაზა 6-ის ქცევა. Subscription state machine სუფთა დომენში (`tick`-ით, out-of-order/დუბლირებული webhook უვნებელია, გადაუხდელ ტრიალს grace არ აქვს). ყოველი ყურება = playback session (Blueprint §8-ის 7 ნაბიჯი): დარეგისტრირებული მოწყობილობა (გასაღების SHA-256, ლიმიტი, გაუქმება), ატომური lease (Redis Lua / PG advisory lock, TTL 120 წმ), heartbeat 30 წმ-ში მიმდინარე ქვეყნით ხელახალი ავტორიზაციით, proxy ბმულები სესიაზე მიბმული (`playback` grant) — სესია მთავრდება = ბმული კვდება. Rights/პაკეტის/comp-ის გაუქმება, ბლოკი, refund ყურებას მაშინვე წყვეტს (heartbeat-ს არ ელოდება). გადახდის პორტი + fake processor (hosted გვერდი, ასინქრონული HMAC webhook): webhook ერთხელ მუშავდება იმავე ტრანზაქციაში, success-გვერდი მხოლოდ პროცესორს ეკითხება, reconciliation საათში ერთხელ; ორჯერ გადახდა / ტრიალის განმეორება / დასრულებულზე ჩამოჭრა ავტომატურად ბრუნდება (outbox), dunning-ით ვადაგასულს პროცესორთანაც აუქმებს. კლიენტი: `/plans`, `/billing/return`, `/account`, player-ის "Subscription required" / "Too many streams → Stop & watch here". Gate შემოწმებულია e2e-ით (bypass ტესტები) და lab-ში ორი ბრაუზერით. სტრატეგია: `docs/architecture/COMMERCE.md`. ღია: რეალური პროცესორი და CDN/DRM ბმულები — ფაზები 18–20; console ეკრანები პაკეტებისთვის — ფაზა 9; კლიენტის მიერ გამოცხადებული device class (attestation) — ფაზა 20.

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

## ფაზა 9 — Admin Console · ✅ დასრულდა

> **სტატუსი:** 9.1–9.10 გაკეთებულია (`0011-console`). 12 სექცია როლების მიხედვით (Overview, Approvals, Live monitoring, Channels, Providers, EPG, Packages & rights, Subscribers, Support, Finance, Audit & security, Staff); ყოველი route-ის უფლებას API ამოწმებს, UI მხოლოდ მალავს. **Four-eyes:** პაკეტის შექმნა/ცვლილება (ფასი, ლიმიტები, სტატუსი, არხები) და rights grant ცვლილების მოთხოვნაა (`202 {changeRequest}`) — მეორე ადამიანი იმავე write-უფლებით ამტკიცებს, საკუთარ მოთხოვნაზე გადაწყვეტილება შეუძლებელია (დომენი + DB `CHECK`); დამტკიცებისას ცვლილება approver-ის ტრანზაქციაში ხელახლა იწერება stale-შემოწმების შემდეგ (შეცვლილი ობიექტი / 30 დღეზე ძველი → `failed`, არაფერი იცვლება); პაკეტზე ერთი pending ცვლილება; revoke მაშინვე მოქმედებს და შემდეგ review-ს გადის; ვისაც TOTP მოთხოვნის შემდეგ ჩაეწერა, ვერ დაამტკიცებს; merge უარყოფილია, სანამ არხს აქტიური rights/პაკეტი აქვს. `CONSOLE_FOUR_EYES=false` production-ში აკრძალულია. Read models: MRR ბოლო გადახდილი ინვოისიდან, churn მხოლოდ გადახდილ გამოწერებზე, 12-თვიანი სერია; პარტნიორის შემოსავალი **ყურების წუთების წილით** (`playback_sessions.provider_id`, სესიები 400 დღე ინახება), CSV formula-injection დაცვით; provider-ის SLA probe-ებიდან; support notes აუდიტში ტექსტის გარეშე. **ოპერატორის EPG:** ლიცენზირებული XMLTV გზამკვლევები generation-ებით, ავტო-mapping alias-ებით (tvg-id ▶ სახელი, priority), ხელით mapping იმარჯვებს, დაფარვა (unmapped / no_data / gaps / ends_soon / ok), მაყურებლისთვის now/next. Gate შემოწმებულია e2e-ით, ბრაუზერის ტესტით თითო როლზე (`roles.ui.test.tsx`, 401/403 გამოძახების გარეშე) და lab-ში (ორი finance/content თანამშრომელი რეალურ UI-ში). სტრატეგია: `docs/architecture/CONSOLE.md`. ღია: SUPER_ADMIN-ს ახალი staff ანგარიშით მაინც შეუძლია მეორე ხელმოწერა — ფაზა 21 (staff შექმნა four-eyes-ით ან IdP); საკონტრაქტო განაკვეთები/მინიმალური გარანტიები — ფაზა 17; ფინანსური მოთხოვნები replica-ზე — ფაზა 22.

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

## ფაზა 10 — Catch-up, Multi-view, Parental · ✅ დასრულდა

> **სტატუსი:** 10.1–10.7 გაკეთებულია (`0012-viewer-controls`). **Catch-up:** არქივის მისამართს სერვერი აგებს — M3U `default/append/shift/flussonic` (Kodi/TiviMate placeholder-ები, უცნობი placeholder → უარი და არა გამოცნობა) და Xtream `timeshift` პანელის დროის სარტყელში (`server_info.timezone`); პროგრამა უნდა იყოს დასრულებული, არქივის ფანჯარაში და ≤12 სთ. ▶ Watch მინი-გიდში, TV Guide-ში და ძიებაში, deep link `?at=&until=`. `proxied` export-ში catch-up ახლა მუშაობს export-ზე მიბმული დაშიფრული archive token-ით (`/media/archive/…`). **ოპერატორის catch-up:** ცალკე უფლება grant-ზე (`catchup_days`, four-eyes-ით), feed-ის არქივი provider sync-იდან; ყურება playback session-ით (lease, entitlement), არქივი ვერ სცდება grant-ის დაწყებას, revoke-ისას სესია მაშინვე წყდება. **Multi-view 2×2:** აუდიო მხოლოდ ფოკუსირებულ ფილაზე, `1`–`4`; ოპერატორის ფილა = playback session, BYO Xtream ფილები `max_connections`-ით სერვერზე (lease, `replaces`). **Parental:** ერთი PIN ანგარიშზე (scrypt, 5 შეცდომა → 15 წთ ბლოკი, ატომურად), წესები პროფილზე (BYO და ოპერატორის ჯგუფები/არხები), unlock token HMAC-ით (device + profile + PIN version, 15 წთ), აღსრულება სერვერზე სიებში, VOD-ში, ძიებაში, Home-ში, EPG-ში, My List-ში და ყველა playback გზაზე; kids პროფილი მკაცრია (დაბლოკილი/adult საერთოდ არ ჩანს, PIN არ ხსნის, წესების/წყაროების/ყიდვის ცვლილება აკრძალულია), PIN-ით დაცული პროფილი და kids lock device session-ზე ინახება სერვერზე. **Notifications:** დღეების მიხედვით, unread ფილტრი, dismiss, clear read, უსაფრთხოების შეტყობინებები (kids-ს არ უჩანს). **Player:** `I` PiP, `C` სუბტიტრები, `0–9`, `?`, Media Session, Auto-ს ფაქტობრივი ხარისხი. Gate შემოწმებულია e2e-ით (`parental.e2e`, `catchup.e2e`), UI ტესტით და lab-ში (11 ნაბიჯი რეალურ ბრაუზერში). სტრატეგია: `docs/architecture/VIEWER_CONTROLS.md`. ღია: დაბლოკილი არხის სახელი/გიდი ზრდასრულ პროფილს ჩანს (locked ნიშნით); PIN-მდე შექმნილი export ბმულები არ უქმდება ავტომატურად; catch-up წუთები პარტნიორის რეპორტში live-ის ტოლფასია — ფაზა 17.

- 10.1 **Catch-up ტემპლეიტები:** `catchup`, `catchup-source`, Xtream timeshift; `{utc}`, `{start}`, `{duration}` და ა.შ. *(Opus)*
- 10.2 **▶ Watch** მინი-გიდში, TV Guide-ში, ძიებაში; ხელმისაწვდომობა `catchupDays`-ით. *(Sonnet)*
- 10.3 catch-up-ის entitlement შემოწმება. *(Opus)*
- 10.4 **Multi-view 2×2:** ფილები, აუდიოს ფოკუსი, თითო ფილა concurrency lease-ს იყენებს. *(Sonnet)*
- 10.5 **Parental:** scrypt-ით ჰეშირებული PIN, კატეგორიების/არხების/adult-ის ბლოკი, unlock token TTL-ით, **სერვერზე აღსრულება** სიებში, ძიებაში, Home-ში, playback-ში; kids პროფილი. *(Opus)*
- 10.6 Notifications center-ის დახვეწა. *(Sonnet)*
- 10.7 Player UX: PiP, კლავიატურა, ხარისხის არჩევა. *(Sonnet)*
- **Gate:** დაბლოკილი კონტენტი არცერთი endpoint-იდან არ გაიცემა PIN-ის გარეშე.

## ფაზა 11 — ნავიგაცია და ავტორიზაციის flow · ✅ დასრულდა

> **სტატუსი:** 11.1–11.6 გაკეთებულია. სად მიდის მოწყობილობა, ერთ ადგილას წყდება: `gateDecision` (სუფთა ფუნქცია) + `SessionGate`. გვერდებს საკუთარი redirect აღარ აქვთ. Guest რეჟიმი რჩება, მაგრამ მხოლოდ არჩევით. პირველ ვიზიტზე → `/welcome` (Create account / Sign in / Continue as guest), შემდეგ უკან იმავე გვერდზე. Sign out → `/login` („You signed out“), ახალი guest ჩუმად აღარ იქმნება, წინა ადამიანის გვერდი არ ახსოვს. ყველა ღია ტაბი გამოდის (`storage` event). ქეში, აქტიური პროფილი და parental unlock-ები იშლება. ვადაგასული ანგარიში → `/login` email-ით, შემდეგ უკან. 1.x guest-ის მონაცემები უკითხავად აღდგება. სესიის გარეშე გაგზავნილი შემთხვევითი მოთხოვნა identity-ს აღარ ქმნის (`onUnauthorized` → `none`). წყაროს გარეშე Home / Live / Guide / Movies / Series ადგილზე რჩება: `NoSourcesState` + „Add a source“ → `/setup` (ყოფილი onboarding, welcome ნაბიჯის გარეშე). ოპერატორის არხებით Home კვლავ `/channels`-ია. ანგარიშის წაშლის შემდეგ → `/welcome`. Gate შემოწმებულია: 9 policy unit ტესტით, 6 ახალი UI ტესტით რეალურ სერვერზე (სხვა ტაბში sign out / sign in-ის ჩათვლით) და ბრაუზერში 15 ნაბიჯით, console შეცდომების გარეშე.

- 11.1 ერთი route guard მდგომარეობების მატრიცით (anonymous / guest / account / ვადაგასული / signed out). *(Opus)*
- 11.2 საჯარო `/welcome` landing; onboarding → `/setup`. *(Sonnet)*
- 11.3 Sign out → `/login`, ქეშის/პროფილის/unlock-ების გასუფთავება, ყველა ტაბი. *(Opus)*
- 11.4 წყაროს გარეშე empty state redirect-ის ნაცვლად. *(Sonnet)*
- 11.5 `returnTo` მხოლოდ same-origin path-ია (`/welcome`, `/login`, `/register` loop-ის გარეშე). *(Opus)*
- 11.6 Stray 401 identity-ს არ ქმნის. *(Opus)*
- **Gate:** მატრიცის ყველა უჯრა ტესტითაა დაფარული; ორ ტაბში sign out ორივეს გამოიყვანს.

## ფაზა 12 — მრავალენოვნება: ქართული / ინგლისური / რუსული · ✅ დასრულდა

> **სტატუსი:** 12.1–12.6 გაკეთებულია. საერთო პაკეტი `@ziptv/i18n` (intl-messageformat, ICU): ტიპიზებული key-ები, ინგლისური bundle-შია, ka/ru lazy-load-ით, `Catalog<M>` ტიპი key-ების დამთხვევას compiler-ით ამოწმებს. კლიენტი ~1150 შეტყობინება, კონსოლი ~790, სამივე ენაზე. ენა: მოწყობილობის (ბრაუზერის `navigator.languages` ან ბოლო არჩევანი) → **პროფილის** `general.language` ჭარბობს მას (`''` = მოწყობილობის). იცვლება Settings-იდან, welcome/login გვერდიდანაც, გადატვირთვის გარეშე; `<html lang>` მიჰყვება. თარიღი, დრო, რიცხვი, ფასი და სია `Intl`-ით, მიმდინარე ენით; რიცხვითი placeholder-ები `{n, number}`. API-ის შეცდომები: ინგლისურად სერვერის ტექსტი, ka/ru-ზე error code-ის თარგმანი. Email-ები (პაროლის აღდგენა, დადასტურება) იწერება იმ ეკრანის ენაზე, საიდანაც მოთხოვნა მოვიდა (კლიენტი `Accept-Language`-ს აგზავნის). კონსოლის ენა მოწყობილობაზე ინახება. Gate: ტესტები ამოწმებს key-ების დამთხვევას, ICU სინტაქსს სამივე ენაზე, placeholder-ების შესაბამისობას, ქართულში თარგმანის გამოტოვებას და JSX-ში hardcoded ტექსტს (`@ziptv/i18n/lint`, კლიენტსა და კონსოლში); რუსული plural-ების unit ტესტი (1/2/5/11/21/22/25); ბრაუზერში 13 შემოწმება (ka ბრაუზერი → ka, ენის გადართვა, პროფილის ენა reload-ის შემდეგ, 12 გვერდი × 3 ენა „ნედლი“ key-ის გარეშე), console შეცდომების გარეშე. ღია: შიდა შეტყობინებების ტექსტი (notifications) სერვერზე ინგლისურად ინახება — params-ით ლოკალიზაცია — ღია (13-დან და 14-დან გადატანილი); ავტომატური პროფილის სახელი „Me“ სერვერზე; კონსოლის ენა staff ანგარიშზე (ახლა მოწყობილობაზე); pseudo-locale არ გაკეთებულა.

- 12.1 i18n ICU message format-ით (მაგ. react-i18next + ICU ან FormatJS). რუსულს 4 plural ფორმა აქვს, ქართულს 2: ხელით `count === 1` არ იწერება. *(Opus)*
- 12.2 ენა **პროფილზეა** (ანგარიშის ენა default-ია, პირველ ვიზიტზე `Accept-Language`). Settings-ში იცვლება გადატვირთვის გარეშე; ადმინ კონსოლში თითო staff-ზე. *(Sonnet)*
- 12.3 თარიღი, დრო, რიცხვი, ფასი `Intl`-ით, EPG-ის ჩათვლით. *(Sonnet)*
- 12.4 API აბრუნებს სტაბილურ error code-ებს, თარგმნა კლიენტზე ხდება (zod-ის ვალიდაციის ჩათვლით). *(Opus)*
- 12.5 სერვერზე ლოკალიზდება email, push და security შეტყობინებები. *(Sonnet)*
- 12.6 CI: key parity (ka/ru-ში key აკლია → build ჩავარდება), pseudo-locale UI-ის გადატეხვის შესამოწმებლად, lint hardcoded სტრიქონებზე. ფონტი ფარავს ქართულსა და კირილიცას. *(Sonnet)*
- **ფარგლებს გარეთ:** კატალოგის მეტამონაცემების თარგმნა (ფაზები 15/16).
- **Gate:** კლიენტსა და ადმინში hardcoded სტრიქონი აღარ არის; სამივე ენა სრულია.

## ფაზა 13 — UX დახმარება: tooltip-ები, ტუტორიალები, empty state-ები

- 13.1 Tooltip ყველა არაცხად კონტროლზე: ჩნდება focus-ზეც (ტელეფონსა და TV-ზე hover არ არსებობს), `aria-describedby`, ~500 ms დაყოვნება, ტექსტი i18n key-ით. *(Sonnet)*
- 13.2 „?“ inline help რთულ პარამეტრებზე (Time shift, Hardware acceleration, catch-up). *(Sonnet)*
- 13.3 პირველი გაშვების checklist: წყარო → პროფილი → პირველი ყურება. *(Sonnet)*
- 13.4 Contextual tour-ები (TV Guide, Multi-view, Parental). მდგომარეობა სერვერზე ინახება თითო პროფილზე; Settings-ში არის „ტუტორიალების თავიდან ჩვენება“. *(Sonnet)*
- 13.5 ერთიანი empty state ყველა სიისთვის (ფაზა 11-ის `NoSourcesState`-ის გაგრძელება). *(Haiku)*
- **Gate:** ყველა icon-only ღილაკს აქვს tooltip და aria-label; tour ერთხელ ჩნდება თითო პროფილზე.

> **სტატუსი:** 13.1–13.5 გაკეთებულია. **Tooltip** (`components/ui/Tooltip`): portal + fixed პოზიცია (scroll/overflow არ ჭრის, ეკრანის კიდესთან გადაბრუნდება), mouse hover ~500 ms დაყოვნებით, keyboard focus-ზე მაშინვე (`:focus-visible`, click-ის შემდეგ არა), touch-ზე long-press (2.5 წმ-ში თავად ქრება), Escape ხურავს მხოლოდ tooltip-ს და არა გარშემო dialog-ს. `IconButton` იყენებს მას `title`-ის ნაცვლად (aria-label უკვე ასახელებს — tooltip მხოლოდ ვიზუალურია, ორჯერ არ ცხადდება); icon-only `<button>`-ებიც (ძიების გასუფთავება, ფავორიტი, პაროლის ჩვენება, ჯგუფის მენიუ და ა.შ.) Tooltip-შია. **HelpHint** „?“ toggletip: click/Enter ხსნის, `role=status`-ით ცხადდება, Escape/გარეთ click/blur ხურავს; Settings-ში: autoplay, ხარისხი, hardware acceleration, EPG time shift, ისტორიის შენახვა. **Checklist** Home-ზე (ცარიელ ბიბლიოთეკაზეც): წყარო → Settings (`visited-settings`) → პირველი ყურება (continue/recent); თავად ინიშნება, ყველაფრის შესრულებისას ქრება, „დამალვა“ ინახება. **Tour-ები** (`features/help/Tour`, `data-tour` anchor-ები): TV Guide (ბადე, დღეები — archive-ის ტექსტით, ჯგუფი, „ახლა“), Multi-view (ფილები, 1–4), Parental (პროფილი, adult, ბლოკები). Next/Back/Skip/Escape, highlight ring, არ არის modal; focus-ს არ ართმევს ველს, რომელსაც ადამიანი უკვე იყენებს; ელემენტის გარეშე ნაბიჯი გამოიტოვება. მდგომარეობა სერვერზე, **თითო პროფილზე**: `settings.help { seen[], checklistDismissed }` (≤50 slug, zod + domain validator); Settings → General → „რჩევები და ტურები → ხელახლა ჩვენება“. **Empty state** ერთიანი: `tone="error"` (გამაფრთხილებელი icon, `role=alert`) + „თავიდან ცდა“ (`refetch`) ყველა ჩატვირთვის შეცდომაზე; ცარიელ My List/History-ს შემდეგი ნაბიჯის ღილაკი აქვს. გზად: **settings-ის ცვლილება ახლა ატომურია** (`changeSettings` — row lock-ით read-modify-write; ადრე ორი სწრაფი PATCH ერთმანეთს გადააწერდა — e2e ტესტით); Switch-ის ბურთულა track-ს გარეთ იყო (`left-0`); parental-ში ორი hardcoded ტექსტი ითარგმნა. Gate: tooltip-ის ქცევა (hover delay, სწრაფი გავლა, click, long-press, focus, Escape, aria), HelpHint, checklist, tour (ერთხელ პროფილზე, გამოტოვება, Escape, focus) — UI ტესტებით რეალურ სერვერზე; ბრაუზერში 7 შემოწმება (en/ka, ტელეფონის სიგანე), console შეცდომების გარეშე. ღია: notifications-ის ტექსტის ლოკალიზაცია (params) — ჯერ ღია; tour-ები Live TV-სა და Playlists-ზე — საჭიროებისამებრ.

## ფაზა 14 — პროფილები: საკუთარი ბიბლიოთეკა

წყარო რჩება **ანგარიშის** საკუთრებაში, პროფილს **ენიჭება** ის წყაროები, რომლებსაც ხედავს. დუბლირება არ ხდება: credentials ერთ ადგილას ინახება, Xtream `max_connections` ითვლება წყაროზე და არა ასლებზე.

- 14.1 `profile_sources`, `profile_epg_sources`. კატალოგის, ძიების, Home-ისა და EPG-ის query-ები პროფილის მიბმაზე იფილტრება. *(Opus)*
- 14.2 პროფილიდან დამატებული წყარო default-ად მხოლოდ ამ პროფილს ენიჭება, ოფციით „ყველა პროფილისთვის“. *(Sonnet)*
- 14.3 პროფილის რედაქტირებაში „ბიბლიოთეკა“ ჩანართი. *(Sonnet)*
- 14.4 Kids პროფილი ხედავს მხოლოდ მიბმულ წყაროებს, ზედ ედება მკაცრი ფილტრები. *(Opus)*
- 14.5 მიგრაცია: არსებული წყაროები ყველა არსებულ პროფილს ენიჭება, ქცევა არ იცვლება. Cache key-ები ბიბლიოთეკის ვერსიას შეიცავს. *(Opus)*
- **Gate:** პროფილი A-ს წყაროს კონტენტი პროფილ B-ში არსად ჩანს (ძიება, Continue Watching, შეტყობინებები) — სერვერის ტესტით.

> **სტატუსი:** 14.1–14.5 გაკეთებულია. **მოდელი:** წყარო ანგარიშისაა (credentials ერთ ადგილას, Xtream-ის კავშირების ლიმიტი წყაროზე ითვლება), `profile_sources` (profile_id, source_id) ამბობს, რომელ პროფილს რა ჩანს. `Viewer.library` (პროფილის წყაროების Set; `null` = ფონური სამუშაო) ყველა წაკითხვის ერთ წერტილში მოწმდება: `requireSource` (არხები, VOD, EPG, playback, mappings — ბიბლიოთეკის გარეთ = იგივე 404, რაც სხვის წყაროზე), `usableSources` (ძიება, My List), Home, EPG ძიება, operator favourites import, Continue Watching / ისტორია / My List (ბიბლიოთეკიდან ამოღებული წყაროს ჩანაწერები იმალება და არ იშლება — დაბრუნებისას აღდგება), storage usage. **შეტყობინებები:** `notifications.source_ids` — წყაროს/გიდის შეტყობინება მხოლოდ იმ პროფილს უჩანს, ვინც ერთ-ერთ მათგანს ხედავს (list, unread, mark-all-read, clear — ყველა scope-ით). **გიდები** (14.1-ის `profile_epg_sources`-ის ნაცვლად, შეგნებულად): გიდი წყაროს მიჰყვება — ერთი გიდი რამდენიმე წყაროს ემსახურება, არხების მიბმა და now/next cache წყაროს დონეზეა, ამიტომ ცალკე ცხრილი პროფილზე მიბმის მიხედვით გადაბმას მოითხოვდა. შედეგი იგივეა: პროფილი ხედავს მხოლოდ საკუთარი წყაროების გიდს. **ახალი წყარო:** ემატება იმ პროფილს, საიდანაც დაამატეს; ოფცია „სხვა პროფილებისთვისაც“ (`audience: 'all'`) = ყველა standard პროფილი. **ახალი პროფილი:** standard — ანგარიშის ყველა წყაროთი (როგორც აქამდე), kids — ცარიელი. **Kids (14.4):** მხოლოდ ხელით მიბმული წყაროები; მისი ბიბლიოთეკის შეცვლა (ან ნებისმიერი ბიბლიოთეკისა kids-ზე დაბლოკილი მოწყობილობიდან) PIN-ს ითხოვს; `/sources?scope=account` kids-ს მაინც მხოლოდ ბიბლიოთეკას აძლევს; მკაცრი ფილტრები (adult, locks) ზემოდან რჩება. **API:** `GET/PUT /profiles/:id/library`, `GET/PUT /sources/:id/profiles`, `GET /sources?scope=account`, `SourceDto.profileIds`. **UI:** პროფილის რედაქტირებაში „ბიბლიოთეკა“ ჩანართი (და ღილაკი სიაში), Sources გვერდი მთელ ანგარიშს აჩვენებს: „ხედავს: …“ + „შეცვლა“, ნიშანი „ამ პროფილში არ არის“, add-source ფორმაში „სხვა პროფილებისთვისაც“. **მიგრაცია (14.5):** `0013-profile-library` — არსებული წყაროები ყველა არსებულ პროფილს ენიჭება, ქცევა არ იცვლება; guest→account merge guest-ის default პროფილის ბიბლიოთეკას account-ის default-ს გადასცემს. Cache: ბიბლიოთეკა თავად cache-დება ანგარიშზე (`library:<userId>`, ნებისმიერ ცვლილებაზე იშლება), Home-ის key ბიბლიოთეკით გაფილტრული წყაროების ვერსიებს შეიცავს, ხოლო წყაროს-დონის cache-ები (არხები, VOD overview) ბიბლიოთეკაზე არ არის დამოკიდებული — წვდომა მათ წინ მოწმდება. Query-ები `EXPLAIN ANALYZE`-ით: `profile_sources_pkey` / `profiles_user_idx`, notifications — `notifications_owner_idx`. Gate: `library.e2e` (7 ტესტი: ბიბლიოთეკის სია, ბიბლიოთეკის გარეთ წყარო არსად — არხები/VOD/EPG/playback/My List/ძიება/Home, შეტყობინებები და mark-all-read, Continue Watching/ისტორია/My List ამოღებისას და დაბრუნებისას, გაზიარება, ახალი პროფილის ბიბლიოთეკა, kids + PIN), UI ტესტები (4) რეალურ სერვერზე, ბრაუზერში 9 შემოწმება en/ka. ღია: გიდების ცალკე მიბმა პროფილზე (საჭიროების შემთხვევაში); notifications-ის ტექსტის ლოკალიზაცია (params) ისევ ღიაა.

## ფაზა 15 — ფილმების და სერიალების ფილტრები

- 15.1 ფილტრები: ჟანრი, წელი, რეიტინგი, ენა/აუდიო, ქვეყანა, ხანგრძლივობა, დამატების თარიღი, წყარო, ნანახი/არნანახი. სორტირება. *(Sonnet)*
- 15.2 Server-side faceted query count-ებით, keyset pagination, GIN ჟანრებზე, `pg_trgm`; ყოველი query `EXPLAIN ANALYZE`-ით. *(Opus)*
- 15.3 ფილტრის მდგომარეობა URL-შია. *(Sonnet)*
- 15.4 ჟანრების ნორმალიზაციის რუკა; სურვილისამებრ enrichment (TMDB-ის კომერციული პირობები შესამოწმებელია). *(Sonnet)*
- **Gate:** 10k+ ფილმიან კატალოგზე p95 < 200 ms.

## ფაზა 16 — კონტენტის პროვაიდერის საფუძველი

წინაპირობა: პროვაიდერის შერჩევა (ფაზა 0). კოდის საფუძველი მანამდეც მზადდება.

- 16.1 პროვაიდერ-აგნოსტიკური პორტი: არხები, VOD, სერიალები, EPG, პაკეტები. ინკრემენტული sync, health, შეცდომების ჟურნალი. *(Opus)*
- 16.2 უფლებები: ტერიტორია, ფანჯრები, მოწყობილობის კლასი, catch-up, ხარისხის ლიმიტი. *(Opus)*
- 16.3 Vendor feed ადაპტერები ხელმოწერილი კონტრაქტის ფორმატით (SoFast და სხვ.); reference adapter ტესტებისთვის. *(Opus)*
- 16.4 ადმინში პროვაიდერის onboarding, sync სტატუსი, კონფლიქტები. *(Sonnet)*
- **ღია:** Mode A (vendor-managed) თუ Mode B (ingest) — კონტრაქტზეა დამოკიდებული.

## ფაზა 17 — კომერციული კატალოგი: გეგმები, პაკეტები, entitlement-ები

ბიზნეს-მოდელი (ფილმები ულიმიტოდ, პაკეტით თუ გამოწერის გარეთ) **კონფიგურაციაა** და არა კოდი: ადმინიდან იცვლება დეპლოის გარეშე.

- 17.1 გეგმა = entitlement-ების ნაკრები: live პაკეტები; VOD რეჟიმი `included` / `package` / `none` (მოგვიანებით `tvod`); ნაკადები, მოწყობილობები, ხარისხი (HD/4K), catch-up დღეები. *(Opus)*
- 17.2 გეგმის ვერსიები და grandfathering. *(Opus)*
- 17.3 ფასები რეგიონისა და ვალუტის მიხედვით (GEL / EUR / USD), ტრიალი, პრომო კოდები, proration. *(Opus)*
- 17.4 ერთი entitlement engine: playback, კატალოგი, UI („შედის შენს გეგმაში“ / „განაახლე“). *(Opus)*
- 17.5 კონტრაქტის პირობები პარტნიორის რეპორტში: minimum guarantee, ცალკე catch-up ტარიფები. *(Sonnet)*
- **ღია (შენი):** VOD-ის საბოლოო მოდელი. Engine სამივე ვარიანტს უჭერს მხარს.

## ფაზა 18 — მრავალი გადახდის სისტემა (ლოკალური + გლობალური)

ყველა ადაპტერი ფაზა 8-ის პორტს ავსებს; გადამოწმება sandbox-ით.

- 18.1 Processor registry + routing ქვეყნის/ვალუტის მიხედვით (GE → TBC / BOG, სხვაგან → Stripe / PayPal), checkout-ზე ხელმისაწვდომი მეთოდები. *(Opus)*
- 18.2 **TBC E-Commerce** (checkout + recurring; recurring ბანკთან შესათანხმებელია). *(Opus)*
- 18.3 **Bank of Georgia** Payment Manager. *(Opus)*
- 18.4 **Stripe / PayPal** — თუ იურიდიული პირი ამის საშუალებას იძლევა. *(Opus)*
- 18.5 ორი recurring მოდელი: processor-managed (Stripe/PayPal subscriptions) და merchant-initiated (TBC/BOG შენახულ ბარათზე, retry/dunning ჩვენთან). *(Opus)*
- 18.6 ყოველდღიური reconciliation, ინვოისები, billing ეკრანები ადმინში. *(Sonnet)*
- **გადასამოწმებელი:** Stripe/PayPal-ის ხელმისაწვდომობა GE კომპანიისთვის; EU-ის დღგ (OSS) — ბუღალტერთან.
- **Gate:** sandbox გადახდა თითო პროცესორზე ქმნის entitlement-ს; webhook-ის განმეორება უვნებელია.

## ფაზა 19 — ვიდეოს მიწოდება CDN-ით

- 19.1 **CDN signed URL / signed cookie** ადაპტერი, origin დაცვა; token მიბმულია სესიაზე, ახლდება, revoke-ით უქმდება. Proxy რჩება BYO წყაროებისთვის. *(Opus)*
- 19.2 DASH manifest rewriting ან CDN მიწოდება. *(Opus)*
- 19.3 **QoE telemetry:** კლიენტის ივენთები + OpenTelemetry + Grafana. *(Sonnet)*
- **Gate:** ოპერატორის დაკვრა მხოლოდ CDN-ის ხელმოწერილი მისამართით.

## ფაზა 20 — DRM, პროვაიდერის playback რეჟიმები, device attestation

- 20.1 **DRM:** Widevine / PlayReady / FairPlay ლიცენზია playback სესიაზე, license proxy entitlement-ის შემოწმებით, EME კლიენტში — თუ კონტრაქტი მოითხოვს. *(Opus)*
- 20.2 Mode A / B-ის სრული რეალიზაცია. *(Opus)*
- 20.3 Native TV / Android TV აპი + attestation: device class აღარ არის თვითგამოცხადებული. *(Opus)*
- **ღია:** DRM vendor და პროვაიდერის მოთხოვნები.

## ფაზა 21 — Pilot Hardening (ZP-ENT-11)

- 21.1 დატვირთვის ტესტები (k6): API, playback start, heartbeat.
- 21.2 Failover game-day.
- 21.3 Backup / PITR აღდგენის რეპეტიცია.
- 21.4 Blue/green, migration rollback staging-ზე.
- 21.5 `infra/terraform`.
- 21.6 Runbook-ები (`docs/runbooks`).
- 21.7 უსაფრთხოების review: დამოუკიდებელი გავლა, SAST, dependency CVE.
- 21.8 Pilot KPI დაფა: ხელმისაწვდომობა ≥ 99.5%, play start ≥ 99%, p95 პირველი კადრი < 5 წმ, rebuffer < 1% — ესენი სამიზნეებია და არა მიღწეული შედეგები.
- 21.9 პერსონალური მონაცემების შენახვის ვადები.
- 21.10 Support პროცედურები და on-call.
- 21.11 Email/SMS პროვაიდერები; secrets manager.
- 21.12 Staff-ის შექმნა four-eyes-ით ან გარე IdP (ფაზა 9-ის ღია საკითხი).
- **მოდელი:** Opus; უსაფრთხოებისა და ბილინგის review სხვა მოდელის/სესიის მიერ, რომ ავტორი თავის თავს არ ამოწმებდეს.

## ფაზა 22 — Scale

Smart TV / Android TV / მობილური, დამატებითი ტერიტორიები, პრემიუმისთვის DRM, 1 000+ არხის შეთანხმებული კატალოგი, ფინანსური მოთხოვნები replica-ზე, probe ცხრილის partitioning. იწყება მხოლოდ მაშინ, როცა 0–21 დადასტურებულია.

## Backlog (ეტაპობრივად ნაწილდება ფაზებში)

- …

---

## ცნობილი ხარვეზები მიღებულ კოდში (გადამოწმებული)

- `media-token.ts`: ხელმოწერილია, მაგრამ არა დაშიფრული — upstream URL და headers იკითხება.
- `plan.ts`: `direct` upstream candidate-ს ანიჭებს უპირატესობას.
- `container.ts`: `noopEpgLinker`; დარეგისტრირებულია მხოლოდ M3U provider-ი.
- admin როლი `users.role`-ში არსებობს, route-ებზე კი არ მოწმდება.
- cache და rate limit process-local-ია (მრავალრეპლიკიანი გარემოსთვის არ ვარგა).

## Mongo ხაზიდან გადმოსატანი (ბაზისგან დამოუკიდებელი)

`domain/epg/*`, XMLTV პარსერი, Xtream URL ბილდერები, catch-up ტემპლეიტები, ყალბი origin-ის lab და მათი ტესტები. Mongo რეპოზიტორიები არ გადმოდის.
