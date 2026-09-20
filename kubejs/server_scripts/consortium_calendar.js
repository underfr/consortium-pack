// priority: 15
// The Consortium - the season calendar of the events engine: reminders, the Friday and Saturday auto-queue and the
// Wednesday contract guard (docs/DISCORD_AND_COMMUNITY.md 6, docs/BATCH_3_INTERFACES.md 2 and 4; PROJECT_RULES 4.6
// "rewards announced beforehand"). Loads after consortium_events.js (20) and consortium_events_lib.js (45): it adds
// ConsortiumEvents.calendar and ConsortiumEvents.queue to the shared shell the way consortium_events.js adds its
// members, and touches neither file. Needs consortium_lib.js (consortiumBroadcast, consortiumSub through
// consortium_charters.js) and consortium_phases.js (Consortium, consortiumState). Discord posts go through the mod's
// one transport, ConsortiumCore.discordAnnounce / discordStaff (0.4.0, probed at call time; without them the text is
// logged), game lines through the say relay (consortiumBroadcast). Runs with or without CONSORTIUM_EVENTS_ON: without
// the events engine the reminders still post and the queue answers a refusal.
//
// Source: kubejs/data/consortium/consortium_calendar/season1.json, read at ServerEvents.loaded (JsonIO): weekly `slots`
// by weekday (wednesday: kind contract; friday: kind friday_zone with a phase1_event fallback; saturday: kind staff,
// a programme only through a date entry) and pre-planned `dates`; staff-set dates in persistent state win over the
// file (`/consortium calendar set|title|cancel|clear`, the DISCORD BLOCK of consortium_commands.js). Every slot is at
// CONSORTIUM_SLOT_HOUR = 20 server time. Reward tokens {kill} {max} {bounty} {share} are filled at post time from the
// events engine's own constants (consortiumEventRef x CONSORTIUM_EVENT_WAVE_KILL / WAVE_CAP / BOUNTY_POT /
// BOUNTY_SHARE_CAP), so a reminder always matches what the event pays; without them the Rewards sentence is dropped.
//
// Its own 5 s step (ServerEvents.tick, the consortiumEventStep pattern, no scheduleRepeating):
//   1. the next slot instant from the slots and the two date sources;
//   2. the 24 h line at slot minus 24 h and the 1 h line at slot minus 1 h, each posted once inside a 30-minute window
//      (PLACEHOLDER) and stamped `<date>:<kind>`; an instant first seen past its window is stamped `missed:<date>:<kind>`
//      and logged once (a restart or downtime spanned it: never a late "Tomorrow at 20:00" on the wrong day);
//   3. the 06:00 auto-queue: the first step with lastDailyDay === today's season day and queuedDate !== today queues
//      today's Friday or Saturday event at 20:00 through ConsortiumEvents.queue (never over a staff queue), the phase 1
//      Friday falls back to the slot's phase1_event, an ineligible event or a cancelled date is reported on the staff
//      lane, a daily step after 20:00 skips with one log line;
//   4. Wednesday 19:00, once per season week: the weekly contract guard reads ConsortiumQuests.contract.current and
//      posts "No weekly contract set for tonight (/consortium contract set)." to the staff lane when the record is
//      absent, ends before 21:00 tonight or was set more than 6 days ago.
// A cancelled date posts the cancellation line at minus 24 h and queues nothing; a Saturday without a programme posts
// "No Saturday programme set for <date> (/consortium calendar set)." to the staff lane at minus 24 h and nothing in
// public; a late `set` or `cancel` inside the 24 h window posts its line at once and stamps it.
//
// State (server.persistentData consortium.events.calendar, the events engine's namespace): reminded24, reminded1h
// (strings `<date>:24h`, `<date>:1h` or `missed:...`), queuedDate, wednesdayGuardWeek, dates.<date> { event, args,
// title, where, rewards, ticket, cancelled, reason }. events.queued is written by ConsortiumEvents.queue only.
//
// Every number marked PLACEHOLDER is tuned in the beta. No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_SLOT_HOUR = 20                    // rule 4.6: every Board slot is at 20:00 server time (the calendar never moves it)
const CONSORTIUM_CALENDAR_PATH = 'kubejs/data/consortium/consortium_calendar/season1.json'
const CONSORTIUM_CALENDAR_STEP_TICKS = 100          // the 5 s step
const CONSORTIUM_CALENDAR_WINDOW_MS = 30 * 60000    // PLACEHOLDER: a reminder is posted only inside this window after its instant
const CONSORTIUM_CALENDAR_LOOKAHEAD_DAYS = 14
const CONSORTIUM_CALENDAR_GUARD_HOUR = 19           // the Wednesday contract guard
const CONSORTIUM_CALENDAR_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const CONSORTIUM_CALENDAR_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const CONSORTIUM_CALENDAR_HOUR_MS = 3600000
const CONSORTIUM_CALENDAR_DAY_MS = 86400000

let consortiumCalendarCache = null   // { roleMention, slots: { weekday: {...} }, dates: { 'YYYY-MM-DD': {...} } } or null
let consortiumCalendarTried = false
let consortiumCalendarServer = null

// ---- source -----------------------------------------------------------------------------------------------

function consortiumCalendarGet(o, k) {
  if (o === null || o === undefined) return undefined
  try {
    if (typeof o.get === 'function') {
      let v = o.get(k)
      if (v !== null && v !== undefined) return v
    }
  } catch (err) { /* not a map */ }
  try { return o[k] } catch (err) { return undefined }
}

function consortiumCalendarKeys(o) {
  let out = []
  if (o === null || o === undefined) return out
  try {
    if (typeof o.keySet === 'function') {
      for (let k of o.keySet()) out.push(String(k))
      return out
    }
  } catch (err) { /* not a map */ }
  for (let k in o) out.push(String(k))
  return out
}

function consortiumCalendarStrings(v) {
  let out = []
  if (v === null || v === undefined) return out
  try {
    if (typeof v.size === 'function' && typeof v.get === 'function') {
      for (let i = 0; i < v.size(); i++) out.push(String(v.get(i)))
      return out
    }
  } catch (err) { /* not a list */ }
  if (typeof v.length === 'number') for (let i = 0; i < v.length; i++) out.push(String(v[i]))
  return out
}

function consortiumCalendarStr(o, k) {
  let v = consortiumCalendarGet(o, k)
  return v === null || v === undefined ? '' : String(v)
}

// A slot or date entry as plain JS: { kind, title, where, event, args, ticket, rewards, phase1Event, phase1Title,
// phase1Ticket, phase1Rewards, cancelled, reason }.
function consortiumCalendarEntry(o) {
  return {
    kind: consortiumCalendarStr(o, 'kind'), title: consortiumCalendarStr(o, 'title'), where: consortiumCalendarStr(o, 'where'),
    event: consortiumCalendarStr(o, 'event'), args: consortiumCalendarStrings(consortiumCalendarGet(o, 'args')),
    ticket: consortiumCalendarStr(o, 'ticket'), rewards: consortiumCalendarStr(o, 'rewards'),
    phase1Event: consortiumCalendarStr(o, 'phase1_event'), phase1Title: consortiumCalendarStr(o, 'phase1_title'),
    phase1Ticket: consortiumCalendarStr(o, 'phase1_ticket'), phase1Rewards: consortiumCalendarStr(o, 'phase1_rewards'),
    cancelled: String(consortiumCalendarGet(o, 'cancelled')) === 'true', reason: consortiumCalendarStr(o, 'reason'),
  }
}

// Reads the JSON once per script load (reload() re-reads it); null with one WARN when missing or invalid, which
// disables the reminders and the auto-queue and nothing else.
function consortiumCalendarData() {
  if (consortiumCalendarTried) return consortiumCalendarCache
  consortiumCalendarTried = true
  let raw = null
  try { raw = JsonIO.read(CONSORTIUM_CALENDAR_PATH) } catch (err) { console.warn('[Consortium] calendar: ' + CONSORTIUM_CALENDAR_PATH + ' unreadable (' + err + '): reminders and auto-queue off'); return null }
  if (raw === null || raw === undefined) { console.warn('[Consortium] calendar: ' + CONSORTIUM_CALENDAR_PATH + ' missing: reminders and auto-queue off'); return null }
  let data = { roleMention: consortiumCalendarStr(raw, 'role_mention'), slots: {}, dates: {} }
  let slots = consortiumCalendarGet(raw, 'slots')
  let slotKeys = consortiumCalendarKeys(slots)
  for (let i = 0; i < slotKeys.length; i++) {
    let key = slotKeys[i].toLowerCase()
    if (CONSORTIUM_CALENDAR_WEEKDAYS.indexOf(key) < 0) { console.warn('[Consortium] calendar: unknown weekday "' + key + '" in slots, skipped'); continue }
    data.slots[key] = consortiumCalendarEntry(consortiumCalendarGet(slots, slotKeys[i]))
  }
  let dates = consortiumCalendarGet(raw, 'dates')
  let dateKeys = consortiumCalendarKeys(dates)
  for (let i = 0; i < dateKeys.length; i++) {
    if (consortiumCalendarParseDate(dateKeys[i]) === null) { console.warn('[Consortium] calendar: bad date "' + dateKeys[i] + '" in dates, skipped'); continue }
    data.dates[dateKeys[i]] = consortiumCalendarEntry(consortiumCalendarGet(dates, dateKeys[i]))
  }
  consortiumCalendarCache = data
  return data
}

// ---- dates -----------------------------------------------------------------------------------------------

function consortiumCalendarPad(n) {
  return (n < 10 ? '0' : '') + n
}

// 'YYYY-MM-DD' (server local time) of an instant.
function consortiumCalendarDateKey(ms) {
  let d = new Date(ms)
  return d.getFullYear() + '-' + consortiumCalendarPad(d.getMonth() + 1) + '-' + consortiumCalendarPad(d.getDate())
}

// A Date at local midnight for 'YYYY-MM-DD', or null when malformed.
function consortiumCalendarParseDate(key) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (m === null) return null
  let y = parseInt(m[1], 10)
  let mo = parseInt(m[2], 10)
  let d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  let date = new Date(y, mo - 1, d, 0, 0, 0, 0)
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date
}

// The slot instant (20:00 server time) of a date key.
function consortiumCalendarSlotMs(key) {
  let d = consortiumCalendarParseDate(key)
  if (d === null) return 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), CONSORTIUM_SLOT_HOUR, 0, 0, 0).getTime()
}

function consortiumCalendarDayLabel(ms) {
  let d = new Date(ms)
  return CONSORTIUM_CALENDAR_DAY_NAMES[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1)
}

function consortiumCalendarHm(ms) {
  let d = new Date(ms)
  return consortiumCalendarPad(d.getHours()) + ':' + consortiumCalendarPad(d.getMinutes())
}

function consortiumCalendarDiscordTime(ms) {
  return '<t:' + Math.floor(ms / 1000) + ':R>'
}

// ---- state -----------------------------------------------------------------------------------------------

function consortiumCalendarTag(server) {
  let ev = typeof consortiumEvents === 'function' ? consortiumEvents(server) : consortiumSub(consortiumState(server), 'events')
  let tag = consortiumSub(ev, 'calendar')
  if (!tag.contains('dates')) tag.put('dates', NBT.compoundTag())
  return tag
}

function consortiumCalendarStateDate(server, key) {
  let dates = consortiumCalendarTag(server).getCompound('dates')
  if (!dates.contains(key)) return null
  let c = dates.getCompound(key)
  let args = []
  if (c.contains('args')) {
    let list = c.getList('args', 8)
    for (let i = 0; i < list.size(); i++) args.push(String(list.getString(i)))
  }
  return { kind: '', title: String(c.getString('title')), where: String(c.getString('where')), event: String(c.getString('event')), args: args,
    ticket: String(c.getString('ticket')), rewards: String(c.getString('rewards')), phase1Event: '', phase1Title: '', phase1Ticket: '', phase1Rewards: '',
    cancelled: c.getBoolean('cancelled'), reason: String(c.getString('reason')) }
}

// ---- slot resolution -----------------------------------------------------------------------------------------

function consortiumCalendarApply(slot, entry, source) {
  if (entry.kind) slot.kind = entry.kind
  if (entry.title) slot.title = entry.title
  if (entry.where) slot.where = entry.where
  if (entry.event) { slot.event = entry.event; slot.args = entry.args }
  if (entry.ticket) slot.ticket = entry.ticket
  if (entry.rewards) slot.rewards = entry.rewards
  if (entry.phase1Event) { slot.phase1Event = entry.phase1Event; slot.phase1Title = entry.phase1Title; slot.phase1Ticket = entry.phase1Ticket; slot.phase1Rewards = entry.phase1Rewards }
  if (entry.cancelled) { slot.cancelled = true; slot.reason = entry.reason }
  slot.source = source
}

// The slot of a date key from the weekly slots and the two date sources (state over JSON over the weekday slot), or
// null when nothing is planned that day. { date, weekday, atMs, kind, title, where, event, args, ticket, rewards,
// phase1Event, phase1Title, phase1Ticket, phase1Rewards, cancelled, reason, source }.
function consortiumCalendarSlotFor(server, key) {
  let data = consortiumCalendarData()
  if (data === null) return null
  let d = consortiumCalendarParseDate(key)
  if (d === null) return null
  let weekday = CONSORTIUM_CALENDAR_WEEKDAYS[d.getDay()]
  let base = data.slots[weekday] || null
  let json = data.dates[key] || null
  let state = consortiumCalendarStateDate(server, key)
  if (base === null && json === null && state === null) return null
  let slot = { date: key, weekday: weekday, atMs: consortiumCalendarSlotMs(key), kind: 'staff', title: '', where: 'HQ', event: '', args: [], ticket: '', rewards: '',
    phase1Event: '', phase1Title: '', phase1Ticket: '', phase1Rewards: '', cancelled: false, reason: '', source: 'slot' }
  if (base !== null) consortiumCalendarApply(slot, base, 'slot')
  if (json !== null) consortiumCalendarApply(slot, json, 'json')
  if (state !== null) consortiumCalendarApply(slot, state, 'state')
  if (!slot.title) slot.title = slot.event ? slot.event : (CONSORTIUM_CALENDAR_DAY_NAMES[d.getDay()] + ' event')
  return slot
}

// The phase 1 Friday fallback (DISCORD 6.3): when the slot's event is refused for a phase reason by the events engine's
// own gate and the slot has a phase1_event, that event and the phase1_* texts replace the slot's, kind 'free'.
function consortiumCalendarEffective(server, slot) {
  if (slot === null) return null
  if (!slot.event || !slot.phase1Event || typeof consortiumEventEligibility !== 'function') return slot
  let why = null
  try { why = consortiumEventEligibility(server, slot.event, true) } catch (err) { why = null }
  if (why === null || String(why).indexOf('phase') !== 0) return slot
  let out = {}
  for (let k in slot) out[k] = slot[k]
  out.kind = 'free'
  out.event = slot.phase1Event
  out.args = []
  if (slot.phase1Title) out.title = slot.phase1Title
  if (slot.phase1Ticket) out.ticket = slot.phase1Ticket
  if (slot.phase1Rewards) out.rewards = slot.phase1Rewards
  return out
}

// The next slot strictly after `fromMs` within the lookahead, phase fallback applied, or null.
function consortiumCalendarNext(server, fromMs) {
  if (consortiumCalendarData() === null) return null
  let start = new Date(fromMs)
  for (let i = 0; i <= CONSORTIUM_CALENDAR_LOOKAHEAD_DAYS; i++) {
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12, 0, 0, 0)
    let slot = consortiumCalendarSlotFor(server, consortiumCalendarDateKey(day.getTime()))
    if (slot !== null && slot.atMs > fromMs) return consortiumCalendarEffective(server, slot)
  }
  return null
}

// ---- rendering (DISCORD 6, the table of texts) -----------------------------------------------------------------

function consortiumCalendarFmt(cents) {
  if (typeof consortiumCcFmt === 'function') return consortiumCcFmt(cents)
  return (Number(cents) / 100).toFixed(2) + ' CC'
}

// The reward tokens for the current phase from the events engine's constants, or null without them.
function consortiumCalendarTokens(server) {
  if (typeof consortiumEventRef !== 'function' || typeof CONSORTIUM_EVENT_WAVE_KILL === 'undefined' || typeof CONSORTIUM_EVENT_WAVE_CAP === 'undefined'
    || typeof CONSORTIUM_EVENT_BOUNTY_POT === 'undefined' || typeof CONSORTIUM_EVENT_BOUNTY_SHARE_CAP === 'undefined') return null
  let ref = 0
  try { ref = Number(consortiumEventRef(server)) } catch (err) { return null }
  if (!(ref > 0)) return null
  return { kill: consortiumCalendarFmt(Math.floor(ref * CONSORTIUM_EVENT_WAVE_KILL)), max: consortiumCalendarFmt(Math.floor(ref * CONSORTIUM_EVENT_WAVE_CAP)),
    bounty: consortiumCalendarFmt(Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_POT)), share: consortiumCalendarFmt(Math.floor(ref * CONSORTIUM_EVENT_BOUNTY_SHARE_CAP)) }
}

// The rewards text with its tokens filled, '' when the text has tokens and the constants are absent.
function consortiumCalendarRewards(server, text) {
  if (!text) return ''
  let tokens = consortiumCalendarTokens(server)
  if (tokens === null) return /\{(kill|max|bounty|share)\}/.test(text) ? '' : text
  return text.replace(/\{kill\}/g, tokens.kill).replace(/\{max\}/g, tokens.max).replace(/\{bounty\}/g, tokens.bounty).replace(/\{share\}/g, tokens.share)
}

// The weekly contract figures for the Wednesday line: " Last day for the current one: 64 Iron per crew member, 3
// members have filled it so far." or '' when no contract is open (ConsortiumQuests.contract.current, paidCount).
function consortiumCalendarContractTail(server) {
  if (typeof ConsortiumQuests === 'undefined' || !ConsortiumQuests.contract || typeof ConsortiumQuests.contract.current !== 'function') return ''
  let c = null
  try { c = ConsortiumQuests.contract.current(server) } catch (err) { return '' }
  if (c === null || c === undefined) return ''
  let name = typeof consortiumQuestFamilyName === 'function' ? consortiumQuestFamilyName(c.family) : c.family
  let paid = Number(c.paidCount) || 0
  return ' Last day for the current one: ' + consortiumFmt(c.units) + ' ' + name + ' per crew member, ' + paid + ' member' + (paid === 1 ? ' has' : 's have') + ' filled it so far.'
}

function consortiumCalendarMention(server, text) {
  let data = consortiumCalendarData()
  return data !== null && data.roleMention ? '<@&' + data.roleMention + '> ' + text : text
}

// { discord, game, staff } for a slot at a moment ('24h', '1h' or 'cancel'); an empty string means "nothing on that side".
function consortiumCalendarRender(server, slot, moment) {
  let out = { discord: '', game: '', staff: '' }
  if (slot === null) return out
  let when = consortiumCalendarHm(slot.atMs)
  if (moment === 'cancel' || (slot.cancelled && moment === '24h')) {
    let next = consortiumCalendarNext(server, slot.atMs + 1)
    let line = '**' + consortiumCalendarDayLabel(slot.atMs) + ', ' + when + '**: no event this week' + (slot.reason ? ' (' + slot.reason + ')' : '') + '.'
      + (next !== null ? ' Next slot: ' + consortiumCalendarDayLabel(next.atMs) + ', ' + consortiumCalendarHm(next.atMs) + ' server time.' : '')
    out.discord = consortiumCalendarMention(server, line)
    out.game = line.replace(/\*\*/g, '')
    return out
  }
  if (slot.cancelled) return out
  let rewards = consortiumCalendarRewards(server, slot.rewards)
  let rewardsSentence = rewards ? ' Rewards: ' + rewards + '.' : ''
  let firstClause = rewards ? rewards.split(',')[0] : ''
  if (slot.kind === 'contract') {
    if (moment === '24h') {
      let line = 'Tomorrow at ' + when + ' server time: the Board publishes the new weekly contract.' + consortiumCalendarContractTail(server)
      out.discord = consortiumCalendarMention(server, '**Tomorrow at ' + when + ' server time**: the Board publishes the new weekly contract.' + consortiumCalendarContractTail(server))
      out.game = line.replace(' server time:', ':')
    } else {
      out.discord = consortiumCalendarMention(server, '**In one hour (' + when + ' server time)**: new weekly contract in ' + slot.where + '.')
      out.game = 'In one hour (' + when + ' server time): new weekly contract in ' + slot.where + '.'
    }
    return out
  }
  if (!slot.event) {
    // A Saturday (or any staff slot) without a programme: staff lane only, nothing in public.
    if (moment === '24h') out.staff = 'No Saturday programme set for ' + slot.date + ' (/consortium calendar set).'
    return out
  }
  let stamp = consortiumCalendarDiscordTime(slot.atMs)
  if (moment === '1h') {
    out.discord = consortiumCalendarMention(server, '**In one hour (' + when + ' server time)**: ' + slot.title + ' at ' + slot.where + '.' + rewardsSentence)
    return out // the queued event's own "starts in 60 minutes. Gather at HQ." covers the game side
  }
  if (slot.kind === 'friday_zone') {
    let ticket = slot.ticket && slot.ticket !== 'none' ? ' Ticket holders only (' + slot.ticket + ').' : ' Ticket: none.'
    out.discord = consortiumCalendarMention(server, '**Tomorrow at ' + when + ' server time** (' + stamp + '): **' + slot.title + '** at ' + slot.where + '.' + ticket + rewardsSentence)
    out.game = 'Tomorrow at ' + when + ': ' + slot.title + ' at ' + slot.where + '.' + ticket
  } else if (slot.kind === 'free') {
    out.discord = consortiumCalendarMention(server, '**Tomorrow at ' + when + ' server time** (' + stamp + '): **' + slot.title + '** at ' + slot.where + ', free, no ticket.' + rewardsSentence + ' Be at HQ five minutes early.')
    out.game = 'Tomorrow at ' + when + ': ' + slot.title + ' at ' + slot.where + ', free, no ticket.'
  } else {
    let ticket = slot.ticket && slot.ticket !== 'none' ? ' Ticket: ' + slot.ticket + '.' : ' Ticket: none.'
    out.discord = consortiumCalendarMention(server, '**Tomorrow at ' + when + ' server time** (' + stamp + '): **' + slot.title + '** at ' + slot.where + '.' + rewardsSentence + ticket + ' Be at HQ five minutes early.')
    out.game = 'Tomorrow at ' + when + ': ' + slot.title + ' at ' + slot.where + '.' + (firstClause ? ' ' + firstClause + '.' : '') + ' Be at HQ five minutes early.'
  }
  return out
}

// ---- transport -------------------------------------------------------------------------------------------

function consortiumCalendarHas(name) {
  return typeof consortiumCoreHas === 'function' && consortiumCoreHas(name)
}

// The announcements lane (ConsortiumCore.discordAnnounce, 0.4.0), else a log line: the game side already has its say.
function consortiumCalendarAnnounce(server, text) {
  if (!text) return false
  if (consortiumCalendarHas('discordAnnounce')) {
    try { return ConsortiumCore.discordAnnounce(text) === true } catch (err) { console.error('[Consortium] calendar: discordAnnounce failed: ' + err); return false }
  }
  console.info('[Consortium] calendar discord (no API): ' + text)
  return false
}

// The staff lane (ConsortiumCore.discordStaff, 0.4.0); the console always carries the line.
function consortiumCalendarStaff(server, text) {
  if (!text) return false
  console.warn('[Consortium] calendar staff: ' + text)
  if (consortiumCalendarHas('discordStaff')) {
    try { return ConsortiumCore.discordStaff(text) === true } catch (err) { console.error('[Consortium] calendar: discordStaff failed: ' + err); return false }
  }
  return false
}

// Posts the rendering of a moment on its lanes.
function consortiumCalendarPost(server, slot, moment) {
  let r = consortiumCalendarRender(server, slot, moment)
  if (r.staff) consortiumCalendarStaff(server, r.staff)
  if (r.discord) consortiumCalendarAnnounce(server, r.discord)
  if (r.game) consortiumBroadcast(server, r.game)
  return r
}

// ---- the step ---------------------------------------------------------------------------------------------

function consortiumCalendarStampKey(kind) {
  return kind === '24h' ? 'reminded24' : 'reminded1h'
}

// True when the reminder of that slot and kind was handled: posted (`<date>:<kind>`), posted to staff only because
// no programme was set (`<date>:<kind>:staff`, which a later `set` may still follow with the public line) or missed.
function consortiumCalendarStamped(tag, slot, kind, publicOnly) {
  let current = String(tag.getString(consortiumCalendarStampKey(kind)))
  if (current === slot.date + ':' + kind || current === 'missed:' + slot.date + ':' + kind) return true
  return !publicOnly && current === slot.date + ':' + kind + ':staff'
}

// One reminder check at `now` (the step passes Date.now(); the debug lever passes an offset instant).
function consortiumCalendarReminder(server, slot, kind, now) {
  let tag = consortiumCalendarTag(server)
  if (consortiumCalendarStamped(tag, slot, kind, false)) return 'stamped'
  let target = slot.atMs - (kind === '24h' ? CONSORTIUM_CALENDAR_DAY_MS : CONSORTIUM_CALENDAR_HOUR_MS)
  if (now < target) return 'early'
  if (now < target + CONSORTIUM_CALENDAR_WINDOW_MS) {
    tag.putString(consortiumCalendarStampKey(kind), slot.date + ':' + kind)
    if (kind === '1h' && slot.cancelled) return 'cancelled'
    let r = consortiumCalendarPost(server, slot, kind)
    if (r.staff && !r.discord && !r.game) { tag.putString(consortiumCalendarStampKey(kind), slot.date + ':' + kind + ':staff'); return 'staff only' }
    return 'posted'
  }
  tag.putString(consortiumCalendarStampKey(kind), 'missed:' + slot.date + ':' + kind)
  console.info('[Consortium] calendar: ' + kind + ' reminder of ' + slot.date + ' missed (server down)')
  return 'missed'
}

// The 06:00 auto-queue of today's Friday or Saturday event (`force` = the debug lever for any date). Returns the
// outcome text.
function consortiumCalendarAutoQueue(server, dateKey, force) {
  let tag = consortiumCalendarTag(server)
  if (!force) {
    if (consortiumState(server).getInt('lastDailyDay') !== Consortium.seasonDay(server)) return 'waiting for the daily step'
    if (String(tag.getString('queuedDate')) === dateKey) return 'already handled today'
    tag.putString('queuedDate', dateKey)
  }
  let slot = consortiumCalendarSlotFor(server, dateKey)
  if (slot === null) return 'no slot on ' + dateKey
  if (slot.weekday !== 'friday' && slot.weekday !== 'saturday') return 'not a Friday or Saturday slot (' + slot.weekday + ')'
  if (slot.cancelled) { console.info('[Consortium] calendar: ' + dateKey + ' not queued: cancelled' + (slot.reason ? ' (' + slot.reason + ')' : '')); return 'not queued: cancelled' }
  let eff = consortiumCalendarEffective(server, slot)
  if (!eff.event) { console.info('[Consortium] calendar: ' + dateKey + ' has no programme, nothing queued'); return 'no programme set' }
  let now = Date.now()
  if (now >= eff.atMs) { console.info('[Consortium] calendar: the daily step ran after ' + consortiumCalendarHm(eff.atMs) + ', ' + eff.event + ' not queued for ' + dateKey); return 'too late: the slot has passed' }
  let name = typeof CONSORTIUM_EVENT_DEFS !== 'undefined' && CONSORTIUM_EVENT_DEFS[eff.event] ? CONSORTIUM_EVENT_DEFS[eff.event].name : eff.event
  if (typeof consortiumEventEligibility === 'function') {
    let why = null
    try { why = consortiumEventEligibility(server, eff.event, true) } catch (err) { why = 'eligibility check failed: ' + err }
    if (why !== null) { consortiumCalendarStaff(server, 'Calendar: ' + name + ' not queued today (' + why + ').'); return 'not queued: ' + why }
  }
  let refusal = ConsortiumEvents.queue(server, eff.event, eff.atMs, eff.args, eff.weekday)
  if (refusal !== null) { consortiumCalendarStaff(server, 'Calendar: ' + name + ' not queued today (' + refusal + ').'); return 'not queued: ' + refusal }
  console.info('[Consortium] calendar: Queued: ' + eff.event + ' at ' + consortiumCalendarHm(eff.atMs) + ', slot ' + eff.weekday + '.')
  return 'Queued: ' + eff.event + ' at ' + consortiumCalendarHm(eff.atMs) + ', slot ' + eff.weekday + '.'
}

// Wednesday 19:00, once per season week: the weekly contract guard (`force` = the debug lever).
function consortiumCalendarWednesdayGuard(server, now, force) {
  let d = new Date(now)
  if (!force && (d.getDay() !== 3 || d.getHours() < CONSORTIUM_CALENDAR_GUARD_HOUR)) return 'not Wednesday evening'
  let tag = consortiumCalendarTag(server)
  let week = Math.floor((Consortium.seasonDay(server) - 1) / 7)
  if (!force) {
    if (tag.contains('wednesdayGuardWeek') && tag.getInt('wednesdayGuardWeek') === week) return 'already run this week'
    tag.putInt('wednesdayGuardWeek', week)
  }
  if (typeof ConsortiumQuests === 'undefined' || !ConsortiumQuests.contract || typeof ConsortiumQuests.contract.current !== 'function') return 'quests script absent'
  let c = null
  try { c = ConsortiumQuests.contract.current(server) } catch (err) { return 'contract read failed: ' + err }
  let tonight = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CONSORTIUM_SLOT_HOUR, 0, 0, 0).getTime()
  let why = c === null || c === undefined ? 'absent' : c.endsAt <= tonight + CONSORTIUM_CALENDAR_HOUR_MS ? 'ends before 21:00 tonight' : c.setAt < now - 6 * CONSORTIUM_CALENDAR_DAY_MS ? 'set more than 6 days ago (renew)' : null
  if (why === null) return 'a fresh contract is open, silent'
  consortiumCalendarStaff(server, 'No weekly contract set for tonight (/consortium contract set).')
  return 'guard fired: ' + why
}

function consortiumCalendarStep(server) {
  let now = Date.now()
  let slot = consortiumCalendarNext(server, now)
  if (slot !== null) {
    consortiumCalendarReminder(server, slot, '24h', now)
    consortiumCalendarReminder(server, slot, '1h', now)
  }
  consortiumCalendarAutoQueue(server, consortiumCalendarDateKey(now), false)
  consortiumCalendarWednesdayGuard(server, now, false)
}

// ---- staff edits (the DISCORD BLOCK wraps these) ----------------------------------------------------------------

function consortiumCalendarWriteDate(server, key, fn) {
  let dates = consortiumCalendarTag(server).getCompound('dates')
  let c = dates.contains(key) ? dates.getCompound(key) : NBT.compoundTag()
  fn(c)
  dates.put(key, c)
  return c
}

// A late set or cancel inside the 24 h window posts its line at once and stamps it (the 30-minute window only
// silences reminders lost to downtime).
function consortiumCalendarLateLine(server, key, evenIfStamped) {
  let slot = consortiumCalendarEffective(server, consortiumCalendarSlotFor(server, key))
  if (slot === null) return false
  let now = Date.now()
  if (now < slot.atMs - CONSORTIUM_CALENDAR_DAY_MS || now >= slot.atMs) return false
  let tag = consortiumCalendarTag(server)
  if (!evenIfStamped && consortiumCalendarStamped(tag, slot, '24h', true)) return false
  tag.putString('reminded24', slot.date + ':24h')
  consortiumCalendarPost(server, slot, '24h')
  return true
}

// ---- the shared objects ----------------------------------------------------------------------------------------

// The events engine's own queue writer (DISCORD 6.4): refuses a past instant or an existing queue (a staff queue is
// never overwritten), writes { id, at, calendar, args, reminded60, reminded5 } for consortiumEventQueuedTick.
ConsortiumEvents.queue = (server, id, atMs, args, calendar) => {
  if (typeof CONSORTIUM_EVENTS_ON === 'undefined' || !CONSORTIUM_EVENTS_ON) return 'the events engine is off'
  if (typeof CONSORTIUM_EVENT_DEFS === 'undefined' || !CONSORTIUM_EVENT_DEFS[String(id)]) return 'unknown event ' + id
  let now = Date.now()
  let at = Number(atMs)
  if (!(at > now)) return 'that time has passed'
  let ev = consortiumEvents(server)
  if (ev.contains('queued')) return 'already queued'
  let q = NBT.compoundTag()
  q.putString('id', String(id))
  q.putLong('at', at)
  q.putString('calendar', calendar && CONSORTIUM_EVENT_CALENDARS.indexOf(String(calendar)) >= 0 ? String(calendar) : consortiumEventCalendar(String(id), true, at))
  let list = NBT.listTag()
  let a = args || []
  for (let i = 0; i < a.length; i++) list.add(NBT.stringTag(String(a[i])))
  q.put('args', list)
  q.putBoolean('reminded60', at - now <= CONSORTIUM_CALENDAR_HOUR_MS)
  q.putBoolean('reminded5', at - now <= 5 * 60000)
  ev.put('queued', q)
  console.info('[Consortium] queued ' + id + ' at ' + consortiumCalendarHm(at) + ' (slot ' + q.getString('calendar') + ', by the calendar)')
  return null
}

ConsortiumEvents.calendar = {
  slotHour: CONSORTIUM_SLOT_HOUR,

  // The next slot after now: { date, weekday, kind, title, where, atMs, source, cancelled, reason, event, args, ticket,
  // rewards } or null.
  next: (server) => consortiumCalendarNext(server, Date.now()),
  slotFor: (server, date) => consortiumCalendarEffective(server, consortiumCalendarSlotFor(server, String(date))),

  // Staff: a programme for a date. Refusal string or null.
  set: (server, date, eventId, args) => {
    let key = String(date)
    if (consortiumCalendarParseDate(key) === null) return 'Dates are written YYYY-MM-DD (server time).'
    let id = String(eventId)
    if (typeof CONSORTIUM_EVENT_DEFS !== 'undefined' && !CONSORTIUM_EVENT_DEFS[id]) return 'Unknown event "' + id + '". Ids: ' + (typeof CONSORTIUM_EVENT_IDS !== 'undefined' ? CONSORTIUM_EVENT_IDS.join(', ') : '?') + '.'
    let list = args || []
    consortiumCalendarWriteDate(server, key, (c) => {
      c.putString('event', id)
      let l = NBT.listTag()
      for (let i = 0; i < list.length; i++) l.add(NBT.stringTag(String(list[i])))
      c.put('args', l)
      c.putBoolean('cancelled', false)
      c.putString('reason', '')
    })
    console.info('[Consortium] calendar: ' + key + ' set to ' + id + (list.length ? ' ' + list.join(' ') : ''))
    consortiumCalendarLateLine(server, key, false)
    return null
  },

  title: (server, date, text) => {
    let key = String(date)
    if (consortiumCalendarParseDate(key) === null) return 'Dates are written YYYY-MM-DD (server time).'
    consortiumCalendarWriteDate(server, key, (c) => c.putString('title', String(text)))
    return null
  },

  cancel: (server, date, reason) => {
    let key = String(date)
    if (consortiumCalendarParseDate(key) === null) return 'Dates are written YYYY-MM-DD (server time).'
    consortiumCalendarWriteDate(server, key, (c) => { c.putBoolean('cancelled', true); c.putString('reason', String(reason || '')) })
    console.info('[Consortium] calendar: ' + key + ' cancelled' + (reason ? ' (' + reason + ')' : ''))
    consortiumCalendarLateLine(server, key, true)
    return null
  },

  clear: (server, date) => {
    let dates = consortiumCalendarTag(server).getCompound('dates')
    let key = String(date)
    if (!dates.contains(key)) return false
    dates.remove(key)
    return true
  },

  reload: (server) => {
    consortiumCalendarTried = false
    consortiumCalendarCache = null
    return consortiumCalendarData() !== null
  },

  // { discord, game, staff } of a slot at a moment ('24h' by default, '1h', 'cancel').
  render: (server, slot, moment) => consortiumCalendarRender(server, slot, moment || '24h'),

  // Status lines for /consortium calendar.
  status: (server) => {
    let lines = []
    if (consortiumCalendarData() === null) { lines.push(Text.of('No calendar loaded (' + CONSORTIUM_CALENDAR_PATH + '): reminders and auto-queue are off.').red()); return lines }
    let next = consortiumCalendarNext(server, Date.now())
    if (next === null) lines.push(Text.of('No slot within ' + CONSORTIUM_CALENDAR_LOOKAHEAD_DAYS + ' days.').gray())
    else lines.push(Text.of('Next slot: ' + next.title + ', ' + consortiumCalendarDayLabel(next.atMs) + ' at ' + consortiumCalendarHm(next.atMs) + ' server time (' + next.date + ', ' + next.kind + ', source ' + next.source
      + (next.event ? ', event ' + next.event + (next.args.length ? ' ' + next.args.join(' ') : '') : next.kind === 'contract' ? '' : ', no programme') + (next.cancelled ? ', CANCELLED' + (next.reason ? ': ' + next.reason : '') : '') + ').').gold())
    let tokens = consortiumCalendarTokens(server)
    lines.push(Text.of(tokens === null ? 'Reward tokens: events engine absent, the Rewards sentence is dropped.'
      : 'Reward tokens for phase ' + Consortium.phase(server) + ': {kill} ' + tokens.kill + ', {max} ' + tokens.max + ', {bounty} ' + tokens.bounty + ', {share} ' + tokens.share + '.').gray())
    let tag = consortiumCalendarTag(server)
    lines.push(Text.of('Stamps: reminded24 ' + (String(tag.getString('reminded24')) || 'none') + ', reminded1h ' + (String(tag.getString('reminded1h')) || 'none') + ', queuedDate ' + (String(tag.getString('queuedDate')) || 'none')
      + ', wednesdayGuardWeek ' + (tag.contains('wednesdayGuardWeek') ? tag.getInt('wednesdayGuardWeek') : 'none') + '.').gray())
    let dates = tag.getCompound('dates')
    let keys = []
    for (let k of dates.getAllKeys()) keys.push(String(k))
    keys.sort()
    for (let i = 0; i < keys.length; i++) {
      let c = dates.getCompound(keys[i])
      lines.push(Text.of('  ' + keys[i] + ': ' + (c.getBoolean('cancelled') ? 'cancelled' + (String(c.getString('reason')) ? ' (' + c.getString('reason') + ')' : '') : (String(c.getString('event')) || 'no event')) + (String(c.getString('title')) ? ', title "' + c.getString('title') + '"' : '')).gray())
    }
    if (!keys.length) lines.push(Text.of('No staff-set date (the JSON dates apply).').gray())
    return lines
  },

  // The harness levers: 24h | 1h | cancel | queue | wednesday | clear, an optional date and an optional offset in ms
  // ('+3h' evaluates the reminder as if now were 3 hours past the instant; without an offset the line is forced).
  debug: (server, what, date, offsetMs) => {
    let key = date ? String(date) : null
    if (what === 'clear') {
      if (key === null) return 'Name the date whose stamps to clear.'
      let tag = consortiumCalendarTag(server)
      let n = 0
      for (let k of ['reminded24', 'reminded1h']) {
        if (String(tag.getString(k)).indexOf(key) >= 0) { tag.putString(k, ''); n++ }
      }
      if (String(tag.getString('queuedDate')) === key) { tag.putString('queuedDate', ''); n++ }
      return n + ' stamp(s) cleared for ' + key + '.'
    }
    if (what === 'wednesday') return consortiumCalendarWednesdayGuard(server, Date.now(), true)
    if (what === 'queue') return consortiumCalendarAutoQueue(server, key !== null ? key : consortiumCalendarDateKey(Date.now()), true)
    let slot = key !== null ? consortiumCalendarEffective(server, consortiumCalendarSlotFor(server, key)) : consortiumCalendarNext(server, Date.now())
    if (slot === null) return 'No slot ' + (key !== null ? 'on ' + key : 'ahead') + '.'
    if (what === 'cancel') {
      let r = consortiumCalendarPost(server, slot, 'cancel')
      return 'Cancellation line posted: ' + r.game
    }
    if (what !== '24h' && what !== '1h') return 'Unknown debug lever ' + what + '.'
    if (offsetMs !== null && offsetMs !== undefined) {
      let target = slot.atMs - (what === '24h' ? CONSORTIUM_CALENDAR_DAY_MS : CONSORTIUM_CALENDAR_HOUR_MS)
      return 'Reminder check at target ' + (offsetMs >= 0 ? '+' : '') + Math.round(offsetMs / 60000) + ' min: ' + consortiumCalendarReminder(server, slot, what, target + offsetMs)
    }
    let r = consortiumCalendarPost(server, slot, what)
    consortiumCalendarTag(server).putString(consortiumCalendarStampKey(what), slot.date + ':' + what)
    return 'Forced ' + what + ' line for ' + slot.date + ': ' + (r.game || r.discord || r.staff || '(nothing to post)')
  },
}

// ---- listeners -------------------------------------------------------------------------------------------

ServerEvents.loaded((event) => {
  let server = event.server
  consortiumCalendarServer = server
  consortiumCalendarTried = false
  consortiumCalendarCache = null
  let data = consortiumCalendarData()
  if (data === null) return
  let next = consortiumCalendarNext(server, Date.now())
  console.info('[Consortium] calendar: ' + Object.keys(data.slots).length + ' weekly slot(s), ' + Object.keys(data.dates).length + ' planned date(s); next slot '
    + (next === null ? 'none within ' + CONSORTIUM_CALENDAR_LOOKAHEAD_DAYS + ' days' : consortiumCalendarDayLabel(next.atMs) + ' ' + consortiumCalendarHm(next.atMs) + ' (' + next.title + (next.cancelled ? ', cancelled' : '') + ')'))
})

let consortiumCalendarFailAt = 0
ServerEvents.tick((event) => {
  if (event.server.tickCount % CONSORTIUM_CALENDAR_STEP_TICKS !== 50) return
  try { consortiumCalendarStep(event.server) } catch (err) {
    if (Date.now() - consortiumCalendarFailAt > 60000) { consortiumCalendarFailAt = Date.now(); console.error('[Consortium] calendar step failed: ' + err) }
  }
})
