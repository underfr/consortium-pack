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

Each script folder currently holds a single `00_placeholder.js` that contains comments only, so the
layout exists in the pack and KubeJS has nothing to run. Replace the placeholders as scripts land.

## Conventions

- English everywhere (comments, chat messages, item names). No em dashes.
- One file per concern, prefixed with a two-digit load order: `10_economy_locks.js`, `20_ranks.js`.
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

## Planned scripts (not written yet, see docs/CONFIG_DECISIONS.md in the server repo)

- `server_scripts/10_economy_locks.js`: remove the Apothic Spawners modifier recipes
  (`type: apothic_spawners:spawner_modifier`), the Chunk Loaders crafting recipes (loaders are
  shop-only), the Mekanism `upgrade/anchor` and `dimensional_stabilizer` recipes (dead items once
  `allowChunkloading = false`), the Immersive Engineering `crafting/resonanz_engineering` recipe
  (Resonanz Observer chunk loader) and the Waystones anywhere-teleport items.
- `server_scripts/20_ranks.js`: LuckPerms track promotion and server-wide announcement (rule 4.3).
- `data/consortium/chapters/stages/phase*.json`: Chapters stage definitions per phase (rule 4.4).

After editing anything here run `packwiz refresh` in the pack root and commit; players and the
server pick the change up on their next launch or restart.
