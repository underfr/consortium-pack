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
