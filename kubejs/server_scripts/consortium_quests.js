// priority: 30
// The Consortium - FTB Quests bridge (docs/QUESTS.md section 5, docs/CONTENT_BATCH_2_INTERFACES.md).
// Needs consortium_lib.js, consortium_charters.js, consortium_phases.js and consortium_money.js (all loaded
// before this file) plus the FTB XMod Compat KubeJS events (FTBQuestsEvents) and the Consortium Core binding
// (ConsortiumCore). Every part is typeof-guarded: without the mod or the events the script only exposes
// the ConsortiumQuests object.
//
// What it does:
//   custom tasks   polled every CONSORTIUM_QUEST_POLL_TICKS for online players whose quest is startable:
//                  delivery runs (units delivered by the player on a price family), staff and engine flags,
//                  week-keyed event stamps, the weekly contract, counters, rank thresholds, the first
//                  paycheck, the charter record and the Founder cohort (CONSORTIUM_QUEST_TASKS)
//   custom rewards re-validated against the CLAIMER's own record (QUESTS 5.4) before anything is paid:
//                  credits through ConsortiumCore.credit (ledger API_CREDIT, never rank credit), XP,
//                  cosmetics (renamed vanilla items with consortium_cosmetic custom data) and company titles
//                  through the engine's title registry Consortium.titles (CONSORTIUM_QUEST_REWARDS)
//   listeners      DeliveryEvent (per-player delivered units, contract buckets, market:charter_bonus and
//                  event:market flags), BalanceChangeEvent (event:bounty and event:invasion from the ledger
//                  reason), a 40 tick poll (event:blood_moon while the events engine runs a blood moon)
//   ConsortiumQuests  flag / unflag / count for the other engine scripts and the /consortium quest and
//                  /consortium contract subtrees (registered in the economy block of consortium_commands.js)
//
// State (server.persistentData consortium.quests, saved with the world; Interfaces section 4):
//   delivered.<uuid>.<family> (double), delivered_since.<contract id>.<uuid>.<family> (double),
//   flags.<uuid>.<key> (boolean; landing:<planet> = the once-per-player stamp of a paid landing reward),
//   counts.<uuid>.<key> (int), weekly.<uuid>.<key> (int season week),
//   weekly_paid.<uuid>.<key> (int), contract { id, family, units, setAt, endsAt }, contract_paid.<uuid> (int),
//   contract_seen.<team uuid> (int), titles_pending.<uuid>.<key> (string, only when the title registry is absent)
//
// The custom task checks are attached to the task objects when the quest file loads (server start and
// "/ftbquests reload quests" from an op in game): after editing this file, run "/reload" AND then reload the
// quests, a plain /reload leaves the old closures in place.
//
// Every credit amount below is a PLACEHOLDER (cents) until PRICE_TABLE.md is final; the hex keys are the
// task and reward ids of config/ftbquests/quests/chapters/*.snbt (tools/ftbq_check.mjs cross-checks both ways).
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_QUEST_POLL_TICKS = 40
const CONSORTIUM_QUEST_FOUNDER_DAYS = 2 // Founder: first login on season day 1 or 2
const CONSORTIUM_QUEST_CONTRACT_DAYS = 7 // default contract length
const CONSORTIUM_QUEST_CONTRACT_QUEST = '5C07000000000020' // Weekly Contract quest (reset for every team on a new contract)
const CONSORTIUM_QUEST_WEEKLY_KEYS = ['event:friday', 'event:saturday'] // week-keyed stamps (QUESTS 5.3)
const CONSORTIUM_MARKET_EVENT_IDS = ['ore_rush', 'power_surge', 'logistics_week', 'market_crash', 'double_quota']
const CONSORTIUM_QUEST_REFUSAL = 'This assignment is credited to the crew member who did it.'
const CONSORTIUM_QUEST_REFUSAL_ONCE = 'This assignment was already paid to you.'
// PLACEHOLDER (cents, PRICE_TABLE 6) used only until the ranks step lands CONSORTIUM_RANK_THRESHOLDS.
const CONSORTIUM_QUEST_RANK_FALLBACK = { operator: 25000, engineer: 250000, director: 750000, shareholder: 1500000 }

// Cosmetics (QUESTS 4.10): vanilla items outside every price family, renamed, glint on, custom data keyed.
const CONSORTIUM_QUEST_COSMETICS = {
  founder_lantern: { item: 'minecraft:lantern', name: "Founder's Lantern", lore: 'Present at the Groundbreaking, Season 1' },
  beacon_shard: { item: 'minecraft:glass_pane', name: 'Beacon Shard', lore: 'Survived the Stress Test, Season 1' },
  refinery_badge: { item: 'minecraft:flower_pot', name: 'Refinery Badge', lore: 'Held the Refinery, Season 1' },
  launch_patch: { item: 'minecraft:paper', name: 'Launch Patch', lore: 'Lifted off with the First Launch, Season 1' },
  station_key: { item: 'minecraft:tripwire_hook', name: 'Station Key', lore: 'Aboard at the inauguration, Season 1' },
  fusion_pin: { item: 'minecraft:lever', name: 'Fusion Pin', lore: 'Season project: the Fusion Core, Season 1' },
  gate_token: { item: 'minecraft:item_frame', name: 'Gate Token', lore: 'Season project: the Frontier Gate, Season 1' },
  reserve_seal: { item: 'minecraft:paper', name: 'Reserve Seal', lore: 'Season project: the Antimatter Reserve, Season 1' },
  salvage_tag: { item: 'minecraft:string', name: 'Salvage Tag', lore: 'Salvage crew, Season 1' },
  share_certificate: { item: 'minecraft:paper', name: 'Share Certificate', lore: 'Shareholder, Season 1' },
  season_share: { item: 'minecraft:paper', name: 'Season 1 Share', lore: 'Season 1 closed' },
}

// Custom tasks, keyed by task id. kind: run { family, units } | flag { key } | weekly { key } | contract |
// count { key, n } | rank { rank } | paycheck | charter | founder. Generated with the chapter files.
const CONSORTIUM_QUEST_TASKS = {
  '5C00000000000041': { kind: 'run', family: 'minecraft:cobblestone', units: 16 }, // First Load
  '5C00000000000051': { kind: 'paycheck' }, // First Paycheck
  '5C00000000000061': { kind: 'charter' }, // Choose Your Charter
  '5C01000000000031': { kind: 'run', family: 'minecraft:iron_ingot', units: 64 }, // Iron Run
  '5C01000000000041': { kind: 'run', family: 'minecraft:coal', units: 128 }, // Coal Line
  '5C01000000000051': { kind: 'run', family: 'create:andesite_alloy', units: 64 }, // Alloy Order
  '5C01000000000061': { kind: 'run', family: 'consortium:cooked_meals', units: 32 }, // Kitchen Duty
  '5C010000000000F1': { kind: 'flag', key: 'moment:groundbreaking' }, // The Groundbreaking
  '5C02000000000031': { kind: 'run', family: 'c:ingots/steel', units: 64 }, // Steel Run
  '5C02000000000041': { kind: 'run', family: 'create:brass_ingot', units: 64 }, // Brass Run
  '5C02000000000051': { kind: 'run', family: 'immersiveengineering:coal_coke', units: 128 }, // Coke Line
  '5C02000000000061': { kind: 'run', family: 'mekanism:basic_control_circuit', units: 32 }, // Circuit Order
  '5C02000000000111': { kind: 'flag', key: 'moment:stress_test' }, // The Stress Test
  '5C03000000000031': { kind: 'run', family: 'minecraft:gold_ingot', units: 64 }, // Gold Run
  '5C03000000000041': { kind: 'run', family: 'ae2:fluix_crystal', units: 128 }, // Fluix Run
  '5C03000000000051': { kind: 'run', family: 'powah:steel_energized', units: 64 }, // Energized Order
  '5C03000000000061': { kind: 'run', family: 'mekanism:advanced_control_circuit', units: 32 }, // Advanced Circuits
  '5C03000000000111': { kind: 'flag', key: 'moment:hostile_takeover' }, // The Hostile Takeover
  '5C03000000000121': { kind: 'flag', key: 'moment:first_launch' }, // The First Launch
  '5C04000000000031': { kind: 'run', family: 'minecraft:diamond', units: 32 }, // Diamond Run
  '5C04000000000041': { kind: 'run', family: 'ad_astra:desh_ingot', units: 64 }, // Desh Run
  '5C04000000000051': { kind: 'run', family: 'ae2:logic_processor', units: 64 }, // Processor Order
  '5C04000000000061': { kind: 'run', family: 'consortium:fuel_buckets', units: 4 }, // Fuel Order
  '5C04000000000121': { kind: 'flag', key: 'moment:station' }, // Orbital Division
  '5C05000000000031': { kind: 'run', family: 'c:ingots/uranium', units: 64 }, // Uranium Run
  '5C05000000000041': { kind: 'run', family: 'ad_astra:ostrum_ingot', units: 32 }, // Ostrum Run
  '5C05000000000051': { kind: 'run', family: 'mekanism:ultimate_control_circuit', units: 16 }, // Ultimate Circuits
  '5C05000000000061': { kind: 'run', family: 'mekanism:pellet_polonium', units: 4 }, // Pellet Order
  '5C05000000000101': { kind: 'flag', key: 'project:fusion_core' }, // The Fusion Core
  '5C05000000000111': { kind: 'flag', key: 'project:frontier_gate' }, // The Frontier Gate
  '5C05000000000121': { kind: 'flag', key: 'project:antimatter' }, // The Antimatter Reserve
  '5C05000000000131': { kind: 'flag', key: 'boss:liquidator' }, // The Liquidator
  '5C06000000000041': { kind: 'flag', key: 'market:charter_bonus' }, // Charter Bonus
  '5C06000000000051': { kind: 'flag', key: 'shop:any' }, // Company Shop
  '5C06000000000061': { kind: 'flag', key: 'shop:chunk_loader' }, // Loaded Chunks
  '5C06000000000071': { kind: 'flag', key: 'shop:claim_chunks' }, // More Ground
  '5C06000000000081': { kind: 'flag', key: 'shop:waystone' }, // Fast Travel
  '5C06000000000091': { kind: 'flag', key: 'contract:gap' }, // The Gap Contract
  '5C060000000000A1': { kind: 'flag', key: 'shop:season_contribution' }, // Season Contribution
  '5C060000000000B1': { kind: 'flag', key: 'licence:purchased' }, // Vacancy Licence
  '5C07000000000021': { kind: 'contract' }, // Weekly Contract
  '5C07000000000031': { kind: 'weekly', key: 'event:friday' }, // Friday Shift
  '5C07000000000041': { kind: 'weekly', key: 'event:saturday' }, // Saturday Roster
  '5C07000000000051': { kind: 'flag', key: 'event:supply_drop' }, // Salvage Crew
  '5C07000000000061': { kind: 'flag', key: 'event:bounty' }, // Bounty Hunter
  '5C07000000000071': { kind: 'flag', key: 'event:invasion' }, // Invasion Veteran
  '5C07000000000081': { kind: 'flag', key: 'event:blood_moon' }, // Night Shift
  '5C07000000000091': { kind: 'flag', key: 'event:market' }, // Market Timing
  '5C08000000000021': { kind: 'rank', rank: 'operator' }, // Operator
  '5C08000000000031': { kind: 'rank', rank: 'engineer' }, // Engineer
  '5C08000000000041': { kind: 'rank', rank: 'director' }, // Director
  '5C08000000000051': { kind: 'rank', rank: 'shareholder' }, // Shareholder
  '5C08000000000061': { kind: 'founder' }, // Founder
  '5C08000000000071': { kind: 'count', key: 'referral', n: 1 }, // Recruiter
  '5C08000000000081': { kind: 'count', key: 'referral', n: 3 }, // Talent Scout
  '5C08000000000091': { kind: 'flag', key: 'season:closed' }, // Season 1 Closed
}

// Custom rewards, keyed by reward id. kind: cc { cents, reason [, xp] } | cxp { xp } | cosmetic { cosmetic } |
// title { title, text }. check = the claimer's own fact (QUESTS 5.4): run | closing | item | flag | weekly |
// contract | paycheck | charter | rank | founder | licence | count | once | none. weeks = season maximum of a
// repeatable (budget only). Every cents value is a PLACEHOLDER. Generated with the chapter files.
// once { key }: a team reward with no per-player fact (the planet landings) paid one time per player: the check
// refuses while flags.<uuid>.<key> is set and the stamp writes it after a successful payment, because FTB Quests
// copies a member's own claimed rewards back to the personal team on leaving a party but never the team rewards,
// and the dimension task completes again on the personal team at the next visit (same guard as weekly_paid).
const CONSORTIUM_QUEST_REWARDS = {
  '5C00000000000054': { kind: 'cc', check: { c: 'paycheck' }, cents: 500, reason: 'first_paycheck' }, // First Paycheck
  '5C00000000000064': { kind: 'cc', check: { c: 'charter' }, cents: 500, reason: 'charter_chosen' }, // Choose Your Charter
  '5C01000000000034': { kind: 'cc', check: { c: 'run', family: 'minecraft:iron_ingot', units: 64 }, cents: 1000, reason: 'run:minecraft_iron_ingot' }, // Iron Run
  '5C01000000000044': { kind: 'cc', check: { c: 'run', family: 'minecraft:coal', units: 128 }, cents: 1000, reason: 'run:minecraft_coal' }, // Coal Line
  '5C01000000000054': { kind: 'cc', check: { c: 'run', family: 'create:andesite_alloy', units: 64 }, cents: 1000, reason: 'run:create_andesite_alloy' }, // Alloy Order
  '5C01000000000064': { kind: 'cc', check: { c: 'run', family: 'consortium:cooked_meals', units: 32 }, cents: 1000, reason: 'run:consortium_cooked_meals' }, // Kitchen Duty
  '5C01000000000074': { kind: 'cc', check: { c: 'item', item: 'create:water_wheel' }, cents: 500, reason: 'cert:create_water_wheel' }, // Water Power
  '5C01000000000084': { kind: 'cc', check: { c: 'item', item: 'create:millstone' }, cents: 500, reason: 'cert:create_millstone' }, // Millstone
  '5C01000000000094': { kind: 'cc', check: { c: 'item', item: 'create:mechanical_press' }, cents: 500, reason: 'cert:create_mechanical_press' }, // Pressed
  '5C010000000000A4': { kind: 'cc', check: { c: 'item', item: 'farmersdelight:cooking_pot' }, cents: 500, reason: 'cert:farmersdelight_cooking_pot' }, // Kitchen Line
  '5C010000000000B4': { kind: 'cc', check: { c: 'item', item: 'create:mechanical_mixer' }, cents: 500, reason: 'cert:create_mechanical_mixer' }, // Cold Mix
  '5C010000000000F4': { kind: 'cosmetic', check: { c: 'flag', key: 'moment:groundbreaking' }, cosmetic: 'founder_lantern' }, // The Groundbreaking
  '5C01000000000104': { kind: 'cc', check: { c: 'closing', runs: [{ family: 'minecraft:iron_ingot', units: 64 }, { family: 'minecraft:coal', units: 128 }, { family: 'create:andesite_alloy', units: 64 }, { family: 'consortium:cooked_meals', units: 32 }] }, cents: 2500, reason: 'phase:1:complete' }, // Phase 1 Complete
  '5C02000000000034': { kind: 'cc', check: { c: 'run', family: 'c:ingots/steel', units: 64 }, cents: 2000, reason: 'run:c_ingots_steel' }, // Steel Run
  '5C02000000000044': { kind: 'cc', check: { c: 'run', family: 'create:brass_ingot', units: 64 }, cents: 2000, reason: 'run:create_brass_ingot' }, // Brass Run
  '5C02000000000054': { kind: 'cc', check: { c: 'run', family: 'immersiveengineering:coal_coke', units: 128 }, cents: 2000, reason: 'run:immersiveengineering_coal_coke' }, // Coke Line
  '5C02000000000064': { kind: 'cc', check: { c: 'run', family: 'mekanism:basic_control_circuit', units: 32 }, cents: 2000, reason: 'run:mekanism_basic_control_circuit' }, // Circuit Order
  '5C02000000000074': { kind: 'cc', check: { c: 'item', item: 'immersiveengineering:blastbrick' }, cents: 1500, reason: 'cert:immersiveengineering_blastbrick' }, // Blast Brick
  '5C02000000000084': { kind: 'cc', check: { c: 'item', item: 'create:steam_engine' }, cents: 1500, reason: 'cert:create_steam_engine' }, // Steam Engine
  '5C02000000000094': { kind: 'cc', check: { c: 'item', item: 'mekanism:metallurgic_infuser' }, cents: 1500, reason: 'cert:mekanism_metallurgic_infuser' }, // Metallurgic Infuser
  '5C020000000000A4': { kind: 'cc', check: { c: 'item', item: 'mekanism:basic_energy_cube' }, cents: 1500, reason: 'cert:mekanism_basic_energy_cube' }, // Basic Energy Cube
  '5C020000000000B4': { kind: 'cc', check: { c: 'item', item: 'immersiveengineering:capacitor_lv' }, cents: 1500, reason: 'cert:immersiveengineering_capacitor_lv' }, // LV Capacitor
  '5C020000000000C4': { kind: 'cc', check: { c: 'item', item: 'powah:reactor_starter' }, cents: 1500, reason: 'cert:powah_reactor_starter' }, // Starter Reactor
  '5C020000000000D4': { kind: 'cc', check: { c: 'item', item: 'create:precision_mechanism' }, cents: 1500, reason: 'cert:create_precision_mechanism' }, // Precision Mechanism
  '5C02000000000114': { kind: 'cosmetic', check: { c: 'flag', key: 'moment:stress_test' }, cosmetic: 'beacon_shard' }, // The Stress Test
  '5C02000000000124': { kind: 'cc', check: { c: 'closing', runs: [{ family: 'c:ingots/steel', units: 64 }, { family: 'create:brass_ingot', units: 64 }, { family: 'immersiveengineering:coal_coke', units: 128 }, { family: 'mekanism:basic_control_circuit', units: 32 }] }, cents: 7500, reason: 'phase:2:complete' }, // Phase 2 Complete
  '5C03000000000034': { kind: 'cc', check: { c: 'run', family: 'minecraft:gold_ingot', units: 64 }, cents: 2000, reason: 'run:minecraft_gold_ingot' }, // Gold Run
  '5C03000000000044': { kind: 'cc', check: { c: 'run', family: 'ae2:fluix_crystal', units: 128 }, cents: 2000, reason: 'run:ae2_fluix_crystal' }, // Fluix Run
  '5C03000000000054': { kind: 'cc', check: { c: 'run', family: 'powah:steel_energized', units: 64 }, cents: 2000, reason: 'run:powah_steel_energized' }, // Energized Order
  '5C03000000000064': { kind: 'cc', check: { c: 'run', family: 'mekanism:advanced_control_circuit', units: 32 }, cents: 2000, reason: 'run:mekanism_advanced_control_circuit' }, // Advanced Circuits
  '5C03000000000074': { kind: 'cc', check: { c: 'item', item: 'mekanism:purification_chamber' }, cents: 2000, reason: 'cert:mekanism_purification_chamber' }, // Purification Chamber
  '5C03000000000084': { kind: 'cc', check: { c: 'item', item: 'mekanism:elite_enriching_factory' }, cents: 2000, reason: 'cert:mekanism_elite_enriching_factory' }, // Elite Factory
  '5C03000000000094': { kind: 'cc', check: { c: 'item', item: 'ae2:drive' }, cents: 2000, reason: 'cert:ae2_drive' }, // ME Drive
  '5C030000000000A4': { kind: 'cc', check: { c: 'item', item: 'immersiveengineering:capacitor_mv' }, cents: 2000, reason: 'cert:immersiveengineering_capacitor_mv' }, // MV Capacitor
  '5C030000000000B4': { kind: 'cc', check: { c: 'item', item: 'powah:reactor_blazing' }, cents: 2000, reason: 'cert:powah_reactor_blazing' }, // Blazing Reactor
  '5C030000000000C4': { kind: 'cc', check: { c: 'item', item: 'create:track_station' }, cents: 2000, reason: 'cert:create_track_station' }, // Track Station
  '5C030000000000E4': { kind: 'title', check: { c: 'licence', stage: 'consortium:licence_extraction' }, title: 'licensed_extractor', text: 'Licensed Extractor' }, // Extraction Licence
  '5C03000000000114': { kind: 'cosmetic', check: { c: 'flag', key: 'moment:hostile_takeover' }, cosmetic: 'refinery_badge' }, // The Hostile Takeover
  '5C03000000000124': { kind: 'cosmetic', check: { c: 'flag', key: 'moment:first_launch' }, cosmetic: 'launch_patch' }, // The First Launch
  '5C03000000000134': { kind: 'cc', check: { c: 'closing', runs: [{ family: 'minecraft:gold_ingot', units: 64 }, { family: 'ae2:fluix_crystal', units: 128 }, { family: 'powah:steel_energized', units: 64 }, { family: 'mekanism:advanced_control_circuit', units: 32 }] }, cents: 10000, reason: 'phase:3:complete' }, // Phase 3 Complete
  '5C04000000000034': { kind: 'cc', check: { c: 'run', family: 'minecraft:diamond', units: 32 }, cents: 3000, reason: 'run:minecraft_diamond' }, // Diamond Run
  '5C04000000000044': { kind: 'cc', check: { c: 'run', family: 'ad_astra:desh_ingot', units: 64 }, cents: 3000, reason: 'run:ad_astra_desh_ingot' }, // Desh Run
  '5C04000000000054': { kind: 'cc', check: { c: 'run', family: 'ae2:logic_processor', units: 64 }, cents: 3000, reason: 'run:ae2_logic_processor' }, // Processor Order
  '5C04000000000064': { kind: 'cc', check: { c: 'run', family: 'consortium:fuel_buckets', units: 4 }, cents: 3000, reason: 'run:consortium_fuel_buckets' }, // Fuel Order
  '5C04000000000074': { kind: 'cc', check: { c: 'item', item: 'mekanism:ultimate_energy_cube' }, cents: 2500, reason: 'cert:mekanism_ultimate_energy_cube' }, // Ultimate Cube
  '5C04000000000084': { kind: 'cc', check: { c: 'item', item: 'mekanism:pressurized_reaction_chamber' }, cents: 2500, reason: 'cert:mekanism_pressurized_reaction_chamber' }, // Reaction Chamber
  '5C04000000000094': { kind: 'cc', check: { c: 'item', item: 'ae2:pattern_provider' }, cents: 2500, reason: 'cert:ae2_pattern_provider' }, // Pattern Provider
  '5C040000000000A4': { kind: 'cc', check: { c: 'item', item: 'ad_astra:tier_1_rocket' }, cents: 2500, reason: 'cert:ad_astra_tier_1_rocket' }, // Tier 1 Rocket
  '5C040000000000B4': { kind: 'cc', check: { c: 'once', key: 'landing:moon' }, cents: 2500, reason: 'cert:moon_landing' }, // Moon Landing (team reward, once per player)
  '5C040000000000C4': { kind: 'cc', check: { c: 'item', item: 'immersiveengineering:capacitor_hv' }, cents: 2500, reason: 'cert:immersiveengineering_capacitor_hv' }, // HV Capacitor
  '5C040000000000D4': { kind: 'cc', check: { c: 'item', item: 'apotheosis:reforging_table' }, cents: 2500, reason: 'cert:apotheosis_reforging_table' }, // Reforging Table
  '5C04000000000104': { kind: 'title', check: { c: 'licence', stage: 'consortium:licence_energy' }, title: 'licensed_engineer', text: 'Licensed Engineer' }, // Energy Licence
  '5C04000000000114': { kind: 'title', check: { c: 'licence', stage: 'consortium:licence_logistics' }, title: 'licensed_courier', text: 'Licensed Courier' }, // Logistics Licence
  '5C04000000000124': { kind: 'cosmetic', check: { c: 'flag', key: 'moment:station' }, cosmetic: 'station_key' }, // Orbital Division
  '5C04000000000134': { kind: 'cc', check: { c: 'closing', runs: [{ family: 'minecraft:diamond', units: 32 }, { family: 'ad_astra:desh_ingot', units: 64 }, { family: 'ae2:logic_processor', units: 64 }, { family: 'consortium:fuel_buckets', units: 4 }] }, cents: 15000, reason: 'phase:4:complete' }, // Phase 4 Complete
  '5C05000000000034': { kind: 'cc', check: { c: 'run', family: 'c:ingots/uranium', units: 64 }, cents: 5000, reason: 'run:c_ingots_uranium' }, // Uranium Run
  '5C05000000000044': { kind: 'cc', check: { c: 'run', family: 'ad_astra:ostrum_ingot', units: 32 }, cents: 5000, reason: 'run:ad_astra_ostrum_ingot' }, // Ostrum Run
  '5C05000000000054': { kind: 'cc', check: { c: 'run', family: 'mekanism:ultimate_control_circuit', units: 16 }, cents: 5000, reason: 'run:mekanism_ultimate_control_circuit' }, // Ultimate Circuits
  '5C05000000000064': { kind: 'cc', check: { c: 'run', family: 'mekanism:pellet_polonium', units: 4 }, cents: 5000, reason: 'run:mekanism_pellet_polonium' }, // Pellet Order
  '5C05000000000074': { kind: 'cc', check: { c: 'item', item: 'mekanism:isotopic_centrifuge' }, cents: 4000, reason: 'cert:mekanism_isotopic_centrifuge' }, // Isotopic Centrifuge
  '5C05000000000084': { kind: 'cc', check: { c: 'item', item: 'ae2:spatial_io_port' }, cents: 4000, reason: 'cert:ae2_spatial_io_port' }, // Spatial IO
  '5C05000000000094': { kind: 'cc', check: { c: 'item', item: 'ad_astra:tier_3_rocket' }, cents: 4000, reason: 'cert:ad_astra_tier_3_rocket' }, // Tier 3 Rocket
  '5C050000000000A4': { kind: 'cc', check: { c: 'once', key: 'landing:venus' }, cents: 4000, reason: 'cert:venus_landing' }, // Venus Landing (team reward, once per player)
  '5C050000000000B4': { kind: 'cc', check: { c: 'item', item: 'ad_astra:tier_4_rocket' }, cents: 4000, reason: 'cert:ad_astra_tier_4_rocket' }, // Tier 4 Rocket
  '5C050000000000C4': { kind: 'cc', check: { c: 'once', key: 'landing:glacio' }, cents: 4000, reason: 'cert:glacio_landing' }, // Glacio Landing (team reward, once per player)
  '5C05000000000104': { kind: 'cosmetic', check: { c: 'flag', key: 'project:fusion_core' }, cosmetic: 'fusion_pin' }, // The Fusion Core
  '5C05000000000114': { kind: 'cosmetic', check: { c: 'flag', key: 'project:frontier_gate' }, cosmetic: 'gate_token' }, // The Frontier Gate
  '5C05000000000124': { kind: 'cosmetic', check: { c: 'flag', key: 'project:antimatter' }, cosmetic: 'reserve_seal' }, // The Antimatter Reserve
  '5C05000000000134': { kind: 'cc', check: { c: 'flag', key: 'boss:liquidator' }, cents: 25000, reason: 'boss:liquidator' }, // The Liquidator
  '5C05000000000135': { kind: 'title', check: { c: 'flag', key: 'boss:liquidator' }, title: 'veteran', text: 'Season 1 Veteran' }, // The Liquidator
  '5C06000000000044': { kind: 'cc', check: { c: 'flag', key: 'market:charter_bonus' }, cents: 1000, reason: 'charter_bonus' }, // Charter Bonus
  '5C06000000000054': { kind: 'cc', check: { c: 'flag', key: 'shop:any' }, cents: 1000, reason: 'first_purchase' }, // Company Shop
  '5C07000000000024': { kind: 'cc', check: { c: 'contract' }, weeks: 12, cents: 2500, reason: 'contract:weekly', xp: 100 }, // Weekly Contract (team reward, cycles per member)
  '5C07000000000034': { kind: 'cxp', check: { c: 'weekly', key: 'event:friday' }, weeks: 12, xp: 150 }, // Friday Shift (team reward, cycles per member)
  '5C07000000000044': { kind: 'cxp', check: { c: 'weekly', key: 'event:saturday' }, weeks: 12, xp: 150 }, // Saturday Roster (team reward, cycles per member)
  '5C07000000000054': { kind: 'cc', check: { c: 'flag', key: 'event:supply_drop' }, cents: 1000, reason: 'event:supply_drop' }, // Salvage Crew
  '5C07000000000055': { kind: 'cosmetic', check: { c: 'flag', key: 'event:supply_drop' }, cosmetic: 'salvage_tag' }, // Salvage Crew
  '5C07000000000064': { kind: 'cc', check: { c: 'flag', key: 'event:bounty' }, cents: 2000, reason: 'event:bounty' }, // Bounty Hunter
  '5C07000000000074': { kind: 'cc', check: { c: 'flag', key: 'event:invasion' }, cents: 2000, reason: 'event:invasion' }, // Invasion Veteran
  '5C07000000000094': { kind: 'cc', check: { c: 'flag', key: 'event:market' }, cents: 1000, reason: 'event:market' }, // Market Timing
  '5C08000000000054': { kind: 'cosmetic', check: { c: 'rank', rank: 'shareholder' }, cosmetic: 'share_certificate' }, // Shareholder
  '5C08000000000064': { kind: 'title', check: { c: 'founder' }, title: 'founder', text: 'Founder' }, // Founder
  '5C08000000000084': { kind: 'title', check: { c: 'count', key: 'referral', min: 3 }, title: 'talent_scout', text: 'Talent Scout' }, // Talent Scout
  '5C08000000000094': { kind: 'cosmetic', check: { c: 'flag', key: 'season:closed' }, cosmetic: 'season_share' }, // Season 1 Closed
  '5C01000000000124': { kind: 'cc', check: { c: 'item', item: 'ironfurnaces:iron_furnace' }, cents: 500, reason: 'cert:ironfurnaces_iron_furnace' }, // Iron Furnace (batch 5)
  '5C01000000000134': { kind: 'cc', check: { c: 'item', item: 'silentgear:alloy_forge' }, cents: 500, reason: 'cert:silentgear_alloy_forge' }, // Alloy Forge (batch 5)
  '5C02000000000134': { kind: 'cc', check: { c: 'item', item: 'productivemetalworks:black_foundry_controller' }, cents: 1500, reason: 'cert:productivemetalworks_black_foundry_controller' }, // Foundry Controller (batch 5)
  '5C02000000000144': { kind: 'cc', check: { c: 'item', item: 'createaddition:alternator' }, cents: 1500, reason: 'cert:createaddition_alternator' }, // Alternator (batch 5)
  '5C02000000000154': { kind: 'cc', check: { c: 'item', item: 'create_enchantment_industry:blaze_enchanter' }, cents: 1500, reason: 'cert:create_enchantment_industry_blaze_enchanter' }, // Blaze Enchanter (batch 5)
  '5C03000000000144': { kind: 'cc', check: { c: 'item', item: 'immersivepetroleum:crudeoil_bucket' }, cents: 2000, reason: 'cert:immersivepetroleum_crudeoil_bucket' }, // Crude Oil (batch 5)
  '5C03000000000154': { kind: 'cc', check: { c: 'item', item: 'extendedae:ex_drive' }, cents: 2000, reason: 'cert:extendedae_ex_drive' }, // Extended Drive (batch 5)
  '5C04000000000144': { kind: 'cc', check: { c: 'item', item: 'merequester:requester' }, cents: 2500, reason: 'cert:merequester_requester' }, // ME Requester (batch 5)
  '5C04000000000154': { kind: 'cc', check: { c: 'item', item: 'megacells:cell_component_1m' }, cents: 2500, reason: 'cert:megacells_cell_component_1m' }, // 1M Cell Component (batch 5)
  '5C05000000000144': { kind: 'cc', check: { c: 'item', item: 'ironfurnaces:million_furnace' }, cents: 4000, reason: 'cert:ironfurnaces_million_furnace' }, // Million Furnace (batch 5)
}

// ---- server handle ----------------------------------------------------------------------------------
// ConsortiumQuests.flag(uuid, key) carries no server argument (Interfaces section 3), so the server is kept
// from ServerEvents.loaded (fired at start and after every /reload) with the FTB Quests file as a fallback.

let consortiumQuestServerRef = null
const CONSORTIUM_SQF = Platform.isLoaded('ftbquests') ? Java.loadClass('dev.ftb.mods.ftbquests.quest.ServerQuestFile') : null
const CONSORTIUM_PROGRESS_CHANGE = Platform.isLoaded('ftbquests') ? Java.loadClass('dev.ftb.mods.ftbquests.util.ProgressChange') : null

function consortiumQuestServer() {
  if (consortiumQuestServerRef !== null) return consortiumQuestServerRef
  if (CONSORTIUM_SQF !== null && CONSORTIUM_SQF.INSTANCE !== null) return CONSORTIUM_SQF.INSTANCE.server
  return null
}

// ---- state ---------------------------------------------------------------------------------------------

function consortiumQuestState(server) {
  return consortiumSub(consortiumState(server), 'quests')
}

// quests.<a>.<b> compound, created on demand.
function consortiumQuestSub2(server, a, b) {
  return consortiumSub(consortiumSub(consortiumQuestState(server), a), b)
}

function consortiumQuestSeasonWeek(server) {
  return Math.floor((consortiumSeasonDay(server) - 1) / 7) + 1
}

function consortiumQuestDelivered(server, uuid, family) {
  let st = consortiumQuestState(server)
  if (!st.contains('delivered')) return 0
  let per = st.getCompound('delivered')
  if (!per.contains(uuid)) return 0
  return per.getCompound(uuid).getDouble(family)
}

function consortiumQuestHasFlag(server, uuid, key) {
  let st = consortiumQuestState(server)
  if (!st.contains('flags')) return false
  let per = st.getCompound('flags')
  return per.contains(uuid) && per.getCompound(uuid).getBoolean(key)
}

function consortiumQuestCount(server, uuid, key) {
  let st = consortiumQuestState(server)
  if (!st.contains('counts')) return 0
  let per = st.getCompound('counts')
  return per.contains(uuid) ? per.getCompound(uuid).getInt(key) : 0
}

function consortiumQuestWeekly(server, uuid, key, paid) {
  let st = consortiumQuestState(server)
  let name = paid ? 'weekly_paid' : 'weekly'
  if (!st.contains(name)) return 0
  let per = st.getCompound(name)
  return per.contains(uuid) ? per.getCompound(uuid).getInt(key) : 0
}

function consortiumQuestRankThresholds() {
  return typeof CONSORTIUM_RANK_THRESHOLDS !== 'undefined' ? CONSORTIUM_RANK_THRESHOLDS : CONSORTIUM_QUEST_RANK_FALLBACK
}

// The open weekly contract as a JS object, or null (closed contracts stay in the record, see contractRecord).
function consortiumQuestContractRecord(server) {
  let st = consortiumQuestState(server)
  if (!st.contains('contract')) return null
  let c = st.getCompound('contract')
  if (c.getInt('id') <= 0) return null
  return { id: c.getInt('id'), family: String(c.getString('family')), units: c.getInt('units'), setAt: c.getLong('setAt'), endsAt: c.getLong('endsAt') }
}

function consortiumQuestContractOpen(server) {
  let c = consortiumQuestContractRecord(server)
  return c !== null && Date.now() < c.endsAt ? c : null
}

function consortiumQuestContractBucket(server, contractId, uuid, family) {
  let st = consortiumQuestState(server)
  if (!st.contains('delivered_since')) return 0
  let byId = st.getCompound('delivered_since')
  if (!byId.contains(String(contractId))) return 0
  let per = byId.getCompound(String(contractId))
  return per.contains(uuid) ? per.getCompound(uuid).getDouble(family) : 0
}

function consortiumQuestContractPaid(server, uuid) {
  let st = consortiumQuestState(server)
  return st.contains('contract_paid') ? st.getCompound('contract_paid').getInt(uuid) : 0
}

// Display name of a price family (the mod's name, else the key).
function consortiumQuestFamilyName(key) {
  if (typeof ConsortiumCore === 'undefined' || !ConsortiumCore.ready()) return key
  let pv = ConsortiumCore.price(key)
  return pv.isPresent() ? String(pv.get().name()) : key
}

// "Wednesday 24/9 at 20:00" for an epoch ms instant (server time).
function consortiumQuestWhen(ms) {
  let names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  let d = new Date(ms)
  let hh = String(d.getHours())
  let mm = String(d.getMinutes())
  return names[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1) + ' at ' + (hh.length < 2 ? '0' + hh : hh) + ':' + (mm.length < 2 ? '0' + mm : mm)
}

// Resets one quest for every FTB team (started, completed, task progress and the NIL-uuid team reward
// claims): used when a new weekly contract replaces the previous one, so no stale progress carries over.
function consortiumQuestResetForAllTeams(server, questHex) {
  if (typeof FTBQuests === 'undefined' || CONSORTIUM_PROGRESS_CHANGE === null) return 0
  let level = server.overworld()
  let quest = FTBQuests.getObject(level, questHex)
  if (quest === null) return 0
  let n = 0
  for (let td of FTBQuests.getFile(level).getAllTeamData()) {
    quest.forceProgress(td, new CONSORTIUM_PROGRESS_CHANGE(quest, new CONSORTIUM_UUID(0, 0)))
    n++
  }
  return n
}

// ---- the ConsortiumQuests object (Interfaces section 3) ----------------------------------------------------

const ConsortiumQuests = {
  // Sets a once-off flag, or stamps the current season week for the week-keyed keys. Safe to call twice.
  flag: (uuid, key) => {
    let server = consortiumQuestServer()
    if (server === null) return false
    let id = String(uuid).toLowerCase()
    if (CONSORTIUM_QUEST_WEEKLY_KEYS.indexOf(key) >= 0) {
      consortiumQuestSub2(server, 'weekly', id).putInt(key, consortiumQuestSeasonWeek(server))
    } else {
      consortiumQuestSub2(server, 'flags', id).putBoolean(key, true)
    }
    return true
  },

  // Clears a flag or removes a weekly stamp (the events engine's Wednesday lapse). weekly_paid is never touched.
  unflag: (uuid, key) => {
    let server = consortiumQuestServer()
    if (server === null) return false
    let id = String(uuid).toLowerCase()
    let name = CONSORTIUM_QUEST_WEEKLY_KEYS.indexOf(key) >= 0 ? 'weekly' : 'flags'
    let st = consortiumQuestState(server)
    if (!st.contains(name) || !st.getCompound(name).contains(id)) return false
    st.getCompound(name).getCompound(id).remove(key)
    return true
  },

  has: (uuid, key) => {
    let server = consortiumQuestServer()
    return server !== null && consortiumQuestHasFlag(server, String(uuid).toLowerCase(), key)
  },

  // Adds n (negative allowed, floor 0) to a counter and returns the new value.
  count: (uuid, key, n) => {
    let server = consortiumQuestServer()
    if (server === null) return 0
    let id = String(uuid).toLowerCase()
    let tag = consortiumQuestSub2(server, 'counts', id)
    let next = Math.max(0, tag.getInt(key) + Math.floor(Number(n) || 0))
    tag.putInt(key, next)
    return next
  },

  delivered: (uuid, family) => {
    let server = consortiumQuestServer()
    return server === null ? 0 : consortiumQuestDelivered(server, String(uuid).toLowerCase(), family)
  },

  contract: {
    // The open record plus paidCount = the contract_paid stamps equal to its id (BATCH_3_INTERFACES 4: the Wednesday guard and the minus 24 h line of consortium_calendar.js).
    current: (server) => { let c = consortiumQuestContractOpen(server); if (c === null) return null; let st = consortiumQuestState(server); let paid = st.contains('contract_paid') ? st.getCompound('contract_paid') : null; let n = 0; if (paid !== null) { for (let k of paid.getAllKeys()) { if (paid.getInt(k) === c.id) n++ } } c.paidCount = n; return c },

    // Opens a new contract (the previous one is superseded). Returns a refusal string or null.
    set: (server, familyKey, units, days, byName) => {
      let key = String(familyKey)
      let n = Math.floor(Number(units) || 0)
      let d = Math.floor(Number(days) || CONSORTIUM_QUEST_CONTRACT_DAYS)
      if (n <= 0) return 'The contract needs a positive number of units.'
      if (d <= 0) return 'The contract needs a positive number of days.'
      if (typeof ConsortiumCore !== 'undefined' && ConsortiumCore.ready() && !ConsortiumCore.price(key).isPresent()) {
        return 'Unknown price family "' + key + '": use a key of /prices list (for example minecraft:iron_ingot).'
      }
      let st = consortiumQuestState(server)
      let prev = st.contains('contract') ? st.getCompound('contract').getInt('id') : 0
      let now = Date.now()
      let c = NBT.compoundTag()
      c.putInt('id', prev + 1)
      c.putString('family', key)
      c.putInt('units', n)
      c.putLong('setAt', now)
      c.putLong('endsAt', now + d * CONSORTIUM_DAY_MS)
      st.put('contract', c)
      let reset = 0
      try { reset = consortiumQuestResetForAllTeams(server, CONSORTIUM_QUEST_CONTRACT_QUEST) } catch (err) { console.error('[Consortium] contract quest reset failed: ' + err) }
      let feeEntry = CONSORTIUM_QUEST_REWARDS['5C07000000000024']
      let feeText = typeof ConsortiumCore !== 'undefined' ? String(ConsortiumCore.format(feeEntry.cents)) : (feeEntry.cents / 100).toFixed(2) + ' CC'
      consortiumBroadcast(server, 'Weekly contract: deliver ' + consortiumFmt(n) + ' ' + consortiumQuestFamilyName(key) + ' by ' + consortiumQuestWhen(now + d * CONSORTIUM_DAY_MS)
        + '. ' + feeText + ' to every crew member who fills it. Progress in the quest book and /consortium contract.')
      console.info('[Consortium] weekly contract #' + (prev + 1) + ' set by ' + (byName || 'staff') + ': ' + n + ' x ' + key + ' for ' + d + ' day(s), ' + reset + ' team(s) reset')
      return null
    },

    // The open contract and the player's own progress, as text.
    status: (server, uuid) => {
      let c = consortiumQuestContractRecord(server)
      if (c === null) return 'No weekly contract is open. Staff sets one on Wednesday evening.'
      let id = String(uuid).toLowerCase()
      let mine = Math.floor(consortiumQuestContractBucket(server, c.id, id, c.family))
      let open = Date.now() < c.endsAt
      let paid = consortiumQuestContractPaid(server, id) === c.id
      return 'Weekly contract #' + c.id + ': ' + consortiumFmt(c.units) + ' ' + consortiumQuestFamilyName(c.family) + ' (' + c.family + '), '
        + (open ? 'until ' + consortiumQuestWhen(c.endsAt) : 'closed') + '. Your own deliveries since it was set: ' + consortiumFmt(Math.min(mine, c.units)) + ' / ' + consortiumFmt(c.units)
        + (paid ? ', paid.' : '.')
    },

    // Ends the open contract now: the buckets freeze, the stamps stay, the quest keeps its progress.
    clear: (server) => {
      let st = consortiumQuestState(server)
      if (!st.contains('contract')) return false
      let c = st.getCompound('contract')
      if (c.getInt('id') <= 0 || Date.now() >= c.getLong('endsAt')) return false
      c.putLong('endsAt', Date.now())
      consortiumBroadcast(server, 'The weekly contract is closed. Claims for filled contracts stay open.')
      return true
    },
  },
}

// ---- per-player validation (QUESTS 5.4) ----------------------------------------------------------------

function consortiumQuestHolds(player, itemId) {
  try {
    if (player.inventory.count(itemId) > 0) return true
  } catch (err) {
    // fall through to the slot scan
  }
  let inv = player.inventory
  let n = inv.getContainerSize()
  for (let i = 0; i < n; i++) {
    let stack = inv.getItem(i)
    if (!stack.isEmpty() && String(stack.id) === itemId) return true
  }
  return false
}

function consortiumQuestFounder(server, uuid) {
  if (typeof ConsortiumCore === 'undefined') return false
  let first = ConsortiumCore.firstLogin(CONSORTIUM_UUID.fromString(uuid))
  if (first <= 0) return false
  let day = consortiumSeasonDayAt(server, first)
  return day >= 1 && day <= CONSORTIUM_QUEST_FOUNDER_DAYS
}

function consortiumQuestRankCents(uuid) {
  return typeof ConsortiumCore === 'undefined' ? 0 : Number(ConsortiumCore.rankCredit(CONSORTIUM_UUID.fromString(uuid)))
}

// True when the claimer's own record satisfies the reward's check.
function consortiumQuestCheck(server, player, uuid, check) {
  switch (check.c) {
    case 'none': return true
    case 'run': return consortiumQuestDelivered(server, uuid, check.family) >= check.units
    case 'closing': {
      for (let i = 0; i < check.runs.length; i++) {
        if (consortiumQuestDelivered(server, uuid, check.runs[i].family) >= check.runs[i].units) return true
      }
      return false
    }
    case 'item': return consortiumQuestHolds(player, check.item)
    case 'flag': return consortiumQuestHasFlag(server, uuid, check.key)
    case 'weekly': return consortiumQuestWeekly(server, uuid, check.key, false) > consortiumQuestWeekly(server, uuid, check.key, true)
    case 'contract': {
      let c = consortiumQuestContractRecord(server)
      if (c === null || consortiumQuestContractPaid(server, uuid) === c.id) return false
      return consortiumQuestContractBucket(server, c.id, uuid, c.family) >= c.units
    }
    case 'paycheck': return typeof ConsortiumCore !== 'undefined' && ConsortiumCore.lifetimeDelivered(CONSORTIUM_UUID.fromString(uuid)) > 0
    case 'charter': return consortiumCharterOf(server, uuid) !== null
    case 'rank': return consortiumQuestRankCents(uuid) >= (consortiumQuestRankThresholds()[check.rank] || 0)
    case 'founder': return consortiumQuestFounder(server, uuid)
    case 'licence': {
      let teams = consortiumTeamsOfId(uuid)
      for (let i = 0; i < teams.length; i++) {
        if (consortiumTeamHasStage(teams[i], check.stage)) return true
      }
      return false
    }
    case 'count': return consortiumQuestCount(server, uuid, check.key) >= check.min
    case 'once': return !consortiumQuestHasFlag(server, uuid, check.key)
    default: return false
  }
}

// Stamps written after a successful claim so a repeatable quest never pays the same member twice (weekly and
// the contract), and so a team reward without a per-player fact is paid once per player (once: the landings).
function consortiumQuestStamp(server, uuid, check) {
  if (check.c === 'weekly') {
    consortiumQuestSub2(server, 'weekly_paid', uuid).putInt(check.key, consortiumQuestWeekly(server, uuid, check.key, false))
  } else if (check.c === 'contract') {
    let c = consortiumQuestContractRecord(server)
    if (c !== null) consortiumSub(consortiumQuestState(server), 'contract_paid').putInt(uuid, c.id)
  } else if (check.c === 'once') {
    consortiumQuestSub2(server, 'flags', uuid).putBoolean(check.key, true)
  }
}

// ---- reward payment -------------------------------------------------------------------------------------

function consortiumSnbtString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// Gives the cosmetic stack: base item, gold custom name, grey lore, glint, consortium_cosmetic custom data.
function consortiumQuestGiveCosmetic(server, player, key) {
  let cos = CONSORTIUM_QUEST_COSMETICS[key]
  if (!cos) return false
  let nameJson = JSON.stringify({ text: cos.name, color: 'gold', italic: false })
  let loreJson = JSON.stringify({ text: cos.lore, color: 'gray', italic: false })
  let spec = cos.item + '[minecraft:custom_name=' + consortiumSnbtString(nameJson) + ',minecraft:lore=[' + consortiumSnbtString(loreJson)
    + '],minecraft:enchantment_glint_override=true,minecraft:custom_data={consortium_cosmetic:' + consortiumSnbtString(key) + '}]'
  try {
    let stack = Item.of(spec)
    if (!stack.isEmpty()) {
      player.give(stack)
      return true
    }
  } catch (err) {
    console.warn('[Consortium] cosmetic stack parse failed (' + key + '): ' + err + '; falling back to /give')
  }
  server.runCommandSilent('give ' + player.username + ' ' + spec + ' 1')
  return true
}

function consortiumQuestGrantTitle(server, player, uuid, entry, hex) {
  let name = String(player.username)
  if (typeof Consortium !== 'undefined' && Consortium.titles && typeof Consortium.titles.grant === 'function') {
    // The tx carries the claimer's uuid: the registry's idempotency is keyed by the tx string, and a team quest is
    // claimed once per member, so a shared 'quest:<hex>' would grant the title to the first claimer only.
    let tx = 'quest:' + hex + ':' + uuid
    let r = Consortium.titles.grant(server, uuid, name, entry.title, entry.text, tx)
    if (r && r.ok === false) {
      consortiumQuestSub2(server, 'titles_pending', uuid).putString(entry.title, entry.text)
      console.warn('[Consortium] quest title ' + entry.title + ' for ' + name + ' refused by the registry (' + r.reason + '); recorded in quests.titles_pending')
      player.tell(Text.of('[Consortium] Company title earned: ' + entry.text + '. It shows once staff attach it.').gold())
      return false
    }
    if (r && r.already) {
      console.warn('[Consortium] quest title ' + entry.title + ' for ' + name + ' already recorded under tx ' + tx + ': nothing granted again')
      player.tell(Text.of('[Consortium] Company title already yours: ' + entry.text + '. Switch between your titles with /consortium title.').gold())
      return true
    }
    player.tell(Text.of('[Consortium] Company title granted: ' + entry.text + '. Switch between your titles with /consortium title.').gold())
    return true
  }
  // Title registry not installed (consortium_shop.js absent): keep the grant for a later resync by staff.
  consortiumQuestSub2(server, 'titles_pending', uuid).putString(entry.title, entry.text)
  console.warn('[Consortium] title registry absent: ' + entry.title + ' for ' + name + ' recorded in quests.titles_pending')
  player.tell(Text.of('[Consortium] Company title earned: ' + entry.text + '. It shows once the title registry is installed.').gold())
  return false
}

// Pays one validated reward. Returns true when something was handed out (the repeatable stamps depend on it).
function consortiumQuestPay(server, player, uuid, hex, entry, notify) {
  let name = String(player.username)
  if (entry.kind === 'cc') {
    if (typeof ConsortiumCore === 'undefined') {
      console.warn('[Consortium] quest credit ' + entry.reason + ' for ' + name + ' skipped: Consortium Core absent')
      return false
    }
    let result = String(ConsortiumCore.credit(player.uuid, entry.cents, 'quest:' + entry.reason))
    if (result !== 'SUCCESS') {
      console.warn('[Consortium] quest credit ' + entry.reason + ' for ' + name + ' failed: ' + result)
      return false
    }
    if (entry.xp) player.giveExperiencePoints(entry.xp)
    if (notify) player.tell(Text.of('[Consortium] ' + String(ConsortiumCore.format(entry.cents)) + (entry.xp ? ' and ' + entry.xp + ' XP' : '') + ' paid for a completed assignment.').gold())
  } else if (entry.kind === 'cxp') {
    player.giveExperiencePoints(entry.xp)
    if (notify) player.tell(Text.of('[Consortium] ' + entry.xp + ' XP paid for a completed assignment.').gold())
  } else if (entry.kind === 'cosmetic') {
    consortiumQuestGiveCosmetic(server, player, entry.cosmetic)
    if (notify) player.tell(Text.of('[Consortium] Keepsake received: ' + CONSORTIUM_QUEST_COSMETICS[entry.cosmetic].name + '.').gold())
  } else if (entry.kind === 'title') {
    consortiumQuestGrantTitle(server, player, uuid, entry, hex)
  }
  return true
}

// ---- custom task checks --------------------------------------------------------------------------------

function consortiumQuestTaskValue(server, player, uuid, task, data) {
  switch (task.kind) {
    case 'run': return Math.min(task.units, Math.floor(consortiumQuestDelivered(server, uuid, task.family)))
    case 'flag': return consortiumQuestHasFlag(server, uuid, task.key) ? 1 : 0
    case 'weekly': return consortiumQuestWeekly(server, uuid, task.key, false) > consortiumQuestWeekly(server, uuid, task.key, true) ? 1 : 0
    case 'count': return Math.min(task.n, consortiumQuestCount(server, uuid, task.key))
    case 'rank': {
      let threshold = Math.floor((consortiumQuestRankThresholds()[task.rank] || 0) / 100)
      return Math.min(threshold, Math.floor(consortiumQuestRankCents(uuid) / 100))
    }
    case 'paycheck': return typeof ConsortiumCore !== 'undefined' && ConsortiumCore.lifetimeDelivered(player.uuid) > 0 ? 1 : 0
    case 'charter': return consortiumCharterOf(server, uuid) !== null ? 1 : 0
    case 'founder': return consortiumQuestFounder(server, uuid) ? 1 : 0
    default: return 0
  }
}

// Max rule (QUESTS 5.2): the check runs per online member and writes that member's own value into the
// team's progress, so the team value only ever rises (the first member at 0 would otherwise erase it).
function consortiumQuestWriteMax(data, value) {
  let current = Number(data.getProgress())
  if (value > current) data.setProgress(value)
}

// The weekly contract task: max = the open contract's units (re-set from inside the check when it changes),
// value = the member's own bucket, 0 once paid; the team's stale value is dropped on a contract change.
function consortiumQuestContractCheck(server, player, uuid, data) {
  let c = consortiumQuestContractRecord(server)
  if (c === null) return
  let task = data.task()
  if (Number(task.getMaxProgress()) !== c.units) task.setMaxProgress(c.units)
  let paid = consortiumQuestContractPaid(server, uuid) === c.id
  let value = paid ? 0 : Math.min(c.units, Math.floor(consortiumQuestContractBucket(server, c.id, uuid, c.family)))
  let seen = consortiumSub(consortiumQuestState(server), 'contract_seen')
  let teamId = String(data.teamData().getTeamId())
  if (seen.getInt(teamId) !== c.id) {
    seen.putInt(teamId, c.id)
    if (Number(data.getProgress()) !== value) data.setProgress(value)
    return
  }
  consortiumQuestWriteMax(data, value)
}

// ---- wiring --------------------------------------------------------------------------------------------

ServerEvents.loaded((event) => {
  consortiumQuestServerRef = event.server
})

if (typeof FTBQuestsEvents !== 'undefined') {
  let taskHexes = Object.keys(CONSORTIUM_QUEST_TASKS)
  let runCount = 0
  let flagCount = 0
  for (let i = 0; i < taskHexes.length; i++) {
    let hex = taskHexes[i]
    let task = CONSORTIUM_QUEST_TASKS[hex]
    if (task.kind === 'run') runCount++
    else if (task.kind === 'flag' || task.kind === 'weekly') flagCount++
    FTBQuestsEvents.customTask(hex, (event) => {
      if (task.kind === 'run') event.setMaxProgress(task.units)
      else if (task.kind === 'count') event.setMaxProgress(task.n)
      else if (task.kind === 'rank') event.setMaxProgress(Math.max(1, Math.floor((consortiumQuestRankThresholds()[task.rank] || 0) / 100)))
      else if (task.kind === 'contract') {
        let server = consortiumQuestServer()
        let c = server === null ? null : consortiumQuestContractRecord(server)
        event.setMaxProgress(c === null ? 1 : c.units)
      }
      event.setCheckTimer(CONSORTIUM_QUEST_POLL_TICKS)
      event.setCheck((data, player) => {
        try {
          let server = player.server
          let uuid = String(player.uuid).toLowerCase()
          if (task.kind === 'contract') consortiumQuestContractCheck(server, player, uuid, data)
          else consortiumQuestWriteMax(data, consortiumQuestTaskValue(server, player, uuid, task, data))
        } catch (err) {
          console.error('[Consortium] quest task ' + hex + ' check failed for ' + player.username + ': ' + err)
        }
      })
    })
  }

  let rewardHexes = Object.keys(CONSORTIUM_QUEST_REWARDS)
  for (let i = 0; i < rewardHexes.length; i++) {
    let hex = rewardHexes[i]
    let entry = CONSORTIUM_QUEST_REWARDS[hex]
    FTBQuestsEvents.customReward(hex, (event) => {
      let player = event.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      try {
        if (!consortiumQuestCheck(server, player, uuid, entry.check)) {
          player.tell(Text.of(entry.check.c === 'once' ? CONSORTIUM_QUEST_REFUSAL_ONCE : CONSORTIUM_QUEST_REFUSAL).gray())
          console.info('[Consortium] quest reward ' + hex + ' (' + entry.kind + ') refused for ' + player.username + ': check ' + JSON.stringify(entry.check) + ' failed')
          return
        }
        if (consortiumQuestPay(server, player, uuid, hex, entry, event.notify)) consortiumQuestStamp(server, uuid, entry.check)
      } catch (err) {
        console.error('[Consortium] quest reward ' + hex + ' failed for ' + player.username + ': ' + err)
      }
    })
  }
  console.info('[Consortium] quests: ' + rewardHexes.length + ' rewards, ' + runCount + ' runs, ' + flagCount + ' flags attached')
} else {
  console.info('[Consortium] FTB XMod Compat quest events absent: quest tasks and rewards off')
}

if (typeof ConsortiumCore !== 'undefined') {
  // Per-player delivered units by price family, contract buckets and the two market flags (QUESTS 5.2).
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      let contract = consortiumQuestContractOpen(server)
      let events = consortiumQuestActiveEvent(server)
      let market = events !== null && CONSORTIUM_MARKET_EVENT_IDS.indexOf(events.id) >= 0
      let charter = consortiumEffectiveCharter(server, player)
      let table = charter === null ? null : (CONSORTIUM_CHARTER_MODIFIERS[charter] || null)
      let delivered = consortiumQuestSub2(server, 'delivered', uuid)
      for (let line of e.lines) {
        let family = String(line.family)
        let units = Number(line.units)
        if (units <= 0) continue
        delivered.putDouble(family, delivered.getDouble(family) + units)
        if (contract !== null && family === contract.family) {
          let bucket = consortiumSub(consortiumQuestSub2(server, 'delivered_since', String(contract.id)), uuid)
          bucket.putDouble(family, bucket.getDouble(family) + units)
        }
        if (table !== null && Number(line.paidUnits) > 0) {
          let pv = ConsortiumCore.price(family)
          if (pv.isPresent() && (table[String(pv.get().charterFamily())] || 1) > 1) ConsortiumQuests.flag(uuid, 'market:charter_bonus')
        }
        if (market) ConsortiumQuests.flag(uuid, 'event:market')
      }
    } catch (err) {
      console.error('[Consortium] quest delivery listener failed: ' + err)
    }
  })

  // event:bounty and event:invasion derived from the events engine's ledger reasons (Interfaces section 6).
  NativeEvents.onEvent('org.consortium.core.api.event.BalanceChangeEvent', (e) => {
    try {
      if (Number(e.delta) <= 0) return
      let reason = String(e.reason || '')
      if (reason.indexOf('event:bounty:') === 0) ConsortiumQuests.flag(String(e.player), 'event:bounty')
      else if (reason.indexOf('event:wave:') === 0) ConsortiumQuests.flag(String(e.player), 'event:invasion')
    } catch (err) {
      console.error('[Consortium] quest balance listener failed: ' + err)
    }
  })
}

// { id, pendingDusk } of the running event (consortium.events.active, EVENTS 2.2), or null. Read-only.
function consortiumQuestActiveEvent(server) {
  let st = consortiumState(server)
  if (!st.contains('events')) return null
  let events = st.getCompound('events')
  if (!events.contains('active')) return null
  let active = events.getCompound('active')
  let id = String(active.getString('id'))
  if (id === '') return null
  return { id: id, pendingDusk: active.getBoolean('pendingDusk') }
}

// event:blood_moon for every online player while a blood moon is past dusk (QUESTS 5.3).
ServerEvents.tick((event) => {
  if (event.server.tickCount % CONSORTIUM_QUEST_POLL_TICKS !== 0) return
  try {
    let active = consortiumQuestActiveEvent(event.server)
    if (active === null || active.id !== 'blood_moon' || active.pendingDusk) return
    for (let p of event.server.players) ConsortiumQuests.flag(String(p.uuid), 'event:blood_moon')
  } catch (err) {
    console.error('[Consortium] blood moon quest poll failed: ' + err)
  }
})
