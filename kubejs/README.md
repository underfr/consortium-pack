# KubeJS scripts for The Consortium

This folder ships with the pack, so every file in it is installed on **both** the client and the
server (packwiz plain files carry no side). Keep secrets, webhook URLs and anything that references a
server-only mod out of here (see "Server-only scripts" below).

KubeJS 2101.7.2 (NeoForge 1.21.1) folder layout, as documented in the `kubejs/README.txt` the mod
generates on first run:

| Folder | Loaded | Use it for |
|---|---|---|
| `startup_scripts/` | once at game start, both sides | registrations (items, blocks, fluids), things that need `StartupEvents` |
| `server_scripts/` | on every server resource reload (`/reload`), dedicated server and the client's integrated server | recipes, tags, loot, `ServerEvents`, `PlayerEvents`, economy and rank logic |
| `client_scripts/` | client only | JEI events, tooltips, client UI |
| `data/` | acts as a datapack on the server | Chapters stage definitions (`data/consortium/chapters/stages/*.json`), the Consortium Core price table (`data/consortium/consortium_prices/*.json`) and shop catalogue (`data/consortium/consortium_shop/*.json`), the season calendar (`data/consortium/consortium_calendar/season1.json`), the rulebook (`data/consortium/consortium_rules/rulebook.json`) and the HQ layout (`data/consortium/consortium_hq/hq.json`, all three read by the scripts through `JsonIO`), custom tags |
| `assets/` | acts as a resource pack on the client | lang files, textures for custom items |

`startup_scripts/` and `client_scripts/` still hold a comments-only `00_placeholder.js` that keeps the
folder in the pack. `server_scripts/` holds the economy locks (`economy_locks.js`: chunk loader, Waystones Warp Stone, IE brass
and Ad Astra ice recipe removals), the spawner lock (`spawner_locks.js`: `minecraft:spawner` added to
`#mekanism:cardboard_blacklist`), the structure loot policy (`structure_loot.js`, priority 30, LootJS 3.7.0,
guarded by `Platform.isLoaded('lootjs')`: removes the Apotheosis `affix_loot_injection` and
`gem_loot_injection` global loot modifiers and strips affixed gear and gems at roll time from
`minecraft:chests/*` and the Terralith, Structory and YUNG's structure tables only; nothing of `@minecraft`
is removed and `consortium:*` event tables stay outside, see `docs/WORLD_VISUALS_ADMIN_PRESENCE.md` section 2)
and the progression engine described below.

- `data/minecraft/chat_type/chat.json`: the chat decoration `%s: %s` (no angle brackets around the badges and the name). The client applies it from the synced registry; the signed body is untouched. Deleting the file restores the vanilla layout after a restart.

## Conventions

- English everywhere (comments, chat messages, item names). No em dashes.
- One file per concern. Load order comes from a `// priority: N` first line (higher loads first; the
  engine uses 100 for helpers, 90 for data, 60 for charters, 50 for logic, 45 for the events library, 40 for the money modifiers, 30 for the shop,
  the quests, the ranks, the daily contracts and the onboarding, 20 for the events engine, 15 for its calendar, 10 for the rulebook, the digest
  and the Nether fence, 0 for commands; two files of the same priority load in path order, so `consortium_contracts.js` and
  `consortium_onboarding.js` load before `consortium_ranks.js` and read its constants at call time only); all server scripts share one
  scope, so top-level names must be unique across files (prefix them, e.g. `consortium...`).
- Consortium Core 0.4.0 API members (`publishRankTiers`, `leaderboard`, `leaderboardText`, `rankOf`, `rankGroup`, `rankPosition`, `uuidOf`,
  `sameConnection`, `discordAnnounce`, `discordStaff`) are probed at call time through `consortiumCoreHas(name)` (`consortium_ranks.js`): a
  missing member of a Java class binding throws in Rhino, so `typeof ConsortiumCore.foo` alone is not safe. The 0.4.0 event classes
  (`RankPromoteEvent`, `ReportEvent`) are probed with `Java.tryLoadClass` before `NativeEvents.onEvent`. A 0.3.x jar runs every script of
  batch 3 with the ranks features degraded (tiers by threshold, no promotion, no leaderboard, Discord posts logged instead of sent).
- KubeJS Rhino quirks: `const` only at file top level or as the first statements of a function, `let`
  inside blocks (a `const` inside a try or for block throws "redeclaration of var"); server scripts
  cannot assign to `global`.
- `server_scripts/` also run inside a singleplayer world where LuckPerms, LootJS, Simple Discord Link
  and the other server-only mods are absent: guard such code with `Platform.isLoaded('lootjs')` or
  move it to the server overlay.
- Never commit `kubejs/config/web_server.json` (per-instance auth token), `kubejs/exported/` or the
  generated `kubejs/README.txt`; they are listed in `.packwizignore`.

## Server-only scripts

On a dedicated server KubeJS also loads `<server>/local/kubejs/local_server_scripts/` and
`<server>/local/kubejs/local_startup_scripts/` (checked with `FMLLoader.getDist().isDedicatedServer()`
in KubeJS 2101.7.2). Those folders are never part of the pack and never reach clients. That is where
Discord webhooks, admin economy tooling and integrations with server-only mods belong.

## Progression engine (rules 4.4 and 4.5, design in docs/PROGRESSION.md)

One server-wide phase for everyone, five phases per season. Files:

| File | Role |
|---|---|
| `data/consortium/chapters/stages/phase_1.json` .. `phase_5.json` | Chapters stage definitions (stage ids `consortium:phase_1` .. `consortium:phase_5`). Each file lists what the phase **opens**; an item is usable once the team holds any stage that mentions it, so the five files are disjoint. `phase_1.json` is the empty `{}` marker (phase 1 opens nothing that is locked) |
| `.../stages/staff.json`, `licence_extraction.json`, `licence_energy.json`, `licence_logistics.json`, `extraction_p1..p5.json`, `energy_p1..p5.json`, `logistics_p1..p5.json` | Staff-only items (PROGRESSION.md section 10), the three charter licences and the charter early-access bundles (section 9.2). Licence, `*_p5` and staff ids are in **no** phase file (exclusive all season); `*_p1..p4` repeat ids of the next phase file on purpose (early access). All 24 files are generated from the registry dump by `scratchpad/gen_stages.mjs`, which asserts every id, the disjointness and the exclusivity; never hand-edit one file without re-running it |
| `server_scripts/consortium_charters.js` (priority 60) | Charter records per player UUID, the staff list, and the team reconciliation (`consortiumApplyTeam`): what every team should hold (phases, its owner's charter stages, or everything for an all-staff team) versus what it holds, grants and strips; `consortiumCharterPublish` writes the player's own record to the LuckPerms meta key `consortium.charter` (the charter badge of Consortium Core 0.5.0, BADGES_AND_HQ 1.4) at every record write and at every login |
| `server_scripts/consortium_lib.js` (priority 100) | Shared helpers: number formatting, the next event slot, announcements (`tellraw @a` plus `say`, the two commands Simple Discord Link relays; `server.tell()` is never relayed), FTB Teams access and the safe stage writers, and the LuckPerms console path `consortiumLp` / `consortiumLpMeta` with the meta key names `CONSORTIUM_META_TITLE` and `CONSORTIUM_META_CHARTER` |
| `server_scripts/consortium_quotas.js` (priority 90) | The `CONSORTIUM_PHASES` table: phase names, stage ids, quest chapter ids, headline text and the delivery quotas (`Q = D x 10 x r x 0.7`). The economy step edits the amounts here |
| `server_scripts/consortium_phases.js` (priority 50) | The engine: persistent state, deliveries, milestones, phase completion, the sweeps, boss bar, daily summary, stall rule, login welcome |
| `server_scripts/consortium_money.js` (priority 40) | The delivery modifiers applied to Consortium Core deliveries through its `DeliveryQuoteEvent`, multiplied into one `setMultiplier` per line in the order charter x newcomer x event x paycheck scale: the charter price table of PROGRESSION 9.1 (+15 % own family, -5 % the two others, read from the `charter_family` of each price family), the newcomer +25 % of PROGRESSION 12 (7 days from the first login, `GRANTED` accounts, launch cohort excluded, stopped by `NEWCOMER_BONUS_CAP`), the market event factor of the events engine (`consortiumEventFactor`, a typeof-guarded wrapper over `ConsortiumEvents.quoteFactor`) and the daily paycheck cap `DAILY_PAYCHECK_CAP` of PRICE_TABLE 1.4 (see "Money caps" below). Off when the mod is absent |
| `server_scripts/consortium_shop.js` (priority 30) | The shop side (SHOP_CATALOGUE 5): sale stages, purchased licences and the vacancy rule, the season fund, event tickets, titles, LuckPerms-backed perks, the Gap Contract, the purchase pre-check (a `BalanceChangeEvent` veto before the debit), the `shop:*` quest flags and the login resync of perks and titles. Exposes `Consortium.sales / licences / season / tickets / titles / perks / gap` and sets `Consortium.onCatchUp`; see "Shop engine" below |
| `server_scripts/consortium_quests.js` (priority 30) | The FTB Quests bridge (QUESTS 5): custom task checks (delivery runs, flags, weekly stamps, the weekly contract, counters, ranks, first paycheck, charter, Founder), custom rewards re-validated per claimer (credits, XP, cosmetics, titles), the `DeliveryEvent`, `BalanceChangeEvent` and blood moon listeners that derive quest flags. Exposes `ConsortiumQuests`; see "Quests bridge" below |
| `server_scripts/consortium_events_lib.js` (priority 45) | Helpers of the events engine: the `Platform.isLoaded` flags (`CONSORTIUM_HAS_INCONTROL`, `CONSORTIUM_HAS_APOTHEOSIS`, `CONSORTIUM_HAS_FTBCHUNKS`, `CONSORTIUM_EVENTS_ON`), every optional Java class behind its flag, the hostile-claim test and the spot finder (FTB Chunks API), the ground finder, tagged spawning, the Apotheosis boss spawner and its whitelist, force-load and cleanup helpers, and the `ConsortiumEvents` shell object the economy scripts call through typeof-guarded wrappers |
| `server_scripts/consortium_events.js` (priority 20) | The random events engine (see "Events" below): state, the catalogue of 10 events, start and stop, scheduler, boss bar, board event object, payouts and caps, the listeners and the load reconciliation |
| `server_scripts/consortium_hq.js` (priority 20) | The HQ spawn generator (BADGES_AND_HQ part 2, see "HQ generator" below): `/consortium hq build` places `data/consortium/consortium_hq/<layout>.json` around an anchor for one of the four facings through a tick queue (snapshot, ground, clear, layers, finish), `hq clear` restores the snapshot, `hq status`, `hq spawnpoint [arena]` and `hq forget` are the bookkeeping; state under its own root key `consortium_hq` |
| `server_scripts/consortium_ranks.js` (priority 30) | Ranks (RANKS_AND_CONTRACTS 1): `CONSORTIUM_RANK_THRESHOLDS` (the one tier table, published to Consortium Core 0.4.0 through `publishRankTiers` at load and from every 5-minute check; the mod promotes through the LuckPerms track and announces), the perk reconcile at login + 60 ticks, on `RankPromoteEvent` and every 5 minutes (FTB Chunks allowance refresh, one perk line per tier, the Engineer chunk loader once the team holds phase 3), the texts of `/consortium ranks` and `/consortium leaderboard`, and the shared probes `consortiumCoreHas`, `consortiumCcFmt`; see "Ranks" below |
| `server_scripts/consortium_contracts.js` (priority 30) | Daily contracts (RANKS_AND_CONTRACTS 2): the pick at the 06:00 boundary, the flat premium per paid unit read by `consortium_money.js`, the consumption on `DeliveryEvent`, the board lines, the compact `contracts` string, the summary line of the daily step; exposes `Consortium.contracts`; see "Daily contracts" below |
| `server_scripts/consortium_onboarding.js` (priority 30) | Onboarding (RANKS_AND_CONTRACTS 3): the starter kit at the first `GRANTED` login (with the rulebook), `/consortium kit`, the referral flow and its milestone payouts, the engine-side first-credit stopwatch; exposes `Consortium.kit` and `Consortium.referrals`; see "Onboarding" below |
| `server_scripts/consortium_calendar.js` (priority 15) | The events engine's calendar (DISCORD_AND_COMMUNITY 6): `season1.json` plus staff-set dates, the 24 h and 1 h reminders, the 06:00 auto-queue of the Friday and Saturday events, the Wednesday contract guard; exposes `ConsortiumEvents.calendar` and `ConsortiumEvents.queue`; see "Calendar and reminders" below |
| `server_scripts/consortium_rules.js` (priority 10) | The rulebook in game (DISCORD_AND_COMMUNITY 7): `/rules`, `/rules <section>`, `/rules book`, the written book built from `rulebook.json` with the page model of `tools/rulebook-md.mjs`; exports `consortiumRulebookStack()` and `consortiumRulebookGive(player)`; see "Rulebook" below |
| `server_scripts/consortium_discord.js` (priority 10) | The daily Discord digest (DISCORD_AND_COMMUNITY 5), one post per season day through `ConsortiumCore.discordAnnounce`; see "Discord digest" below |
| `server_scripts/consortium_border.js` (priority 10) | The Nether fence (DISCORD_AND_COMMUNITY 10): players beyond the overworld border / 8 in the Nether are teleported back to their last in-bounds position; see "Nether fence" below |
| `server_scripts/consortium_commands.js` (priority 0) | The `/consortium` commands: the base tree, then the delimited **economy block** (licence, season, event ticket, perk, meta, title, sale, gap, debug vacancy, quest, contract), the events engine's **events block**, the **ranks block** (ranks, leaderboard, contracts, referral, kit), the **discord block** (calendar, discord digest, rules helpers, border) and the **HQ block** (hq build, status, clear, spawnpoint, forget), each a separate `commandRegistry` listener whose `consortium`, `event` and `debug` literals Brigadier merges |

How it works:

- **State** lives in `server.persistentData` under `consortium` (saved with the world in
  `<world>/kubejs_persistent_data.nbt`): `currentPhase`, `startedAt` (season start, normalised to the
  06:00 at or before the real start so season days roll over at 06:00 server time), `lastDailyDay`,
  `charters.<uuid>` (`charter`, `chosenAt`, `switchedAt`, `switches`, `name`, `lastDeliveryAt`), `staff.<uuid>` (name), and per phase `startedAt`,
  `completedAt`, `lastProgressAt`, `stalled`, `stalledAt`, `milestone`, `history.<season day>` (`C x 1000`
  at that day's snapshot) and `progress.<line>`; the money and shop keys are listed under "Money caps" and
  "Shop engine" below. Dump it with `/kubejs persistent-data server get consortium`.
- **Deliveries**: the Consortium Core mod runs `/consortium contribute <item> <count>` as the console once per
  delivered item id right after each terminal delivery is committed (its `contribute_command` server config; the
  mod's own KubeJS binding is `ConsortiumCore`, so this script-level `Consortium` object is untouched). Scripts can
  also call `Consortium.contribute(player, itemId, count)` directly (or
  `Consortium.record(server, name, itemId, count, source)` without a player). Only items of the current phase
  quota count (family lines such as `#c:ingots/steel` list every accepted id in `items`); the return
  value is the number of units recorded, 0 when the item is not in the quota. `source` absent or `'terminal'`
  multiplies the count by the events engine's Double Quota Hour factor (`ConsortiumEvents.quotaFactor`,
  typeof-guarded, log suffix `(x2 quota hour)`); `'board'` (the Gap Contract) counts once. At 25, 50, 75 and 90 % of
  the phase average (`CONSORTIUM_MILESTONES`) the engine announces the progress and the missing amounts.
  The quota counts item ids (1 per item) while the terminal pays family units (a block pays 9 units and
  counts 1, raw iron pays 1 unit and counts 0 for the iron line): not exploitable, credits are capped per
  family and per paycheck.
- **Completion** (section 11): average of the lines >= 90 % and every line >= 60 %. The engine then
  reconciles every FTB team (the new phase stage and the charters' next early-access bundles), shows the
  title, posts the section 13 unlock text with an `[open quests]` link, plays `ui.toast.challenge_complete`,
  sends the Discord `say` line and renames the boss bar.
- **Stage writes** never use `/ftbteams teamstage` or `TeamStagesHelper.addTeamStage` (they corrupt
  FTB Teams' shared default set). A team with an online member whose effective team is that team gets
  the write through Chapters' `PlayerStages` bridge; every other team (nobody online, or the inactive
  personal team of a party member) gets a copy-on-write of `ftbteams:team_stages` that mirrors Chapters'
  own commit (verified on the test server, persisted in `<world>/ftbteams/`). Personal teams of party
  members are therefore kept current, so a player leaving a party is not stripped by Chapters' audit.
- **What a team holds** (`consortium_charters.js`): `phase_1..phase_<current>`; plus, when the team's
  owner has a charter, `<charter>_p1..p<current>` and `licence_<charter>` from phase 3 (Extraction) or 4
  (Energy, Logistics); an all-staff team (every member on the staff list) holds `staff` and every stage.
  Any other `consortium:*` stage is stripped (old charter after a switch, staff stages on a team that
  gained a non-staff member, phases above the current one). Charter choice: `/consortium charter
  <extraction|energy|logistics>` once per player, staff switch with `/consortium charter set`, which
  enforces PROGRESSION.md 9.1: refused while the player's effective or personal team holds any
  `licence_*` stage, after the one switch of the season (`switches` in the record) or within 7 days of
  the choice or the last switch; `none` clears the record and is always allowed.
- **Rule 4.5**: every login reconciles the player's team (again 2 s later, once FTB Teams has surely
  assigned the team) and tells the player their charter or how to pick one; a 1 second sweep reconciles
  the team of any online player whose team lacks the current stage (party changes) or holds
  `consortium:staff` against the staff rule (a non-staff player joined a staff party, or a staff-only
  team lost the stage); a 5 minute check reconciles every team, refreshes the boss bar and runs the
  daily step when due.
- **Quota board** (Consortium Core): `consortiumPublishBoard(server, force)` in `consortium_phases.js` hands the mod the
  phase, name, season day, completion and every quota line (key, label, icon, current, target) as JSON through
  `ConsortiumCore.publishBoard(json)`, plus the `season_fund` line once the first contribution wrote the fund's
  target and the `event` object of the events engine (`ConsortiumEvents.boardObject`, rendered by Consortium Core
  0.3.1, ignored by 0.3.0); the mod draws it on every Delivery Station screen and keeps no phase state of
  its own. Called after every recorded delivery, at phase completion, `phase set`, `clearprogress`, `reset` (forced),
  from `daily` and from the 5 minute check (which also covers the first publish 100 ticks after load and every
  `/reload`); identical payloads are skipped and publishes are throttled to one per second with one trailing publish.
  A quota line may carry an optional `icon` item id (`consortium_quotas.js`), else the first listed item, else its id.
- **Boss bar** `consortium:phase`: "Phase N: <name> - <percent>%", max 100, created on server start and
  only re-sent when its text changes. Players are added to it on login.
- **Daily step** (section 11): at the first check after 06:00 server time each day (season days roll
  over at 06:00 because `startedAt` is normalised to it, whatever the hour the state was created or
  wiped), the engine
  snapshots the phase average `C`, posts the summary (`say`, so it reaches Discord without the
  experimental tellraw relay: day, phase, `C`, every line's percent) and evaluates the stall rule: flagged
  when `C` gained less than 5 points over the newest snapshot at least 5 days old while `C < 1` and the
  phase is 5 days old; cleared when the gain is 5 points again. One notice per stall and one when it
  clears, never daily. `consortium_shop.js` sets `Consortium.onCatchUp`, so the stall notice names the Board's
  offer and carries a clickable `[Gap Contract]` link, and the clear notice says the contract is closed. The
  daily summary also reads `season fund <pct> %` once the fund exists, and the daily step then runs the shop's
  vacancy rule (`consortiumShopDaily`); the 5 minute check closes expired sales (`consortiumShopCheck`).
- `Consortium` is a plain object in the shared server-script scope (KubeJS 2101 refuses writes to
  `global` from server scripts), reachable from any other server script.
- Singleplayer: the engine also runs on the integrated server (FTB Teams and Chapters are both-sided);
  the `say` relay is skipped when Simple Discord Link is absent.

Commands (`/consortium ...`):

| Command | Who | Effect |
|---|---|---|
| `phase` | anyone | current phase, quota table, days since the last delivery |
| `phase set <n>` | op 2 | staff lever: jump to phase n; every team is reconciled, delivery progress is kept (a phase whose progress is already complete stays complete) |
| `phase resync` | op 2 | reconcile every FTB team (phases, charters, staff) |
| `phase reset WIPE` | op 4 | wipe phase and charter state (the confirmation word is required); the staff list is kept |
| `charter` | anyone | your charter and, in a party, the party's (owner's) |
| `charter <extraction\|energy\|logistics>` | anyone | choose a charter, once per player; a second call says switching goes through staff |
| `charter set <player> <charter\|none>` | op 2 | staff switch; old charter stages are stripped at once, the record applies at the next login if the player is unknown to FTB Teams. Refused with the reason while the player's team holds a licence stage, after the one switch of the season or within the 7-day cooldown (section 9.1); `none` always clears the record |
| `staff list\|add <player>\|remove <player>` | op 4 | the staff list; all-staff teams get `consortium:staff` and every stage, others lose them |
| `contribute <item> <count>` | op 2 | test delivery (announces milestones like a real one) |
| `teams` | op 2 | every FTB team with the `consortium:*` stages it holds, its owner's charter and whether it is staff |
| `check` | op 2 | run the 5 minute maintenance now |
| `debug daily` | op 4 | run the daily snapshot, summary and stall evaluation now |
| `debug stall` | op 4 | fake a flat 5 day quota (backdated phase plus a snapshot), then `debug daily` shows the stall notice |
| `debug clearprogress` | op 4 | wipe the delivery progress of the current phase |
| `licence grant <player> <extraction\|energy\|logistics> [tx]` | op 2 | purchased (with `tx`, the shop's path) or staff-granted licence: record written, vacancy and sale closed, team reconciled, announced; idempotent on `tx` |
| `licence revoke <player> <charter>`, `licence list` | op 2 | record removed (stage stripped at once); records and the vacancy state of each charter |
| `season` | anyone | fund, target, top 3 with plaque tiers, the caller's share |
| `season contribute <player> <credits> [tx]` | op 2 | counts a contribution the shop already debited (1..100000 CC); idempotent on `tx` |
| `season target <credits>` | op 4 | sets the fund target (announced) |
| `event ticket <player> add <n> [tx]`, `event ticket take <player> <n>` | op 2 | Friday Zone tickets (`n` 1..9, idempotent on `tx`; `take` refunds or consumes by hand, floor 0) |
| `event ticket get [player]` | anyone for self, op 2 for others | unused tickets |
| `perk grant <player> <perk> [tx]`, `perk revoke <player> <perk>`, `perk resync <player>` | op 2 | `home_slot_1..3`, `warp_pass`, `nickname`: the record plus the LuckPerms line through the console (`resync` re-issues them, the active title's suffix and `consortium.title`, and `consortium.charter`) |
| `perk list [player]` | anyone for self, op 2 for others | held perks |
| `meta resync [player]` | op 2 | re-issues every LuckPerms value the engine owns (perks, the title suffix and meta key, the charter meta key) for one player, or for **every known player** without one (FTB Teams' known players plus every title, perk or charter record): the repair lever after a LuckPerms wipe or a hand-set key (BADGES_AND_HQ 1.4) |
| `title <key>`, `title none`, `title list [player]` | anyone (list of others: op 2) | puts a held title on, hides the suffix, lists what is held |
| `title grant <player> <key> [tx]`, `title revoke <player> <key>` | op 2 | `foundry`, `orbital`, `horizon`, `benefactor`, `bug_hunter` (the quests script passes its own keys and texts through the API) |
| `sale open <stage> [hours]`, `sale close <stage>`, `sale list` | op 2 | sale stages every team holds while open (the vacancy licences use `consortium:vacancy_<charter>`) |
| `gap`, `gap buy <item> <units>` | anyone / player | the Gap Contract: status, and a purchase at `units x max(1 CC, 2 x base)` with every refusal before the debit |
| `debug vacancy <charter> [clear]` | op 4 | backdates the charter's activity and the phase by 15 days (then `debug daily` prints the idle notice and opens the sale in one pass); `clear` stamps a delivery now |
| `quest flag\|unflag <players> <key>`, `quest count <players> <key> <n>` | op 2 | wrappers over `ConsortiumQuests` (selectors allowed; a key without a namespace such as `referral` keeps no `minecraft:` prefix) |
| `contract`, `contract set <family> <units> [days]`, `contract clear` | anyone / op 2 / op 2 | wrappers over `ConsortiumQuests.contract` (the weekly contract lives in `consortium_quests.js`) |
| `ranks [player]` | anyone | rank by threshold, credits earned at the terminal, position (0.4.0) and the next tier; an offline name resolves through `ConsortiumCore.uuidOf` (0.4.0) or FTB Teams |
| `leaderboard [n]` | anyone | `Top n by credits earned:` (1..25, default 10) in the mod's one entry format `1. underfr (Engineer) 2,512.00 CC`, then `You are #7 with ...` |
| `contracts` | anyone | today's daily contracts (`Iron +0.25 CC per unit: 40 of 136 units taken, until 06:00.`) and the caller's eligibility |
| `contracts set <family> [units]`, `contracts reroll`, `contracts clear` | op 4 | one contract on a family (units default to the computed N), a new pick for today (announced, never a family of the previous list), no contract until tomorrow |
| `referral <name>` | player | names the caller's recruiter during the first 7 days (refusal texts of RANKS_AND_CONTRACTS 3.2; `pending` when the connection check cannot answer) |
| `referral list`, `referral status <player>`, `referral approve <newcomer>`, `referral clear <newcomer>` | op 2 | the records; a pending record becomes active and is polled at once; a record is deleted (the payout reversal is `/credits take`) |
| `kit`, `kit reset <player>` | player / op 2 | the starter kit again, once (`GRANTED` accounts only; a `DENIED` alt gets the login refusal text); clears both stamps |
| `calendar`, `calendar reload` | op 2 | the next slot, its source, the rendered reward tokens, the stamps and the staff-set dates; re-read the JSON |
| `calendar set <date> <event> [args]`, `calendar title <date> <text>`, `calendar cancel <date> [reason]`, `calendar clear <date>` | op 2 | the programme of a date (`YYYY-MM-DD`, server time; a late `set` or `cancel` inside the 24 h window posts its line at once), its public title, a cancellation, or forget the staff entry |
| `calendar debug <24h\|1h\|cancel\|queue\|wednesday\|clear> [date] [+offset]` | op 2 | force a reminder line, the cancellation line, the auto-queue or the Wednesday guard; `+3h` or `+10m` evaluates the reminder as if now were that far past its instant (`missed:` stamp or the line); `clear` wipes the stamps of a date |
| `discord digest` | op 2 | prints the daily digest and posts it on the announcements lane |
| `rules give <player>`, `rules spec`, `rules reset <player>` | op 2 | a rulebook copy to an online player, the written book spec, the daily `/rules book` stamp |
| `border` | op 2 | the Nether fence centre and radius derived from the overworld border |
| `hq build <x> <y> <z> <south\|west\|north\|east> [<layout>]` | op 4 | generates the HQ around the anchor (`y` = the floor block level, `x z` = the spawn plinth centre) from `consortium_hq/<layout>.json` (default `hq`): snapshot of the box first, then the passes; refused while a build or a clear runs or a box is recorded |
| `hq status` (also `hq info`) | op 4 | not built / snapshot / building / built / interrupted, the layout, anchor, facing and box, the five marks in world coordinates, the arena check against the events record and the claim, then the post-build commands with the real numbers |
| `hq clear` | op 4 | kills the tagged entities, restores the snapshot (terminals and waystone first, then the bulk) and drops the record; a build that never wrote is simply dropped, an unreadable record falls back to a wipe with a red warning |
| `hq spawnpoint [arena [<player>]]` | op 4 | `setworldspawn` on the plinth and `spawnRadius 0`; with `arena`, writes the events arena record (centre = the arena mark, radius 3, ring 6..10, pit 12 from the layout) for the party of the player, refused when the team is not a party |
| `hq forget` | op 4 | drops the record and the box without touching a block (after the production build is approved; `hq clear` is then impossible) |

`/rules`, `/rules <section>` and `/rules book` are a top-level literal of `consortium_rules.js` (anyone; the book once per player per day).

Simple Discord Link: with `broadcastCommands = true` every command the engine runs (`bossbar`, `title`,
`playsound`) is posted to the Discord events channel as "Server executed command"; the server overlay's
`simple-discord-link.toml.example` lists them (plus `ftbquests` and `consortium`) in `ignoredCommands`.
`say` and `tellraw @a` return before that check and are relayed as chat instead.

## Money caps (`consortium_money.js`, PRICE_TABLE 1.4 and 6)

- **Daily paycheck cap** `DAILY_PAYCHECK_CAP = { 1: 560, 2: 1100, 3: 830, 4: 1130, 5: 2750 }` CC (PLACEHOLDER, 3 x the
  design income of the best-paid charter of the phase): per player and per season day (06:00 server time) the terminal
  pays at most that; `consortium.paycheck.<uuid> { day, cents, notifiedDay }` is fed by the `DeliveryEvent` listener and,
  at quote time, every line factor is scaled by `max(0, (cap - paid) / projected)` when the receipt would cross the cap.
  Units beyond it count for the quota only; the player is told once per day. Harness: set `DAILY_PAYCHECK_CAP[1] = 100`
  in the srvdev copy, `/ccore selftest` twice, expect the reduced percentage and the chat line.
- **Newcomer bonus cap** `NEWCOMER_BONUS_CAP = { 1: 310, 2: 630, 3: 460, 4: 630, 5: 550 }` CC (PLACEHOLDER, 25 % of 7 design
  days at the median income of the phase): `consortium.newcomer.<uuid>.bonusCents` accumulates the bonus share of every
  receipt the +25 % applied to; the factor returns to 1 at the cap.
- Both value sets are re-derived from `tools/pricing` after the beta-week rate corrections (PRICE_TABLE 8).

## Shop engine (`consortium_shop.js`, SHOP_CATALOGUE 5)

- **State** under `consortium`: `licences.<uuid>.<charter> { grantedAt, tx, by }`, `activity.<charter>.lastDeliveryAt`,
  `vacancy.<charter> { inactiveSince, openSince }`, `sales.<stage id> { until, by }`, `season { fund, target, milestone,
  contributors.<uuid> { cents, name, tier } }`, `events.tickets.<uuid>` (int, the events engine reads it through the API),
  `perks.<uuid>.<perk> { grantedAt, tx }`, `titles.<uuid> { active, held.<key> }`, `gap.<phase> { day, today, total,
  buyers }`, `txs.<tx> { at, what }` (pruned after 30 days).
- **Idempotency and refusals**: every engine command behind a shop entry carries the purchase `{tx}` and applies once
  (`txs.<tx>` seen = "already applied", still a successful command so the mod never reports an effect failure). A
  failed effect is never refunded, so every refusal happens **before** the debit in the `BalanceChangeEvent` listener
  (counterpart `shop:<key>`): claim limit 200, perk already held or missing prerequisite, licence sale closed, buyer not
  the team owner, no charter, licence already held, title already held. Tickets, season packs and item entries are
  never refused there.
- **Licences and vacancy** (PROGRESSION 9.4): `Consortium.licences.grant` writes the record `consortium_charters.js` reads
  in `consortiumWantedStages` (the licence stage survives the 1 second sweep; the team keeps its own charter and holds a
  second licence stage), closes the vacancy and the sale, stamps the charter's activity. The daily step marks a charter
  idle after 7 days without a delivery by a holder (notice), opens the sale stage `consortium:vacancy_<charter>` to every
  team after 7 more days, and withdraws it when a holder delivers again. The `DeliveryEvent` listener stamps
  `activity.<charter>` for non-staff players (effective charter plus the licences the team owner holds).
- **Season fund**: `Consortium.season.contribute` (target 30,000 CC PLACEHOLDER written at first use), milestone
  announcements at 25 / 50 / 75 / 100 % with the events engine's fireworks, the Benefactor title at 500 CC contributed,
  plaque tiers at 1,000 / 3,000 / 6,000 CC, then the board line.
- **Titles**: one registry for the shop and the quests, one LuckPerms suffix at priority 60 (`" &7<text>"`), the newest
  grant is active, `/consortium title <key>` switches; **perks** run their LuckPerms lines through
  `server.runCommandSilent` (the shop's own command source is refused by LuckPerms): home slots set
  `ftbessentials.home.max` to the number of slots held, the pass and the nickname set `command.warp` and
  `command.nickname`. Both are re-issued at login (LuckPerms runs asynchronously and always reports success).
- **Badge meta keys** (BADGES_AND_HQ 1.4, read by Consortium Core 0.5.0): every `Consortium.titles` mutator and the
  login resync also write `lp user <uuid> meta set consortium.title <active key>` (or `meta unset` when no title is
  active; the resync runs this half record or no record, so a hand-set key does not survive a login), and
  `consortiumCharterPublish` (consortium_charters.js) writes `consortium.charter = extraction | energy | logistics`
  from the player's own record at every choice, switch, staff set or clear and at every login. The suffix stays as it
  was for servers with badges off; a `meta set` of an unchanged value is a LuckPerms no-op, so the login costs nothing
  for an unchanged player. `/consortium meta resync` re-issues everything for every known player.
- **Gap Contract** (PROGRESSION 11): open while the phase is stalled; `/consortium gap buy <item> <units>` at
  `max(1 CC, 2 x base)` per unit with the base read from `ConsortiumCore.price(family).baseCents()` (never the degressive
  unit price), packs of 10 on lines with a quota of at least 500, caps of 10 % of the line per day, 30 % per phase and
  10 % per buyer per phase (PLACEHOLDER), then `ConsortiumCore.debit`, `Consortium.record(..., 'board')`, rank credit at
  50 %, the `contract:gap` quest flag and the announcement.
- **Quest flags** (`ShopPurchaseEvent`): `shop:any` on every purchase, then `shop:chunk_loader`, `shop:claim_chunks`,
  `shop:waystone`, `shop:season_contribution`, `shop:ticket` by key prefix; `licence:purchased` from a shop licence.
- Everything is off when `ConsortiumCore` is undefined (singleplayer); LuckPerms lines are skipped and logged when the
  mod is absent.

## Quests bridge (`consortium_quests.js`, priority 30, docs/QUESTS.md 5)

The FTB Quests tree (`config/ftbquests/quests`: 9 chapters, 129 quests, `lang/en_us.snbt`) talks to the engine
through this script and the FTB XMod Compat KubeJS events (`FTBQuestsEvents`). Static check before every change:
`node tools/ftbq_check.mjs --registry <reg_items.txt>` (ids, dependencies, lang keys, item ids, stage ids, the
script tables both ways, run families against the price table, shop items, the credit budget, repeatable rules and
the quota numbers of the briefings against `consortium_quotas.js`).

- **Tables**: `CONSORTIUM_QUEST_TASKS` (custom task id -> `run { family, units }`, `flag { key }`, `weekly { key }`,
  `contract`, `count { key, n }`, `rank { rank }`, `paycheck`, `charter`, `founder`) and `CONSORTIUM_QUEST_REWARDS`
  (custom reward id -> `cc { cents, reason [, xp] }`, `cxp { xp }`, `cosmetic { cosmetic }`, `title { title, text }`,
  each with the claimer `check` of QUESTS 5.4). Every cents value is a PLACEHOLDER; the season total is 2,175 CC per
  player (10.3 % of the median season income), recomputed by the checker.
- **Custom tasks** are polled every 40 ticks for online players whose quest is startable, with the max rule: each
  member writes its own value into the team's progress and the value only rises (a party member at 0 never erases a
  crew mate's run). `run` reads `quests.delivered.<uuid>.<family>` (units by price family key, fed by the
  `DeliveryEvent` listener, zero-floor and capped units included); `rank` shows whole credits against
  `CONSORTIUM_RANK_THRESHOLDS` (the ranks step's table; `CONSORTIUM_QUEST_RANK_FALLBACK` until it lands).
- **Custom rewards re-check the claimer** before paying (FTB completes a quest for the whole team): a run needs the
  claimer's own units, a phase closing one run of the phase, a certification the item in the claimer's inventory, a
  moment or event quest the staff or engine flag on that uuid, the contract and the weekly stamps their own records,
  Founder `ConsortiumCore.firstLogin` on season day 1 or 2, a licence title the team's licence stage. A refused claim
  is consumed, prints `This assignment is credited to the crew member who did it.` and one `console.info` line, writes
  no ledger line (staff refund with `/credits add` when a player claims by mistake). Credits go through
  `ConsortiumCore.credit(uuid, cents, 'quest:<reason>')` (ledger `API_CREDIT`, never rank credit), cosmetics are
  vanilla items with `minecraft:custom_name`, `minecraft:lore`, glint and `minecraft:custom_data { consortium_cosmetic }`
  given through `Item.of(...)` (fallback `/give` from the console), titles go through `Consortium.titles.grant` (the
  shop's registry; when it is absent the grant is kept in `quests.titles_pending.<uuid>.<key>` and logged).
- **Repeatables** (weekly contract, Friday Shift, Saturday Roster): every reward is a team reward, so one claim resets
  the quest for the party after the 5 minute cooldown; the check pays each member once (`weekly_paid`, `contract_paid`
  stamps) and the task re-completes only while an unpaid member qualifies. The XP of these three quests is paid by the
  handler (custom reward), not by an FTB `xp` reward, so it is stamped too.
- **State** under `consortium.quests`: `delivered.<uuid>.<family>`, `delivered_since.<contract id>.<uuid>.<family>`,
  `flags.<uuid>.<key>`, `counts.<uuid>.<key>`, `weekly.<uuid>.<key>` and `weekly_paid.<uuid>.<key>` (season week
  numbers), `contract { id, family, units, setAt, endsAt }`, `contract_paid.<uuid>`, `contract_seen.<team uuid>`,
  `titles_pending.<uuid>.<key>`.
- **`ConsortiumQuests`** (shared scope object): `flag(uuid, key)` (week stamp for `event:friday` and `event:saturday`,
  boolean otherwise), `unflag(uuid, key)`, `has(uuid, key)`, `count(uuid, key, n)` (adds `n`, floor 0),
  `delivered(uuid, family)`, `contract.set(server, familyKey, units, days, byName)` (refusal string or null; announces
  through `say`, resets the Weekly Contract quest for every team so no stale progress carries over),
  `contract.status(server, uuid)`, `contract.clear(server)`, `contract.current(server)`. Setters: staff
  (`/consortium quest flag|unflag|count`, the economy block of `consortium_commands.js`), the events engine
  (`event:friday`, `event:saturday`, `event:supply_drop`, the Wednesday lapse through `unflag`), the shop script
  (`shop:*`, `licence:purchased`, `contract:gap`) and this script (`market:charter_bonus` and `event:market` from the
  `DeliveryEvent`, `event:bounty` and `event:invasion` from `BalanceChangeEvent` reasons `event:bounty:*` and
  `event:wave:*`, `event:blood_moon` from a 40 tick poll of `consortium.events.active`).
- **Reload rule**: the task checks are attached to the task objects when the quest file loads. After editing this
  script run `/reload` and then `/ftbquests reload quests` from an op in game (the dedicated console is refused; use
  `execute as <op> run ftbquests reload quests` in `console-in.txt` on the harness); a plain `/reload` leaves the old
  closures on the tasks. Never copy a running server's `config/ftbquests` back into the pack (FTB rewrites dirty
  files without comments).
- **Log lines**: `[Consortium] quests: 84 rewards, 21 runs, 25 flags attached` at script load; FTB's `Loaded 3
  chapter groups, 9 chapters, 129 quests, 0 reward tables` at quest load.

## Events (rule 4.6, design in docs/EVENTS.md, contract in docs/CONTENT_BATCH_2_INTERFACES.md)

Ten events, one at a time, in `consortium_events.js` (priority 20) over the helpers of `consortium_events_lib.js`
(45): market multipliers `ore_rush` (raw x2, 60 min), `power_surge` (power x2, 45 min), `logistics_week`
(transport x1.5, 90 min, phase 2), `market_crash` (one price family x0.5 on a quota line at 60 % or more, phase 2),
`double_quota` (deliveries count twice for the quota, credits unchanged), `supply_drop` (a `consortium:event/supply_drop`
crate 2 chunks clear of every claim, `_late` from phase 4), `bounty` (an Apotheosis invader 200 blocks from every
claim, paid by damage share at its death, phase 2), `invasion` (waves at the HQ arena for opted-in players, phase 2),
`blood_moon` (In Control phase `consortium_blood_moon` plus the root flag `consortium_event_bloodmoon`, one night) and
the staff-only `friday_zone` (muster with a ticket, waves, boss finale, crate; phase 2). Every number in the two
files is a PLACEHOLDER for the beta. The engine is inert unless Consortium Core and FTB Chunks are present
(`CONSORTIUM_EVENTS_ON`); Apotheosis and In Control are optional (bounty and blood moon ineligible without them).

- **State** under `consortium.events`: `version`, `paused` (true by default: the random scheduler is off until
  staff run `/consortium event resume`), `arena { dim, x, y, z, team, radius }`, `active { id, startedAt, endsAt,
  forced, calendar, payouts, kills, damage, ... }`, `cooldowns.<id>`, `dayKey`, `dayCount`, `lastRollSlot`,
  `queued`, `optin.<uuid>`, `dailyPaid.<uuid> { day, cents, week, weekCents }`, `summaryDay`, `wednesdayWeek`,
  `tickets.<uuid>` (the shop script's key, read through `Consortium.tickets`), `log` (last 10). The top-level flag
  `consortium_event_bloodmoon` is never nested: In Control's `kubejs` condition reads the root of the same file.
- **Scheduler**: a 5 s step in `ServerEvents.tick` (no `scheduleRepeating`: its callbacks survive `/reload`).
  Random rolls at most twice a day, one per half-hour slot, inside 18:00-23:00 (plus 14:00-18:00 on Saturday and
  Sunday), with at least 3 players online (2 for market events), never while stalled, never when the event would end
  less than 5 minutes before the next Wednesday, Friday or Saturday 20:00 slot (`consortiumNextSlotMs`). A staff
  `start` or a queued event cuts a running random event short and is refused while a staff event runs.
- **Stop order**: results paid, `active` removed and logged, then cleanup (force-loads, In Control phase and flag,
  crate, `kill @e[tag=consortium_event]` in every dimension); the death and hurt listeners return when no event
  runs, so the cleanup kill never pays. `ServerEvents.loaded` reconciles an event that outlived a restart and
  republishes the board synchronously (the mod folds it over the saved snapshot).
- **Money** (rule 4.3 and EVENTS 4): payouts go through `ConsortiumCore.credit` with reasons `event:bounty:<boss>`
  and `event:wave:<n>`, never `addRankCredit`; every payout and every market bonus (booked from the mod's
  `DeliveryEvent`) is clipped to the per-player daily cap (60 % of the phase's median design income day) and weekly
  cap (70 %); a bounty pot is 1.5 x ref split by damage, 0.5 x ref max per hunter; a wave kill pays 1 % of ref, 30 %
  max per invasion. The market factor multiplies only the lines whose price family sits on a quota line of the
  current phase and drops to 1 for a player whose caps are spent.
- **Safety** (rule 4.6): every spawn and crate is placed outside hostile claims (every claimed chunk except the arena
  team's own chunks inside the arena radius) through the FTB Chunks API, engine mobs inside a hostile claim or
  beyond 48 blocks of the arena centre are discarded every 5 s, tagged mobs joining a level outside their event are
  discarded (`EntityEvents.spawned`), and blood moon natural spawns are cancelled inside hostile claims.
- **Quest flags** set here: `event:friday` (Friday Zone admission or a Friday-slot event end), `event:saturday`
  (a Saturday-slot event end), `event:supply_drop` (the crate opener), all through `ConsortiumQuests.flag`; the
  Wednesday duties lapse the unclaimed weekly stamps through `ConsortiumQuests.unflag`.
- **Board and presence**: `ConsortiumEvents.boardObject(server)` feeds the board's `event` band (Consortium Core
  0.3.1) and the `{event}` tab token; `ConsortiumEvents.quoteFactor`, `quotaFactor` and `fireworks` are the other
  entry points the economy scripts wrap.
- **In Control**: the blood moon rules ship in the server overlay (`server/overlay/config/incontrol/spawner.json`
  and `spawn.json`, README next to them), not in the pack (server-only mod); the harness copies them into
  `srvdev/config/incontrol/` by hand. The engine reloads them at every server load.
- **Loot tables**: `data/consortium/loot_table/event/supply_drop.json` and `supply_drop_late.json` hold one Apotheosis
  affix item, 0 to 2 gems and the "Board Courier Cap" cosmetic (`consortium_cosmetic: courier_cap`): never a priced
  item (rule 4.1). `structure_loot.js` leaves `consortium:*` tables outside the affix strip on purpose.

Commands (`/consortium event ...`, the events block of `consortium_commands.js`; `event ticket ...` is the economy block's):

| Command | Who | Effect |
|---|---|---|
| `event` | anyone | the running event, its slot and stage, the queue, your opt-in state and event bonus room |
| `event join` / `leave` | anyone | invasion opt-in (persisted), or the Friday Zone muster registration (inside the arena, ticket in hand; consumed at the wave start) |
| `event slot <friday\\|saturday\\|none>` | op 2 | overrides the running event's slot (which participant stamp its end sets) |
| `event list` | op 2 | the catalogue: kind, duration, weight, phase, cooldown left, eligible now or why not |
| `event start <id> [args]` | op 2 | forced start (cuts a random event short; refused while a staff event runs). Args: `market_crash <family>`, `bounty [<boss id> <rarity>] [arena]`, `supply_drop [meteor]` |
| `event stop` | op 2 | ends the active event now |
| `event next` / `next <id> <hour> <minute> [args]` / `next clear` | op 2 | the queue for today at that server time, with reminders at minus 60 and minus 5 minutes |
| `event arena here [<radius>]` / `set <x> <y> <z>` / `team <player>` / `ring <min> <max> [<pit>]` / `show` | op 2 | the HQ arena record (centre, FTB team id, radius in chunks, default 3, plus the wave ring in blocks and the pit square: `ring` sets them, `here` carries them over from a record within 16 blocks, `show` prints `ring 6..10 blocks, pit 12 blocks` or `ring 8..40 blocks (default), pit none (chunk rule)`); with a pit, every "inside the arena" test is the block square around the centre and a wave mob farther than pit + 4 (Chebyshev) is discarded (BADGES_AND_HQ 2.7) |
| `event pause` / `resume` | op 2 | the random scheduler (paused by default) |
| `event debug roll [<id>]` / `muster` / `stage` / `paid <player> <cents>` / `wednesday` / `clear` | op 4 | one roll now ignoring the window and caps; end the muster or move the Friday stage; set today's event credits; run the Wednesday duties; wipe the events state (arena and tickets kept) |

## HQ generator (`consortium_hq.js`, priority 20, docs/BADGES_AND_HQ.md part 2)

- **Layout**: `data/consortium/consortium_hq/hq.json`, generated by `node tools/hq/build-layout.mjs` (walls, bays, sawtooth
  roof, light grids and rooms as code; the JSON is the shipped artifact) and checked by `node tools/hq/check-layout.mjs
  <file> [--anchor x y z]` (row lengths, palette keys, state strings, marks, the arena spawn-ring shelf rule, entity
  supports, the no-loot rule 4.1, the price table; `--anchor` writes `tools/hq/out/expected-marks.json`). One
  printable character per cell, `.` and space are empty; palette entries are a state string or an object with `state`,
  `connect` (shape pass after the bulk pass: fences, bars, walls, stairs, girders), `last` (placed in the finish pass:
  the Delivery Terminals after their panels), `sign` (four lines plus `color`, composed into the waxed `front_text`
  NBT), `nbt` (an SNBT string loaded in the same tick as the placement), `states` (one state per facing) or `api:
  waystone` (`style`, `name`, `visibility` through the Waystones API). Layer `y` is relative to the floor blocks;
  `marks` (`spawn`, `arena`, `terminal`, `shop`, `waystone`) are local cells, `arena.ring` and `arena.pit` are what
  `hq spawnpoint arena` writes.
- **Build**: `/consortium hq build <x> <y> <z> <facing> [<layout>]` rotates the layout around the anchor (south 0,
  west 1, north 2, east 3 clockwise quarter turns: a state is rotated by its own `rotate()`, then by a generic property
  walk for mod blocks that do not override it), force-loads the box (rectangle plus a 3-block apron, layers -2 to
  clear_top), and runs an in-memory tick queue: pass 0 snapshots every position (state plus block entity NBT, runs
  along x packed as `dx | dy << 8 | dz << 16` from the box corner) into `server.persistentData.consortium_hq.record`
  and saves the world before the first write; pass 1 lays the foundation (`fill`) and the ground where the layer 0
  map is empty; pass 2 clears the box to air; pass 3 places the layers bottom to top (`Level.setBlock` flags 18, the
  NBT at once); pass 4 fixes the `connect` shapes, places the `last` entries, the waystone and the tagged item frames
  (`Tags:["consortium_hq"]`), runs the survival audit (`canSurvive` on every placed position), releases the ticket and
  saves. Budget 800 placements or 4,000 scans per tick (fewer for the ground and audit steps), halved after a step over 25 ms and restored after five quiet
  steps; the finish line prints the placements, ticks, worst tick and the audit.
- **Clear**: `/consortium hq clear` kills the tagged entities in the box, restores the terminals and the waystone
  halves first (one formation scan, the waystone's `onRemove` drops its database entry), then the bulk from the
  record (flags 2, block entity NBT in the same tick), releases the ticket and drops the root key. A build that never
  left the snapshot is dropped without a write; an unreadable record falls back to a wipe (air above the floor,
  ground at the floor level, fill below) with a red warning.
- **Recovery**: the queue is script state and dies with `/reload`; the first tick after every script load releases a
  force-load ticket left by an interrupted run and warns (`build interrupted: run hq clear, then hq build`).
- **Site**: Season 1 is `consortium hq build 250 65 0 south` (floor y 65, the plinth centre at 250 0), then the five
  post-build commands `hq status` prints (party, allowance, `ftbchunks admin claim_as staff 80 250 0
  minecraft:overworld`, `hq spawnpoint arena <member>`, the interact mode). On the dev world the pad is `fill 265 62
  -420 335 62 -350 minecraft:smooth_stone` and `consortium hq build 287 63 -385 south`.

## Consortium Core data (shop and prices)

- `data/consortium/consortium_prices/starter.json`: the Season 1 price table (75 families, docs/PRICE_TABLE.md), **generated**
  by `tools/pricing/price-table-build.mjs` and copied here verbatim: never hand-edit it. Re-run the build after any
  change to a rate, a multiplier or a family (`node tools/pricing/price-table-build.mjs`; the tag snapshot with
  `node tools/pricing/tagcheck.mjs <extracted jars> --snapshot` after a mod update), then the simulation and the
  acceptance checks (`node tools/pricing/results.mjs` writes `tools/pricing/results.md`), then copy `price-table.json`
  over this file. The mod announces every changed base, half volume or cap at the next boot (rule 4.2). Each family
  carries its `charter_family` (`raw`, `power`, `transport`, `neutral`) for the modifiers above; `base 0` families
  (cobblestone and stone, gravel, sand, the singularity, the antimatter pellet) are quota only.
- `data/consortium/consortium_shop/catalogue.json`: the shop catalogue of docs/SHOP_CATALOGUE.md section 3 (24 entries: three
  chunk loaders behind `consortium:phase_3`, claim chunks, home slots, the Board warp pass, the nickname right, the Warp
  Stone, the three vacancy licences behind `consortium:vacancy_<charter>`, three season fund packs, the event ticket,
  three titles, three IE shaders, the pennant; every price a PLACEHOLDER sized from PRICE_TABLE 6). It replaces
  `starter.json`: delete that file from every mirror of this folder (the srvdev harness, a synced server), because the
  first file in id order wins and would resurrect the placeholder prices. Entry fields: `name`, `description`, `item`
  or `command` (`{player}`, `{uuid}`, `{tx}`; the claim entry addresses the buyer by `{player}` because FTB Chunks'
  player argument refuses a UUID), `icon`, `price`, `daily_limit`, `stage`, `phase`. Never sell an item the price table
  buys: the mod refuses it at load and at purchase (the build script asserts the item entries are in no family).
- `data/consortium/chapters/stages/vacancy_extraction.json`, `vacancy_energy.json`, `vacancy_logistics.json`: empty `{}`
  markers for the sale stages (hand-written, like `phase_1.json`).
- `tools/pricing/shop-budget.mjs`: the sink budget of SHOP_CATALOGUE 2 from the simulation medians and the catalogue,
  and the realised spend per key from ledger files (`node tools/pricing/shop-budget.mjs [ledger folder]`).

## Ranks (`consortium_ranks.js`, docs/RANKS_AND_CONTRACTS.md 1, docs/BATCH_3_INTERFACES.md)

- **Metric**: `rank_credit` only, fed by the mod (delivery receipts, every multiplier included, plus Gap Contract units at
  50 % through `addRankCredit`); quest, event, shop and referral credits go through `ConsortiumCore.credit` and never count
  (rule 4.3). No command adds rank credit anywhere.
- **Tiers** `CONSORTIUM_RANK_THRESHOLDS = { operator: 25000, engineer: 250000, director: 750000, shareholder: 1500000 }` cents
  (PLACEHOLDER `[S]`, PRICE_TABLE 6) with `CONSORTIUM_RANK_ORDER` and `CONSORTIUM_RANK_NAMES`: the one table, read by
  `consortium_quests.js` (rank tasks; its fallback is dead), `consortium_contracts.js` (the Operator gate) and
  `consortium_onboarding.js` (the referral milestones), and handed to Consortium Core 0.4.0 as
  `{"track":"progression","tiers":[{"group":"operator","name":"Operator","credits":25000}, ...]}` through `publishRankTiers`
  at `ServerEvents.loaded` (when the runtime is ready) and from every 5-minute `Consortium.check` (the mod dedups and
  persists it in `consortium_ranks.dat`). The **promotion** is the mod's (`RankService`, one `Track.promote` per check,
  never a demotion, announced by `Notifier.announcement` on the announcements lane); the engine never announces a rank.
- **Perks are a login reconcile** (`Consortium.ranks.reconcile`, login + 60 ticks, `RankPromoteEvent` with a player, every
  5 minutes for online players): the held progression group (`ConsortiumCore.rankGroup`, else the tier by threshold) is
  compared with `ranks.<uuid>.tier`; each tier crossed refreshes the FTB Chunks allowance (`ftbchunks admin
  extra_claim_chunks <name> add 0`, the allowance is cached until a relog) and tells one line of `CONSORTIUM_RANK_PERKS`
  (PLACEHOLDER texts); at Engineer or above `loaderDue` is stamped and exactly one `chunkloaders:single_chunk_loader` is
  given once the team holds `consortium:phase_3` (`loaderAt`; before that the player is told once that it unlocks with
  phase 3). Nothing is ever taken back.
- **State**: `ranks.<uuid> { tier, loaderDue, loaderAt, loaderTold }`. Harness lever (RANKS 8): lower the thresholds in
  the srvdev copy only (`{ operator: 2000, engineer: 4000, director: 6000, shareholder: 8000 }`).

## Daily contracts (`consortium_contracts.js`, docs/RANKS_AND_CONTRACTS.md 2)

- **Pick**: once per season day (06:00 server time, `Consortium.seasonDay`, the same clock as the paycheck cap and the Gap
  counters; the mod's `[market] day_boundary_hour` is the same 06:00 and never changes alone, a boot check warns when it
  differs), three draws without replacement among the open quota lines of the phase (ratio < 1, priced, not quota-only,
  not a family of the previous list), weighted by the shortfall `1 - ratio`. Fewer candidates = fewer contracts, never a
  repeat (the summary says `yesterday's lines rest` or `every open line is on target`). The pick runs from the daily step
  (`consortiumContractsDaily`, right after the shop's duties) and lazily from every read whose stored day differs.
- **Sizing**: `premium_i = round(0.25 x baseCents_i)` per paid unit (`PriceView.baseCents`, the datapack base, never the
  degressive unit price) on the first `N_i = min(half_volume_i, floor(pot / premium_i))` paid units server-wide (N floored
  to a multiple of 8 from 32 up), `CONSORTIUM_CONTRACT_POT = { 1: 35, 2: 75, 3: 55, 4: 70, 5: 70 }` CC and
  `CONSORTIUM_CONTRACT_PREMIUM = 0.25` (PLACEHOLDER). A contract pays at most `N x premium <= pot` whatever the
  saturation, charter, newcomer or event factor; three contracts stay under 10 % of the design daily income (RANKS 2.2).
  Every player text says `+0.25 CC per unit`, the compact forms `+0.25 CC/unit`, never "+25 %".
- **Quote and consumption**: `consortium_money.js` adds `consortiumContractBonus` (a typeof-guarded wrapper over
  `Consortium.contracts.quoteBonus`: `floor(min(room, paidUnits) x premium)` for an Operator or above while a contract on
  the family is open) to its single multiplier as `m += bonus / cents` before the paycheck scale, read-only at quote time
  (the quote event repeats); the answer is stashed per `uuid|family` and the `DeliveryEvent` listener of the contracts
  script consumes the stashed units only when a bonus was priced (a delivery that crosses the Operator threshold at commit
  consumes nothing), closes a filled contract with `Contract filled: Iron +0.25 CC per unit (136 units), last units by
  <name>.` (`consortiumSay`) and republishes the board. The mod's 5 % quote tolerance turns a lost race into "Prices
  moved, please check again" (first come, first served). The premium counts toward `rank_credit` like a charter bonus and is
  invisible to the mod's weekly report by type: `paidCents`, `seasonCents` and `history` are the engine's journal.
- **Display**: the daily summary is followed by `Daily contracts until 06:00: Iron +0.25 CC per unit on the first 136
  units, Coal ... (Operator rank and above, /consortium contracts).` (say relay); the board gets one line per contract
  (`contract_<family>`, label `Contract: Iron +0.25 CC/unit`, current = taken, target = N) next to `season_fund` and the
  payload field `contracts` (`Iron +0.25 CC/unit 40/136, ...`, at most 140 characters, the `{contracts}` tab token of
  Consortium Core 0.4.0 and the digest's `Contracts today:` line, empty without a contract).
- **State**: `contracts { day, reason, previous, list [{ family, line, label, icon, premiumCents, units, filled, paidCents,
  closedAt, closedBy, setBy }], seasonCents, history.<season day> { count, filled, paidCents } }`. `ReportEvent` (0.4.0)
  gains `Contracts (7 d): F of C filled, X CC of premiums`.

## Onboarding (`consortium_onboarding.js`, docs/RANKS_AND_CONTRACTS.md 3)

- **Starter kit**: at login + 40 ticks a `GRANTED` account (starting capital paid, the same-connection check passed) with
  no `kitAt` stamp receives `CONSORTIUM_STARTER_KIT` (PLACEHOLDER: a named stone pickaxe, a stone axe and shovel, 16 bread,
  32 torches, a white bed) plus the Consortium Rulebook (`consortiumRulebookStack()`, typeof-guarded) and one chat line;
  `DENIED` alts get nothing, `NONE` retries at the next login. `/consortium kit` re-claims the items once (no second book:
  `/rules book`), `/consortium kit reset <player>` clears both stamps. No kit item has a price. FTB Essentials kits stay
  off (world data, autogrant ignores the identity check).
- **Referral**: `/consortium referral <name>` inside the caller's first 7 days, guards in order: the window, the launch
  cohort (`The launch crew was recruited by the Board itself.`), the grant state, one record per newcomer, the recruiter
  (must have joined, not the caller, not the caller's own recruit, launch crew or 7 days older than the caller), then
  `ConsortiumCore.sameConnection`: `SAME` refused and reported on the staff lane, `UNKNOWN` (or a 0.3.x jar) recorded
  `pending` for `/consortium referral approve`, `DIFFERENT` `active`. Payouts by `Consortium.referrals.poll` (every 5
  minutes and after each delivery of the newcomer): stage 1 at the Operator threshold (100 CC PLACEHOLDER,
  `referral:stage1:<uuid>`, at most `weeklyCap = 2` stage-1 payments per recruiter per season week, beyond it
  `stage1Skipped`), stage 2 at Engineer (250 CC, `referral:stage2:<uuid>`, uncapped); `ConsortiumCore.credit` only
  (never rank credit), stamped on `SUCCESS` only, `ConsortiumQuests.count(recruiter, 'referral', 1)` advances Recruiter and
  Talent Scout, one `say` line per payout. `CONSORTIUM_REFERRAL = { windowDays: 7, stage1PayCents: 10000, stage2PayCents:
  25000, weeklyCap: 2 }` (PLACEHOLDER; harness lever `weeklyCap = 1`).
- **First credit**: the mod owns the canonical stopwatch from 0.4.0 (`firstCreditAt`, `firstCreditPlayMinutes`, the weekly
  report's `Newcomers (7 d)` line); the engine keeps its own copy in `onboarding.<uuid>` (`playMs` before the first
  credit, `firstCreditAt`, `firstCreditPlayMinutes`, `firstCreditWallMinutes`) and logs `[Consortium] first credit: <name>
  after N min of play` once, so the figure exists on a 0.3.1 jar too.
- **State**: `onboarding.<uuid> { kitAt, reclaimAt, playMs, firstCreditAt, firstCreditPlayMinutes, firstCreditWallMinutes }`,
  `referrals.<newcomer uuid> { referrer, referrerName, newcomerName, at, status, stage1PaidAt, stage2PaidAt,
  stage1Skipped }`, `referrals_week.<referrer uuid>.<season week>`. `ReportEvent` (0.4.0) gains `Referrals (7 d): R
  recorded, P stage payments, X CC`.

## Calendar and reminders (`consortium_calendar.js`, docs/DISCORD_AND_COMMUNITY.md 6)

- **Source**: `data/consortium/consortium_calendar/season1.json` (`role_mention`, weekly `slots` by weekday, pre-planned
  `dates`; the two dates shipped are PLACEHOLDER examples) plus staff-set dates in `consortium.events.calendar.dates`
  (state wins over the file, so a weekly Saturday programme survives the packwiz re-sync). Every slot is at 20:00 server
  time (`CONSORTIUM_SLOT_HOUR`). Reward tokens `{kill} {max} {bounty} {share}` are filled from the events engine's own
  constants for the current phase (without them the Rewards sentence is dropped).
- **Reminders** (its own 5 s step): the 24 h line at slot minus 24 h and the 1 h line at slot minus 1 h, posted once
  inside a 30-minute window (PLACEHOLDER) and stamped `reminded24` / `reminded1h` = `<date>:<kind>`; an instant first seen
  past its window is stamped `missed:<date>:<kind>` and logged. Texts per DISCORD 6: the Discord line (`**Tomorrow at 20:00
  server time** (<t:...:R>): **Boss Hunt** at the HQ arena. Rewards: ... Ticket: none. Be at HQ five minutes early.`)
  goes through `ConsortiumCore.discordAnnounce` (logged without the 0.4.0 API), the game line through the say relay; the 1 h
  line is Discord-only for Friday and Saturday (the queued event says `starts in 60 minutes` in game) and both for
  Wednesday (`In one hour (20:00 server time): new weekly contract in the quest book and /consortium contract.`). A
  cancelled date posts `**Saturday 10/10, 20:00**: no event this week (reason). Next slot: ...` at minus 24 h; a Saturday
  without a programme posts `No Saturday programme set for <date> (/consortium calendar set).` to the staff lane only.
- **Auto-queue**: at the first step after the engine's daily step (`lastDailyDay === day`, once per date) today's Friday or
  Saturday event is queued at 20:00 through `ConsortiumEvents.queue` (refuses a past instant or an existing queue: a staff
  queue is never overwritten); the phase 1 Friday falls back to the slot's `phase1_event` (`invasion`) with the `phase1_*`
  texts when `consortiumEventEligibility` answers a phase reason; an ineligible or cancelled day is reported on the staff
  lane; a daily step after 20:00 skips with one log line.
- **Wednesday guard**: Wednesday 19:00, once per season week, `ConsortiumQuests.contract.current` (now with `paidCount`)
  absent, ending before 21:00 tonight or set more than 6 days ago posts `No weekly contract set for tonight (/consortium
  contract set).` to the staff lane.
- **State**: `events.calendar { reminded24, reminded1h, queuedDate, wednesdayGuardWeek, dates.<date> { event, args, title,
  cancelled, reason } }`; `events.queued` is written by `ConsortiumEvents.queue` and the events block only.

## Discord digest (`consortium_discord.js`, docs/DISCORD_AND_COMMUNITY.md 5)

One post per season day, one 5 s step after the engine's daily summary (stamp `discord.digestDay`): the day line, the
quota lines (12 at most), `Contracts today: <Consortium.contracts.text> (Operator and above)`, `Event:` from
`ConsortiumEvents.boardObject`, `Top 3 by credits earned:` from `ConsortiumCore.leaderboardText(3)` (0.4.0), `Next slot:`
from `ConsortiumEvents.calendar.next` with a `<t:...:R>` token (the lib's `consortiumNextSlot` as the fallback) and the
season fund line; under 1,900 characters, posted through `ConsortiumCore.discordAnnounce` (logged without the API).
`/consortium discord digest` prints and posts it on demand.

## Rulebook (`consortium_rules.js`, docs/DISCORD_AND_COMMUNITY.md 7)

One source, `data/consortium/consortium_rules/rulebook.json` (the words belong to the docs-and-server implementer;
`tools/rulebook-md.mjs` renders `server/docs/RULEBOOK.md` and checks the book budget from the same file). `/rules` prints
the clickable index (plus `Discord: [join the server]` where SDLink runs), `/rules <section>` a section with `[index]` and
`[next: ...]` links, `/rules book` a fresh written book once per player per day (`rules.book.<uuid>`, refusal `You already
got a copy today; /rules shows it in chat at any time.`). The book follows the page model of `tools/rulebook-md.mjs`
(greedy wrap at 18 characters, 14 lines per page, 12 under a section title, a cover with `change_page` links; the wrap is
PLACEHOLDER until the owner reads every page in game). The starter kit gives `consortiumRulebookStack()` once at the first
login; this script has no login handler of its own.

## Nether fence (`consortium_border.js`, docs/DISCORD_AND_COMMUNITY.md 10)

Vanilla has one world border shared by every dimension, so the Nether radius is a KubeJS fence (beta-gated, ChunkyBorder
is the tested alternative): every 20 ticks a Nether player farther than `overworld border size / 16` from `centre / 8` is
teleported back to their last in-bounds position (or the overworld spawn when none is recorded, never a clamped point)
with an action bar line at most once per 10 s. Inactive while the overworld border keeps its default size.

## Not coming

- `phase_guards.js`: the placement guard, the instant inventory audit and the party-creation stage copy live in the
  Consortium Core mod (v0.2, DECISIONS.md 2026-09-16).

After editing anything here run `packwiz refresh` in the pack root and commit; players and the
server pick the change up on their next launch or restart.
