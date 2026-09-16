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
| `data/` | acts as a datapack on the server | Chapters stage definitions (`data/consortium/chapters/stages/*.json`), custom tags |
| `assets/` | acts as a resource pack on the client | lang files, textures for custom items |

`startup_scripts/` and `client_scripts/` still hold a comments-only `00_placeholder.js` that keeps the
folder in the pack. `server_scripts/` holds the economy locks (`economy_locks.js`: chunk loader, IE brass
and Ad Astra ice recipe removals), the spawner lock (`spawner_locks.js`: `minecraft:spawner` added to
`#mekanism:cardboard_blacklist`) and the progression engine described below.

## Conventions

- English everywhere (comments, chat messages, item names). No em dashes.
- One file per concern. Load order comes from a `// priority: N` first line (higher loads first; the
  engine uses 100 for helpers, 90 for data, 60 for charters, 50 for logic, 0 for commands); all server scripts share one
  scope, so top-level names must be unique across files (prefix them, e.g. `consortium...`).
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
| `server_scripts/consortium_charters.js` (priority 60) | Charter records per player UUID, the staff list, and the team reconciliation (`consortiumApplyTeam`): what every team should hold (phases, its owner's charter stages, or everything for an all-staff team) versus what it holds, grants and strips |
| `server_scripts/consortium_lib.js` (priority 100) | Shared helpers: number formatting, the next event slot, announcements (`tellraw @a` plus `say`, the two commands Simple Discord Link relays; `server.tell()` is never relayed), FTB Teams access and the safe stage writers |
| `server_scripts/consortium_quotas.js` (priority 90) | The `CONSORTIUM_PHASES` table: phase names, stage ids, quest chapter ids, headline text and the delivery quotas (`Q = D x 10 x r x 0.7`). The economy step edits the amounts here |
| `server_scripts/consortium_phases.js` (priority 50) | The engine: persistent state, deliveries, milestones, phase completion, the sweeps, boss bar, daily summary, stall rule, login welcome |
| `server_scripts/consortium_commands.js` (priority 0) | The `/consortium` commands |

How it works:

- **State** lives in `server.persistentData` under `consortium` (saved with the world in
  `<world>/kubejs_persistent_data.nbt`): `currentPhase`, `startedAt` (season start, normalised to the
  06:00 at or before the real start so season days roll over at 06:00 server time), `lastDailyDay`,
  `charters.<uuid>` (`charter`, `chosenAt`, `switchedAt`, `switches`, `name`), `staff.<uuid>` (name), and per phase `startedAt`,
  `completedAt`, `lastProgressAt`, `stalled`, `stalledAt`, `milestone`, `history.<season day>` (`C x 1000`
  at that day's snapshot) and `progress.<line>`. Dump it with `/kubejs persistent-data server get consortium`.
- **Deliveries**: the Consortium Core mod runs `/consortium contribute <item> <count>` as the console once per
  delivered item id right after each terminal delivery is committed (its `contribute_command` server config; the
  mod's own KubeJS binding is `ConsortiumCore`, so this script-level `Consortium` object is untouched). Scripts can
  also call `Consortium.contribute(player, itemId, count)` directly (or
  `Consortium.record(server, name, itemId, count)` without a player). Only items of the current phase
  quota count (family lines such as `#c:ingots/steel` list every accepted id in `items`); the return
  value is the number of units accepted, 0 when the item is not in the quota. At 25, 50, 75 and 90 % of
  the phase average (`CONSORTIUM_MILESTONES`) the engine announces the progress and the missing amounts.
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
- **Boss bar** `consortium:phase`: "Phase N: <name> - <percent>%", max 100, created on server start and
  only re-sent when its text changes. Players are added to it on login.
- **Daily step** (section 11): at the first check after 06:00 server time each day (season days roll
  over at 06:00 because `startedAt` is normalised to it, whatever the hour the state was created or
  wiped), the engine
  snapshots the phase average `C`, posts the summary (`say`, so it reaches Discord without the
  experimental tellraw relay: day, phase, `C`, every line's percent) and evaluates the stall rule: flagged
  when `C` gained less than 5 points over the newest snapshot at least 5 days old while `C < 1` and the
  phase is 5 days old; cleared when the gain is 5 points again. One notice per stall and one when it
  clears, never daily. The Gap Contract purchase itself is later work; the terminal script can set
  `Consortium.onCatchUp = (server, phaseNumber) => ...` and the notice then names the Board's offer.
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

Simple Discord Link: with `broadcastCommands = true` every command the engine runs (`bossbar`, `title`,
`playsound`) is posted to the Discord events channel as "Server executed command"; the server overlay's
`simple-discord-link.toml.example` lists them (plus `ftbquests` and `consortium`) in `ignoredCommands`.
`say` and `tellraw @a` return before that check and are relayed as chat instead.

## Planned scripts (not written yet)

- `server_scripts/20_ranks.js`: LuckPerms track promotion and server-wide announcement (rule 4.3).
- Delivery terminal, credits and the Gap Contract (rule 4.2, PROGRESSION.md section 11).
- `server_scripts/phase_guards.js`: the placement guard and the instant inventory audit (PROGRESSION.md
  section 2, guards 1 and 2; deferred, DECISIONS.md 2026-09-16).

After editing anything here run `packwiz refresh` in the pack root and commit; players and the
server pick the change up on their next launch or restart.
