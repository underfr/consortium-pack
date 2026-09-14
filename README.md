# Consortium Pack

packwiz manifest for **The Consortium** private NeoForge 1.21.1 server. Consumed by the
[Consortium Launcher](https://github.com/underfr/consortium-launcher); can also be imported into
any packwiz-compatible launcher.

> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

This repository contains only mod metadata (`*.pw.toml` files pointing at each mod author's
official distribution on Modrinth or the FTB Maven), our own configuration files and scripts,
and `launcher.json` (server address, message of the day, news, minimum launcher version). It
contains no Mojang code or assets and no altered vanilla files. Nothing is re-hosted.

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
Install pinned dependencies before the mods that depend on them (Rhino before KubeJS).

Sides are set by hand for mods whose Modrinth metadata is incomplete: server-only mods carry
`side = "server"` (LuckPerms, In Control, Chunky, LootJS, CraterLib, Alternate Current, Almanac,
Let Me Despawn, Simple Backups) and client-only ones `side = "client"` (Sodium, Iris, Entity Culling,
ImmediatelyFast, BadOptimizations, Mouse Tweaks, Controlling, Searchables, Xaero's maps).
