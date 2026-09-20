// priority: 45
// The Consortium - helpers of the random events engine (docs/EVENTS.md 2.1, 3.9; PROJECT_RULES 4.1, 4.6).
// Loaded after consortium_phases.js (50) and before consortium_money.js (40) and consortium_events.js (20).
//
// Everything that touches a Java class of an optional mod sits behind a Platform.isLoaded flag and is null
// otherwise: server_scripts/ also run on every client's integrated server, where In Control and LootJS are
// absent and Consortium Core may be too. The engine itself (consortium_events.js) is inert unless
// CONSORTIUM_EVENTS_ON holds (Consortium Core present and FTB Chunks present: the claim checks are what
// keeps every spawn and every crate out of the players' bases, rule 4.6).
//
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_HAS_INCONTROL = Platform.isLoaded('incontrol')
const CONSORTIUM_HAS_APOTHEOSIS = Platform.isLoaded('apotheosis')
const CONSORTIUM_HAS_FTBCHUNKS = Platform.isLoaded('ftbchunks')
const CONSORTIUM_EVENTS_ON = typeof ConsortiumCore !== 'undefined' && CONSORTIUM_HAS_FTBCHUNKS

// FTB Chunks (claims) and FTB Library (ChunkDimPos).
const CONSORTIUM_FTBCHUNKS_API = CONSORTIUM_HAS_FTBCHUNKS ? Java.loadClass('dev.ftb.mods.ftbchunks.api.FTBChunksAPI') : null
const CONSORTIUM_CHUNKDIMPOS = CONSORTIUM_HAS_FTBCHUNKS ? Java.loadClass('dev.ftb.mods.ftblibrary.math.ChunkDimPos') : null
// Apotheosis (bounty bosses through the Java API: no player context needed, works at any world tier).
const CONSORTIUM_APOTH_INVADERS = CONSORTIUM_HAS_APOTHEOSIS ? Java.loadClass('dev.shadowsoffire.apotheosis.mobs.registries.InvaderRegistry') : null
const CONSORTIUM_APOTH_GENCTX = CONSORTIUM_HAS_APOTHEOSIS ? Java.loadClass('dev.shadowsoffire.apotheosis.tiers.GenContext') : null
const CONSORTIUM_APOTH_TIER = CONSORTIUM_HAS_APOTHEOSIS ? Java.loadClass('dev.shadowsoffire.apotheosis.tiers.WorldTier') : null
const CONSORTIUM_APOTH_RARITIES = CONSORTIUM_HAS_APOTHEOSIS ? Java.loadClass('dev.shadowsoffire.apotheosis.loot.RarityRegistry') : null
const CONSORTIUM_APOTH_MOB_EVENTS = CONSORTIUM_HAS_APOTHEOSIS ? Java.loadClass('dev.shadowsoffire.apotheosis.mobs.ApothMobEvents') : null
// In Control (blood moon rules): the reload entry points, because /incontrol reload needs a player.
const CONSORTIUM_IC_RULES = CONSORTIUM_HAS_INCONTROL ? Java.loadClass('mcjty.incontrol.rules.RulesManager') : null
const CONSORTIUM_IC_SPAWNER = CONSORTIUM_HAS_INCONTROL ? Java.loadClass('mcjty.incontrol.spawner.SpawnerSystem') : null
const CONSORTIUM_IC_EVENTS = CONSORTIUM_HAS_INCONTROL ? Java.loadClass('mcjty.incontrol.events.EventsSystem') : null
const CONSORTIUM_IC_AREAS = CONSORTIUM_HAS_INCONTROL ? Java.loadClass('mcjty.incontrol.areas.AreaSystem') : null
// Vanilla classes (always present).
const CONSORTIUM_HEIGHTMAP = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
const CONSORTIUM_RL = Java.loadClass('net.minecraft.resources.ResourceLocation')

// Tags every engine mob carries: the kind tag plus this one (cleanup and the orphan sweep key on it).
const CONSORTIUM_EVENT_TAG = 'consortium_event'
const CONSORTIUM_TAG_BOUNTY = 'consortium_bounty'
const CONSORTIUM_TAG_WAVE = 'consortium_wave'
const CONSORTIUM_TAG_BLOODMOON = 'consortium_bloodmoon'

// Bounty boss whitelist (EVENTS 3.5, PLACEHOLDER): the phase key is the lowest phase that may roll the id.
// Endermen (teleport out of the ring and into claims), the breeze (wind charges) and every twilight/* id
// (Twilight Forest absent) are excluded on purpose.
const CONSORTIUM_BOUNTY_BOSSES = {
  2: ['apotheosis:overworld/zombie', 'apotheosis:overworld/skeleton', 'apotheosis:overworld/husk'],
  3: ['apotheosis:overworld/stray', 'apotheosis:overworld/bogged', 'apotheosis:overworld/vindicator'],
  4: ['apotheosis:the_nether/wither_skeleton', 'apotheosis:the_nether/piglin_brute'],
}
// Rarity and world tier per phase (PLACEHOLDER): never apotheosis:common (no boss stats block).
const CONSORTIUM_BOUNTY_RARITIES = {
  1: { tier: 'HAVEN', rarities: ['apotheosis:uncommon', 'apotheosis:rare'] },
  2: { tier: 'HAVEN', rarities: ['apotheosis:uncommon', 'apotheosis:rare'] },
  3: { tier: 'FRONTIER', rarities: ['apotheosis:rare'] },
  4: { tier: 'ASCENT', rarities: ['apotheosis:rare', 'apotheosis:epic'] },
  5: { tier: 'ASCENT', rarities: ['apotheosis:rare', 'apotheosis:epic'] },
}
const CONSORTIUM_BOSS_RARITY_IDS = ['apotheosis:uncommon', 'apotheosis:rare', 'apotheosis:epic', 'apotheosis:mythic']

// Every whitelisted boss id up to phase n (the roll pick and the staff argument check).
function consortiumBountyBossesUpTo(n) {
  let out = []
  for (let p = 1; p <= n; p++) {
    let list = CONSORTIUM_BOUNTY_BOSSES[p]
    if (list) for (let i = 0; i < list.length; i++) out.push(list[i])
  }
  return out
}

// ---- claims (FTB Chunks API, verified on the harness) --------------------------------------------

function consortiumClaimManager() {
  if (CONSORTIUM_FTBCHUNKS_API === null) return null
  let api = CONSORTIUM_FTBCHUNKS_API.api()
  if (!api.isManagerLoaded()) return null
  return api.getManager()
}

// The claim on the chunk of `pos` in `level`, or null when unclaimed. Only valid while the manager is loaded
// (consortiumClaimManager() !== null): every caller fails CLOSED without it, so no spawn or crate ever lands
// anywhere the engine cannot check.
function consortiumClaimAt(mgr, level, pos) {
  return mgr.getChunk(new CONSORTIUM_CHUNKDIMPOS(level, pos))
}

// The FTB team id (lowercase uuid string) owning a claim, or '' when unknown.
function consortiumClaimTeamId(claim) {
  try { return String(claim.getTeamData().getTeam().getId()).toLowerCase() } catch (err) { return '' }
}

// True when `pos` lies inside the arena record (same dimension). With a pit (arena.pit > 0, the generated HQ
// of BADGES_AND_HQ 2.7) it is the block square |dx| <= pit and |dz| <= pit around the centre: the hall, the
// yard and the plinth are then outside (a bystander at the shop gets no warning, a wave mob that leaves the
// pit is discarded by the hostile-claim sweep); without one, the chunk rule: within `radius` chunks of the
// centre chunk (Chebyshev). `level.dimension` is KubeJS's ResourceLocation property (it shadows the vanilla
// dimension() method).
function consortiumInArena(level, pos, arena) {
  if (arena === null) return false
  if (String(level.dimension) !== arena.dim) return false
  let pit = arena.pit || 0
  if (pit > 0) return Math.abs(pos.getX() - arena.x) <= pit && Math.abs(pos.getZ() - arena.z) <= pit
  let dx = Math.abs((pos.getX() >> 4) - (arena.x >> 4))
  let dz = Math.abs((pos.getZ() >> 4) - (arena.z >> 4))
  return dx <= arena.radius && dz <= arena.radius
}

// EVENTS 3.9: a HOSTILE claim is any claimed chunk except the arena team's own chunks inside the arena radius.
// `arena` is the plain object of consortiumArena(server) or null. Unclaimed = not hostile; unknown = hostile.
function consortiumHostileClaim(level, pos, arena) {
  let mgr = consortiumClaimManager()
  if (mgr === null) return true
  let claim = consortiumClaimAt(mgr, level, pos)
  if (claim === null) return false
  if (arena === null || !consortiumInArena(level, pos, arena)) return true
  return consortiumClaimTeamId(claim) !== arena.team
}

// True when no claimed chunk lies within `chunks` chunks of pos (a square ring, one getChunk per chunk).
// The arena's own chunks count as claims here too: a random bounty and a supply drop keep away from HQ.
function consortiumFarFromClaims(level, pos, chunks) {
  let mgr = consortiumClaimManager()
  if (mgr === null) return false
  let cx = pos.getX() >> 4
  let cz = pos.getZ() >> 4
  for (let dx = -chunks; dx <= chunks; dx++) {
    for (let dz = -chunks; dz <= chunks; dz++) {
      // The (Level, BlockPos) constructor: KubeJS exposes level.dimension as the ResourceLocation property (the
      // vanilla dimension() method is shadowed), so the ResourceKey form is not reachable from a script.
      let probe = BlockPos.containing((cx + dx) * 16 + 8, pos.getY(), (cz + dz) * 16 + 8)
      if (mgr.getChunk(new CONSORTIUM_CHUNKDIMPOS(level, probe)) !== null) return false
    }
  }
  return true
}

// ---- ground and spots ------------------------------------------------------------------------------

// The first air block above the highest motion-blocking non-leaf block at (x, z), or null when the block
// under it is not solid ground (water, lava, leaves) or the chunk is not loaded (getHeight answers the
// minimum build height there).
function consortiumGround(level, x, z) {
  let y = level.getHeight(CONSORTIUM_HEIGHTMAP.MOTION_BLOCKING_NO_LEAVES, x, z)
  if (y <= level.getMinBuildHeight() + 1) return null
  let pos = BlockPos.containing(x, y, z)
  let below = level.getBlockState(pos.below())
  if (!below.isSolid() || !below.getFluidState().isEmpty()) return null
  if (!level.getBlockState(pos).isAir()) return null
  return pos
}

// A random spot on solid ground in the ring [minR, maxR] around `centre` (a BlockPos), or null after 24 tries.
//   allowedTeam null: the spot must be `claimRingChunks` chunks clear of EVERY claim (supply drop, wilderness bounty).
//   allowedTeam set:  the spot must lie in a chunk claimed by that team and inside the arena radius (invasion,
//                     Friday zone); `arena` is the arena record then.
// Keep maxR inside the players' view distance: getHeight only answers for loaded chunks.
function consortiumEventSpot(level, centre, minR, maxR, claimRingChunks, allowedTeam, arena) {
  let rand = level.getRandom()
  for (let i = 0; i < 24; i++) {
    let a = rand.nextDouble() * Math.PI * 2
    let r = minR + rand.nextDouble() * (maxR - minR)
    let x = Math.floor(centre.getX() + Math.cos(a) * r)
    let z = Math.floor(centre.getZ() + Math.sin(a) * r)
    let pos = consortiumGround(level, x, z)
    if (pos === null) continue
    if (allowedTeam === null) {
      if (consortiumFarFromClaims(level, pos, claimRingChunks)) return pos
    } else {
      let mgr = consortiumClaimManager()
      if (mgr === null) return null
      let claim = consortiumClaimAt(mgr, level, pos)
      if (claim === null) continue
      if (consortiumClaimTeamId(claim) !== allowedTeam) continue
      if (arena !== null && !consortiumInArena(level, pos, arena)) continue
      return pos
    }
  }
  return null
}

// ---- spawning ---------------------------------------------------------------------------------------

// Spawns one mob of `id` at `pos` (block position, centred), tagged CONSORTIUM_EVENT_TAG plus `kindTag`,
// persistent (Let Me Despawn never clears PersistenceRequired, so the engine's cleanup is the only exit) and
// with the extra NBT merged (DeathLootTable "minecraft:empty" for wave mobs: no loot-table drops, rule 4.1).
// Returns the entity or null.
function consortiumSpawnTagged(level, pos, id, kindTag, extraNbt) {
  let e = level.createEntity(id)
  if (e === null) return null
  e.setPosition(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5)
  let nbt = extraNbt || {}
  nbt.PersistenceRequired = true
  e.mergeNbt(nbt)
  e.addTag(CONSORTIUM_EVENT_TAG)
  e.addTag(kindTag)
  e.spawn()
  return e
}

// An Apotheosis invader boss at `pos` (EVENTS 3.5, verified on the harness with overworld/zombie): stats,
// gear, name and glow applied by createBoss, then tagged, made persistent (createBoss does not, the boss would
// despawn at 128 blocks) and added with its passengers. Throws on an unknown invader id.
function consortiumSpawnBoss(level, pos, bossId, rarityId, tier) {
  if (CONSORTIUM_APOTH_INVADERS === null) throw new Error('Apotheosis absent')
  let invader = CONSORTIUM_APOTH_INVADERS.INSTANCE.getValue(CONSORTIUM_RL.parse(bossId))
  if (invader === null) throw new Error('unknown invader ' + bossId)
  let ctx = CONSORTIUM_APOTH_GENCTX.standalone(level.getRandom(), CONSORTIUM_APOTH_TIER.valueOf(tier || 'HAVEN'), 0.0, level, pos)
  let rarity = CONSORTIUM_APOTH_RARITIES.INSTANCE.holder(CONSORTIUM_RL.parse(rarityId)).get()
  let mob = invader.createBoss(level, pos, ctx, rarity)
  mob.addTag(CONSORTIUM_EVENT_TAG)
  mob.addTag(CONSORTIUM_TAG_BOUNTY)
  mob.setPersistenceRequired()
  level.addFreshEntityWithPassengers(mob)
  try { CONSORTIUM_APOTH_MOB_EVENTS.sendInvaderSpawnNotification(level, mob) } catch (err) { console.warn('[Consortium] boss notification failed: ' + err) }
  return mob
}

// True when the entity is an Apotheosis boss (the marker lives in NeoForge's persistent data, not in KubeJS').
function consortiumIsApothBoss(entity) {
  try { return entity.nbt.getCompound('NeoForgeData').getBoolean('apoth.boss') } catch (err) { return false }
}

function consortiumHasTag(entity, tag) {
  try { return entity.tags.contains(tag) } catch (err) { return false }
}

// ---- cleanup ----------------------------------------------------------------------------------------

// Kills every tagged engine mob in every loaded dimension (the stop order of EVENTS 2.3 and the load sweep).
function consortiumKillTagged(server) {
  for (let level of server.getAllLevels()) {
    server.runCommandSilent('execute in ' + String(level.dimension) + ' run kill @e[tag=' + CONSORTIUM_EVENT_TAG + ']')
  }
}

// Force-loads or releases the 3 x 3 chunks around a block position in a dimension; returns the chunk keys used.
function consortiumForceLoad(server, dim, pos, add) {
  let cx = pos.getX() >> 4
  let cz = pos.getZ() >> 4
  let keys = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      let x = (cx + dx) * 16
      let z = (cz + dz) * 16
      keys.push(dim + ':' + (cx + dx) + ':' + (cz + dz))
      server.runCommandSilent('execute in ' + dim + ' run forceload ' + (add ? 'add ' : 'remove ') + x + ' ' + z)
    }
  }
  return keys
}

// Releases every chunk key recorded by consortiumForceLoad ("dim:cx:cz" strings in an NBT list).
function consortiumReleaseForceLoads(server, keysTag) {
  if (!keysTag) return 0
  let n = 0
  for (let i = 0; i < keysTag.size(); i++) {
    let parts = String(keysTag.getString(i)).split(':')
    if (parts.length < 4) continue // "minecraft:overworld:cx:cz"
    let dim = parts[0] + ':' + parts[1]
    server.runCommandSilent('execute in ' + dim + ' run forceload remove ' + (parseInt(parts[2], 10) * 16) + ' ' + (parseInt(parts[3], 10) * 16))
    n++
  }
  return n
}

// In Control rule reload from a script (the command needs a player).
function consortiumInControlReload() {
  if (!CONSORTIUM_HAS_INCONTROL) return false
  CONSORTIUM_IC_RULES.reloadRules()
  CONSORTIUM_IC_SPAWNER.reloadRules()
  CONSORTIUM_IC_EVENTS.reloadRules()
  CONSORTIUM_IC_AREAS.reloadRules()
  return true
}

// ---- the shared object -------------------------------------------------------------------------------
// Filled by consortium_events.js (priority 20). The economy scripts call these through typeof-guarded
// wrappers at quote, record, publish and completion time (never at load time). The shell answers the
// neutral value so a pack without the events file still runs.

const ConsortiumEvents = {
  // 1 outside a market event, outside the phase's quota families, or past the player's event caps.
  quoteFactor: (server, uuid, family, charterFamily) => 1,
  // 2 during Double Quota Hour, else 1.
  quotaFactor: (server) => 1,
  // { name, detail, seconds_left } for the board's event object, or null.
  boardObject: (server) => null,
  // Fireworks at the HQ arena (no-op until the arena is set).
  fireworks: (server) => false,
}
