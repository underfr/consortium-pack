# Consortium Pack

packwiz manifest for **The Consortium** private NeoForge 1.21.1 server. Consumed by the
[Consortium Launcher](https://github.com/underfr/consortium-launcher); can also be imported into
any packwiz-compatible launcher.

> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

This repository contains only mod metadata (`*.pw.toml` files pointing at each mod author's
official distribution on Modrinth or the FTB Maven), our own configuration files and scripts,
and `launcher.json` (server address, message of the day, news, minimum launcher version). It
contains no Mojang code or assets and no altered vanilla files. Nothing is re-hosted.

## What is in the pack (0.11.0)

163 metafiles: 154 mods that every player receives or that only the server runs, plus 9 optional
client-side entries (see below). Content batch 5 (2026-09-21) added 69 mods: Silent Gear, the Productive
Metalworks foundry, Create addons (Crafts & Additions, Enchantment Industry, Slice & Dice, Connected, Copycats+,
Deco, Bells & Whistles, Jetpack, Ultimine, Stock Bridge), AE2 addons (Extended AE, MEGA Cells, wireless terminals,
ME Requester, Import Export Card), Mekanism Additions, More Mekanism Processing, Mekanism Curios and Ponders, Immersive
Petroleum, Iron Furnaces, Ender Storage, Dark Utilities, Lootr, FTB Ultimine, Leaves Be Gone, ElevatorMod, Chisel
Reborn, FramedBlocks, Crystalix, Handcrafted, the twelve Macaw's mods, the eight remaining YUNG's mods, Polymorph,
Crafting Tweaks, Inventory Essentials, TrashSlot, Cosmetic Armor Reworked Forked and Ok Zoomer. The full list with versions, sides and reasons is in the main
repository's `docs/MODLIST.md`.

World generation (fresh world for Season 1): Terralith, Tectonic and Lithostitched (overworld),
Amplified Nether, Nullscape (End), YUNG's Better Mineshafts, Better Strongholds and Better Nether
Fortresses on YUNG's API, and Structory. Server-only admin tools: GriefLogger, Vanishmod, WorldEdit
with WorldEdit Hang Fix, FTB Essentials (moderation commands and `/spawn`; every other teleport, kit,
virtual workstation, `/enderchest` and `/nick` is disabled in the server config).

Sourcing: every mod comes from the Modrinth CDN or the FTB Maven except Productive Metalworks, fetched
from its author's CurseForge file link (no API key). Client RAM: 6 GB recommended since 0.11.0; the
8 GB preset (3 GB heap) still boots.

## Optional mods (player toggle in the launcher)

Only client-side entries can be optional (`[option]` block in the metafile). The launcher shows a
checkbox per entry; a change applies at the next Play.

| Entry | Default | What it does |
|---|---|---|
| `mods/iris.pw.toml` Iris Shaders 1.8.14-beta.1 | off | Shader support. Forced off by the low RAM preset. |
| `shaderpacks/complementary-reimagined.pw.toml` Complementary Shaders - Reimagined r5.9.3 | off | Full-quality shader pack (profiles Potato to Complementary). Needs Iris. |
| `shaderpacks/makeup-ultra-fast-shaders.pw.toml` MakeUp - Ultra Fast 9.5e | off | Light shader pack (shadowless profiles for weak GPUs). Needs Iris. |
| `mods/3dskinlayers.pw.toml` 3D Skin Layers 1.11.2 | on | 3D skin layers on players. |
| `mods/not-enough-animations.pw.toml` Not Enough Animations 1.12.4 | on | Third-person animations (maps, eating, ladders). |
| `mods/wavey-capes.pw.toml` Wavey Capes 1.11.1 | on | Cape physics. |
| `mods/chat-heads.pw.toml` Chat Heads 0.15.7 | on | Player head next to chat lines (rendering only, chat signing untouched). |
| `mods/visuality-forge.pw.toml` Visuality: Reforged 3.0.0 | on | Hit, slime and ore sparkle particles. |
| `mods/fallingleavesforge.pw.toml` Falling Leaves 2.5.1 | on | Leaf particles. |

### Shaders

- `config/iris.properties` ships with `enableShaders=false` and no pack selected. Turn Iris on in
  the launcher, then pick the pack in Options > Video Settings > Shader Packs. The file is marked
  `preserve = true` in `index.toml`: the launcher never overwrites it once present, so the selection
  survives every pack update.
- When a shader pack is bumped (for example r5.9.3 to r5.9.4), the old zip is removed from
  `shaderpacks/` and the new one downloaded. Iris then logs "no valid shaderpack is selected":
  reselect the pack once in the Shader Packs screen.
- Other shader packs (BSL, Solas, Bliss and the rest) are not in the pack because their licences
  give no modpack redistribution grant. Any player can drop such a zip into
  `<instance>/shaderpacks/` by hand; the launcher never touches files it did not install.

## Credits and licences

- **Terralith, Amplified Nether, Nullscape and Structory** by [Stardust Labs](https://www.stardustlabs.net/):
  [Terralith](https://modrinth.com/mod/terralith), [Amplified Nether](https://modrinth.com/mod/amplified-nether),
  [Nullscape](https://modrinth.com/mod/nullscape), [Structory](https://modrinth.com/mod/structory).
  Shipped unmodified through the Modrinth CDN under the Stardust Labs licence (credit and links required;
  loot table changes are explicitly allowed by that licence).
- **Complementary Shaders - Reimagined** by EminGT: [Modrinth page](https://modrinth.com/shader/complementary-reimagined).
  Shipped unmodified through the Modrinth CDN under the Complementary License Agreement 1.7.
- **MakeUp - Ultra Fast** by KDXavier: [Modrinth page](https://modrinth.com/shader/makeup-ultra-fast-shaders), LGPL-3.0-or-later.
- **3D Skin Layers, Not Enough Animations and Wavey Capes** by tr7zw (tr7zw Protective License): fetched from the
  Modrinth CDN, never re-hosted. No paid feature of this server depends on them.
- Every other mod is fetched from its author's official Modrinth or FTB Maven distribution; see `docs/MODLIST.md`
  in the main repository for versions and licences.

## Editing the pack (admins)

```
packwiz modrinth install <slug>     # add a mod from Modrinth
packwiz update --all                # bump every mod to its latest compatible version
packwiz refresh                     # rebuild index.toml hashes after editing config/ or kubejs/
git commit -am "..." && git push    # players receive the change on their next launch
```

`.gitattributes` forces `* -text` so line endings never change file hashes on Windows.
`.nojekyll` keeps GitHub Pages from dropping files whose names start with `_` or `.`.

Owner and contact: underfr, contact.consortiummc@gmail.com.

## Pinning a specific version

`--version-filename` is ignored by the packwiz build we use. To pin a version that is not the
newest, pass the Modrinth project id and version id explicitly:

```
packwiz modrinth install --project-id <project id> --version-id <version id> -y
```

Both ids come from `https://api.modrinth.com/v2/project/<slug>/version?loaders=["neoforge"]&game_versions=["1.21.1"]`.
Install pinned dependencies before the mods that depend on them (Rhino before KubeJS, Lithostitched
before Terralith and Tectonic, YUNG's API before the YUNG's structure mods).

Sides are set by hand for mods whose Modrinth metadata is incomplete: server-only mods carry
`side = "server"` (LuckPerms, In Control, Chunky, LootJS, CraterLib, Alternate Current, Almanac,
Let Me Despawn, Simple Backups, GriefLogger, Vanishmod, WorldEdit, WorldEdit Hang Fix, FTB Essentials)
and client-only ones `side = "client"` (Sodium, Iris, Entity Culling, ImmediatelyFast, BadOptimizations,
Mouse Tweaks, Controlling, Searchables, Xaero's maps, the six cosmetic mods and both shader packs).

Shader packs: `packwiz modrinth add` puts them in `shaderpacks/` but writes `side = "both"` (Modrinth
reports the environment as unknown); set `side = "client"` and add the `[option]` block by hand.
Re-adding an existing optional mod (an Iris bump) rewrites its metafile and drops the `[option]` block:
restore it. Only client-side entries may be optional (docs/MODLIST.md section 2).

Files the mods regenerate with comments (`config/tectonic.json`, the server overlay's FTB Essentials
and Vanishmod files) are shipped as generated on a fresh boot, with the changed values edited in place:
never hand-write them from scratch.
