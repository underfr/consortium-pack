// The Consortium - economy locks (PROJECT_RULES 4.1 and 4.2, PROGRESSION.md sections 14 and 15).
//
// Chunk loading is a paid money sink and Chunk Loaders (SuperMartijn642) is the only
// chunk-loading system. Every other way to keep chunks loaded is removed here, and the
// Chunk Loaders themselves lose their crafting recipes: players buy them from the
// Consortium shop (data/consortium/consortium_shop/catalogue.json, from phase 3). The
// Waystones Warp Stone follows the same pattern (SHOP_CATALOGUE 3.4, DECISIONS 2026-09-17).
//
// Recipe ids were read from the mod jars shipped in pack 0.3.0 (Waystones in 0.6.0):
//   chunkloaders 1.2.9, Mekanism 10.7.19.85, Applied Energistics 2 19.2.17,
//   Immersive Engineering 12.4.2-194, Ad Astra 1.16.26, Waystones 21.1.45.

ServerEvents.recipes((event) => {
  // Chunk Loaders: shop-only.
  event.remove({ id: 'chunkloaders:single_chunk_loader' })
  event.remove({ id: 'chunkloaders:basic_chunk_loader' })
  event.remove({ id: 'chunkloaders:advanced_chunk_loader' })
  event.remove({ id: 'chunkloaders:ultimate_chunk_loader' })
  event.remove({ id: 'chunkloaders:single_to_basic_chunk_loader' })

  // Waystones Warp Stone (SHOP_CATALOGUE 3.4): shop-only from phase 2 (600 CC PLACEHOLDER), 128 warps per
  // stone (durability stays on in config/waystones-common.toml). Every other Waystones item stays craftable:
  // basic waystones are free forever, the network items are Logistics' phase 2 early access.
  event.remove({ id: 'waystones:warp_stone' })

  // Mekanism: the Anchor Upgrade and the Dimensional Stabilizer keep chunks loaded.
  // Config already disables their behaviour (general.toml allowChunkloading = false);
  // removing the recipes avoids players crafting items that do nothing.
  event.remove({ id: 'mekanism:upgrade/anchor' })
  event.remove({ id: 'mekanism:dimensional_stabilizer' })

  // Applied Energistics 2: the Spatial Anchor force-loads every chunk of its network
  // and has no config toggle.
  event.remove({ id: 'ae2:network/blocks/spatial_anchor' })

  // Immersive Engineering: the Resonanz Observer multiblock is a chunk loader with no
  // config toggle; its only specific block has this single recipe.
  event.remove({ id: 'immersiveengineering:crafting/resonanz_engineering' })

  // Immersive Engineering brass (PROGRESSION.md section 15): brass is a phase 2 gate made by
  // heated Create mixing only. The alloy kiln is free from phase 1 (bronze, constantan,
  // electrum) and would otherwise output create:brass_ingot with no blaze burner; the arc
  // furnace recipes are removed for the same reason (verified data/immersiveengineering/recipe/).
  // Note: arcfurnace/dust_brass carries a neoforge:tag_empty condition on #c:dusts/brass, which
  // is empty in this pack, so IE never loads it and KubeJS reports 14 removed recipes for the
  // 15 ids below. The line stays as a safety net for a mod that adds brass dust later.
  event.remove({ id: 'immersiveengineering:alloysmelter/brass' })
  event.remove({ id: 'immersiveengineering:arcfurnace/alloy_brass' })
  event.remove({ id: 'immersiveengineering:arcfurnace/dust_brass' })

  // Ad Astra cryo fuel (PROGRESSION.md section 15): #ad_astra:fuel lists cryo fuel as an
  // efficient rocket fuel for every tier, and free overworld ice would make launches nearly
  // free from phase 4. Cryo fuel is made from planet ice shards only
  // (cryo_fuel_from_cryo_freezing_ice_shard stays).
  event.remove({ id: 'ad_astra:cryo_freezing/cryo_fuel_from_cryo_freezing_ice' })
  event.remove({ id: 'ad_astra:cryo_freezing/cryo_fuel_from_cryo_freezing_packed_ice' })
  event.remove({ id: 'ad_astra:cryo_freezing/cryo_fuel_from_cryo_freezing_blue_ice' })
})
