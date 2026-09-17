// priority: 20
// The Consortium - random events engine (docs/EVENTS.md, content batch 2; PROJECT_RULES 4.1, 4.2, 4.3, 4.6;
// PROGRESSION 13 and 14). Needs consortium_lib.js, consortium_phases.js (Consortium.def/phase/progress/seasonDay,
// consortiumPublishBoard) and consortium_events_lib.js (flags, claims, spots, spawning, the ConsortiumEvents
// shell). Consortium_money.js multiplies ConsortiumEvents.quoteFactor into its single setMultiplier call,
// consortium_phases.js reads ConsortiumEvents.quotaFactor in Consortium.record, boardObject in the board
// payload and fireworks at phase completion (all typeof-guarded, all at call time).
//
// Ten events, one at a time (EVENTS 3): three market multipliers, a market crash, Double Quota Hour, a supply
// drop crate, an Apotheosis bounty boss, an invasion at the HQ arena, a blood moon through In Control and the
// staff-only Friday Zone. Random rolls happen at most twice a day inside the windows; staff start, queue,
// pause and stop them with /consortium event ... (the events block of consortium_commands.js).
//
// Never free resources (4.1): an event multiplies credits or quota progress, spawns mobs, or places one crate
// whose consortium:* loot table holds no priced item. Never a base (4.6): every spawn and crate is placed by
// consortium_events_lib.js outside hostile claims; engine mobs inside one are discarded every 5 s. Never a
// silent price move (4.2): start, minus 5 and end lines. Never a rank shortcut (4.3): payouts go through
// ConsortiumCore.credit, never addRankCredit. Capped mint (EVENTS 4): per event, per day and per week.
//
// State (server.persistentData.consortium.events, saved with the world; EVENTS 2.2):
//   version, paused, arena { dim, x, y, z, team, radius }, active { id, startedAt, endsAt, forced, calendar,
//   ... per event }, cooldowns.<id>, dayKey, dayCount, lastRollSlot, queued { id, at, calendar, args,
//   reminded60, reminded5 }, optin.<uuid>, dailyPaid.<uuid> { day, cents, week, weekCents }, summaryDay,
//   wednesdayWeek, tickets.<uuid> (SHOP's key, read through Consortium.tickets only), log (last 10 events).
// Top-level flag (never nested): consortium_event_bloodmoon, read by In Control's kubejs condition.
// Inspect with: /kubejs persistent-data server get consortium
//
// Reload safe: no scheduleRepeating (its callbacks survive /reload and duplicate); the 5 s step lives in
// ServerEvents.tick; listeners are re-registered by KubeJS on every reload. Inert (no listener, no tick)
// unless CONSORTIUM_EVENTS_ON (Consortium Core and FTB Chunks present, consortium_events_lib.js).
//
// Every number marked PLACEHOLDER is tuned in the closed beta (balancing journal). No em dashes anywhere.
// Rhino: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_EVENTS_VERSION = 2
const CONSORTIUM_EVENT_BAR = 'consortium:event'
const CONSORTIUM_EVENT_STEP_TICKS = 100          // the 5 s step
const CONSORTIUM_EVENT_BOARD_MS = 60000          // board republish cadence while an event runs (seconds_left)
const CONSORTIUM_EVENT_ROLL_P = 0.25             // PLACEHOLDER: chance of a start per rollable half-hour slot
const CONSORTIUM_EVENT_MIN_ONLINE = 3            // PLACEHOLDER: players online for a random start
const CONSORTIUM_EVENT_MIN_ONLINE_MARKET = 2     // PLACEHOLDER: same for market events
const CONSORTIUM_EVENT_DAY_CAP = 2               // random starts per season day
const CONSORTIUM_EVENT_SLOT_MARGIN_MS = 5 * 60000 // an event must end 5 minutes before the next rule 4.6 slot
const CONSORTIUM_EVENT_MUSTER_MS = 5 * 60000
const CONSORTIUM_EVENT_WAVES_MS = 15 * 60000
const CONSORTIUM_EVENT_FINALE_MS = 10 * 60000
const CONSORTIUM_EVENT_CRATE_MS = 10 * 60000
const CONSORTIUM_EVENT_CRATE_SEARCH = 4          // the Friday crate looks this many blocks above the arena centre for an air block on solid ground
const CONSORTIUM_EVENT_BOSS_MISSING_MS = 60000   // a bounty is void after 60 s without its boss
const CONSORTIUM_EVENT_BLOODMOON_WAIT_MS = 15 * 60000
const CONSORTIUM_EVENT_BLOODMOON_NIGHT_MS = 12 * 60000
const CONSORTIUM_EVENT_WAVE_ALIVE_PER_PLAYER = 6 // PLACEHOLDER
const CONSORTIUM_EVENT_WAVE_ALIVE_CAP = 24       // PLACEHOLDER
const CONSORTIUM_EVENT_WAVE_PER_STEP = 4         // PLACEHOLDER
const CONSORTIUM_EVENT_WAVE_RADIUS = 48          // wave mobs beyond this distance from the centre are discarded
const CONSORTIUM_EVENT_TICKET_CHANCE = 0.3       // PLACEHOLDER: crate opener ticket bonus
const CONSORTIUM_EVENT_CRASH_FACTOR = 0.5        // PLACEHOLDER
const CONSORTIUM_EVENT_CRASH_MIN_RATIO = 0.6     // a crash only hits a line at 60 % or more
const CONSORTIUM_EVENT_LOG_MAX = 10

// EVENTS 4: the median design income day per active player, in cents (PRICE_TABLE 5.4 and 6), PLACEHOLDER.
const CONSORTIUM_EVENT_INCOME_REF = { 1: 17600, 2: 35800, 3: 26500, 4: 35800, 5: 31600 }
// Pots and caps as fractions of the reference (PLACEHOLDER).
const CONSORTIUM_EVENT_BOUNTY_POT = 1.5
const CONSORTIUM_EVENT_BOUNTY_SHARE_CAP = 0.5
const CONSORTIUM_EVENT_WAVE_KILL = 0.01
const CONSORTIUM_EVENT_WAVE_CAP = 0.3
const CONSORTIUM_EVENT_DAILY_CAP = 0.6
const CONSORTIUM_EVENT_WEEKLY_CAP = 0.7

// Wave table (PLACEHOLDER): weight per entity, the vindicator from phase 3.
const CONSORTIUM_EVENT_WAVE_TABLE = [
  { id: 'minecraft:zombie', weight: 5, minPhase: 1 },
  { id: 'minecraft:skeleton', weight: 3, minPhase: 1 },
  { id: 'minecraft:spider', weight: 2, minPhase: 1 },
  { id: 'minecraft:vindicator', weight: 1, minPhase: 3 },
]
const CONSORTIUM_EVENT_WAVE_BASE_HEALTH = { 'minecraft:zombie': 20, 'minecraft:skeleton': 20, 'minecraft:spider': 16, 'minecraft:vindicator': 24 }

// Random windows (server time): every day 18:00-23:00, plus Saturday (6) and Sunday (0) 14:00-18:00.
const CONSORTIUM_EVENT_WINDOWS = [
  { days: [0, 1, 2, 3, 4, 5, 6], from: 18, to: 23 },
  { days: [0, 6], from: 14, to: 18 },
]

const CONSORTIUM_EVENT_CALENDARS = ['none', 'friday', 'saturday']

// ---- state ------------------------------------------------------------------------------------------

function consortiumEvents(server) {
  let st = consortiumState(server)
  if (!st.contains('events')) st.put('events', NBT.compoundTag())
  let ev = st.getCompound('events')
  if (!ev.contains('version')) {
    ev.putInt('version', CONSORTIUM_EVENTS_VERSION)
    ev.putBoolean('paused', true) // off by default until the beta ends (EVENTS 6)
  }
  for (let key of ['cooldowns', 'optin', 'dailyPaid']) {
    if (!ev.contains(key)) ev.put(key, NBT.compoundTag())
  }
  return ev
}

function consortiumActiveEvent(server) {
  let ev = consortiumEvents(server)
  return ev.contains('active') ? ev.getCompound('active') : null
}

function consortiumActiveId(server) {
  let active = consortiumActiveEvent(server)
  return active === null ? '' : String(active.getString('id'))
}

// The HQ arena record as a plain object { dim, x, y, z, team, radius }, or null until staff set it.
function consortiumArena(server) {
  let ev = consortiumEvents(server)
  if (!ev.contains('arena')) return null
  let a = ev.getCompound('arena')
  if (!a.contains('team') || String(a.getString('team')).length === 0) return null
  return { dim: String(a.getString('dim')), x: a.getInt('x'), y: a.getInt('y'), z: a.getInt('z'),
    team: String(a.getString('team')).toLowerCase(), radius: Math.max(1, a.getInt('radius')) }
}

function consortiumLevelOf(server, dim) {
  return server.getLevel(CONSORTIUM_RL.parse(String(dim)))
}

function consortiumArenaLevel(server, arena) {
  return consortiumLevelOf(server, arena.dim)
}

function consortiumArenaCentre(arena) {
  return BlockPos.containing(arena.x, arena.y, arena.z)
}

function consortiumEventSub(tag, key) {
  if (!tag.contains(key)) tag.put(key, NBT.compoundTag())
  return tag.getCompound(key)
}

function consortiumUuidOf(player) {
  return String(player.uuid).toLowerCase()
}

function consortiumEventRef(server) {
  return CONSORTIUM_EVENT_INCOME_REF[Consortium.phase(server)] || CONSORTIUM_EVENT_INCOME_REF[1]
}

function consortiumSeasonWeek(server) {
  return Math.floor((Consortium.seasonDay(server) - 1) / 7)
}

// Per-player event credits today and this season week, lazily reset (EVENTS 4).
function consortiumDailyPaid(server, uuid) {
  let all = consortiumEventSub(consortiumEvents(server), 'dailyPaid')
  let d = consortiumEventSub(all, uuid)
  let day = Consortium.seasonDay(server)
  let week = consortiumSeasonWeek(server)
  if (d.getInt('day') !== day) { d.putInt('day', day); d.putLong('cents', 0) }
  if (d.getInt('week') !== week) { d.putInt('week', week); d.putLong('weekCents', 0) }
  return d
}

// Cents the player may still earn from events today and this week (never negative).
function consortiumEventRoom(server, uuid) {
  let ref = consortiumEventRef(server)
  let d = consortiumDailyPaid(server, uuid)
  let day = Math.floor(ref * CONSORTIUM_EVENT_DAILY_CAP) - d.getLong('cents')
  let week = Math.floor(ref * CONSORTIUM_EVENT_WEEKLY_CAP) - d.getLong('weekCents')
  return Math.max(0, Math.min(day, week))
}

// Books cents against the caps and the active event's payouts without crediting (market bonuses: the mod paid).
function consortiumEventBook(server, active, uuid, cents) {
  if (cents <= 0) return
  let d = consortiumDailyPaid(server, uuid)
  d.putLong('cents', d.getLong('cents') + cents)
  d.putLong('weekCents', d.getLong('weekCents') + cents)
  if (active !== null) {
    let payouts = consortiumEventSub(active, 'payouts')
    payouts.putLong(uuid, payouts.getLong(uuid) + cents)
  }
}

// Pays `cents` clipped to the day and week room through ConsortiumCore.credit (ledger API_CREDIT, structured
// reason), booking the amount BEFORE the credit call so a crash between the two never double-pays. Returns the
// cents paid (0 when the room is spent or the ledger refused; a refusal is logged, never retried). Rule 4.3:
// never addRankCredit.
function consortiumEventPay(server, active, uuid, cents, reason) {
  let amount = Math.min(Math.floor(cents), consortiumEventRoom(server, uuid))
  if (amount <= 0) return 0
  consortiumEventBook(server, active, uuid, amount)
  let result = ConsortiumCore.credit(CONSORTIUM_UUID.fromString(uuid), amount, reason)
  if (String(result) !== 'SUCCESS') {
    console.warn('[Consortium] event payout of ' + amount + ' cents to ' + uuid + ' (' + reason + ') refused: ' + result)
    return 0
  }
  return amount
}

function consortiumEventPlayerName(server, uuid) {
  for (let p of server.players) {
    if (consortiumUuidOf(p) === uuid) return String(p.username)
  }
  let who = consortiumResolvePlayer(server, uuid)
  return who === null ? uuid.slice(0, 8) : who.name
}

function consortiumEventOnline(server, uuid) {
  for (let p of server.players) {
    if (consortiumUuidOf(p) === uuid) return p
  }
  return null
}

function consortiumClock(ms) {
  let d = new Date(ms)
  let h = d.getHours()
  let m = d.getMinutes()
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
}

function consortiumEventJoinLink() {
  return [{ text: ' [join]', color: 'aqua', underlined: true,
    clickEvent: { action: 'run_command', value: '/consortium event join' },
    hoverEvent: { action: 'show_text', contents: 'Click to take part' } }]
}

function consortiumEventFlag(uuid, key) {
  if (typeof ConsortiumQuests === 'undefined' || typeof ConsortiumQuests.flag !== 'function') return false
  try { ConsortiumQuests.flag(uuid, key); return true } catch (err) { console.error('[Consortium] quest flag ' + key + ' failed: ' + err); return false }
}

// Top 3 "Name N" of a compound of numbers, highest first.
function consortiumEventTop(server, tag, unit) {
  let rows = []
  for (let key of tag.getAllKeys()) rows.push({ uuid: String(key), n: unit === 'cents' ? tag.getLong(key) : tag.getDouble(key) })
  rows.sort((a, b) => b.n - a.n)
  let out = []
  for (let i = 0; i < rows.length && i < 3; i++) {
    out.push(consortiumEventPlayerName(server, rows[i].uuid) + ' ' + (unit === 'cents' ? ConsortiumCore.format(rows[i].n) : unit === 'int' ? Math.round(rows[i].n) : rows[i].n))
  }
  return out.join(', ')
}

function consortiumEventArenaPlayers(server, arena, filter) {
  let out = []
  if (arena === null) return out
  let centre = consortiumArenaCentre(arena)
  let level = consortiumArenaLevel(server, arena)
  if (level === null) return out
  for (let p of server.players) {
    if (String(p.level.dimension) !== arena.dim) continue
    if (!consortiumInArena(level, p.blockPosition(), arena)) continue
    if (filter && !filter(p)) continue
    out.push(p)
  }
  return out
}

// ---- families on the quota (market factor scope, EVENTS 3.1) ---------------------------------------

let consortiumQuotaFamilyCache = { phase: 0, families: {} }

// The price families of the current phase's quota lines, built lazily (the price index exists only after the
// tags load), cached per phase number and rebuilt by /reload (script scope reset).
function consortiumQuotaFamilies(server) {
  let n = Consortium.phase(server)
  if (consortiumQuotaFamilyCache.phase === n) return consortiumQuotaFamilyCache.families
  let families = {}
  let def = Consortium.def(n)
  for (let i = 0; i < def.quota.length; i++) {
    let line = def.quota[i]
    let ids = line.items && line.items.length ? line.items : [line.id]
    for (let j = 0; j < ids.length; j++) {
      if (String(ids[j]).charAt(0) === '#') continue
      try {
        let fam = ConsortiumCore.familyOf(Item.of(ids[j]).item)
        if (fam.isPresent()) families[String(fam.get())] = line.id
      } catch (err) { /* unknown item id: not priced */ }
    }
  }
  consortiumQuotaFamilyCache = { phase: n, families: families }
  return families
}

function consortiumFamilyOnQuota(server, family) {
  return Object.prototype.hasOwnProperty.call(consortiumQuotaFamilies(server), String(family))
}

// The quota line of the current phase fed by a price family, or null.
function consortiumQuotaLineOfFamily(server, family) {
  let lineId = consortiumQuotaFamilies(server)[String(family)]
  if (!lineId) return null
  let prog = Consortium.progress(server, Consortium.phase(server))
  for (let i = 0; i < prog.lines.length; i++) {
    if (prog.lines[i].line.id === lineId) return prog.lines[i]
  }
  return null
}

// The factor quoteFactor last returned per "uuid|family" (transient: the DeliveryEvent listener divides by it).
let consortiumEventLastFactor = {}

// ---- announcements ---------------------------------------------------------------------------------

function consortiumEventAnnounce(server, body, extra) {
  // Discord through the safe say relay, the game through tellraw when a click action is needed.
  if (extra) {
    consortiumSay(server, body, extra)
    consortiumDiscord(server, body)
  } else {
    consortiumBroadcast(server, body)
  }
}

function consortiumEventActionBar(server, text) {
  server.runCommandSilent('title @a actionbar ' + JSON.stringify({ text: text, color: 'yellow' }))
}

// ---- catalogue ---------------------------------------------------------------------------------------
// Each definition: name, kind, minutes (whole footprint), cooldownHours, weight (0 = never rolled),
// minPhase (random rolls), staffMinPhase (optional, lower bound for staff and queued starts), minOnline,
// precondition(server) -> reason or null (roll and start), start(server, active, args) -> refusal string or
// null, tick(server, active, now), results(server, active, reason) -> summary text, cleanup(server, active),
// detail(server, active) -> board detail.

function consortiumMarketDef(name, charterFamily, factor, minutes, cooldownHours, weight, minPhase, lower) {
  return {
    name: name, kind: 'market', minutes: minutes, cooldownHours: cooldownHours, weight: weight, minPhase: minPhase,
    minOnline: CONSORTIUM_EVENT_MIN_ONLINE_MARKET,
    precondition: (server) => null,
    start: (server, active, args) => {
      active.putString('family', charterFamily)
      active.putDouble('factor', factor)
      let n = Consortium.phase(server)
      consortiumEventAnnounce(server, name + ': ' + lower + ' deliveries of the Phase ' + n + ' quota pay x' + factor + ' at every terminal until ' + consortiumClock(active.getLong('endsAt')) + '.')
      consortiumTitle(server, name, lower.charAt(0).toUpperCase() + lower.slice(1) + ' deliveries pay x' + factor + ' for ' + minutes + ' minutes')
      return null
    },
    tick: (server, active, now) => consortiumMarketWarn(server, active, now, name),
    results: (server, active, reason) => 'The ' + name.toLowerCase() + ' is over. Prices are back to normal.',
    cleanup: (server, active) => {},
    detail: (server, active) => 'x' + factor + ' on ' + lower + ' deliveries',
  }
}

// "5 minutes left" once per market event (a confirm after the end is re-quoted and refused by the mod).
function consortiumMarketWarn(server, active, now, name) {
  if (active.getBoolean('warned')) return
  if (active.getLong('endsAt') - now > CONSORTIUM_EVENT_SLOT_MARGIN_MS) return
  active.putBoolean('warned', true)
  consortiumEventAnnounce(server, name + ' ends in 5 minutes. Confirm your deliveries before ' + consortiumClock(active.getLong('endsAt')) + '.')
  consortiumEventActionBar(server, name + ' ends in 5 minutes')
}

const CONSORTIUM_EVENT_DEFS = {
  ore_rush: consortiumMarketDef('Ore Rush', 'raw', 2.0, 60, 24, 20, 1, 'raw'),
  power_surge: consortiumMarketDef('Power Surge', 'power', 2.0, 45, 24, 15, 1, 'power'),
  logistics_week: consortiumMarketDef('Logistics Week', 'transport', 1.5, 90, 48, 12, 2, 'transport'),

  market_crash: {
    name: 'Market Crash', kind: 'crash', minutes: 60, cooldownHours: 72, weight: 5, minPhase: 2, minOnline: CONSORTIUM_EVENT_MIN_ONLINE_MARKET,
    precondition: (server) => consortiumCrashCandidates(server).length ? null : 'no quota line at 60 % or more (or the phase is stalled)',
    start: (server, active, args) => {
      let family = null
      if (args.length) {
        family = String(args[0])
        if (!ConsortiumCore.price(family).isPresent()) return 'unknown price family ' + family
        if (!consortiumFamilyOnQuota(server, family)) return family + ' is not a quota line of this phase'
        let line = consortiumQuotaLineOfFamily(server, family)
        if (line === null || line.ratio < CONSORTIUM_EVENT_CRASH_MIN_RATIO) return 'the ' + family + ' line is under 60 %'
      } else {
        let candidates = consortiumCrashCandidates(server)
        if (!candidates.length) return 'no quota line at 60 % or more'
        family = candidates[Math.floor(Math.random() * candidates.length)]
      }
      active.putString('family', family)
      active.putDouble('factor', CONSORTIUM_EVENT_CRASH_FACTOR)
      let label = String(ConsortiumCore.price(family).get().name())
      active.putString('label', label)
      consortiumEventAnnounce(server, 'Market Crash: ' + label + ' pay half until ' + consortiumClock(active.getLong('endsAt')) + '. Deliveries still count for the quota.')
      consortiumTitle(server, 'Market Crash', label + ' pay half for 60 minutes')
      return null
    },
    tick: (server, active, now) => consortiumMarketWarn(server, active, now, 'The market crash'),
    results: (server, active, reason) => 'The market crash is over: ' + active.getString('label') + ' pay full price again.',
    cleanup: (server, active) => {},
    detail: (server, active) => active.getString('label') + ' pay half',
  },

  double_quota: {
    name: 'Double Quota Hour', kind: 'quota', minutes: 60, cooldownHours: 48, weight: 10, minPhase: 1, minOnline: CONSORTIUM_EVENT_MIN_ONLINE_MARKET,
    precondition: (server) => Consortium.phaseTag(server, Consortium.phase(server)).getLong('completedAt') > 0 ? 'the phase is complete' : null,
    start: (server, active, args) => {
      consortiumEventAnnounce(server, 'Double Quota Hour: every delivery counts twice for the Phase ' + Consortium.phase(server) + ' quota until ' + consortiumClock(active.getLong('endsAt')) + '.')
      consortiumTitle(server, 'Double Quota Hour', 'Deliveries count twice for 60 minutes')
      return null
    },
    tick: (server, active, now) => consortiumMarketWarn(server, active, now, 'Double Quota Hour'),
    results: (server, active, reason) => 'Double Quota Hour is over. Deliveries count once again.',
    cleanup: (server, active) => {},
    detail: (server, active) => 'deliveries count twice',
  },

  supply_drop: {
    name: 'Supply Drop', kind: 'field', minutes: 30, cooldownHours: 24, weight: 18, minPhase: 1, minOnline: CONSORTIUM_EVENT_MIN_ONLINE,
    precondition: (server) => consortiumSupplyAnchor(server) === null ? 'no player in the overworld' : null,
    start: (server, active, args) => {
      let level = server.overworld()
      let anchor = consortiumSupplyAnchor(server)
      if (anchor === null) return 'no player in the overworld'
      let pos = consortiumEventSpot(level, anchor.blockPosition(), 48, 64, 2, null, null)
      if (pos === null) return 'no spot 2 chunks clear of every claim near ' + anchor.username
      let table = Consortium.phase(server) >= 4 ? 'consortium:event/supply_drop_late' : 'consortium:event/supply_drop'
      if (!consortiumPlaceCrate(server, active, level, pos, table, args.indexOf('meteor') >= 0)) return 'the crate spot ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' is no longer air'
      level.spawnLightning(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5, true)
      consortiumTitle(server, 'Supply Drop', 'Crate sighted at ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ())
      consortiumEventAnnounce(server, 'Supply drop sighted at ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + '. First crew there keeps the crate. It vanishes at ' + consortiumClock(active.getLong('endsAt')) + '.')
      return null
    },
    tick: (server, active, now) => {
      if (!consortiumCratePresent(server, active)) consortiumStopEvent(server, 'done', null)
    },
    results: (server, active, reason) => {
      let by = String(active.getString('openedBy'))
      if (by.length === 0) return reason === 'done' ? 'The crate was recovered by an unknown crew.' : 'The crate vanished unclaimed.'
      return 'The crate was recovered by ' + consortiumEventPlayerName(server, by) + (active.getBoolean('ticketBonus') ? ', who also found an event ticket.' : '.')
    },
    cleanup: (server, active) => consortiumRemoveCrate(server, active, true),
    detail: (server, active) => 'crate at ' + active.getInt('x') + ' ' + active.getInt('y') + ' ' + active.getInt('z'),
  },

  bounty: {
    // minPhase gates the random roll; staffMinPhase lets a staff or queued start run the phase 1 Friday slot
    // (EVENTS 3.7: a free staff-started arena invasion or bounty before the ticket sells).
    name: 'Bounty', kind: 'field', minutes: 30, cooldownHours: 24, weight: 15, minPhase: 2, staffMinPhase: 1, minOnline: CONSORTIUM_EVENT_MIN_ONLINE, needs: 'apotheosis',
    precondition: (server) => consortiumBountySpot(server) === null ? 'no wilderness spot' : null,
    start: (server, active, args) => {
      if (!CONSORTIUM_HAS_APOTHEOSIS) return 'Apotheosis absent'
      let n = Consortium.phase(server)
      let arena = args.indexOf('arena') >= 0 ? consortiumArena(server) : null
      if (args.indexOf('arena') >= 0 && arena === null) return 'the arena is not set (/consortium event arena here)'
      let ids = args.filter((a) => a !== 'arena')
      let bossId, rarity
      let profile = CONSORTIUM_BOUNTY_RARITIES[n] || CONSORTIUM_BOUNTY_RARITIES[2]
      if (ids.length >= 1) {
        bossId = String(ids[0])
        if (consortiumBountyBossesUpTo(5).indexOf(bossId) < 0) return 'unknown or unsafe boss id ' + bossId
        rarity = ids.length >= 2 ? String(ids[1]) : profile.rarities[Math.floor(Math.random() * profile.rarities.length)]
        if (CONSORTIUM_BOSS_RARITY_IDS.indexOf(rarity) < 0) return 'unknown rarity ' + rarity + ' (uncommon, rare, epic or mythic; never common)'
      } else {
        let pool = consortiumBountyBossesUpTo(Math.max(2, n))
        bossId = pool[Math.floor(Math.random() * pool.length)]
        rarity = profile.rarities[Math.floor(Math.random() * profile.rarities.length)]
      }
      let level, pos
      if (arena !== null) {
        level = consortiumArenaLevel(server, arena)
        pos = consortiumArenaCentre(arena)
      } else {
        let spot = consortiumBountySpot(server)
        if (spot === null) return 'no wilderness spot'
        level = spot.level
        pos = spot.pos
      }
      let mob
      try { mob = consortiumSpawnBoss(level, pos, bossId, rarity, profile.tier) } catch (err) { return 'boss spawn failed: ' + err }
      let ref = consortiumEventRef(server)
      active.putString('boss', String(mob.uuid))
      active.putString('bossName', String(mob.name.string))
      active.putString('bossDim', String(level.dimension))
      active.putLong('bossMissingSince', 0)
      active.putLong('pot', Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_POT))
      active.putLong('shareCap', Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_SHARE_CAP))
      active.putInt('x', pos.getX()); active.putInt('y', pos.getY()); active.putInt('z', pos.getZ())
      consortiumBossForceLoad(server, active, level, mob.blockPosition())
      consortiumEventAnnounce(server, 'Bounty: ' + active.getString('bossName') + ' (' + rarity.replace('apotheosis:', '') + ') roams near ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + '. '
        + ConsortiumCore.format(active.getLong('pot')) + ' shared by damage, ' + ConsortiumCore.format(active.getLong('shareCap')) + ' max per hunter, 30 minutes.')
      consortiumTitle(server, 'Bounty', active.getString('bossName') + ' near ' + pos.getX() + ' ' + pos.getZ())
      return null
    },
    tick: (server, active, now) => consortiumBossTick(server, active, now, (s, a) => consortiumStopEvent(s, 'void', null)),
    results: (server, active, reason) => {
      if (reason === 'done') return consortiumBountyResultLine(server, active)
      if (reason === 'void') return 'The bounty is void: the boss is gone.'
      return 'The bounty on ' + active.getString('bossName') + ' is closed: nobody claimed it.'
    },
    cleanup: (server, active) => consortiumReleaseForceLoads(server, active.contains('loaded') ? active.getList('loaded', 8) : null),
    detail: (server, active) => active.getString('bossName') + ' near ' + active.getInt('x') + ' ' + active.getInt('z'),
  },

  invasion: {
    name: 'Invasion', kind: 'field', minutes: 20, cooldownHours: 48, weight: 10, minPhase: 2, staffMinPhase: 1, minOnline: CONSORTIUM_EVENT_MIN_ONLINE,
    precondition: (server) => consortiumArena(server) === null ? 'arena not set' : null,
    start: (server, active, args) => {
      if (consortiumArena(server) === null) return 'the arena is not set (/consortium event arena here)'
      let ref = consortiumEventRef(server)
      active.putString('stage', 'muster')
      active.putLong('stageEndsAt', active.getLong('startedAt') + CONSORTIUM_EVENT_MUSTER_MS)
      active.putLong('killCents', Math.floor(ref * CONSORTIUM_EVENT_WAVE_KILL))
      active.putLong('killCap', Math.floor(ref * CONSORTIUM_EVENT_WAVE_CAP))
      consortiumEventAnnounce(server, 'Invasion at the HQ arena in 5 minutes, open to every Recruit: /consortium event join. '
        + ConsortiumCore.format(active.getLong('killCents')) + ' per kill, ' + ConsortiumCore.format(active.getLong('killCap')) + ' max.', consortiumEventJoinLink())
      consortiumTitle(server, 'Invasion', 'Muster at the HQ arena, 5 minutes')
      return null
    },
    tick: (server, active, now) => consortiumInvasionTick(server, active, now, false),
    results: (server, active, reason) => {
      if (reason === 'cancel') return 'No volunteers at the arena, the invasion is called off.'
      return consortiumWaveResultLine(server, active, 'The arena holds.')
    },
    cleanup: (server, active) => {},
    detail: (server, active) => String(active.getString('stage')) === 'muster' ? 'muster at the arena, /consortium event join' : 'waves at the arena',
  },

  blood_moon: {
    name: 'Blood Moon', kind: 'world', minutes: 22, cooldownHours: 72, weight: 12, minPhase: 1, minOnline: CONSORTIUM_EVENT_MIN_ONLINE, needs: 'incontrol',
    precondition: (server) => consortiumOverworldTime(server) < 12000 ? null : 'night already (rolls only by day)',
    start: (server, active, args) => {
      if (!CONSORTIUM_HAS_INCONTROL) return 'In Control absent'
      active.putBoolean('pendingDusk', true)
      active.putLong('duskAt', 0)
      active.putLong('endsAt', active.getLong('startedAt') + CONSORTIUM_EVENT_BLOODMOON_WAIT_MS)
      consortiumEventAnnounce(server, 'Blood Moon at dusk: hostiles are stronger tonight outside claims. Bases stay safe.')
      if (consortiumOverworldTime(server) >= 12500) consortiumBloodMoonRise(server, active, Date.now())
      return null
    },
    tick: (server, active, now) => {
      let t = consortiumOverworldTime(server)
      if (active.getBoolean('pendingDusk')) {
        if (t >= 12500) consortiumBloodMoonRise(server, active, now)
        else if (now >= active.getLong('endsAt')) {
          consortiumEvents(server).getCompound('cooldowns').remove('blood_moon') // no cooldown for a moon that never rose
          consortiumStopEvent(server, 'cancel', null)
        }
        return
      }
      if (t >= 23460 || t < 12000) consortiumStopEvent(server, 'done', null)
    },
    results: (server, active, reason) => reason === 'cancel' ? 'The blood moon never rose (the night never came).' : 'The moon sets. Hostiles are back to normal.',
    cleanup: (server, active) => consortiumBloodMoonClear(server),
    detail: (server, active) => active.getBoolean('pendingDusk') ? 'at dusk' : 'hostiles are stronger outside claims',
  },

  friday_zone: {
    name: 'Friday Zone', kind: 'staff', minutes: 40, cooldownHours: 0, weight: 0, minPhase: 2, minOnline: 0, staffOnly: true,
    precondition: (server) => consortiumArena(server) === null ? 'arena not set' : null,
    start: (server, active, args) => {
      if (consortiumArena(server) === null) return 'the arena is not set (/consortium event arena here)'
      let ref = consortiumEventRef(server)
      active.putString('stage', 'muster')
      active.putLong('stageEndsAt', active.getLong('startedAt') + CONSORTIUM_EVENT_MUSTER_MS)
      active.putLong('endsAt', active.getLong('startedAt') + CONSORTIUM_EVENT_MUSTER_MS + CONSORTIUM_EVENT_WAVES_MS + CONSORTIUM_EVENT_FINALE_MS + CONSORTIUM_EVENT_CRATE_MS)
      active.putLong('killCents', Math.floor(ref * CONSORTIUM_EVENT_WAVE_KILL))
      active.putLong('killCap', Math.floor(ref * CONSORTIUM_EVENT_WAVE_CAP))
      active.putLong('pot', Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_POT))
      active.putLong('shareCap', Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_SHARE_CAP))
      active.put('joined', NBT.compoundTag())
      active.put('admitted', NBT.compoundTag())
      consortiumEventAnnounce(server, 'Friday Zone at the HQ arena in 5 minutes. Ticket holders at the arena: /consortium event join (your ticket is taken when the waves start). '
        + ConsortiumCore.format(active.getLong('killCents')) + ' per kill, ' + ConsortiumCore.format(active.getLong('killCap')) + ' max, then the auditor ('
        + ConsortiumCore.format(active.getLong('pot')) + ' bounty) and the Board\'s crate.', consortiumEventJoinLink())
      consortiumTitle(server, 'Friday Zone', 'Ticket holders muster at the HQ arena')
      return null
    },
    tick: (server, active, now) => consortiumFridayTick(server, active, now),
    results: (server, active, reason) => {
      if (reason === 'cancel') return 'No ticket holder at the arena, the Friday Zone is called off. Nothing was consumed.'
      let crate = String(active.getString('openedBy')).length ? ' Crate opened by ' + consortiumEventPlayerName(server, String(active.getString('openedBy'))) + '.' : ''
      return consortiumWaveResultLine(server, active, 'The Friday Zone closes.') + crate
    },
    cleanup: (server, active) => {
      consortiumReleaseForceLoads(server, active.contains('loaded') ? active.getList('loaded', 8) : null)
      consortiumRemoveCrate(server, active, !active.getBoolean('crateOpened'))
    },
    detail: (server, active) => {
      let stage = String(active.getString('stage'))
      if (stage === 'muster') return 'muster, ticket holders /consortium event join'
      if (stage === 'waves') return 'waves at the arena'
      if (stage === 'finale') return 'the auditor: ' + active.getString('bossName')
      return 'the Board\'s crate at the arena'
    },
  },
}

const CONSORTIUM_EVENT_IDS = Object.keys(CONSORTIUM_EVENT_DEFS)

// ---- event helpers ---------------------------------------------------------------------------------

function consortiumOverworldTime(server) {
  return Number(server.overworld().getDayTime() % 24000)
}

function consortiumSupplyAnchor(server) {
  let candidates = []
  for (let p of server.players) {
    if (String(p.level.dimension) !== 'minecraft:overworld') continue
    candidates.push(p)
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null
}

// A wilderness spot 64..128 blocks from an online overworld player and 13 chunks (200 blocks) from every claim.
function consortiumBountySpot(server) {
  let level = server.overworld()
  let players = []
  for (let p of server.players) {
    if (String(p.level.dimension) === 'minecraft:overworld') players.push(p)
  }
  for (let i = players.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    let t = players[i]; players[i] = players[j]; players[j] = t
  }
  for (let i = 0; i < players.length; i++) {
    let pos = consortiumEventSpot(level, players[i].blockPosition(), 64, 128, 13, null, null)
    if (pos !== null) return { level: level, pos: pos }
  }
  return null
}

// Price families of quota lines at 60 % or more, priced above zero, phase not stalled or complete (EVENTS 3.2).
function consortiumCrashCandidates(server) {
  let n = Consortium.phase(server)
  let tag = Consortium.phaseTag(server, n)
  if (tag.getBoolean('stalled') || tag.getLong('completedAt') > 0) return []
  let families = consortiumQuotaFamilies(server)
  let prog = Consortium.progress(server, n)
  let out = []
  for (let family in families) {
    if (!Object.prototype.hasOwnProperty.call(families, family)) continue
    let line = null
    for (let i = 0; i < prog.lines.length; i++) if (prog.lines[i].line.id === families[family]) line = prog.lines[i]
    if (line === null || line.ratio < CONSORTIUM_EVENT_CRASH_MIN_RATIO) continue
    let view = ConsortiumCore.price(family)
    if (!view.isPresent() || view.get().baseCents() <= 0) continue
    out.push(family)
  }
  return out
}

// ---- crates (supply drop and the Friday crate stage) --------------------------------------------------

// The first air block standing on a solid, dry block at `centre` or above it, up to CONSORTIUM_EVENT_CRATE_SEARCH
// blocks higher (an arena plinth or a marker block at the centre is kept and the crate goes on top of it), or null.
function consortiumCrateSpot(level, centre) {
  for (let i = 0; i <= CONSORTIUM_EVENT_CRATE_SEARCH; i++) {
    let pos = centre.above(i)
    if (!level.getBlockState(pos).isAir()) continue
    let below = level.getBlockState(pos.below())
    if (below.isSolid() && below.getFluidState().isEmpty()) return pos
  }
  return null
}

// Places the crate at `pos` and records it in `active`. Never overwrites a block: when `pos` is not air (the world
// changed between the spot search and the placement) nothing is placed, one console line says so and the call
// answers false with `active` untouched. Both crate paths (supply drop and the Friday crate stage) go through here.
function consortiumPlaceCrate(server, active, level, pos, table, meteor) {
  let dim = String(level.dimension)
  let state = level.getBlockState(pos)
  if (!state.isAir()) {
    console.warn('[Consortium] crate not placed: ' + dim + ' ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' holds ' + String(state.block.id) + ' (never overwritten)')
    return false
  }
  active.putString('crateDim', dim)
  active.putInt('x', pos.getX()); active.putInt('y', pos.getY()); active.putInt('z', pos.getZ())
  active.putString('table', table)
  active.putString('openedBy', '')
  server.runCommandSilent('execute in ' + dim + ' run forceload add ' + pos.getX() + ' ' + pos.getZ())
  if (meteor) {
    // Optional dressing: one of the six orphan Ad Astra meteor templates (basalt, obsidian, magma: no ore), placed
    // 2 blocks under the crate. Not verified on the harness yet (EVENTS 11): staff opt in with "meteor".
    server.runCommandSilent('execute in ' + dim + ' run place template ad_astra:meteor' + (1 + Math.floor(Math.random() * 6)) + ' ' + (pos.getX() - 3) + ' ' + (pos.getY() - 2) + ' ' + (pos.getZ() - 3))
  }
  // "keep" form: the chest only goes into an air block, a block that appeared since the check above stays.
  server.runCommandSilent('execute in ' + dim + ' run setblock ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' minecraft:chest{LootTable:"' + table + '"} keep')
  return true
}

function consortiumCratePresent(server, active) {
  if (!active.contains('crateDim')) return true
  let level = consortiumLevelOf(server, active.getString('crateDim'))
  if (level === null) return true
  let state = level.getBlockState(BlockPos.containing(active.getInt('x'), active.getInt('y'), active.getInt('z')))
  return String(state.block.id) === 'minecraft:chest'
}

function consortiumRemoveCrate(server, active, removeBlock) {
  if (!active.contains('crateDim')) return
  let dim = String(active.getString('crateDim'))
  let x = active.getInt('x'), y = active.getInt('y'), z = active.getInt('z')
  if (removeBlock && consortiumCratePresent(server, active)) server.runCommandSilent('execute in ' + dim + ' run setblock ' + x + ' ' + y + ' ' + z + ' minecraft:air')
  server.runCommandSilent('execute in ' + dim + ' run forceload remove ' + x + ' ' + z)
}

// The crate opener (BlockEvents.rightClicked): first click wins; the Friday crate refuses non-admitted players.
function consortiumCrateClicked(server, active, player, level, pos) {
  if (!active.contains('crateDim')) return false
  if (String(level.dimension) !== String(active.getString('crateDim'))) return false
  if (pos.getX() !== active.getInt('x') || pos.getY() !== active.getInt('y') || pos.getZ() !== active.getInt('z')) return false
  let id = consortiumActiveId(server)
  let uuid = consortiumUuidOf(player)
  if (id === 'friday_zone' && !active.getCompound('admitted').contains(uuid)) {
    player.tell(Text.of('Ticket holders only.').red())
    return true // cancel
  }
  if (String(active.getString('openedBy')).length === 0) {
    active.putString('openedBy', uuid)
    consortiumEventFlag(uuid, 'event:supply_drop')
    if (Math.random() < CONSORTIUM_EVENT_TICKET_CHANCE && typeof Consortium.tickets !== 'undefined' && Consortium.tickets && typeof Consortium.tickets.grant === 'function') {
      try {
        Consortium.tickets.grant(server, uuid, 1, 'event:' + active.getLong('startedAt') + ':' + uuid)
        active.putBoolean('ticketBonus', true)
        player.tell(Text.of('An event ticket was tucked inside the crate. It is yours.').gold())
      } catch (err) { console.error('[Consortium] crate ticket grant failed: ' + err) }
    }
    if (id === 'friday_zone') active.putBoolean('crateOpened', true)
    console.info('[Consortium] event crate opened by ' + player.username)
  }
  return false
}

// ---- bosses (bounty and the Friday finale) --------------------------------------------------------------

function consortiumBossForceLoad(server, active, level, pos) {
  let dim = String(level.dimension)
  let cx = pos.getX() >> 4, cz = pos.getZ() >> 4
  if (active.contains('loaded') && active.getInt('loadedCx') === cx && active.getInt('loadedCz') === cz) return
  consortiumReleaseForceLoads(server, active.contains('loaded') ? active.getList('loaded', 8) : null)
  let keys = consortiumForceLoad(server, dim, pos, true)
  let list = NBT.listTag()
  for (let i = 0; i < keys.length; i++) list.add(NBT.stringTag(keys[i]))
  active.put('loaded', list)
  active.putInt('loadedCx', cx); active.putInt('loadedCz', cz)
}

// Boss presence: 60 s of absence voids it (onGone runs the stop); the force-loaded 3 x 3 follows the boss.
function consortiumBossTick(server, active, now, onGone) {
  let uuidText = String(active.getString('boss'))
  if (uuidText.length === 0) return
  let mob = server.getEntityByUUID(CONSORTIUM_UUID.fromString(uuidText))
  if (mob === null || !mob.isAlive()) {
    if (active.getLong('bossMissingSince') === 0) active.putLong('bossMissingSince', now)
    else if (now - active.getLong('bossMissingSince') >= CONSORTIUM_EVENT_BOSS_MISSING_MS) onGone(server, active)
    return
  }
  active.putLong('bossMissingSince', 0)
  consortiumBossForceLoad(server, active, mob.level, mob.blockPosition())
}

// Removes a boss that outlived its stage without a death event: the reference is cleared first (the death listener
// then returns for every bounty-tagged mob), bossExpired keeps the listener out for good, and the entity is
// discard()ed (no LivingDeathEvent, unlike /kill). Returns true when the entity was found and removed.
function consortiumBossExpire(server, active) {
  let uuidText = String(active.getString('boss'))
  active.putString('boss', '')
  active.putBoolean('bossExpired', true)
  if (uuidText.length === 0) return false
  let mob = server.getEntityByUUID(CONSORTIUM_UUID.fromString(uuidText))
  if (mob === null || mob === undefined) return false
  mob.discard()
  return true
}

// Pays the pot by damage share (capped per hunter and by the day and week room), announces the top 3.
function consortiumBountyPayout(server, active, filter) {
  let damage = consortiumEventSub(active, 'damage')
  let total = 0
  for (let key of damage.getAllKeys()) total += damage.getDouble(key)
  let pot = active.getLong('pot')
  let paid = NBT.compoundTag()
  let count = 0
  for (let key of damage.getAllKeys()) {
    let uuid = String(key)
    if (filter && !filter(uuid)) continue
    let share = Math.min(active.getLong('shareCap'), Math.floor(pot * damage.getDouble(key) / Math.max(1, total)))
    let got = consortiumEventPay(server, active, uuid, share, 'event:bounty:' + active.getString('bossName'))
    paid.putLong(uuid, got)
    count++
  }
  active.put('paid', paid)
  active.putInt('hunters', count)
}

function consortiumBountyResultLine(server, active) {
  let paid = consortiumEventSub(active, 'paid')
  let sum = 0
  for (let key of paid.getAllKeys()) sum += paid.getLong(key)
  let hunters = active.getInt('hunters')
  if (hunters === 0) return active.getString('bossName') + ' fell to no one. The bounty is void.'
  return 'Bounty claimed: ' + active.getString('bossName') + ' fell. ' + ConsortiumCore.format(sum) + ' shared by ' + hunters + ' hunter' + (hunters === 1 ? '' : 's') + ': ' + consortiumEventTop(server, paid, 'cents') + '.'
}

// ---- waves (invasion and the Friday waves) --------------------------------------------------------------

function consortiumWavePick(server) {
  let n = Consortium.phase(server)
  let pool = []
  for (let i = 0; i < CONSORTIUM_EVENT_WAVE_TABLE.length; i++) {
    let m = CONSORTIUM_EVENT_WAVE_TABLE[i]
    if (n < m.minPhase) continue
    for (let w = 0; w < m.weight; w++) pool.push(m.id)
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

function consortiumSpawnWave(server, arena, count) {
  let level = consortiumArenaLevel(server, arena)
  if (level === null) return 0
  let centre = consortiumArenaCentre(arena)
  let n = Consortium.phase(server)
  let healthFactor = 1 + 0.25 * Math.max(0, n - 2) // PLACEHOLDER
  let spawned = 0
  for (let i = 0; i < count; i++) {
    let pos = consortiumEventSpot(level, centre, 8, 40, 0, arena.team, arena)
    if (pos === null) continue
    let id = consortiumWavePick(server)
    let hp = Math.round((CONSORTIUM_EVENT_WAVE_BASE_HEALTH[id] || 20) * healthFactor)
    let nbt = { DeathLootTable: 'minecraft:empty', PersistenceRequired: true }
    if (healthFactor > 1) {
      nbt.attributes = [{ id: 'minecraft:generic.max_health', base: hp }]
      nbt.Health = hp
    }
    if (consortiumSpawnTagged(level, pos, id, CONSORTIUM_TAG_WAVE, nbt) !== null) spawned++
  }
  return spawned
}

function consortiumWaveMobs(server, arena) {
  let level = consortiumArenaLevel(server, arena)
  if (level === null) return []
  let out = []
  for (let e of level.entities) {
    if (consortiumHasTag(e, CONSORTIUM_TAG_WAVE)) out.push(e)
  }
  return out
}

let consortiumWaveWarned = {}

// One 5 s step of the waves: spawn to the target, discard strays, warn bystanders. `participant(p)` says who counts.
function consortiumWaveStep(server, active, arena, participant) {
  let centre = consortiumArenaCentre(arena)
  let inside = consortiumEventArenaPlayers(server, arena, null)
  let participants = 0
  for (let i = 0; i < inside.length; i++) {
    if (participant(inside[i])) participants++
    else {
      let uuid = consortiumUuidOf(inside[i])
      if (!consortiumWaveWarned[uuid]) {
        consortiumWaveWarned[uuid] = true
        server.runCommandSilent('title ' + inside[i].username + ' actionbar ' + JSON.stringify({ text: 'You are not in this event: kills here pay nothing. /consortium event join', color: 'yellow' }))
      }
    }
  }
  let mobs = consortiumWaveMobs(server, arena)
  let alive = 0
  for (let i = 0; i < mobs.length; i++) {
    let e = mobs[i]
    let far = e.blockPosition().distSqr(centre) > CONSORTIUM_EVENT_WAVE_RADIUS * CONSORTIUM_EVENT_WAVE_RADIUS
    if (far || consortiumHostileClaim(e.level, e.blockPosition(), arena)) { e.discard(); continue }
    alive++
  }
  if (participants > 0) {
    let target = Math.min(CONSORTIUM_EVENT_WAVE_ALIVE_CAP, CONSORTIUM_EVENT_WAVE_ALIVE_PER_PLAYER * participants)
    if (alive < target) consortiumSpawnWave(server, arena, Math.min(CONSORTIUM_EVENT_WAVE_PER_STEP, target - alive))
  }
  return participants
}

function consortiumInvasionTick(server, active, now, friday) {
  let arena = consortiumArena(server)
  if (arena === null) { consortiumStopEvent(server, 'cancel', null); return }
  let stage = String(active.getString('stage'))
  if (stage === 'muster') {
    if (now < active.getLong('stageEndsAt')) return
    let volunteers = consortiumEventArenaPlayers(server, arena, (p) => consortiumEventOptedIn(server, consortiumUuidOf(p)))
    if (volunteers.length === 0) { consortiumStopEvent(server, 'cancel', null); return }
    active.putString('stage', 'waves')
    active.putLong('stageEndsAt', active.getLong('endsAt'))
    consortiumTitle(server, 'Invasion', 'The waves begin: ' + volunteers.length + ' volunteer' + (volunteers.length === 1 ? '' : 's'))
    consortiumEventAnnounce(server, 'The waves begin at the HQ arena: ' + volunteers.length + ' volunteer' + (volunteers.length === 1 ? '' : 's') + '.')
    return
  }
  consortiumWaveStep(server, active, arena, (p) => consortiumEventOptedIn(server, consortiumUuidOf(p)))
}

function consortiumEventOptedIn(server, uuid) {
  return consortiumEventSub(consortiumEvents(server), 'optin').getBoolean(uuid)
}

function consortiumWaveResultLine(server, active, head) {
  let kills = consortiumEventSub(active, 'kills')
  let total = 0
  for (let key of kills.getAllKeys()) total += kills.getInt(key)
  let payouts = consortiumEventSub(active, 'payouts')
  let paid = 0
  for (let key of payouts.getAllKeys()) paid += payouts.getLong(key)
  let top = total > 0 ? ' Top crews: ' + consortiumEventTop(server, kills, 'int') + '.' : ''
  return head + ' ' + total + ' kill' + (total === 1 ? '' : 's') + ', ' + ConsortiumCore.format(paid) + ' paid.' + top
}

// ---- Friday Zone stages ----------------------------------------------------------------------------------

function consortiumFridayAdmitted(active, uuid) {
  return active.getCompound('admitted').contains(uuid)
}

function consortiumFridayNextStage(server, active, now) {
  let stage = String(active.getString('stage'))
  let arena = consortiumArena(server)
  if (stage === 'muster') {
    // Admission: registered players still inside the radius whose ticket can be consumed now.
    let joined = active.getCompound('joined')
    let admitted = active.getCompound('admitted')
    let n = 0
    for (let key of joined.getAllKeys()) {
      let uuid = String(key)
      let p = consortiumEventOnline(server, uuid)
      let inside = p !== null && consortiumEventArenaPlayers(server, arena, (q) => consortiumUuidOf(q) === uuid).length > 0
      let ok = inside && consortiumTicketConsume(server, uuid)
      if (ok) {
        admitted.putBoolean(uuid, true)
        consortiumEventFlag(uuid, 'event:friday')
        n++
      } else if (p !== null) {
        p.tell(Text.of(inside ? 'Your ticket is gone; you are not admitted.' : 'You were not at the arena when the waves started; your ticket is kept.').yellow())
      }
    }
    if (n === 0) { consortiumStopEvent(server, 'cancel', null); return }
    active.putString('stage', 'waves')
    active.putLong('stageEndsAt', now + CONSORTIUM_EVENT_WAVES_MS)
    consortiumTitle(server, 'Friday Zone', 'The waves begin')
    consortiumEventAnnounce(server, 'The waves begin: ' + n + ' ticket holder' + (n === 1 ? '' : 's') + ' admitted.')
    return
  }
  if (stage === 'waves') {
    let kills = consortiumEventSub(active, 'kills')
    let total = 0
    for (let key of kills.getAllKeys()) total += kills.getInt(key)
    consortiumKillTagged(server) // the wave leftovers go before the auditor
    if (!CONSORTIUM_HAS_APOTHEOSIS) {
      consortiumEventAnnounce(server, 'The waves are over: ' + total + ' kills. No auditor tonight; the Board\'s crate stands at the arena centre for ticket holders.')
      consortiumFridayCrate(server, active, now, arena)
      return
    }
    let level = consortiumArenaLevel(server, arena)
    let n = Consortium.phase(server)
    let profile = CONSORTIUM_BOUNTY_RARITIES[n] || CONSORTIUM_BOUNTY_RARITIES[2]
    let pool = consortiumBountyBossesUpTo(Math.max(2, n))
    let bossId = pool[Math.floor(Math.random() * pool.length)]
    let rarity = profile.rarities[Math.floor(Math.random() * profile.rarities.length)]
    let mob
    try { mob = consortiumSpawnBoss(level, consortiumArenaCentre(arena), bossId, rarity, profile.tier) } catch (err) {
      console.error('[Consortium] Friday finale boss failed: ' + err)
      consortiumEventAnnounce(server, 'The waves are over: ' + total + ' kills. No auditor tonight; the Board\'s crate stands at the arena centre for ticket holders.')
      consortiumFridayCrate(server, active, now, arena)
      return
    }
    active.putString('stage', 'finale')
    active.putLong('stageEndsAt', now + CONSORTIUM_EVENT_FINALE_MS)
    active.putString('boss', String(mob.uuid))
    active.putString('bossName', String(mob.name.string))
    active.putLong('bossMissingSince', 0)
    active.put('damage', NBT.compoundTag())
    consortiumBossForceLoad(server, active, level, mob.blockPosition())
    consortiumTitle(server, 'Friday Zone', 'The auditor enters the arena')
    consortiumEventAnnounce(server, 'The waves are over: ' + total + ' kills. The auditor enters the arena: ' + active.getString('bossName') + ', ' + ConsortiumCore.format(active.getLong('pot')) + ' bounty for ticket holders.')
    return
  }
  if (stage === 'finale') {
    // Time is up: the auditor leaves unpaid (EVENTS 3.7). Never /kill here: a kill fires the death listener
    // synchronously while active.boss still matches and would pay the pot by damage share, announce "The auditor
    // fell" and place a second crate. consortiumBossExpire clears the reference first and discards the entity.
    consortiumBossExpire(server, active)
    consortiumEventAnnounce(server, 'The auditor left before anyone could stop it. The Board\'s crate stands at the arena centre for ticket holders.')
    consortiumFridayCrate(server, active, now, arena)
    return
  }
  if (stage === 'crate') consortiumStopEvent(server, 'done', null)
}

// The crate stage: the chest goes on the first air block on solid ground at the arena centre or up to
// CONSORTIUM_EVENT_CRATE_SEARCH blocks above it (a plinth or a marker block at the centre is never overwritten).
// No such block, or the spot taken meanwhile: the stage is refused with a console line, no crate is placed and
// the stage ends at the next 5 s step ("The Friday Zone closes.", nothing to remove).
function consortiumFridayCrate(server, active, now, arena) {
  let level = consortiumArenaLevel(server, arena)
  let table = Consortium.phase(server) >= 4 ? 'consortium:event/supply_drop_late' : 'consortium:event/supply_drop'
  let centre = consortiumArenaCentre(arena)
  let pos = consortiumCrateSpot(level, centre)
  let placed = pos !== null && consortiumPlaceCrate(server, active, level, pos, table, false)
  active.putString('stage', 'crate')
  if (!placed) {
    console.warn('[Consortium] Friday crate stage refused: no air block on solid ground at the arena centre ' + arena.dim + ' ' + centre.getX() + ' ' + centre.getY() + ' ' + centre.getZ()
      + ' or up to ' + CONSORTIUM_EVENT_CRATE_SEARCH + ' blocks above it; nothing was overwritten, the Friday Zone ends without a crate')
    active.putLong('stageEndsAt', now)
    consortiumEventAnnounce(server, 'The Board\'s crate could not be set down at the arena centre (the spot is blocked): staff clear the centre for next time.')
    return
  }
  active.putLong('stageEndsAt', now + CONSORTIUM_EVENT_CRATE_MS)
  consortiumTitle(server, 'Friday Zone', 'The Board\'s crate is at the arena centre')
}

function consortiumFridayTick(server, active, now) {
  let arena = consortiumArena(server)
  if (arena === null) { consortiumStopEvent(server, 'cancel', null); return }
  let stage = String(active.getString('stage'))
  if (stage === 'waves') consortiumWaveStep(server, active, arena, (p) => consortiumFridayAdmitted(active, consortiumUuidOf(p)))
  if (stage === 'finale') {
    consortiumBossTick(server, active, now, (s, a) => {
      consortiumEventAnnounce(s, 'The auditor is gone. The Board\'s crate stands at the arena centre for ticket holders.')
      consortiumFridayCrate(s, a, Date.now(), consortiumArena(s))
    })
    if (String(active.getString('stage')) !== 'finale') return
  }
  if (stage === 'crate' && active.getBoolean('crateOpened')) { consortiumStopEvent(server, 'done', null); return }
  if (now >= active.getLong('stageEndsAt')) consortiumFridayNextStage(server, active, now)
}

// SHOP's Consortium.tickets API (typeof-guarded: without the shop script no ticket exists and the muster refuses).
function consortiumTicketCount(server, uuid) {
  if (typeof Consortium.tickets === 'undefined' || !Consortium.tickets || typeof Consortium.tickets.count !== 'function') return 0
  try { return Number(Consortium.tickets.count(server, uuid)) } catch (err) { console.error('[Consortium] ticket count failed: ' + err); return 0 }
}

function consortiumTicketConsume(server, uuid) {
  if (typeof Consortium.tickets === 'undefined' || !Consortium.tickets || typeof Consortium.tickets.consume !== 'function') return false
  try { return Consortium.tickets.consume(server, uuid, 1) === true } catch (err) { console.error('[Consortium] ticket consume failed: ' + err); return false }
}

// ---- blood moon -------------------------------------------------------------------------------------------

function consortiumBloodMoonRise(server, active, now) {
  active.putBoolean('pendingDusk', false)
  active.putLong('duskAt', now)
  active.putLong('endsAt', now + CONSORTIUM_EVENT_BLOODMOON_NIGHT_MS)
  server.persistentData.putBoolean('consortium_event_bloodmoon', true) // root key: In Control reads the root
  server.runCommandSilent('incontrol setphase consortium_blood_moon')
  consortiumTitle(server, 'Blood Moon', 'Hostiles are stronger tonight. Bases stay safe.')
  consortiumEventAnnounce(server, 'Blood Moon: hostiles are stronger tonight outside claims. Bases stay safe.')
  consortiumEventBar(server, true)
}

function consortiumBloodMoonClear(server) {
  server.persistentData.putBoolean('consortium_event_bloodmoon', false)
  if (CONSORTIUM_HAS_INCONTROL) server.runCommandSilent('incontrol clearphase consortium_blood_moon')
}

// ---- start, stop, log --------------------------------------------------------------------------------------

// The slot of a staff start: the server weekday now (friday_zone is always friday); random rolls pass 'none'.
function consortiumEventCalendar(id, forced, at) {
  if (id === 'friday_zone') return 'friday'
  if (!forced) return 'none'
  let d = new Date(at).getDay()
  return d === 5 ? 'friday' : d === 6 ? 'saturday' : 'none'
}

// Why `id` cannot roll or start now, or null. Staff starts (`forced`) skip the cooldown, the window rules, the
// online minimum and the roll precondition (their start() validates its own arguments: a staff bounty may use
// the arena, a staff blood moon may start at night) but keep the mod presence and the phase gate, which is
// `staffMinPhase` for them when the definition has one (bounty and invasion from phase 1: the phase 1 Friday
// slot of EVENTS 3.7 and rule 4.6) and `minPhase` otherwise.
function consortiumEventEligibility(server, id, forced) {
  let def = CONSORTIUM_EVENT_DEFS[id]
  if (!def) return 'unknown event'
  let n = Consortium.phase(server)
  let minPhase = forced && def.staffMinPhase ? def.staffMinPhase : def.minPhase
  if (n < minPhase) return 'phase ' + minPhase + ' required'
  if (def.needs === 'apotheosis' && !CONSORTIUM_HAS_APOTHEOSIS) return 'Apotheosis absent'
  if (def.needs === 'incontrol' && !CONSORTIUM_HAS_INCONTROL) return 'In Control absent'
  if (forced) return null
  if (def.staffOnly) return 'staff only'
  let last = consortiumEvents(server).getCompound('cooldowns').getLong(id)
  let left = last + def.cooldownHours * 3600000 - Date.now()
  if (last > 0 && left > 0) return 'cooldown ' + Math.ceil(left / 3600000) + ' h left'
  return def.precondition(server)
}

// Starts an event. Returns { ok: true, name } or { ok: false, reason }. A staff start (`forced`) cuts a running
// random event short and is refused while a staff event runs (EVENTS 1 "one event at a time").
function consortiumStartEvent(server, id, forced, args, byName) {
  let def = CONSORTIUM_EVENT_DEFS[id]
  if (!def) return { ok: false, reason: 'unknown event ' + id }
  let running = consortiumActiveEvent(server)
  if (running !== null) {
    if (!forced) return { ok: false, reason: 'an event is running' }
    if (running.getBoolean('forced')) return { ok: false, reason: 'a staff event is running: /consortium event stop first' }
    consortiumStopEvent(server, 'cut', def.name)
  }
  let why = consortiumEventEligibility(server, id, forced)
  if (why !== null) return { ok: false, reason: why }
  let ev = consortiumEvents(server)
  let now = Date.now()
  let active = NBT.compoundTag()
  active.putString('id', id)
  active.putLong('startedAt', now)
  active.putLong('endsAt', now + def.minutes * 60000)
  active.putBoolean('forced', !!forced)
  active.putString('calendar', consortiumEventCalendar(id, forced, now))
  active.put('payouts', NBT.compoundTag())
  active.put('kills', NBT.compoundTag())
  active.put('damage', NBT.compoundTag())
  ev.put('active', active)
  consortiumWaveWarned = {}
  consortiumEventLastFactor = {}
  let refusal = null
  try { refusal = def.start(server, active, args || []) } catch (err) { refusal = 'start failed: ' + err; console.error('[Consortium] event ' + id + ' start failed: ' + err) }
  if (refusal !== null) {
    ev.remove('active')
    try { def.cleanup(server, active) } catch (err) { console.error('[Consortium] event ' + id + ' cleanup after a refused start failed: ' + err) }
    consortiumKillTagged(server)
    return { ok: false, reason: refusal }
  }
  ev.getCompound('cooldowns').putLong(id, now)
  console.info('[Consortium] event ' + id + ' started' + (forced ? ' by ' + (byName || 'staff') : ' (random)') + ', ends ' + consortiumClock(active.getLong('endsAt')) + ', slot ' + active.getString('calendar'))
  consortiumEventBarCache = ''
  consortiumEventBar(server, true)
  consortiumPublishBoard(server, true)
  return { ok: true, name: def.name }
}

// Stops the active event under the stop order of EVENTS 2.3: (a) results computed and paid, (b) active removed
// and the log written, (c) cleanup (force-loads, In Control phase and flag, crate, tagged mobs). The death and
// hurt listeners see no active event during (c), so the cleanup kill never pays. `reason`: expired, stop, cut,
// reconcile, void, cancel, done.
function consortiumStopEvent(server, reason, cutBy) {
  let ev = consortiumEvents(server)
  let active = consortiumActiveEvent(server)
  if (active === null) return false
  let id = String(active.getString('id'))
  let def = CONSORTIUM_EVENT_DEFS[id]
  let summary = ''
  try { summary = def ? def.results(server, active, reason) : '' } catch (err) { console.error('[Consortium] event ' + id + ' results failed: ' + err) }
  // Slot participant stamps (EVENTS 2.4): every participant of a friday or saturday slot event.
  let calendar = String(active.getString('calendar'))
  if ((calendar === 'friday' || calendar === 'saturday') && reason !== 'cancel') {
    let participants = consortiumEventParticipants(server, active)
    for (let i = 0; i < participants.length; i++) consortiumEventFlag(participants[i], 'event:' + calendar)
  }
  // (b) the record goes before any world change.
  ev.remove('active')
  consortiumEventLog(ev, id, active.getLong('startedAt'), Date.now(), summary)
  // (c) cleanup.
  try { if (def) def.cleanup(server, active) } catch (err) { console.error('[Consortium] event ' + id + ' cleanup failed: ' + err) }
  if (id !== 'blood_moon' && server.persistentData.getBoolean('consortium_event_bloodmoon')) consortiumBloodMoonClear(server)
  consortiumKillTagged(server)
  server.runCommandSilent('bossbar remove ' + CONSORTIUM_EVENT_BAR)
  consortiumEventBarCache = ''
  consortiumEventLastFactor = {}
  if (reason === 'cut' && cutBy) {
    consortiumEventAnnounce(server, (def ? def.name : id) + ' is cut short by the Board: ' + cutBy + ' starts now. ' + summary)
  } else if (summary.length) {
    consortiumEventAnnounce(server, summary)
  }
  console.info('[Consortium] event ' + id + ' ended (' + reason + '): ' + summary)
  consortiumPublishBoard(server, true)
  return true
}

// Participants per kind (EVENTS 2.4): payouts keys (market, quota), the crate opener, damage keys (bounty), kills
// keys plus opted-in players inside the arena (invasion), everyone online (blood moon), admitted (Friday zone).
function consortiumEventParticipants(server, active) {
  let id = String(active.getString('id'))
  let out = {}
  let add = (tag) => { for (let key of tag.getAllKeys()) out[String(key)] = true }
  if (id === 'ore_rush' || id === 'power_surge' || id === 'logistics_week' || id === 'market_crash' || id === 'double_quota') add(consortiumEventSub(active, 'payouts'))
  else if (id === 'supply_drop') { if (String(active.getString('openedBy')).length) out[String(active.getString('openedBy'))] = true }
  else if (id === 'bounty') add(consortiumEventSub(active, 'damage'))
  else if (id === 'invasion') {
    add(consortiumEventSub(active, 'kills'))
    let inside = consortiumEventArenaPlayers(server, consortiumArena(server), (p) => consortiumEventOptedIn(server, consortiumUuidOf(p)))
    for (let i = 0; i < inside.length; i++) out[consortiumUuidOf(inside[i])] = true
  } else if (id === 'blood_moon') { for (let p of server.players) out[consortiumUuidOf(p)] = true }
  else if (id === 'friday_zone') add(consortiumEventSub(active, 'admitted'))
  return Object.keys(out)
}

function consortiumEventLog(ev, id, startedAt, endedAt, summary) {
  if (!ev.contains('log')) ev.put('log', NBT.listTag())
  let log = ev.getList('log', 10)
  let entry = NBT.compoundTag()
  entry.putString('id', id)
  entry.putLong('startedAt', startedAt)
  entry.putLong('endedAt', endedAt)
  entry.putString('summary', summary)
  log.add(entry)
  while (log.size() > CONSORTIUM_EVENT_LOG_MAX) log.remove(0)
}

// ---- boss bar and board ------------------------------------------------------------------------------------

let consortiumEventBarCache = ''
let consortiumEventBoardAt = 0

function consortiumEventBar(server, force) {
  let active = consortiumActiveEvent(server)
  if (active === null) return
  let def = CONSORTIUM_EVENT_DEFS[String(active.getString('id'))]
  let now = Date.now()
  let left = Math.max(0, Math.ceil((active.getLong('endsAt') - now) / 60000))
  let name = JSON.stringify({ text: 'Event: ' + (def ? def.name : active.getString('id')) + ' - ' + left + ' min left', color: 'red' })
  if (!force && name === consortiumEventBarCache) return
  consortiumEventBarCache = name
  let run = (c) => server.runCommandSilent('bossbar ' + c)
  run('add ' + CONSORTIUM_EVENT_BAR + ' ' + name)
  run('set ' + CONSORTIUM_EVENT_BAR + ' name ' + name)
  run('set ' + CONSORTIUM_EVENT_BAR + ' max 100')
  run('set ' + CONSORTIUM_EVENT_BAR + ' color red')
  run('set ' + CONSORTIUM_EVENT_BAR + ' style progress')
  let span = Math.max(1, active.getLong('endsAt') - active.getLong('startedAt'))
  run('set ' + CONSORTIUM_EVENT_BAR + ' value ' + Math.max(0, Math.min(100, Math.round(100 * (active.getLong('endsAt') - now) / span))))
  run('set ' + CONSORTIUM_EVENT_BAR + ' players @a')
}

// ---- scheduler ----------------------------------------------------------------------------------------------

function consortiumEventInWindow(now) {
  let d = new Date(now)
  let day = d.getDay()
  let hour = d.getHours()
  for (let i = 0; i < CONSORTIUM_EVENT_WINDOWS.length; i++) {
    let w = CONSORTIUM_EVENT_WINDOWS[i]
    if (w.days.indexOf(day) >= 0 && hour >= w.from && hour < w.to) return true
  }
  return false
}

// The next window opening after `now` as "Weekday HH:MM", for the status lines.
function consortiumEventNextWindowText(now) {
  let names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (consortiumEventInWindow(now)) return 'open now'
  for (let i = 0; i < 8; i++) {
    let base = new Date(now)
    base.setDate(base.getDate() + i)
    for (let j = 0; j < CONSORTIUM_EVENT_WINDOWS.length; j++) {
      let w = CONSORTIUM_EVENT_WINDOWS[j]
      if (w.days.indexOf(base.getDay()) < 0) continue
      let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), w.from, 0, 0)
      if (at.getTime() > now) return names[at.getDay()] + ' ' + consortiumClock(at.getTime())
    }
  }
  return 'unknown'
}

// One roll: returns the outcome text. `onlyId` restricts the candidates (debug); `debug` ignores the window, the
// day cap and the online minimum. Never rolls while an event runs, while paused (unless debug) or while stalled.
function consortiumEventRoll(server, onlyId, debug) {
  let ev = consortiumEvents(server)
  if (consortiumActiveEvent(server) !== null) return 'nothing eligible: an event is running'
  if (!debug && ev.getBoolean('paused')) return 'nothing eligible: paused'
  let now = Date.now()
  let n = Consortium.phase(server)
  if (Consortium.phaseTag(server, n).getBoolean('stalled')) return 'nothing eligible: the phase is stalled (the Gap Contract has the floor)'
  let day = Consortium.seasonDay(server)
  if (ev.getInt('dayKey') !== day) { ev.putInt('dayKey', day); ev.putInt('dayCount', 0) }
  if (!debug) {
    if (!consortiumEventInWindow(now)) return 'nothing eligible: outside the windows'
    if (ev.getInt('dayCount') >= CONSORTIUM_EVENT_DAY_CAP) return 'nothing eligible: ' + CONSORTIUM_EVENT_DAY_CAP + ' random events today already'
  }
  let online = server.players.size()
  let nextSlot = consortiumNextSlotMs()
  let queuedAt = ev.contains('queued') ? ev.getCompound('queued').getLong('at') : 0
  let candidates = []
  let reasons = []
  for (let i = 0; i < CONSORTIUM_EVENT_IDS.length; i++) {
    let id = CONSORTIUM_EVENT_IDS[i]
    if (onlyId && id !== onlyId) continue
    let def = CONSORTIUM_EVENT_DEFS[id]
    if (def.weight <= 0 && !onlyId) continue
    let why = consortiumEventEligibility(server, id, false)
    if (why === null && !debug && online < def.minOnline) why = online + ' online, ' + def.minOnline + ' needed'
    if (why === null) {
      let end = now + def.minutes * 60000 + CONSORTIUM_EVENT_SLOT_MARGIN_MS
      if (end > nextSlot) why = 'slot: the next rule 4.6 slot is too close'
      else if (queuedAt > 0 && end > queuedAt) why = 'slot: the queued event is too close'
    }
    if (why === null) candidates.push({ id: id, weight: Math.max(1, def.weight) })
    else reasons.push(id + ': ' + why)
  }
  if (!candidates.length) return 'nothing eligible: ' + (onlyId ? reasons.join('; ').replace(onlyId + ': ', '') : reasons.join('; '))
  if (!debug && Math.random() >= CONSORTIUM_EVENT_ROLL_P) return 'no start this slot (roll)'
  let total = 0
  for (let i = 0; i < candidates.length; i++) total += candidates[i].weight
  let r = Math.random() * total
  let pick = candidates[candidates.length - 1].id
  for (let i = 0; i < candidates.length; i++) {
    r -= candidates[i].weight
    if (r < 0) { pick = candidates[i].id; break }
  }
  let result = consortiumStartEvent(server, pick, false, [], null)
  if (!result.ok) return 'pick ' + pick + ' refused: ' + result.reason
  ev.putInt('dayCount', ev.getInt('dayCount') + 1)
  return 'pick ' + pick + ' (' + result.name + ') started'
}

function consortiumEventQueuedTick(server, ev, now) {
  if (!ev.contains('queued')) return
  let q = ev.getCompound('queued')
  let at = q.getLong('at')
  let def = CONSORTIUM_EVENT_DEFS[String(q.getString('id'))]
  let name = def ? def.name : String(q.getString('id'))
  if (!q.getBoolean('reminded60') && at - now <= 3600000) {
    q.putBoolean('reminded60', true)
    if (at - now > 600000) consortiumEventAnnounce(server, name + ' starts in 60 minutes. Gather at HQ.')
  }
  if (!q.getBoolean('reminded5') && at - now <= 300000) {
    q.putBoolean('reminded5', true)
    if (at - now > 60000) consortiumEventAnnounce(server, name + ' starts in 5 minutes. Gather at HQ.')
  }
  if (now < at) return
  let running = consortiumActiveEvent(server)
  if (running !== null && running.getBoolean('forced')) return // a staff event delays the queued one until it ends
  let args = []
  let list = q.getList('args', 8)
  for (let i = 0; i < list.size(); i++) args.push(String(list.getString(i)))
  let id = String(q.getString('id'))
  let calendar = String(q.getString('calendar'))
  ev.remove('queued')
  let result = consortiumStartEvent(server, id, true, args, 'the queue')
  if (!result.ok) { consortiumEventAnnounce(server, name + ' could not start: ' + result.reason + '.'); return }
  let active = consortiumActiveEvent(server)
  if (active !== null && CONSORTIUM_EVENT_CALENDARS.indexOf(calendar) >= 0 && id !== 'friday_zone') active.putString('calendar', calendar)
}

// The daily step of the events engine (EVENTS 2.3 step 6): the summary line once per season day after the
// engine's own daily step, and the Wednesday duties once per season week.
function consortiumEventDaily(server, ev, force) {
  let st = consortiumState(server)
  let day = Consortium.seasonDay(server)
  if (!force && (st.getInt('lastDailyDay') !== day || ev.getInt('summaryDay') === day)) return
  ev.putInt('summaryDay', day)
  let parts = []
  if (ev.contains('log')) {
    let log = ev.getList('log', 10)
    let since = Date.now() - 86400000
    for (let i = 0; i < log.size(); i++) {
      let e = log.getCompound(i)
      if (e.getLong('startedAt') < since) continue
      let def = CONSORTIUM_EVENT_DEFS[String(e.getString('id'))]
      parts.push((def ? def.name : e.getString('id')) + ' ' + consortiumClock(e.getLong('startedAt')))
    }
  }
  consortiumBroadcast(server, 'Events yesterday: ' + (parts.length ? parts.join(', ') : 'none') + '. Today\'s window: 18:00-23:00' + (new Date().getDay() === 0 || new Date().getDay() === 6 ? ' and 14:00-18:00' : '') + '.')
  if (new Date().getDay() === 3) consortiumEventWednesday(server, ev, false)
}

// Wednesday duties: lapse the unclaimed weekly stamps of the previous week (ConsortiumQuests.unflag), once per
// season week. Returns the outcome text.
function consortiumEventWednesday(server, ev, force) {
  let week = consortiumSeasonWeek(server)
  if (!force && ev.contains('wednesdayWeek') && ev.getInt('wednesdayWeek') === week) return 'already run this week'
  ev.putInt('wednesdayWeek', week)
  let st = consortiumState(server)
  let n = 0
  if (typeof ConsortiumQuests !== 'undefined' && typeof ConsortiumQuests.unflag === 'function' && st.contains('quests') && st.getCompound('quests').contains('weekly')) {
    let weekly = st.getCompound('quests').getCompound('weekly')
    let uuids = []
    for (let key of weekly.getAllKeys()) uuids.push(String(key))
    for (let i = 0; i < uuids.length; i++) {
      for (let key of ['event:friday', 'event:saturday']) {
        try { if (ConsortiumQuests.unflag(uuids[i], key) === true) n++ } catch (err) { console.error('[Consortium] weekly unflag failed: ' + err) }
      }
    }
  }
  console.info('[Consortium] Wednesday duties run for season week ' + week + ': ' + n + ' weekly stamp(s) lapsed')
  return 'Wednesday duties run: ' + n + ' weekly stamp(s) lapsed'
}

// EVENTS 3.9: every engine mob standing in a hostile claim is discarded, every 5 s while an event runs (bosses and
// blood moon mobs included; wave mobs get the arena-radius rule on top in consortiumWaveStep). Returns the count.
function consortiumEventSweep(server) {
  let arena = consortiumArena(server)
  let n = 0
  for (let e of server.entities) {
    if (!consortiumHasTag(e, CONSORTIUM_EVENT_TAG)) continue
    if (consortiumHostileClaim(e.level, e.blockPosition(), arena)) { e.discard(); n++ }
  }
  return n
}

let consortiumEventSweepLogAt = 0

function consortiumEventStep(server) {
  let ev = consortiumEvents(server)
  let now = Date.now()
  let active = consortiumActiveEvent(server)
  if (active !== null) {
    // The event's own step first (a pending blood moon cancels itself at its wait bound), then the expiry.
    let def = CONSORTIUM_EVENT_DEFS[String(active.getString('id'))]
    if (def) def.tick(server, active, now)
    active = consortiumActiveEvent(server)
    if (active !== null && now >= active.getLong('endsAt')) consortiumStopEvent(server, 'expired', null)
    else if (active !== null) {
      let swept = consortiumEventSweep(server)
      if (swept > 0 && now - consortiumEventSweepLogAt > 60000) { consortiumEventSweepLogAt = now; console.info('[Consortium] ' + swept + ' event mob(s) discarded inside a claim') }
      consortiumEventBar(server, false)
      if (now - consortiumEventBoardAt >= CONSORTIUM_EVENT_BOARD_MS) { consortiumEventBoardAt = now; consortiumPublishBoard(server, true) }
    }
  }
  consortiumEventQueuedTick(server, ev, now)
  if (consortiumActiveEvent(server) === null && !ev.getBoolean('paused')) {
    let slot = Math.floor(now / 1800000)
    if (ev.getLong('lastRollSlot') !== slot) {
      ev.putLong('lastRollSlot', slot)
      let out = consortiumEventRoll(server, null, false)
      if (out.indexOf('pick') === 0) console.info('[Consortium] event roll: ' + out)
    }
  }
  consortiumEventDaily(server, ev, false)
}

// ---- the shared object (filled) ------------------------------------------------------------------------------

// The market factor of one quote line, clipped to the player's event room at quote time (EVENTS 4: the daily and
// weekly event caps bind on this receipt, never one receipt later). `cents` is the line's credits before the event
// factor (base x charter x newcomer, from the money script), so cents x (f - 1) is the bonus the DeliveryEvent
// booking will see (the paycheck scale only lowers it): f = 1 + min(factor - 1, room / cents). `quote` is one
// { used } object per DeliveryQuoteEvent: the boosted lines of a receipt share the room in line order. Without
// `cents` (an older caller) the factor is unclipped while any room is left.
ConsortiumEvents.quoteFactor = (server, uuid, family, charterFamily, cents, quote) => {
  let active = consortiumActiveEvent(server)
  if (active === null) return 1
  let id = String(active.getString('id'))
  let def = CONSORTIUM_EVENT_DEFS[id]
  let who = String(uuid).toLowerCase()
  let key = who + '|' + String(family)
  if (def && def.kind === 'market') {
    if (String(charterFamily) !== String(active.getString('family'))) return 1
    if (!consortiumFamilyOnQuota(server, family)) return 1
    let used = quote && quote.used > 0 ? Math.floor(quote.used) : 0
    let room = consortiumEventRoom(server, who) - used
    if (room <= 0) { consortiumEventLastFactor[key] = 1; return 1 }
    let f = active.getDouble('factor')
    let base = Number(cents)
    if (base > 0) {
      f = 1 + Math.min(f - 1, room / base)
      if (quote) quote.used = used + Math.min(room, Math.ceil(base * (f - 1)))
    }
    consortiumEventLastFactor[key] = f
    return f
  }
  if (id === 'market_crash' && String(family) === String(active.getString('family'))) return active.getDouble('factor')
  return 1
}

ConsortiumEvents.quotaFactor = (server) => consortiumActiveId(server) === 'double_quota' ? 2 : 1

ConsortiumEvents.boardObject = (server) => {
  let active = consortiumActiveEvent(server)
  if (active === null) return null
  let def = CONSORTIUM_EVENT_DEFS[String(active.getString('id'))]
  if (!def) return null
  let detail = ''
  try { detail = String(def.detail(server, active)) } catch (err) { detail = '' }
  return { name: def.name, detail: detail, seconds_left: Math.max(1, Math.ceil((active.getLong('endsAt') - Date.now()) / 1000)) }
}

ConsortiumEvents.fireworks = (server) => {
  let arena = consortiumArena(server)
  if (arena === null) return false
  let level = consortiumArenaLevel(server, arena)
  if (level === null) return false
  for (let i = 0; i < 6; i++) {
    let x = arena.x + (Math.random() * 12 - 6)
    let z = arena.z + (Math.random() * 12 - 6)
    server.runCommandSilent('execute in ' + arena.dim + ' run summon minecraft:firework_rocket ' + x.toFixed(1) + ' ' + (arena.y + 1) + ' ' + z.toFixed(1)
      + ' {LifeTime:' + (20 + Math.floor(Math.random() * 20)) + ',FireworksItem:{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{explosions:[{shape:"large_ball",colors:[I;16766720,16777215],fade_colors:[I;16755200],has_trail:1b}],flight_duration:1}}}}')
  }
  return true
}

// ---- status text (the /consortium event line) ----------------------------------------------------------------

function consortiumEventStatus(server, player) {
  let lines = []
  let active = consortiumActiveEvent(server)
  let ev = consortiumEvents(server)
  if (!CONSORTIUM_EVENTS_ON) {
    lines.push(Text.of('The events engine is off on this side (Consortium Core or FTB Chunks absent).').gray())
    return lines
  }
  if (active === null) {
    lines.push(Text.of('No event is running. ').gray().append(Text.of('Random window: ' + consortiumEventNextWindowText(Date.now()) + (ev.getBoolean('paused') ? ' (scheduler paused)' : '') + '. Next Board slot: ' + consortiumNextSlot() + ' 20:00.').yellow()))
  } else {
    let def = CONSORTIUM_EVENT_DEFS[String(active.getString('id'))]
    let left = Math.max(0, Math.ceil((active.getLong('endsAt') - Date.now()) / 60000))
    let detail = ''
    try { detail = def ? String(def.detail(server, active)) : '' } catch (err) { detail = '' }
    lines.push(Text.of((def ? def.name : active.getString('id')) + ': ').gold().bold().append(Text.of(detail + ', ' + left + ' min left' + (String(active.getString('calendar')) !== 'none' ? ', ' + active.getString('calendar') + ' slot' : '') + '.').yellow()))
    let stage = String(active.getString('stage'))
    if (stage.length) lines.push(Text.of('Stage: ' + stage + '.').gray())
  }
  if (ev.contains('queued')) {
    let q = ev.getCompound('queued')
    let def = CONSORTIUM_EVENT_DEFS[String(q.getString('id'))]
    lines.push(Text.of('Queued: ' + (def ? def.name : q.getString('id')) + ' at ' + consortiumClock(q.getLong('at')) + '.').gray())
  }
  if (player) {
    let uuid = consortiumUuidOf(player)
    let room = consortiumEventRoom(server, uuid)
    lines.push(Text.of('You: ' + (consortiumEventOptedIn(server, uuid) ? 'opted in to invasions' : 'not opted in (/consortium event join)') + ', event bonus room today ' + ConsortiumCore.format(room) + (room <= 0 ? ' (your event bonus for today is spent)' : '') + '.').gray())
    if (active !== null && String(active.getString('id')) === 'friday_zone') {
      let joined = active.getCompound('joined').contains(uuid)
      let admitted = active.getCompound('admitted').contains(uuid)
      lines.push(Text.of(admitted ? 'You are admitted to the Friday Zone.' : joined ? 'You are registered; stay inside the arena until the waves start.' : 'Not registered: /consortium event join at the arena with a ticket.').gray())
    }
  }
  return lines
}

// /consortium event join and leave (invasion opt-in, Friday zone muster registration).
function consortiumEventJoin(server, player, join) {
  let uuid = consortiumUuidOf(player)
  let ev = consortiumEvents(server)
  let active = consortiumActiveEvent(server)
  if (active !== null && String(active.getString('id')) === 'friday_zone' && String(active.getString('stage')) === 'muster') {
    let joined = active.getCompound('joined')
    if (!join) {
      joined.remove(uuid)
      return Text.of('You left the Friday Zone muster. Your ticket is untouched.').yellow()
    }
    let arena = consortiumArena(server)
    let inside = consortiumEventArenaPlayers(server, arena, (p) => consortiumUuidOf(p) === uuid).length > 0
    if (!inside) return Text.of('Come to the HQ arena first: the Friday Zone muster is inside it.').red()
    if (consortiumTicketCount(server, uuid) < 1) return Text.of('You need an event ticket to join the Friday Zone: the Board sells them at the HQ shop (30 CC).').red()
    joined.putBoolean(uuid, true)
    return Text.of('Registered for the Friday Zone. Stay inside the arena: your ticket is taken when the waves start.').green()
  }
  consortiumEventSub(ev, 'optin').putBoolean(uuid, !!join)
  if (join) return Text.of('You are in. Waves may spawn near you at the HQ arena during invasions. /consortium event leave to opt out.').green()
  return Text.of('You are out of invasions. /consortium event join to opt in again.').yellow()
}

// ---- listeners (only with the engine on) ----------------------------------------------------------------------

if (CONSORTIUM_EVENTS_ON) {
  ServerEvents.loaded((event) => {
    let server = event.server
    try {
      if (CONSORTIUM_HAS_INCONTROL) {
        try { consortiumInControlReload() } catch (err) { console.error('[Consortium] In Control rule reload failed: ' + err) }
      }
      let ev = consortiumEvents(server)
      let active = consortiumActiveEvent(server)
      let now = Date.now()
      if (active !== null && now >= active.getLong('endsAt')) {
        let id = String(active.getString('id'))
        consortiumStopEvent(server, 'reconcile', null)
        console.info('[Consortium] events: expired ' + id + ' during downtime, cleaned up')
      } else if (active !== null) {
        let id = String(active.getString('id'))
        if (id === 'blood_moon' && !active.getBoolean('pendingDusk')) {
          server.persistentData.putBoolean('consortium_event_bloodmoon', true)
          if (CONSORTIUM_HAS_INCONTROL) server.runCommandSilent('incontrol setphase consortium_blood_moon')
        }
        consortiumEventBarCache = ''
        server.scheduleInTicks(40, () => { try { consortiumEventBar(server, true) } catch (err) { console.error('[Consortium] event bar failed: ' + err) } })
        console.info('[Consortium] events: resumed ' + id + ', ' + Math.max(0, Math.ceil((active.getLong('endsAt') - now) / 60000)) + ' min left')
      } else {
        consortiumBloodMoonClear(server)
        server.runCommandSilent('bossbar remove ' + CONSORTIUM_EVENT_BAR)
        consortiumKillTagged(server)
      }
      // Synchronous: the publish lands in the mod's pending snapshot and is folded over the saved one at
      // ServerStartedEvent, so no client ever sees a saved snapshot's dead event.
      consortiumPublishBoard(server, true)
      let rollable = 0
      for (let i = 0; i < CONSORTIUM_EVENT_IDS.length; i++) if (CONSORTIUM_EVENT_DEFS[CONSORTIUM_EVENT_IDS[i]].weight > 0) rollable++
      console.info('[Consortium] events engine loaded: ' + CONSORTIUM_EVENT_IDS.length + ' events (' + rollable + ' rollable), scheduler ' + (ev.getBoolean('paused') ? 'paused' : 'running') + ', arena ' + (consortiumArena(server) === null ? 'unset' : 'set')
        + (CONSORTIUM_HAS_APOTHEOSIS ? '' : ', bounty ineligible (Apotheosis absent)') + (CONSORTIUM_HAS_INCONTROL ? '' : ', blood_moon ineligible (In Control absent)'))
    } catch (err) { console.error('[Consortium] events load failed: ' + err) }
  })

  let consortiumEventTickFailAt = 0
  ServerEvents.tick((event) => {
    if (event.server.tickCount % CONSORTIUM_EVENT_STEP_TICKS !== 0) return
    try { consortiumEventStep(event.server) } catch (err) {
      if (Date.now() - consortiumEventTickFailAt > 60000) { consortiumEventTickFailAt = Date.now(); console.error('[Consortium] event step failed: ' + err) }
    }
  })

  // Market bonus accounting (EVENTS 2.4 and 3.1): the mod already paid, the bonus is booked against the caps. The
  // factor was clipped to the room at quote time (quoteFactor above), so the booking lands inside the caps up to
  // the cent rounding of the mod.
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let active = consortiumActiveEvent(server)
      if (active === null) return
      let id = String(active.getString('id'))
      let def = CONSORTIUM_EVENT_DEFS[id]
      if (!def || (def.kind !== 'market' && id !== 'market_crash' && id !== 'double_quota')) return
      let uuid = consortiumUuidOf(player)
      let payouts = consortiumEventSub(active, 'payouts')
      if (!payouts.contains(uuid)) payouts.putLong(uuid, 0) // participation mark
      if (def.kind !== 'market') return
      for (let line of e.lines) {
        let f = consortiumEventLastFactor[uuid + '|' + String(line.family)] || 1
        if (f <= 1.001) continue
        let cents = Number(line.cents)
        let bonus = cents - Math.floor(cents / f)
        if (bonus > 0) consortiumEventBook(server, active, uuid, bonus)
      }
    } catch (err) { console.error('[Consortium] event delivery accounting failed: ' + err) }
  })

  // Bounty damage shares (direct or projectile player sources).
  EntityEvents.afterHurt((event) => {
    try {
      let e = event.entity
      if (!consortiumHasTag(e, CONSORTIUM_TAG_BOUNTY)) return
      let server = e.server
      let active = consortiumActiveEvent(server)
      if (active === null || String(active.getString('boss')) !== String(e.uuid)) return
      let p = event.source.player
      if (p === null || p === undefined) return
      let damage = consortiumEventSub(active, 'damage')
      let uuid = consortiumUuidOf(p)
      damage.putDouble(uuid, damage.getDouble(uuid) + Number(event.damage))
    } catch (err) { console.error('[Consortium] bounty damage tracking failed: ' + err) }
  })

  // Bounty payout and wave kill credit. Both return when no event runs (the cleanup kill never pays).
  EntityEvents.death((event) => {
    try {
      let e = event.entity
      let bounty = consortiumHasTag(e, CONSORTIUM_TAG_BOUNTY)
      let wave = consortiumHasTag(e, CONSORTIUM_TAG_WAVE)
      if (!bounty && !wave) return
      let server = e.server
      let active = consortiumActiveEvent(server)
      if (active === null) return
      let id = String(active.getString('id'))
      if (bounty) {
        if (active.getBoolean('bossExpired')) return // the finale timed out: the auditor left unpaid (EVENTS 3.7)
        if (String(active.getString('boss')) !== String(e.uuid)) return
        if (id === 'bounty') {
          consortiumBountyPayout(server, active, null)
          consortiumStopEvent(server, 'done', null)
        } else if (id === 'friday_zone' && String(active.getString('stage')) === 'finale') {
          consortiumBountyPayout(server, active, (uuid) => consortiumFridayAdmitted(active, uuid))
          consortiumEventAnnounce(server, consortiumBountyResultLine(server, active).replace('Bounty claimed: ', 'The auditor fell: ') + ' The Board\'s crate stands at the arena centre for ticket holders.')
          active.putString('boss', '')
          consortiumFridayCrate(server, active, Date.now(), consortiumArena(server))
        }
        return
      }
      // Wave kill.
      if (id !== 'invasion' && !(id === 'friday_zone' && String(active.getString('stage')) === 'waves')) return
      let p = event.source.player
      if (p === null || p === undefined) return
      let uuid = consortiumUuidOf(p)
      let allowed = id === 'invasion' ? consortiumEventOptedIn(server, uuid) : consortiumFridayAdmitted(active, uuid)
      if (!allowed) return
      let kills = consortiumEventSub(active, 'kills')
      kills.putInt(uuid, kills.getInt(uuid) + 1)
      let payouts = consortiumEventSub(active, 'payouts')
      let room = active.getLong('killCap') - payouts.getLong(uuid)
      if (room > 0) consortiumEventPay(server, active, uuid, Math.min(room, active.getLong('killCents')), 'event:wave:' + kills.getInt(uuid))
    } catch (err) { console.error('[Consortium] event death handling failed: ' + err) }
  })

  // Orphan sweep (EVENTS 2.4): a tagged entity joining a level outside its event is discarded.
  let consortiumOrphanLogAt = 0
  EntityEvents.spawned((event) => {
    try {
      let e = event.entity
      if (!consortiumHasTag(e, CONSORTIUM_EVENT_TAG)) return
      let server = e.server
      let active = consortiumActiveEvent(server)
      let owned = false
      if (active !== null) {
        let id = String(active.getString('id'))
        if (consortiumHasTag(e, CONSORTIUM_TAG_BOUNTY)) owned = id === 'bounty' || id === 'friday_zone'
        else if (consortiumHasTag(e, CONSORTIUM_TAG_WAVE)) owned = id === 'invasion' || id === 'friday_zone'
        else if (consortiumHasTag(e, CONSORTIUM_TAG_BLOODMOON)) owned = id === 'blood_moon'
      }
      if (owned) return
      let pos = e.blockPosition()
      e.discard()
      if (Date.now() - consortiumOrphanLogAt > 60000) {
        consortiumOrphanLogAt = Date.now()
        console.info('[Consortium] orphan event mob discarded: ' + e.type + ' at ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ())
      }
    } catch (err) { console.error('[Consortium] orphan sweep failed: ' + err) }
  })

  // Blood moon base safety: no natural or spawner spawn inside a hostile claim while the flag is on.
  EntityEvents.checkSpawn((event) => {
    try {
      let level = event.level
      let server = level.server
      if (!server.persistentData.getBoolean('consortium_event_bloodmoon')) return
      let type = String(event.type)
      if (type !== 'NATURAL' && type !== 'SPAWNER') return
      if (consortiumHostileClaim(level, BlockPos.containing(event.x, event.y, event.z), consortiumArena(server))) event.cancel()
    } catch (err) { /* never block a spawn on a script error */ }
  })

  // Crate opener.
  BlockEvents.rightClicked((event) => {
    try {
      let player = event.player
      if (!player || !player.server) return
      let server = player.server
      let active = consortiumActiveEvent(server)
      if (active === null) return
      let id = String(active.getString('id'))
      if (id !== 'supply_drop' && !(id === 'friday_zone' && String(active.getString('stage')) === 'crate')) return
      if (consortiumCrateClicked(server, active, player, event.block.level, event.block.pos)) event.cancel()
    } catch (err) { console.error('[Consortium] crate click handling failed: ' + err) }
  })

  PlayerEvents.loggedIn((event) => {
    let player = event.player
    let server = player.server
    server.scheduleInTicks(60, () => {
      try {
        let active = consortiumActiveEvent(server)
        if (active === null) return
        server.runCommandSilent('bossbar set ' + CONSORTIUM_EVENT_BAR + ' players @a')
        let lines = consortiumEventStatus(server, player)
        for (let i = 0; i < lines.length && i < 2; i++) player.tell(lines[i])
        let id = String(active.getString('id'))
        if ((id === 'invasion' || id === 'friday_zone') && String(active.getString('stage')) === 'muster') {
          player.tell(Text.of('Muster at the HQ arena is open: ').yellow().append(Text.of('[join]').aqua().underlined().clickRunCommand('/consortium event join')))
        }
      } catch (err) { console.error('[Consortium] event login status failed: ' + err) }
    })
  })

  console.info('[Consortium] events engine registered: ' + CONSORTIUM_EVENT_IDS.length + ' events')
} else {
  console.info('[Consortium] events engine off: Consortium Core or FTB Chunks absent')
}
