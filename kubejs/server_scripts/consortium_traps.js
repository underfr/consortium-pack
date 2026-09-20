// priority: 25
// The Consortium - arena traps engine (docs/HQ_SITE.md 4). Reads the trap groups the HQ builder recorded
// under server.persistentData.consortium_hq_traps (world coordinates, written by /consortium hq build from
// the layout's `traps`, dropped by hq clear, kept by hq forget) and drives them from the tick:
//   pitfall  2x2 iron trapdoors flush with the pit floor over a shaft: a player standing on them opens them
//            for 3 s (the fall lands on magma), then they close; 10 s cooldown per pit
//   vent     netherrack cells that flare up: every 12 s each vent group smokes for 2 s, then burns for 3 s
//            (fire on the standing cells), then goes out; groups are offset so the pit never burns at once
//   arrows   a barred slit in the pit wall that fires a volley of three arrows at a player who stands in its
//            zone (pickup disallowed, 3 damage), 3 s cooldown per slit
// Mode (persisted, /consortium hq traps <off|on|events>, default events): `on` runs the traps always, `events`
// only while an arena event runs (invasion, Friday Zone, or a bounty started at the arena), `off` never.
// Creative and spectator players never trigger anything. A script reload closes every pit and puts out every
// vent on its first tick (the in-memory timers are gone). No block outside the recorded cells is ever touched
// and no item is created (rule 4.1: an arrow with pickup 0 vanishes).

const CONSORTIUM_TRAPS_ROOT = 'consortium_hq_traps'
const CONSORTIUM_TRAPS_PERIOD = 4               // ticks between trap scans
const CONSORTIUM_TRAPS_PIT_OPEN = 60            // ticks a pitfall stays open
const CONSORTIUM_TRAPS_PIT_COOLDOWN = 200       // ticks before a pit can open again
const CONSORTIUM_TRAPS_VENT_CYCLE = 240         // ticks per vent cycle
const CONSORTIUM_TRAPS_VENT_WARN = 40           // smoke for this long before the fire
const CONSORTIUM_TRAPS_VENT_BURN = 60           // fire for this long
const CONSORTIUM_TRAPS_ARROW_COOLDOWN = 60      // ticks between volleys of one slit
const CONSORTIUM_TRAPS_ARROW_SPEED = 1.8        // blocks per tick
const CONSORTIUM_TRAPS_ARROW_DAMAGE = 3.0
const CONSORTIUM_TRAPS_ARENA_EVENTS = ['invasion', 'friday_zone']
const CONSORTIUM_TRAPS_PROPS = Java.loadClass('net.minecraft.world.level.block.state.properties.BlockStateProperties')

// In-memory timers (reset by a reload): per group index.
let consortiumTrapsState = { checked: false, pitOpenUntil: {}, pitCoolUntil: {}, ventBurning: {}, arrowCoolUntil: {}, ventTestUntil: undefined }

function consortiumTrapsRoot(server) {
  let pd = server.persistentData
  return pd.contains(CONSORTIUM_TRAPS_ROOT) ? pd.getCompound(CONSORTIUM_TRAPS_ROOT) : null
}

// The recorded groups as plain objects: { kind, cells: [BlockPos], trigger: [BlockPos] }.
function consortiumTrapsGroups(root) {
  let out = []
  let list = root.getList('traps', 10)
  for (let i = 0; i < list.size(); i++) {
    let t = list.getCompound(i)
    let g = { kind: String(t.getString('kind')), cells: [], trigger: [] }
    for (let part of ['cells', 'trigger']) {
      let flat = t.getList(part, 3)
      for (let j = 0; j + 2 < flat.size(); j += 3) g[part].push(BlockPos.containing(flat.getInt(j), flat.getInt(j + 1), flat.getInt(j + 2)))
    }
    out.push(g)
  }
  return out
}

function consortiumTrapsMode(server) {
  let root = consortiumTrapsRoot(server)
  if (root === null) return 'none'
  let m = String(root.getString('mode'))
  return m === 'on' || m === 'off' ? m : 'events'
}

// Whether an event that plays at the arena runs now: the invasion, the Friday Zone, or a bounty whose boss
// was placed at the arena centre.
function consortiumTrapsArenaEventActive(server, root) {
  if (typeof consortiumActiveEvent !== 'function') return false
  let active = consortiumActiveEvent(server)
  if (active === null) return false
  let id = String(active.getString('id'))
  if (CONSORTIUM_TRAPS_ARENA_EVENTS.indexOf(id) >= 0) return true
  if (id === 'bounty' && root.contains('arena') && active.contains('x')) {
    let a = root.getCompound('arena')
    return Math.abs(active.getInt('x') - a.getInt('x')) <= 6 && Math.abs(active.getInt('z') - a.getInt('z')) <= 6
  }
  return false
}

function consortiumTrapsLive(server) {
  let root = consortiumTrapsRoot(server)
  if (root === null) return false
  let mode = consortiumTrapsMode(server)
  if (mode === 'off') return false
  if (mode === 'on') return true
  return consortiumTrapsArenaEventActive(server, root)
}

function consortiumTrapsLevel(server, root) {
  try { return server.getLevel(CONSORTIUM_RL.parse(String(root.getString('dim')))) } catch (err) { return null }
}

function consortiumTrapsSetOpen(level, pos, open) {
  let st = level.getBlockState(pos)
  if (!st.hasProperty(CONSORTIUM_TRAPS_PROPS.OPEN)) return false
  // a Java Boolean comes back: compare as text; cycle() flips it without a boolean-to-Comparable conversion
  if ((String(st.getValue(CONSORTIUM_TRAPS_PROPS.OPEN)) === 'true') === open) return true
  level.setBlock(pos, st.cycle(CONSORTIUM_TRAPS_PROPS.OPEN), 3)
  return true
}

function consortiumTrapsSound(server, level, pos, sound, pitch) {
  server.runCommandSilent('execute in ' + String(level.dimension) + ' run playsound ' + sound + ' block @a ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' 1 ' + pitch)
}

function consortiumTrapsParticles(server, level, pos, particle, count) {
  server.runCommandSilent('execute in ' + String(level.dimension) + ' run particle ' + particle + ' ' + (pos.getX() + 0.5) + ' ' + (pos.getY() + 0.2) + ' ' + (pos.getZ() + 0.5) + ' 0.3 0.4 0.3 0.02 ' + count + ' normal')
}

// Players who can trigger a trap in this level: survival or adventure, alive.
function consortiumTrapsVictims(server, level) {
  let out = []
  for (let p of server.players) {
    if (String(p.level.dimension) !== String(level.dimension)) continue
    if (p.isCreative() || p.isSpectator() || !p.isAlive()) continue
    out.push(p)
  }
  return out
}

function consortiumTrapsStandingIn(player, cells) {
  let bp = player.blockPosition()
  for (let i = 0; i < cells.length; i++) if (cells[i].getX() === bp.getX() && cells[i].getY() === bp.getY() && cells[i].getZ() === bp.getZ()) return true
  return false
}

function consortiumTrapsFireState(level) { return consortiumHqParseState(level, 'minecraft:fire') }
function consortiumTrapsAirState(level) { return consortiumHqParseState(level, 'minecraft:air') }

function consortiumTrapsVentSet(server, level, g, burning) {
  let fire = consortiumTrapsFireState(level), air = consortiumTrapsAirState(level)
  for (let i = 0; i < g.cells.length; i++) {
    let pos = g.cells[i]
    let st = level.getBlockState(pos)
    if (burning && st.isAir()) level.setBlock(pos, fire, 3)
    else if (!burning && st.getBlock() === fire.getBlock()) level.setBlock(pos, air, 3)
  }
  if (g.cells.length) consortiumTrapsSound(server, level, g.cells[0], burning ? 'minecraft:entity.blaze.shoot' : 'minecraft:block.fire.extinguish', burning ? 0.7 : 1.2)
}

function consortiumTrapsVolley(server, level, g, target) {
  let slit = g.cells[0]
  let sx = slit.getX() + 0.5, sy = slit.getY() + 0.5, sz = slit.getZ() + 0.5
  let tx = target.x, ty = target.y + 1.0, tz = target.z
  let dx = tx - sx, dy = ty - sy, dz = tz - sz
  let len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1.5) return
  dx /= len; dy /= len; dz /= len
  for (let i = 0; i < 3; i++) {
    let e = level.createEntity('minecraft:arrow')
    if (e === null) return
    let spread = (i - 1) * 0.06
    let vx = (dx + spread * dz) * CONSORTIUM_TRAPS_ARROW_SPEED, vy = (dy + 0.02) * CONSORTIUM_TRAPS_ARROW_SPEED, vz = (dz - spread * dx) * CONSORTIUM_TRAPS_ARROW_SPEED
    e.setPosition(sx + dx * 0.9, sy + dy * 0.9, sz + dz * 0.9)
    e.mergeNbt({ pickup: 0, damage: CONSORTIUM_TRAPS_ARROW_DAMAGE, crit: 0, life: 0, Motion: [vx, vy, vz], Tags: ['consortium_trap'] })
    e.spawn()
  }
  consortiumTrapsSound(server, level, slit, 'minecraft:entity.arrow.shoot', 0.9)
}

// Puts every trap back to rest (closed pits, no fire).
function consortiumTrapsReset(server) {
  let root = consortiumTrapsRoot(server)
  if (root === null) return 0
  let level = consortiumTrapsLevel(server, root)
  if (level === null) return 0
  let groups = consortiumTrapsGroups(root)
  let n = 0
  for (let i = 0; i < groups.length; i++) {
    let g = groups[i]
    if (g.kind === 'pitfall') { for (let j = 0; j < g.cells.length; j++) if (consortiumTrapsSetOpen(level, g.cells[j], false)) n++ }
    else if (g.kind === 'vent') { consortiumTrapsVentSet(server, level, g, false); n++ }
  }
  consortiumTrapsState = { checked: true, pitOpenUntil: {}, pitCoolUntil: {}, ventBurning: {}, arrowCoolUntil: {} }
  return n
}

// One scan: closes pits and vents that ran out, then fires what the players trigger when the traps are live.
function consortiumTrapsStep(server) {
  let root = consortiumTrapsRoot(server)
  if (root === null) return
  if (!consortiumTrapsState.checked) { consortiumTrapsReset(server); return }
  let level = consortiumTrapsLevel(server, root)
  if (level === null) return
  let now = server.tickCount
  let live = consortiumTrapsLive(server)
  let groups = consortiumTrapsGroups(root)
  let victims = live ? consortiumTrapsVictims(server, level) : []
  let st = consortiumTrapsState
  for (let i = 0; i < groups.length; i++) {
    let g = groups[i]
    if (g.kind === 'pitfall') {
      if (st.pitOpenUntil[i] !== undefined) {
        if (now >= st.pitOpenUntil[i]) {
          for (let j = 0; j < g.cells.length; j++) consortiumTrapsSetOpen(level, g.cells[j], false)
          delete st.pitOpenUntil[i]
          consortiumTrapsSound(server, level, g.cells[0], 'minecraft:block.iron_trapdoor.close', 0.8)
        }
        continue
      }
      if (!live || (st.pitCoolUntil[i] !== undefined && now < st.pitCoolUntil[i])) continue
      let hit = false
      for (let v = 0; v < victims.length && !hit; v++) hit = consortiumTrapsStandingIn(victims[v], g.trigger)
      if (!hit) continue
      for (let j = 0; j < g.cells.length; j++) consortiumTrapsSetOpen(level, g.cells[j], true)
      st.pitOpenUntil[i] = now + CONSORTIUM_TRAPS_PIT_OPEN
      st.pitCoolUntil[i] = now + CONSORTIUM_TRAPS_PIT_COOLDOWN
      consortiumTrapsSound(server, level, g.cells[0], 'minecraft:block.iron_trapdoor.open', 0.6)
    } else if (g.kind === 'vent') {
      // phase within the cycle, offset per group
      let phase = (now + i * 53) % CONSORTIUM_TRAPS_VENT_CYCLE
      let burning = st.ventBurning[i] === true
      if (!live) {
        // a test burn runs its full duration even while idle; anything else goes out at once
        if (burning && (st.ventTestUntil === undefined || now >= st.ventTestUntil)) { consortiumTrapsVentSet(server, level, g, false); st.ventBurning[i] = false; delete st.ventTestUntil }
        continue
      }
      if (phase < CONSORTIUM_TRAPS_VENT_WARN) {
        if (burning) { consortiumTrapsVentSet(server, level, g, false); st.ventBurning[i] = false }
        if (phase % 8 === 0) for (let j = 0; j < g.cells.length; j++) consortiumTrapsParticles(server, level, g.cells[j], 'minecraft:campfire_cosy_smoke', 6)
      } else if (phase < CONSORTIUM_TRAPS_VENT_WARN + CONSORTIUM_TRAPS_VENT_BURN) {
        if (!burning) { consortiumTrapsVentSet(server, level, g, true); st.ventBurning[i] = true }
      } else if (burning) { consortiumTrapsVentSet(server, level, g, false); st.ventBurning[i] = false }
    } else if (g.kind === 'arrows') {
      if (!live || (st.arrowCoolUntil[i] !== undefined && now < st.arrowCoolUntil[i])) continue
      let target = null
      for (let v = 0; v < victims.length && target === null; v++) if (consortiumTrapsStandingIn(victims[v], g.trigger)) target = victims[v]
      if (target === null) continue
      consortiumTrapsVolley(server, level, g, target)
      st.arrowCoolUntil[i] = now + CONSORTIUM_TRAPS_ARROW_COOLDOWN
    }
  }
}

// /consortium hq traps [status|on|off|events|test|reset]
function consortiumTrapsCommand(server, verb, by) {
  let root = consortiumTrapsRoot(server)
  if (root === null) return { ok: false, reason: 'No traps are recorded: build a layout that carries traps first (/consortium hq build).' }
  let groups = consortiumTrapsGroups(root)
  let count = { pitfall: 0, vent: 0, arrows: 0 }
  for (let i = 0; i < groups.length; i++) count[groups[i].kind]++
  let summary = count.pitfall + ' pitfall(s), ' + count.vent + ' vent group(s), ' + count.arrows + ' arrow slit(s)'
  if (verb === 'status') return { ok: true, text: 'Traps: ' + summary + ' in ' + root.getString('dim') + ', mode ' + consortiumTrapsMode(server) + ', ' + (consortiumTrapsLive(server) ? 'live now' : 'idle') + '.' }
  if (verb === 'on' || verb === 'off' || verb === 'events') {
    root.putString('mode', verb)
    if (verb === 'off') consortiumTrapsReset(server)
    console.info('[Consortium] ' + by + ' hq traps ' + verb)
    return { ok: true, text: 'Traps mode ' + verb + (verb === 'events' ? ' (live while an invasion, a Friday Zone or an arena bounty runs)' : '') + ': ' + summary + '.' }
  }
  if (verb === 'reset') return { ok: true, text: 'Traps reset: ' + consortiumTrapsReset(server) + ' group(s) closed or put out.' }
  if (verb === 'test') {
    let level = consortiumTrapsLevel(server, root)
    if (level === null) return { ok: false, reason: 'The traps dimension is not loaded.' }
    let now = server.tickCount
    let st = consortiumTrapsState
    st.checked = true
    for (let i = 0; i < groups.length; i++) {
      let g = groups[i]
      if (g.kind === 'pitfall') { for (let j = 0; j < g.cells.length; j++) consortiumTrapsSetOpen(level, g.cells[j], true); st.pitOpenUntil[i] = now + CONSORTIUM_TRAPS_PIT_OPEN }
      else if (g.kind === 'vent') { consortiumTrapsVentSet(server, level, g, true); st.ventBurning[i] = true; st.ventTestUntil = now + CONSORTIUM_TRAPS_VENT_BURN }
      else if (g.kind === 'arrows') { let c = root.getCompound('arena'); consortiumTrapsVolley(server, level, g, { x: c.getInt('x') + 0.5, y: c.getInt('y'), z: c.getInt('z') + 0.5 }) }
    }
    console.info('[Consortium] ' + by + ' hq traps test')
    return { ok: true, text: 'Traps test fired: ' + summary + ' (pits close in 3 s, vents go out at their next cycle, arrows aimed at the arena centre).' }
  }
  return { ok: false, reason: 'Verb: status, on, off, events, test or reset.' }
}

ServerEvents.tick((event) => {
  let server = event.server
  if (server.tickCount % CONSORTIUM_TRAPS_PERIOD !== 0) return
  try { consortiumTrapsStep(server) } catch (err) { console.error('[Consortium] traps step failed: ' + err) }
})

console.info('[Consortium] arena traps loaded (' + CONSORTIUM_TRAPS_ROOT + ', /consortium hq traps)')
