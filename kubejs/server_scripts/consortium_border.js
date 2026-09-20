// priority: 10
// The Consortium - the Nether fence (docs/DISCORD_AND_COMMUNITY.md 10, docs/BATCH_3_INTERFACES.md 1; PROJECT_RULES 4.5
// "nothing lost"). Needs consortium_lib.js only. A beta-gated feature (DECISIONS: ChunkyBorder is the tested
// alternative): vanilla has ONE world border shared by every dimension (every `worldborder` subcommand edits the
// overworld border and the Nether and the End mirror it), so the Nether radius of 375 blocks is a KubeJS fence.
//
// Every 20 ticks each Nether player's last in-bounds position is recorded (in memory); a player farther than the fence
// radius from the fence centre is dismounted and teleported back to that position (never to a clamped point, which
// would land inside netherrack, a wall or lava), or to the overworld spawn when none is recorded; the action bar line
// is sent at most once per 10 s per player. Centre and radius derive from the overworld border (centre / 8, size /
// 16: 6000 gives 375), so there is no second source of truth; the fence is inactive while the overworld border keeps
// its default size (about 60,000,000 blocks). The fence stops players, not chunk generation. /consortium border (op 2,
// the DISCORD BLOCK of consortium_commands.js) prints the centre and radius.
//
// No em dashes. Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_BORDER_TICKS = 20
const CONSORTIUM_BORDER_NOTICE_MS = 10000
const CONSORTIUM_BORDER_DIM = 'minecraft:the_nether'
const CONSORTIUM_BORDER_OVERWORLD = 'minecraft:overworld'
const CONSORTIUM_BORDER_MAX_SIZE = 1000000 // a larger overworld border is the vanilla default: no fence

let consortiumBorderLast = {}     // uuid -> { x, y, z } last in-bounds Nether position
let consortiumBorderNoticeAt = {} // uuid -> Date.now() of the last action bar line

// { cx, cz, radius } of the Nether fence, or null while the overworld border is at its default size.
function consortiumBorderFence(server) {
  let wb = server.overworld().getWorldBorder()
  let size = Number(wb.getSize())
  if (!(size < CONSORTIUM_BORDER_MAX_SIZE)) return null
  return { cx: Number(wb.getCenterX()) / 8, cz: Number(wb.getCenterZ()) / 8, radius: size / 16 }
}

function consortiumBorderText(server) {
  let fence = consortiumBorderFence(server)
  if (fence === null) return 'Nether fence inactive: the overworld border is at its default size (run worldborder center and worldborder set first).'
  return 'Nether fence: centre ' + Math.round(fence.cx) + ' ' + Math.round(fence.cz) + ', radius ' + Math.round(fence.radius) + ' blocks (overworld border / 8; the vanilla border is shared by every dimension).'
}

function consortiumBorderStep(server) {
  let fence = consortiumBorderFence(server)
  if (fence === null) return
  let now = Date.now()
  for (let p of server.players) {
    if (String(p.level.dimension) !== CONSORTIUM_BORDER_DIM) continue
    let uuid = String(p.uuid).toLowerCase()
    let x = Number(p.getX())
    let y = Number(p.getY())
    let z = Number(p.getZ())
    if (Math.max(Math.abs(x - fence.cx), Math.abs(z - fence.cz)) <= fence.radius) {
      consortiumBorderLast[uuid] = { x: x, y: y, z: z }
      continue
    }
    let name = String(p.username)
    let last = consortiumBorderLast[uuid]
    if (last) {
      server.runCommandSilent('execute in ' + CONSORTIUM_BORDER_DIM + ' run tp ' + name + ' ' + last.x.toFixed(2) + ' ' + last.y.toFixed(2) + ' ' + last.z.toFixed(2))
    } else {
      let spawn = server.overworld().getSharedSpawnPos()
      server.runCommandSilent('execute in ' + CONSORTIUM_BORDER_OVERWORLD + ' run tp ' + name + ' ' + spawn.getX() + ' ' + (spawn.getY() + 1) + ' ' + spawn.getZ())
    }
    if (!consortiumBorderNoticeAt[uuid] || now - consortiumBorderNoticeAt[uuid] >= CONSORTIUM_BORDER_NOTICE_MS) {
      consortiumBorderNoticeAt[uuid] = now
      server.runCommandSilent('title ' + name + ' actionbar ' + JSON.stringify({ text: 'The Nether is fenced at ' + Math.round(fence.radius) + ' blocks from the centre this season.', color: 'yellow' }))
      console.info('[Consortium] border: ' + name + ' pushed back inside the Nether fence' + (last ? '' : ' (no recorded position: sent to the overworld spawn)'))
    }
  }
}

ServerEvents.loaded((event) => {
  consortiumBorderLast = {}
  consortiumBorderNoticeAt = {}
  try { console.info('[Consortium] border: ' + consortiumBorderText(event.server)) } catch (err) { console.error('[Consortium] border read failed: ' + err) }
})

let consortiumBorderFailAt = 0
ServerEvents.tick((event) => {
  if (event.server.tickCount % CONSORTIUM_BORDER_TICKS !== 7) return
  try { consortiumBorderStep(event.server) } catch (err) {
    if (Date.now() - consortiumBorderFailAt > 60000) { consortiumBorderFailAt = Date.now(); console.error('[Consortium] border step failed: ' + err) }
  }
})

PlayerEvents.loggedOut((event) => {
  let uuid = String(event.player.uuid).toLowerCase()
  delete consortiumBorderLast[uuid]
  delete consortiumBorderNoticeAt[uuid]
})
