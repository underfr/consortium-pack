// priority: 50
// The Consortium - phase engine (docs/PROGRESSION.md sections 2, 11, 12, 13; PROJECT_RULES 4.4, 4.5).
// Needs consortium_lib.js (helpers), consortium_quotas.js (the CONSORTIUM_PHASES table) and
// consortium_charters.js (charter and staff stage reconciliation), loaded before this file. The
// commands live in consortium_commands.js.
//
// One server-wide phase for everyone. State lives in server.persistentData under "consortium" and is
// saved with the world in <world>/kubejs_persistent_data.nbt:
//   currentPhase (int), startedAt (long: season start, normalised to the 06:00 at or before the real
//   start so season days roll over at 06:00 server time), lastDailyDay (int: season day of the last
//   daily summary), charters and staff (see consortium_charters.js),
//   phases.<n>: { startedAt, completedAt, lastProgressAt, stalledAt (longs), milestone (int),
//                 stalled (boolean), history.<season day> (int: C x 1000 at that day's 06:00 check),
//                 progress.<line key> (long) }
//   money and shop keys (paycheck, newcomer, licences, activity, vacancy, season, events.tickets, perks,
//   titles, sales, gap, txs): consortium_money.js and consortium_shop.js (SHOP_CATALOGUE 5.1)
//   batch 3 keys (ranks, contracts, referrals, referrals_week, onboarding, rules, discord, events.calendar):
//   consortium_ranks.js, consortium_contracts.js, consortium_onboarding.js, consortium_rules.js,
//   consortium_discord.js and consortium_calendar.js (BATCH_3_INTERFACES 6)
// The delivery terminal calls Consortium.contribute(player, itemId, count). Only items of the
// current phase quota count. When the rule of section 11 holds (average of the lines >= 90 % and every
// line >= 60 %) the next phase opens: every FTB team is reconciled (consortium_charters.js), the
// section 13 text is announced, the boss bar consortium:phase is renamed. Rule 4.5: every login
// reconciles the joining player's team, a 1 second sweep over online players catches party changes
// (leaving a party gives a stageless team; the sweep is the mechanism, no script listener can run
// before Chapters' own audit) and staff leaks (a non-staff player joining a staff party), and the
// 5 minute check reconciles every team, updates the boss bar, posts the daily summary and evaluates
// the stall rule. Consortium Core (when present) displays the quota board this engine publishes
// through ConsortiumCore.publishBoard(json) on every Delivery Station screen: the mod keeps no
// phase state of its own (docs/CONSORTIUM_CORE_V02.md section 2). Sibling engines are reached through
// typeof-guarded calls only (CONTENT_BATCH_2_INTERFACES 3): ConsortiumEvents.quotaFactor (Double Quota
// Hour, applied by Consortium.record unless the units are Board-sourced), ConsortiumEvents.boardObject
// (the board's event band), ConsortiumEvents.fireworks (phase completion), and the shop script's
// consortiumShopDaily / consortiumShopCheck (vacancy detection, sale expiry) and season fund line.
// Inspect the raw state with: /kubejs persistent-data server get consortium

const CONSORTIUM_SEASON_DAYS = 84
const CONSORTIUM_DAY_MS = 86400000
const CONSORTIUM_STALL_DAYS = 5 // section 11: C(d) - C(d-5) < 0.05 while C(d) < 1 and the phase is 5 days old
const CONSORTIUM_STALL_GAIN = 0.05
// Season days roll over at this hour (startedAt is normalised to it), so the daily snapshot and summary
// happen at the first check after 06:00 server time whatever the hour the season was started (review G3).
// The season day keys the paycheck cap, the Gap counters and the daily contracts; the mod's [market]
// day_boundary_hour (family caps, shop daily limits) is a second constant nobody reads against this one:
// both are 06:00 and never change alone (RANKS_AND_CONTRACTS 2.1, CONFIG_DECISIONS; consortium_contracts.js
// warns once at boot when they differ).
const CONSORTIUM_DAILY_HOUR = 6
const CONSORTIUM_MILESTONES = [25, 50, 75, 90] // section 13: quota announcements at these percents of C
const CONSORTIUM_BAR = 'consortium:phase'
const CONSORTIUM_CHECK_TICKS = 6000 // 5 minutes
const CONSORTIUM_PLAYER_TICKS = 20 // 1 second: safety net after a party change (review F3) or a staff leak (review G2)
const CONSORTIUM_STATE_VERSION = 3

// ---- persistent state -----------------------------------------------------------------------------

// The CONSORTIUM_DAILY_HOUR (06:00) at or before the instant `now`, as epoch ms in server time: the
// season start every day number is counted from. A season started at 20:00 therefore begins its day 2
// at 06:00 the next morning, not at 20:00 (a DST change shifts one boundary by an hour, the hour guard
// in consortiumDaily keeps the summary after 06:00 that day).
function consortiumSeasonStart(now) {
  let d = new Date(now)
  if (d.getHours() < CONSORTIUM_DAILY_HOUR) d.setDate(d.getDate() - 1)
  d.setHours(CONSORTIUM_DAILY_HOUR, 0, 0, 0)
  return d.getTime()
}

function consortiumState(server) {
  let pd = server.persistentData
  if (!pd.contains('consortium')) pd.put('consortium', NBT.compoundTag())
  let st = pd.getCompound('consortium')
  if (!st.contains('currentPhase')) {
    st.putInt('version', CONSORTIUM_STATE_VERSION)
    st.putInt('currentPhase', 1)
    st.putLong('startedAt', consortiumSeasonStart(Date.now()))
    st.putInt('lastDailyDay', 0)
    st.put('phases', NBT.compoundTag())
    console.info('[Consortium] fresh state: phase 1, season day 1')
  } else if (st.getInt('version') < 3) {
    // Version 2 states kept the raw start instant: align the day boundary to 06:00 once.
    st.putLong('startedAt', consortiumSeasonStart(st.getLong('startedAt')))
    st.putInt('version', CONSORTIUM_STATE_VERSION)
    console.info('[Consortium] state upgraded to version 3: season days now roll over at 06:00')
  }
  return st
}

function consortiumPhaseTag(server, n) {
  let st = consortiumState(server)
  if (!st.contains('phases')) st.put('phases', NBT.compoundTag())
  let phases = st.getCompound('phases')
  let key = String(n)
  if (!phases.contains(key)) {
    let tag = NBT.compoundTag()
    tag.putLong('startedAt', Date.now())
    tag.putLong('completedAt', 0)
    tag.putLong('lastProgressAt', 0)
    tag.putLong('stalledAt', 0)
    tag.putBoolean('stalled', false)
    tag.putInt('milestone', 0)
    tag.put('history', NBT.compoundTag())
    tag.put('progress', NBT.compoundTag())
    phases.put(key, tag)
  }
  let tag = phases.getCompound(key)
  if (!tag.contains('history')) tag.put('history', NBT.compoundTag()) // states written before version 2
  return tag
}

function consortiumLineKey(line) {
  return line.id.replace(/[^a-z0-9]/g, '_')
}

function consortiumDef(n) {
  return CONSORTIUM_PHASES[Math.min(Math.max(n, 1), CONSORTIUM_PHASES.length) - 1]
}

// Season day (1 = launch day) of an epoch ms instant; days roll over at 06:00 server time.
function consortiumSeasonDayAt(server, when) {
  return Math.floor((when - consortiumState(server).getLong('startedAt')) / CONSORTIUM_DAY_MS) + 1
}

function consortiumSeasonDay(server) {
  return consortiumSeasonDayAt(server, Date.now())
}

// { lines: [{ line, delivered, ratio }], c, complete } for phase n (section 11: C = average of min(1, delivered / quota)).
function consortiumProgress(server, n) {
  let def = consortiumDef(n)
  let progress = consortiumPhaseTag(server, n).getCompound('progress')
  let lines = []
  let sum = 0
  let allAbove = true
  for (let i = 0; i < def.quota.length; i++) {
    let line = def.quota[i]
    let delivered = progress.getLong(consortiumLineKey(line))
    let ratio = Math.min(1, delivered / line.amount)
    sum += ratio
    if (ratio < 0.6) allAbove = false
    lines.push({ line: line, delivered: delivered, ratio: ratio })
  }
  let c = def.quota.length ? sum / def.quota.length : 0
  return { lines: lines, c: c, complete: c >= 0.9 && allAbove }
}

function consortiumStagesUpTo(n) {
  let out = []
  for (let i = 1; i <= n; i++) out.push(consortiumDef(i).stage)
  return out
}

function consortiumMissingList(prog) {
  let parts = []
  for (let i = 0; i < prog.lines.length; i++) {
    let l = prog.lines[i]
    if (l.delivered < l.line.amount) parts.push(consortiumFmt(l.line.amount - l.delivered) + ' ' + l.line.label)
  }
  return parts.length ? parts.join(', ') : 'nothing'
}

// "cobblestone 12 %, iron ingots 40 %, ..." for the daily summary.
function consortiumLinePercents(prog) {
  let parts = []
  for (let i = 0; i < prog.lines.length; i++) parts.push(prog.lines[i].line.label + ' ' + consortiumPct(prog.lines[i].ratio) + ' %')
  return parts.join(', ')
}

// ---- boss bar ---------------------------------------------------------------------------------------

let consortiumBarCache = '' // last name pushed; unchanged bars are not re-sent (keeps the SDLink command feed quiet)

function consortiumUpdateBar(server, force) {
  let n = consortiumState(server).getInt('currentPhase')
  let pct = consortiumPct(consortiumProgress(server, n).c)
  let name = JSON.stringify({ text: 'Phase ' + n + ': ' + consortiumDef(n).name + ' - ' + pct + '%', color: 'gold' })
  if (!force && name === consortiumBarCache) return
  consortiumBarCache = name
  let run = (c) => server.runCommandSilent('bossbar ' + c)
  run('add ' + CONSORTIUM_BAR + ' ' + name) // fails silently once the bar exists (bars persist in level.dat)
  run('set ' + CONSORTIUM_BAR + ' max 100')
  run('set ' + CONSORTIUM_BAR + ' value ' + pct)
  run('set ' + CONSORTIUM_BAR + ' name ' + name)
  run('set ' + CONSORTIUM_BAR + ' color yellow')
  run('set ' + CONSORTIUM_BAR + ' style notched_10')
  run('set ' + CONSORTIUM_BAR + ' players @a')
}

// ---- quota board (Consortium Core, CONSORTIUM_CORE_V02.md 2.4) --------------------------------------
// The mod displays what the engine pushes: ConsortiumCore.publishBoard(json) with the payload below.
// The binding only exists when the mod is loaded, hence the typeof guard; the mod accepts a publish
// before its runtime exists (ServerEvents.loaded fires before its ServerStartedEvent) and folds it in.

let consortiumBoardCache = ''  // last JSON handed to the mod; identical payloads are not re-sent
let consortiumBoardSentAt = 0  // Date.now() of the last publish
let consortiumBoardPending = false
const CONSORTIUM_BOARD_MIN_MS = 1000

// Display item of a quota line: an explicit `icon`, else the first listed member, else the id itself
// (a tag id without `items` would show a barrier, so tag lines must carry `items` or `icon`).
function consortiumLineIcon(line) {
  if (line.icon) return line.icon
  if (line.items && line.items.length) return line.items[0]
  return line.id
}

// "cobblestone" -> "Cobblestone" (labels are lower case in the quota table for chat sentences).
function consortiumLabelCase(label) {
  let s = String(label)
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// The board's event band (Consortium Core 0.3.1, EVENTS 8): { name, detail, seconds_left } from the events
// engine, or null; a 0.3.0 jar ignores the key.
function consortiumBoardEvent(server) {
  if (typeof ConsortiumEvents === 'undefined' || typeof ConsortiumEvents.boardObject !== 'function') return null
  try {
    let e = ConsortiumEvents.boardObject(server)
    return e ? e : null
  } catch (err) {
    console.error('[Consortium] board event object failed: ' + err)
    return null
  }
}

// Daily contracts (RANKS_AND_CONTRACTS 2, consortium_contracts.js): typeof-guarded wrappers, [] / '' / no-op
// without the script. The board lines sit next to season_fund, the compact text feeds the payload's `contracts`
// field (the {contracts} tab token of Consortium Core 0.4.0, ignored by 0.3.x) and the daily hook runs the pick
// and the summary line right after the shop's daily duties.
function consortiumContractBoardLines(server) {
  if (typeof Consortium.contracts === 'undefined' || !Consortium.contracts || typeof Consortium.contracts.boardLines !== 'function') return []
  try { return Consortium.contracts.boardLines(server) } catch (err) { console.error('[Consortium] contract board lines failed: ' + err); return [] }
}

function consortiumContractBoardText(server) {
  if (typeof Consortium.contracts === 'undefined' || !Consortium.contracts || typeof Consortium.contracts.text !== 'function') return ''
  try { return String(Consortium.contracts.text(server)) } catch (err) { console.error('[Consortium] contract text failed: ' + err); return '' }
}

function consortiumContractsDaily(server, day) {
  if (typeof Consortium.contracts === 'undefined' || !Consortium.contracts || typeof Consortium.contracts.daily !== 'function') return false
  try { Consortium.contracts.daily(server, day); return true } catch (err) { console.error('[Consortium] contracts daily step failed: ' + err); return false }
}

// Rank tiers (RANKS_AND_CONTRACTS 1.2, consortium_ranks.js): published to Consortium Core 0.4.0 at load and from
// every 5 minute check (the mod dedups identical tables); a no-op without the script or the API.
function consortiumRankTiersPublish(server) {
  if (typeof consortiumRankPublish !== 'function') return false
  try { return consortiumRankPublish(server) } catch (err) { console.error('[Consortium] rank tiers publish failed: ' + err); return false }
}

function consortiumBoardPayload(server) {
  let st = consortiumState(server)
  let n = st.getInt('currentPhase')
  let def = consortiumDef(n)
  let tag = consortiumPhaseTag(server, n)
  let prog = consortiumProgress(server, n)
  let lines = []
  for (let i = 0; i < prog.lines.length; i++) {
    let l = prog.lines[i]
    lines.push({ key: l.line.id, label: consortiumLabelCase(l.line.label), icon: consortiumLineIcon(l.line),
      current: Number(l.delivered), target: l.line.amount })
  }
  // Season fund (SHOP_CATALOGUE 5.6): one more line once the first contribution wrote the target; the mod
  // renders it like a quota line (completion comes from the quota lines only).
  if (st.contains('season') && st.getCompound('season').getLong('target') > 0) {
    let season = st.getCompound('season')
    lines.push({ key: 'season_fund', label: 'Season fund', icon: 'minecraft:gold_ingot',
      current: Math.floor(season.getLong('fund') / 100), target: Math.floor(season.getLong('target') / 100) })
  }
  // Daily contracts (RANKS 2.4): one line per contract, rendered like a quota line (a filled one shows as done).
  let contracts = consortiumContractBoardLines(server)
  for (let i = 0; i < contracts.length; i++) lines.push(contracts[i])
  let payload = {
    phase: n, name: def.name,
    day: consortiumSeasonDay(server), days: CONSORTIUM_SEASON_DAYS,
    completion: Math.round(prog.c * 1000) / 1000,
    complete: tag.getLong('completedAt') > 0,
    lines: lines,
  }
  let event = consortiumBoardEvent(server)
  if (event !== null) payload.event = event
  let contractText = consortiumContractBoardText(server)
  if (contractText.length) payload.contracts = contractText
  return payload
}

// At most one publish per second: the first change goes out at once, later ones inside the same second
// collapse into one trailing publish that recomputes the payload (one delivery of three item ids is
// three record() calls in the same tick). `force` bypasses the unchanged check, not the window.
function consortiumPublishBoard(server, force) {
  if (typeof ConsortiumCore === 'undefined') return
  let json = JSON.stringify(consortiumBoardPayload(server))
  if (!force && json === consortiumBoardCache) return
  let now = Date.now()
  if (now - consortiumBoardSentAt < CONSORTIUM_BOARD_MIN_MS) {
    if (consortiumBoardPending) return
    consortiumBoardPending = true
    server.scheduleInTicks(20, () => {
      consortiumBoardPending = false
      try { consortiumPublishBoard(server, true) } catch (err) { console.error('[Consortium] board publish failed: ' + err) }
    })
    return
  }
  consortiumBoardCache = json
  consortiumBoardSentAt = now
  try {
    if (!ConsortiumCore.publishBoard(json)) console.warn('[Consortium] board publish refused by Consortium Core (see its log)')
  } catch (err) { console.error('[Consortium] board publish failed: ' + err) }
}

// ---- daily snapshot, summary and stall rule (section 11) -------------------------------------------

// The newest snapshot taken at least `days` season days before `day`, as C (0..1), or -1 when none.
function consortiumSnapshotBefore(tag, day, days) {
  let history = tag.getCompound('history')
  let best = -1
  let bestDay = null
  for (let key of history.getAllKeys()) {
    let d = parseInt(String(key), 10)
    if (d <= day - days && (bestDay === null || d > bestDay)) { bestDay = d; best = history.getInt(key) / 1000 }
  }
  return best
}

// Runs once per season day (first check after 06:00 server time, the season day boundary, or forced):
// snapshot C, post the summary, evaluate the stall flag. Returns true when it ran.
function consortiumDaily(server, force) {
  let st = consortiumState(server)
  let day = consortiumSeasonDay(server)
  if (!force && (st.getInt('lastDailyDay') === day || new Date().getHours() < CONSORTIUM_DAILY_HOUR)) return false
  st.putInt('lastDailyDay', day)
  let n = st.getInt('currentPhase')
  let def = consortiumDef(n)
  let tag = consortiumPhaseTag(server, n)
  let prog = consortiumProgress(server, n)
  tag.getCompound('history').putInt(String(day), Math.round(prog.c * 1000))
  let done = tag.getLong('completedAt') > 0
  let fund = ''
  if (st.contains('season') && st.getCompound('season').getLong('target') > 0) {
    let season = st.getCompound('season')
    fund = ', season fund ' + consortiumPct(season.getLong('fund') / season.getLong('target')) + ' %'
  }
  consortiumBroadcast(server, 'Day ' + day + ' of ' + CONSORTIUM_SEASON_DAYS + ', Phase ' + n + ': ' + def.name + ', quota ' + consortiumPct(prog.c) + ' %'
    + (done ? ' (complete)' : '') + '. Lines: ' + consortiumLinePercents(prog) + fund + '.')
  // Shop-side daily duties (consortium_shop.js, SHOP_CATALOGUE 5.5): vacancy detection, tx pruning.
  if (typeof consortiumShopDaily === 'function') {
    try { consortiumShopDaily(server, day) } catch (err) { console.error('[Consortium] shop daily step failed: ' + err) }
  }
  // Daily contracts (consortium_contracts.js, RANKS_AND_CONTRACTS 2.1): the pick of the day and its summary line.
  consortiumContractsDaily(server, day)
  if (done) return true
  let now = Date.now()
  let old = consortiumSnapshotBefore(tag, day, CONSORTIUM_STALL_DAYS)
  let oldEnough = now - tag.getLong('startedAt') >= CONSORTIUM_STALL_DAYS * CONSORTIUM_DAY_MS
  let stalled = oldEnough && old >= 0 && prog.c < 1 && prog.c - old < CONSORTIUM_STALL_GAIN
  if (stalled && !tag.getBoolean('stalled')) {
    tag.putBoolean('stalled', true)
    tag.putLong('stalledAt', now)
    if (typeof Consortium.onCatchUp === 'function') {
      consortiumBroadcast(server, 'Phase ' + n + ' has stalled for ' + CONSORTIUM_STALL_DAYS + ' days. The Board now sources missing deliveries at twice the base price. Ask at the HQ terminal.')
      Consortium.onCatchUp(server, n)
    } else {
      consortiumBroadcast(server, 'Phase ' + n + ' has stalled for ' + CONSORTIUM_STALL_DAYS + ' days. The Board is reviewing the quota.')
    }
  } else if (!stalled && tag.getBoolean('stalled')) {
    tag.putBoolean('stalled', false)
    if (typeof Consortium.onCatchUp === 'function') {
      consortiumBroadcast(server, 'Deliveries on Phase ' + n + ' have resumed, the Gap Contract is closed.')
    } else {
      consortiumBroadcast(server, 'Deliveries on Phase ' + n + ' have resumed. The Board stands down.')
    }
  }
  return true
}

// Double Quota Hour (EVENTS 3.5): the events engine's factor on recorded units, 1 without the engine.
function consortiumQuotaFactor(server) {
  if (typeof ConsortiumEvents === 'undefined' || typeof ConsortiumEvents.quotaFactor !== 'function') return 1
  try {
    let f = Number(ConsortiumEvents.quotaFactor(server))
    return isFinite(f) && f > 0 ? f : 1
  } catch (err) {
    console.error('[Consortium] quota factor failed: ' + err)
    return 1
  }
}

// ---- engine ----------------------------------------------------------------------------------------
// Shared server-script scope object (KubeJS 2101 refuses writes to `global` from server scripts). Any
// server script (terminal, quests, events) can call Consortium.contribute(...) directly.

const Consortium = {
  phases: CONSORTIUM_PHASES,
  charters: CONSORTIUM_CHARTERS,
  def: consortiumDef,
  phase: (server) => consortiumState(server).getInt('currentPhase'),
  progress: (server, n) => consortiumProgress(server, n),
  phaseTag: (server, n) => consortiumPhaseTag(server, n),
  seasonDay: consortiumSeasonDay,
  stagesUpTo: consortiumStagesUpTo,

  // Quota line of the current phase that accepts this item id, or null.
  lineFor: (server, itemId) => {
    let def = consortiumDef(consortiumState(server).getInt('currentPhase'))
    for (let i = 0; i < def.quota.length; i++) {
      let line = def.quota[i]
      if (line.id === itemId) return line
      if (line.items && line.items.indexOf(itemId) >= 0) return line
    }
    return null
  },

  // Delivery by an online player (the terminal's entry point). Returns the units accepted (0 = not in quota).
  contribute: (player, itemId, count) => Consortium.record(player.server, player.username, itemId, count),

  // Same, with an explicit server and a display name (console tests). Announces the section 13 milestones.
  // "source" (CONTENT_BATCH_2_INTERFACES 3): absent or 'terminal' = the Double Quota Hour factor of the
  // events engine multiplies the count; 'board' (the Gap Contract) = counted once. Returns the units recorded.
  record: (server, who, itemId, count, source) => {
    if (count <= 0) return 0
    let n = consortiumState(server).getInt('currentPhase')
    let tag = consortiumPhaseTag(server, n)
    if (tag.getLong('completedAt') > 0) return 0
    let line = Consortium.lineFor(server, itemId)
    if (line === null) return 0
    let factor = source === 'board' ? 1 : consortiumQuotaFactor(server)
    let units = Math.max(1, Math.round(count * factor))
    let progress = tag.getCompound('progress')
    let key = consortiumLineKey(line)
    progress.putLong(key, progress.getLong(key) + units)
    tag.putLong('lastProgressAt', Date.now())
    let after = consortiumProgress(server, n)
    console.info('[Consortium] ' + who + ' delivered ' + count + ' ' + itemId + (factor !== 1 ? ' (x' + factor + ' quota hour, ' + units + ' units)' : '')
      + (source === 'board' ? ' (Board-sourced)' : '') + ' (phase ' + n + ' quota at ' + consortiumPct(after.c) + '%)')
    // Credits, charter modifiers, the newcomer bonus and the daily caps are the mod's and consortium_money.js's.
    let pct = consortiumPct(after.c)
    let reached = 0
    for (let i = 0; i < CONSORTIUM_MILESTONES.length; i++) {
      if (pct >= CONSORTIUM_MILESTONES[i]) reached = CONSORTIUM_MILESTONES[i]
    }
    if (!after.complete && reached > tag.getInt('milestone')) {
      tag.putInt('milestone', reached)
      consortiumSay(server, 'Phase ' + n + ' quota at ' + reached + ' %. Still needed: ' + consortiumMissingList(after) + '. Open the terminal at HQ to contribute.')
    }
    consortiumUpdateBar(server, false)
    consortiumPublishBoard(server, false)
    if (after.complete) Consortium.completePhase(server)
    return units
  },

  // Closes the current phase and opens the next one for every team (section 13 ceremony text).
  completePhase: (server) => {
    let st = consortiumState(server)
    let n = st.getInt('currentPhase')
    let done = consortiumDef(n)
    consortiumPhaseTag(server, n).putLong('completedAt', Date.now())
    if (n >= CONSORTIUM_PHASES.length) {
      consortiumTitle(server, 'Phase 5 complete', 'The season project can begin')
      consortiumSay(server, 'The Phase 5 quota is complete. The Board convenes on ' + consortiumNextSlot() + ' at 20:00 server time at HQ for ' + done.moment + '.')
      consortiumDiscord(server, 'Phase 5 quota complete: ' + done.moment + ' is next.')
      consortiumUpdateBar(server, true)
      consortiumPublishBoard(server, true)
      return
    }
    let next = consortiumDef(n + 1)
    st.putInt('currentPhase', n + 1)
    consortiumPhaseTag(server, n + 1).putLong('startedAt', Date.now())
    let changes = Consortium.resync(server)
    console.info('[Consortium] phase ' + (n + 1) + ' opened, ' + changes + ' team stage change(s)')
    consortiumTitle(server, 'Phase ' + (n + 1) + ' unlocked', next.name)
    let link = [{ text: ' [open quests]', color: 'aqua', underlined: true,
      clickEvent: { action: 'run_command', value: '/ftbquests open_book ' + next.quest },
      hoverEvent: { action: 'show_text', contents: 'Click to open the quest book' } }]
    consortiumSay(server, 'The Phase ' + n + ' quota is complete. Phase ' + (n + 1) + ' is open now: ' + next.name + '. New this phase: ' + next.headline + '.', link)
    consortiumSay(server, 'The Board convenes on ' + consortiumNextSlot() + ' at 20:00 server time at HQ for ' + done.moment + '.')
    server.runCommandSilent('playsound minecraft:ui.toast.challenge_complete master @a')
    consortiumDiscord(server, 'Phase ' + (n + 1) + ' unlocked: ' + next.name)
    consortiumUpdateBar(server, true)
    consortiumPublishBoard(server, true)
    consortiumFireworks(server) // section 13 fireworks at HQ (events engine, no-op until its arena is set)
    // The moment reminders (minus 60 and minus 5 min) and the moment title are the events engine's (EVENTS 9).
  },

  // Reconciles every team: phases, charter and staff stages (consortium_charters.js). Returns the
  // number of stage changes.
  resync: (server) => consortiumApplyAllTeams(server),

  // Reconciles one online player's current team (login, party change).
  applyPlayer: (server, player) => consortiumApplyPlayer(server, player),

  // Runs the daily step now, whatever the time (staff and tests).
  daily: (server) => {
    let ran = consortiumDaily(server, true)
    consortiumPublishBoard(server, false)
    return ran
  },

  // 5 minute maintenance: team stages, boss bar, daily snapshot and summary, stall rule, quota board
  // (the season day rolls over within 5 minutes; the first check 100 ticks after load and every
  // /reload, which resets the script-level cache, republish the board).
  check: (server) => {
    // Shop-side maintenance first (consortium_shop.js: expired sales close), so the resync below strips them.
    if (typeof consortiumShopCheck === 'function') {
      try { consortiumShopCheck(server) } catch (err) { console.error('[Consortium] shop check failed: ' + err) }
    }
    let changes = Consortium.resync(server)
    if (changes > 0) console.info('[Consortium] check: ' + changes + ' team stage change(s)')
    consortiumUpdateBar(server, false)
    consortiumDaily(server, false)
    consortiumRankTiersPublish(server) // Consortium Core 0.4.0 dedups the table (RANKS 1.2)
    consortiumPublishBoard(server, false)
  },

  // Staff lever: jump to phase n. Every team is reconciled (stages above n stripped from non-staff
  // teams), delivery progress is kept: a phase whose progress already satisfies the completion rule
  // stays complete (the next delivery does not re-announce the unlock, review F6).
  setPhase: (server, n) => {
    let st = consortiumState(server)
    st.putInt('currentPhase', n)
    let tag = consortiumPhaseTag(server, n)
    if (consortiumProgress(server, n).complete) {
      if (tag.getLong('completedAt') === 0) tag.putLong('completedAt', Date.now())
    } else {
      tag.putLong('completedAt', 0)
    }
    tag.putLong('startedAt', Date.now())
    let changes = Consortium.resync(server)
    consortiumUpdateBar(server, true)
    consortiumPublishBoard(server, true)
    consortiumSay(server, 'Staff set the server to Phase ' + n + ': ' + consortiumDef(n).name + '.')
    return changes
  },

  // Staff lever: wipes the delivery progress of the current phase (milestones, stall history included).
  clearProgress: (server) => {
    let n = consortiumState(server).getInt('currentPhase')
    let tag = consortiumPhaseTag(server, n)
    tag.put('progress', NBT.compoundTag())
    tag.put('history', NBT.compoundTag())
    tag.putLong('completedAt', 0)
    tag.putLong('lastProgressAt', 0)
    tag.putLong('stalledAt', 0)
    tag.putBoolean('stalled', false)
    tag.putInt('milestone', 0)
    consortiumUpdateBar(server, true)
    consortiumPublishBoard(server, true)
  },

  // Wipes phase and charter state and the boss bar; the staff list is kept (it is configuration,
  // not season state). Every team is reconciled back to phase 1. The fresh state comes from
  // consortiumState, so the new season start is the 06:00 at or before the wipe.
  reset: (server) => {
    let staff = consortiumStaffList(server).copy()
    server.persistentData.remove('consortium')
    server.runCommandSilent('bossbar remove ' + CONSORTIUM_BAR)
    consortiumBarCache = ''
    consortiumBoardCache = ''
    consortiumState(server).put('staff', staff)
    Consortium.resync(server)
    consortiumUpdateBar(server, true)
    consortiumPublishBoard(server, true)
  },

  onCatchUp: null, // set by consortium_shop.js (the Gap Contract, SHOP_CATALOGUE 5.8): (server, phaseNumber) => void
}

// Fireworks at HQ through the events engine (EVENTS 9), typeof-guarded: a pack without it does nothing.
function consortiumFireworks(server) {
  if (typeof ConsortiumEvents === 'undefined' || typeof ConsortiumEvents.fireworks !== 'function') return
  try { ConsortiumEvents.fireworks(server) } catch (err) { console.error('[Consortium] fireworks failed: ' + err) }
}

// ---- events ----------------------------------------------------------------------------------------

ServerEvents.loaded((event) => {
  let server = event.server
  consortiumState(server)
  consortiumUpdateBar(server, true)
  // Rank tiers (RANKS 1.2): published here when the mod's runtime is already up (a /reload), else by the first
  // check below; the mod keeps the last table in consortium_ranks.dat, so a boot-time delivery already promotes.
  consortiumRankTiersPublish(server)
  // The team manager is loaded by now but give FTB Teams a moment before the first sweep. The first
  // quota board publish happens in that check too (Consortium Core's runtime does not exist yet here).
  server.scheduleInTicks(100, () => {
    try { Consortium.check(server) } catch (err) { console.error('[Consortium] first check failed: ' + err) }
  })
  console.info('[Consortium] engine loaded: phase ' + Consortium.phase(server) + ', season day ' + consortiumSeasonDay(server))
})

ServerEvents.tick((event) => {
  let tick = event.server.tickCount
  if (tick % CONSORTIUM_PLAYER_TICKS === 0) {
    // Party changes and staff leaks: a player whose current team lacks the current phase stage, or
    // whose team holds consortium:staff against the staff rule (or lacks it while staff-only), gets
    // the team reconciled (consortiumPlayerNeedsSweep, consortium_charters.js).
    let n = Consortium.phase(event.server)
    let stage = consortiumDef(n).stage
    for (let p of event.server.players) {
      try {
        if (consortiumPlayerNeedsSweep(event.server, p, stage)) console.info('[Consortium] reconciled the team of ' + p.username + ' (' + Consortium.applyPlayer(event.server, p) + ' stage change(s))')
      } catch (err) { console.error('[Consortium] player sweep failed for ' + p.username + ': ' + err) }
    }
  }
  if (tick % CONSORTIUM_CHECK_TICKS === 0) {
    try { Consortium.check(event.server) } catch (err) { console.error('[Consortium] check failed: ' + err) }
  }
})

PlayerEvents.loggedIn((event) => {
  let player = event.player
  let server = player.server
  let n = Consortium.phase(server)
  let apply = () => {
    try { Consortium.applyPlayer(server, player) } catch (err) { console.error('[Consortium] login grant for ' + player.username + ' failed: ' + err) }
  }
  apply()
  server.scheduleInTicks(40, apply) // again once FTB Teams has surely assigned the team
  server.runCommandSilent('bossbar set ' + CONSORTIUM_BAR + ' players @a') // the bar's player set is explicit
  player.tell(Text.of('Welcome to The Consortium, Season 1, phase ' + n + ' of 5: ').gray()
    .append(Text.of(consortiumDef(n).name).gold())
    .append(Text.of(' (day ' + consortiumSeasonDay(server) + ' of ' + CONSORTIUM_SEASON_DAYS + '). Your team holds phases 1-' + n + '.').gray()))
  server.scheduleInTicks(45, () => {
    try { player.tell(consortiumCharterStatus(server, player)) } catch (err) { console.error('[Consortium] charter status for ' + player.username + ' failed: ' + err) }
  })
})
