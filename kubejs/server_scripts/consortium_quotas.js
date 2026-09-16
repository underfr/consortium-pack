// priority: 90
// The Consortium - phase table: names, Chapters stage ids, quest chapters and delivery quotas
// (docs/PROGRESSION.md sections 4 to 8). Data only, read by consortium_phases.js. The economy step
// edits the `r` rates here (Q = D x 10 x r x 0.7 for 10 active players) without touching the engine.
//
// Fields: number, name, stage (Chapters stage id, kubejs/data/consortium/chapters/stages/<id>.json),
// quest (FTB Quests chapter hex id opened by the [open quests] link), headline (what the phase opens,
// read out at the unlock), moment (the collective moment of section 1), quota: [{ id, label, amount,
// items?, icon? }] where `id` is a registry id or a family key, `items` lists every id counted by a
// family line and `icon` is the item the quota board shows for the line (default: items[0], else id).

// Cooking-pot meals accepted by the phase 1 "cooked meals" line (final list: economy price table).
const CONSORTIUM_MEALS = ['apple_cider', 'baked_cod_stew', 'beef_stew', 'bone_broth', 'cabbage_rolls', 'chicken_soup', 'dumplings',
  'fish_stew', 'fried_rice', 'glow_berry_custard', 'hot_cocoa', 'mushroom_rice', 'noodle_soup', 'onion_soup', 'pasta_with_meatballs',
  'pasta_with_mutton_chop', 'pumpkin_soup', 'ratatouille', 'squid_ink_pasta', 'vegetable_noodles', 'vegetable_soup']
  .map((id) => 'farmersdelight:' + id).concat(['minecraft:beetroot_soup', 'minecraft:mushroom_stew', 'minecraft:rabbit_stew'])

// Quotas of sections 4 to 8 (10 active players, Q = D x 10 x r x 0.7). `id` is the registry id or a
// family key; `items` lists every id that counts for a family line; `label` is the player-facing name;
// `quest` is the FTB Quests chapter opened by the [open quests] link (config/ftbquests/quests/chapters).
const CONSORTIUM_PHASES = [
  {
    number: 1, name: 'Groundbreaking', stage: 'consortium:phase_1', quest: '5C01000000000001',
    headline: 'vanilla, Create kinetics, Farmer\'s Delight and basic waystones', moment: 'the Groundbreaking ceremony',
    quota: [
      { id: 'minecraft:cobblestone', label: 'cobblestone', amount: 40000 },
      { id: 'minecraft:iron_ingot', label: 'iron ingots', amount: 2500 },
      { id: 'minecraft:copper_ingot', label: 'copper ingots', amount: 2000 },
      { id: 'create:zinc_ingot', label: 'zinc ingots', amount: 1700 },
      { id: 'minecraft:coal', label: 'coal', amount: 3500 },
      { id: 'create:andesite_alloy', label: 'andesite alloy', amount: 1000 },
      { id: 'create:andesite_funnel', label: 'andesite funnels', amount: 500 },
      { id: 'consortium:cooked_meals', label: 'cooked meals', amount: 1000, items: CONSORTIUM_MEALS, icon: 'farmersdelight:beef_stew' },
    ],
  },
  {
    number: 2, name: 'The Foundry', stage: 'consortium:phase_2', quest: '5C02000000000001',
    headline: 'steel, Immersive Engineering low voltage, Create brass and steam, Mekanism basic machines, Powah starter and basic, the waystone network',
    moment: 'the Stress Test',
    quota: [
      { id: '#c:ingots/steel', label: 'steel ingots', amount: 5000, items: ['mekanism:ingot_steel', 'immersiveengineering:ingot_steel', 'ad_astra:steel_ingot'] },
      { id: 'create:brass_ingot', label: 'brass ingots', amount: 5000 },
      { id: 'immersiveengineering:coal_coke', label: 'coal coke', amount: 4000 },
      { id: 'mekanism:energy_tablet', label: 'energy tablets', amount: 800 },
      { id: 'mekanism:steel_casing', label: 'steel casings', amount: 400 },
      { id: 'mekanism:basic_control_circuit', label: 'basic control circuits', amount: 1500 },
      { id: 'create:precision_mechanism', label: 'precision mechanisms', amount: 600 },
      { id: 'create:brass_funnel', label: 'brass funnels', amount: 600 },
    ],
  },
  {
    number: 3, name: 'The Refinery', stage: 'consortium:phase_3', quest: '5C03000000000001',
    headline: 'Mekanism advanced and elite, 3x and 4x ore processing, AE2 storage, Create trains, Immersive Engineering medium voltage, Powah hardened and blazing, chunk loaders on sale',
    moment: 'the Hostile Takeover and the First Launch',
    quota: [
      { id: 'minecraft:gold_ingot', label: 'gold ingots', amount: 3000 },
      { id: 'mekanism:ingot_refined_obsidian', label: 'refined obsidian ingots', amount: 500 },
      { id: 'ae2:fluix_crystal', label: 'fluix crystals', amount: 4000 },
      { id: 'powah:steel_energized', label: 'energized steel', amount: 2000 },
      { id: 'mekanism:advanced_control_circuit', label: 'advanced control circuits', amount: 2000 },
      { id: 'mekanism:alloy_reinforced', label: 'reinforced alloy', amount: 1500 },
      { id: 'mekanism:hydrogen_chloride_bucket', label: 'hydrogen chloride buckets', amount: 100 },
      { id: 'ae2:item_storage_cell_1k', label: '1k storage cells', amount: 300 },
    ],
  },
  {
    number: 4, name: 'Orbital Division', stage: 'consortium:phase_4', quest: '5C04000000000001',
    headline: 'Mekanism ultimate and chemistry, AE2 autocrafting and wireless, Ad Astra rockets to the Moon and Mars, Immersive Engineering high voltage, Apotheosis reforging, Powah niotic',
    moment: 'the Orbital Division ceremony',
    quota: [
      { id: 'minecraft:diamond', label: 'diamonds', amount: 1500 },
      { id: 'ad_astra:desh_ingot', label: 'desh ingots', amount: 2000 },
      { id: 'mekanism:alloy_atomic', label: 'atomic alloy', amount: 1000 },
      { id: 'mekanism:hdpe_sheet', label: 'HDPE sheets', amount: 1000 },
      { id: 'ae2:logic_processor', label: 'logic processors', amount: 2000 },
      { id: 'ae2:engineering_processor', label: 'engineering processors', amount: 750 },
      { id: 'powah:crystal_niotic', label: 'niotic crystals', amount: 400 },
      { id: 'consortium:fuel_buckets', label: 'fuel buckets', amount: 300, items: ['ad_astra:fuel_bucket', 'immersiveengineering:biodiesel_bucket', 'ad_astra:cryo_fuel_bucket'] },
    ],
  },
  {
    number: 5, name: 'Event Horizon', stage: 'consortium:phase_5', quest: '5C05000000000001',
    headline: 'fusion fuel and antimatter, AE2 spatial storage, Venus, Mercury and Glacio, the MekaSuit, Powah spirited and nitro',
    moment: 'the season project and the final boss',
    quota: [
      { id: 'mekanism:ingot_uranium', label: 'uranium ingots', amount: 4000 },
      { id: 'ad_astra:ostrum_ingot', label: 'ostrum ingots', amount: 1600 },
      { id: 'ad_astra:calorite_ingot', label: 'calorite ingots', amount: 1000 },
      { id: 'mekanism:ultimate_control_circuit', label: 'ultimate control circuits', amount: 800 },
      { id: 'mekanism:pellet_polonium', label: 'polonium pellets', amount: 600 },
      { id: 'mekanism:pellet_plutonium', label: 'plutonium pellets', amount: 150 },
      { id: 'powah:crystal_nitro', label: 'nitro crystals', amount: 80 },
      { id: 'ae2:singularity', label: 'singularities', amount: 32 },
      { id: 'mekanism:pellet_antimatter', label: 'antimatter pellet', amount: 1 },
    ],
  },
]
