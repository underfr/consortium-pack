// The Consortium - economy locks (PROJECT_RULES 4.1 and 4.2).
//
// Chunk loading is a paid money sink and Chunk Loaders (SuperMartijn642) is the only
// chunk-loading system. Every other way to keep chunks loaded is removed here, and the
// Chunk Loaders themselves lose their crafting recipes: players buy them from the
// Consortium shop (Phase 4). Until the shop exists, admins hand them out with /give.
//
// Recipe ids were read from the mod jars shipped in pack 0.3.0:
//   chunkloaders 1.2.9, Mekanism 10.7.19.85, Applied Energistics 2 19.2.17,
//   Immersive Engineering 12.4.2-194.

ServerEvents.recipes((event) => {
  // Chunk Loaders: shop-only.
  event.remove({ id: 'chunkloaders:single_chunk_loader' })
  event.remove({ id: 'chunkloaders:basic_chunk_loader' })
  event.remove({ id: 'chunkloaders:advanced_chunk_loader' })
  event.remove({ id: 'chunkloaders:ultimate_chunk_loader' })
  event.remove({ id: 'chunkloaders:single_to_basic_chunk_loader' })

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
})
