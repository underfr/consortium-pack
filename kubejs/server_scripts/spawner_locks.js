// The Consortium - spawner locks (PROJECT_RULES 4.1, PROGRESSION.md section 15).
//
// No relocatable mob spawners: Apothic Spawners was removed for this, and a vanilla spawner
// moved next to a base is a mob farm. Mekanism's cardboard box refuses blocks tagged
// #mekanism:cardboard_blacklist; the shipped tag (Mekanism 10.7.19.85) only lists the trial
// spawner and the vault (plus #c:relocation_not_supported, beds and doors), so the vanilla
// spawner is added here. Kept even though the box itself is staff-only (staff.json).
// Contraptions are covered by config/create-server.toml (movableSpawners = "UNMOVABLE").

ServerEvents.tags('block', (event) => {
  event.add('mekanism:cardboard_blacklist', 'minecraft:spawner')
})
