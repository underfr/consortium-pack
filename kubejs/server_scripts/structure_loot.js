// priority: 30
// The Consortium - structure loot policy (PROJECT_RULES 4.1 and 4.6, PROGRESSION.md sections 3 and 11).
//
// Scope: minecraft:chests/* (structure chests and trial vaults), minecraft:gameplay/fishing (Apotheosis
// affix conversion of fished gear, review 2026-09-17) and the structure namespaces of the
// pack (Terralith, Structory, YUNG's Better Strongholds, Mineshafts and Nether Fortresses).
// consortium:* and every KubeJS or Consortium Core event table stay outside on purpose: Friday-zone
// reward chests are where affix loot belongs (rule 4.6), and a type-wide LootType.CHEST filter would
// have stripped exactly those rewards.
//
// Nothing of @minecraft is removed (PROGRESSION 3: netherite, enchanting, elytra, the mace, totems and
// enchanted golden apples are free forever). Priced families (iron, gold, diamond, ...) stay in chests:
// structure loot is finite (one roll per chest, one vault reward per player, one guaranteed diamond
// per Terralith mage tower) and the degressive prices plus the daily credit cap of PROGRESSION 11
// bound the cash-out. Elytra is not on any list because no loot table places it: it sits in an item
// frame of the End ship NBT, outside every loot pass. Decision document: docs/WORLD_VISUALS_ADMIN_PRESENCE.md
// section 2, and the DECISIONS.md row of 2026-09-17 (world generation).
//
// What is removed, and why (auditable list):
//   apotheosis:affix_loot_injection   global loot modifier, matched every table whose path starts with
//                                     "chests" (35 % minecraft, 30 % any namespace). Removed so that
//                                     opening chests is not the main affix gear source; affix gear stays
//                                     a combat reward (affix_conversion on entity tables, bosses, Friday
//                                     zones). Rule 4.6, design choice. Revert: delete the line.
//   apotheosis:gem_loot_injection     global loot modifier, same tables (25 % / 20 %). Removed for the
//                                     same reason; gems keep their mob-drop source (gem_entity_drops),
//                                     so PROGRESSION 3 (gems free forever) holds. Revert: delete the line.
//   items with apotheosis:affixes     roll-time strip on the policy tables only: affix_conversion still
//                                     runs at 35 % on every table, so gear rolled by a chest table can
//                                     come out affixed. The plain piece is lost with it (accepted: a few
//                                     enchanted iron pieces per End city).
//   apotheosis:gem                    roll-time strip on the policy tables only, same reason as above
//                                     (a gem placed by a mod's own chest table, not by the injection).
//
// API checked against lootjs-neoforge-1.21.1-3.7.0 (javap): LootModificationEvent.removeGlobalModifiers
// (IdFilter...), addTableModifier(LootTableFilter...: string or regex), LootActionContainer.removeLoot
// (ItemFilter), ItemFilter.anyOf / hasComponent, string item ids wrapped by KubeJS.
// KubeJS 2101.7.2 ItemStack has no hasTag: tags go through LootJS string filters ('#c:...'), never a
// custom predicate. The modifiers event runs after the NeoForge global loot modifier hook, so it sees
// what affix_conversion produced (verified by source reading; the harness loot spawns are the proof).
// LootJS is server-only in the pack: the Platform guard keeps singleplayer scripts silent.

const CONSORTIUM_STRUCTURE_TABLES = [
  /^minecraft:chests\//,
  /^(terralith|structory|betterstrongholds|bettermineshafts|betterfortresses):/,
  // Fishing: apotheosis:affix_conversion turns fished gear into affix gear (review 2026-09-17); affix gear
  // stays a combat reward, so the same roll-time strip applies to the vanilla fishing tables.
  /^minecraft:gameplay\/fishing/
]

if (Platform.isLoaded('lootjs')) {
  LootJS.modifiers((event) => {
    // Both injections only ever matched "chests.*" paths, so the removal changes structure chests
    // and trial vaults and nothing else.
    event.removeGlobalModifiers('apotheosis:affix_loot_injection', 'apotheosis:gem_loot_injection')

    event
      .addTableModifier(CONSORTIUM_STRUCTURE_TABLES[0], CONSORTIUM_STRUCTURE_TABLES[1], CONSORTIUM_STRUCTURE_TABLES[2])
      .removeLoot(ItemFilter.anyOf(ItemFilter.hasComponent('apotheosis:affixes'), 'apotheosis:gem'))
  })
}

// Harness check (console): 30 x `loot spawn 0 120 0 loot betterstrongholds:chests/grand_library`,
// 30 x `loot spawn 0 120 0 loot minecraft:chests/end_city_treasure`, 30 x `minecraft:chests/trial_chambers/reward`,
// then `execute if entity @e[type=item,nbt={Item:{id:"apotheosis:gem"}}]` and
// `execute if entity @e[type=item,nbt={Item:{components:{"apotheosis:affixes":{}}}}]` must print no match,
// while `@e[type=item,nbt={Item:{id:"minecraft:diamond"}}]` (end city) and
// `@e[type=item,nbt={Item:{id:"minecraft:enchanted_book"}}]` (vault) must match at least once.
