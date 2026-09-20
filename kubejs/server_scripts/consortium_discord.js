// priority: 10
// The Consortium - the daily Discord digest (docs/DISCORD_AND_COMMUNITY.md 5, docs/BATCH_3_INTERFACES.md 2; the daily
// post of RANKS_AND_CONTRACTS.md 1.5). Needs consortium_lib.js, consortium_phases.js (Consortium, consortiumState,
// consortiumSub through consortium_charters.js). Reads, all typeof-guarded at call time: Consortium.contracts.text
// (consortium_contracts.js), ConsortiumEvents.boardObject (consortium_events.js), ConsortiumEvents.calendar.next
// (consortium_calendar.js) with the lib's consortiumNextSlot / consortiumNextSlotMs as the fallback, and
// ConsortiumCore.leaderboardText (0.4.0). The post leaves through the mod's one transport, ConsortiumCore.discordAnnounce
// (the announcements lane, queued while the bot is not ready); without that API (a 0.3.x jar) the text is logged and
// nothing else happens: #minecraft-chat already carries the engine's "Day <d> of 84" say line, never both.
//
// One post per season day, right after the engine's own daily summary: the 5 s step below runs when lastDailyDay ===
// today's season day and discord.digestDay !== day, one step after it first notices the new day (so a contracts pick
// running in the same step is included), then stamps digestDay (persistent: a restart never double-posts).
// /consortium discord digest (op 2, the DISCORD BLOCK of consortium_commands.js) prints the text and posts it on demand.
// Plain text under 1,900 characters, at most 12 quota lines (PLACEHOLDER; the board allows 32, phase 5 has 9).
//
// State: consortium.discord.digestDay (int season day). No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_DIGEST_STEP_TICKS = 100
const CONSORTIUM_DIGEST_MAX_CHARS = 1900
const CONSORTIUM_DIGEST_MAX_LINES = 12 // PLACEHOLDER
const CONSORTIUM_DIGEST_TOP = 3

let consortiumDigestNoticedDay = 0 // the season day first seen without a digest (posted at the following step)

function consortiumDigestTag(server) {
  return consortiumSub(consortiumState(server), 'discord')
}

function consortiumDigestHas(name) {
  return typeof consortiumCoreHas === 'function' && consortiumCoreHas(name)
}

function consortiumDigestClock(ms) {
  let d = new Date(ms)
  let h = d.getHours()
  let m = d.getMinutes()
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
}

function consortiumDigestDayLabel(ms) {
  let names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  let d = new Date(ms)
  return names[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1)
}

// The digest text (an array of lines), built from the engine's own state and the sibling APIs.
function consortiumDigestLines(server) {
  let st = consortiumState(server)
  let n = Consortium.phase(server)
  let def = Consortium.def(n)
  let prog = Consortium.progress(server, n)
  let day = Consortium.seasonDay(server)
  let complete = 0
  for (let i = 0; i < prog.lines.length; i++) if (prog.lines[i].ratio >= 1) complete++
  let out = []
  out.push('**Day ' + day + ' of ' + CONSORTIUM_SEASON_DAYS + ', Phase ' + n + ': ' + def.name + '. Quota ' + consortiumPct(prog.c) + ' %, ' + complete + ' of ' + prog.lines.length + ' lines complete.**')
  let parts = []
  let shown = Math.min(prog.lines.length, CONSORTIUM_DIGEST_MAX_LINES)
  for (let i = 0; i < shown; i++) {
    let l = prog.lines[i]
    parts.push(l.line.label + ' ' + (l.ratio >= 1 ? 'done' : consortiumPct(l.ratio) + ' %'))
  }
  out.push('Lines: ' + parts.join(', ') + ' (' + shown + ' of ' + prog.lines.length + ' listed)')
  if (typeof Consortium.contracts !== 'undefined' && Consortium.contracts && typeof Consortium.contracts.text === 'function') {
    let text = ''
    try { text = String(Consortium.contracts.text(server)) } catch (err) { console.error('[Consortium] digest: contracts text failed: ' + err) }
    if (text.length) out.push('Contracts today: ' + text + ' (Operator and above)')
  }
  let event = null
  if (typeof ConsortiumEvents !== 'undefined' && typeof ConsortiumEvents.boardObject === 'function') {
    try { event = ConsortiumEvents.boardObject(server) } catch (err) { event = null }
  }
  out.push('Event: ' + (event ? event.name + ' until ' + consortiumDigestClock(Date.now() + Number(event.seconds_left) * 1000) + ' server time' + (event.detail ? ' (' + event.detail + ')' : '') : 'none scheduled'))
  if (consortiumDigestHas('leaderboardText')) {
    try {
      let text = String(ConsortiumCore.leaderboardText(CONSORTIUM_DIGEST_TOP)).split('\n').filter((s) => s.length > 0).join(', ')
      if (text.length) out.push('Top ' + CONSORTIUM_DIGEST_TOP + ' by credits earned: ' + text)
    } catch (err) { console.error('[Consortium] digest: leaderboardText failed: ' + err) }
  }
  let slotText = null
  if (typeof ConsortiumEvents !== 'undefined' && ConsortiumEvents.calendar && typeof ConsortiumEvents.calendar.next === 'function') {
    try {
      let next = ConsortiumEvents.calendar.next(server)
      if (next !== null && next !== undefined) {
        slotText = (next.cancelled ? 'no event (' + (next.reason || 'cancelled') + '), ' : next.title + ', ') + consortiumDigestDayLabel(next.atMs) + ' at ' + consortiumDigestClock(next.atMs)
          + ' server time (<t:' + Math.floor(next.atMs / 1000) + ':R>)'
      }
    } catch (err) { console.error('[Consortium] digest: calendar next failed: ' + err) }
  }
  if (slotText === null) {
    let ms = consortiumNextSlotMs()
    slotText = consortiumNextSlot() + ' at 20:00 server time (<t:' + Math.floor(ms / 1000) + ':R>)'
  }
  out.push('Next slot: ' + slotText)
  let fund = ''
  if (st.contains('season') && st.getCompound('season').getLong('target') > 0) {
    let season = st.getCompound('season')
    fund = 'Season fund ' + consortiumPct(season.getLong('fund') / season.getLong('target')) + ' %. '
  }
  out.push(fund + 'Deliver at the Field Office at HQ; /consortium ranks shows your own progress.')
  return out
}

function consortiumDigestText(server) {
  let text = consortiumDigestLines(server).join('\n')
  return text.length > CONSORTIUM_DIGEST_MAX_CHARS ? text.slice(0, CONSORTIUM_DIGEST_MAX_CHARS - 3) + '...' : text
}

// Posts the digest through the announcements lane. Returns 'posted', 'queued or refused' or 'no api'.
function consortiumDigestPost(server) {
  let text = consortiumDigestText(server)
  if (!consortiumDigestHas('discordAnnounce')) {
    console.info('[Consortium] digest (Consortium Core 0.4.0 API absent, not posted):\n' + text)
    return 'no api'
  }
  let ok = false
  try { ok = ConsortiumCore.discordAnnounce(text) === true } catch (err) { console.error('[Consortium] digest post failed: ' + err) }
  console.info('[Consortium] digest ' + (ok ? 'posted or queued' : 'not posted (no transport)') + ' (' + text.length + ' chars)')
  return ok ? 'posted' : 'queued or refused'
}

function consortiumDigestStep(server) {
  let st = consortiumState(server)
  let day = Consortium.seasonDay(server)
  if (st.getInt('lastDailyDay') !== day) return
  let tag = consortiumDigestTag(server)
  if (tag.getInt('digestDay') === day) return
  if (consortiumDigestNoticedDay !== day) { consortiumDigestNoticedDay = day; return } // one step later: the pick of the same step is in
  tag.putInt('digestDay', day)
  consortiumDigestPost(server)
}

// The command entry point: prints the lines to the source and posts.
function consortiumDigestCommand(server) {
  return { lines: consortiumDigestLines(server), result: consortiumDigestPost(server) }
}

let consortiumDigestFailAt = 0
ServerEvents.tick((event) => {
  if (event.server.tickCount % CONSORTIUM_DIGEST_STEP_TICKS !== 70) return
  try { consortiumDigestStep(event.server) } catch (err) {
    if (Date.now() - consortiumDigestFailAt > 60000) { consortiumDigestFailAt = Date.now(); console.error('[Consortium] digest step failed: ' + err) }
  }
})
