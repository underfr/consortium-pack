// priority: 30
// The Consortium - ranks (docs/RANKS_AND_CONTRACTS.md 1, docs/BATCH_3_INTERFACES.md 4 and 5; PROJECT_RULES 4.3).
// Needs consortium_lib.js (helpers, FTB Teams), consortium_phases.js (Consortium, consortiumState, consortiumSub
// through consortium_charters.js) loaded before this file. Everything money-related needs the Consortium Core
// binding (ConsortiumCore); the 0.4.0 API members (publishRankTiers, leaderboard, leaderboardText, rankOf, rankGroup,
// rankPosition, uuidOf, sameConnection, discordAnnounce, discordStaff) are probed at call time through
// consortiumCoreHas(name), so a 0.3.1 jar runs the scripts of this batch with the ranks features degraded (tiers by
// threshold only, no promotion, no leaderboard) and never throws.
//
// Ranks count rank_credit only: credits paid by the delivery terminal (every multiplier included) plus Gap Contract
// units at 50 %; quest, event, shop and referral credits never count (rule 4.3). The promotion itself is the mod's
// (RankService through the LuckPerms track "progression", one tier per check, never a demotion, announced by the mod
// on the announcements lane): this script
//   - publishes the tier table to the mod (consortiumRankPublish, called from ServerEvents.loaded and the 5-minute
//     Consortium.check of consortium_phases.js; the mod dedups identical JSON),
//   - reconciles the perks of the held tier at login + 60 ticks, on RankPromoteEvent with a player and every 5 minutes
//     for online players (Consortium.ranks.reconcile: FTB Chunks allowance refresh, one perk line per new tier, the
//     Engineer chunk loader once the team holds phase 3),
//   - answers /consortium ranks [player] and /consortium leaderboard [n] (the RANKS BLOCK of consortium_commands.js),
//   - exports CONSORTIUM_RANK_THRESHOLDS for consortium_quests.js (rank tasks), consortium_contracts.js (the Operator
//     gate) and consortium_onboarding.js (the referral milestones).
//
// State (server.persistentData consortium.ranks.<uuid>, saved with the world): tier (last reconciled tier key),
// loaderDue (boolean), loaderAt (long, the Engineer loader given), loaderTold (boolean, the "unlocks with phase 3"
// line said once). Inspect with: /kubejs persistent-data server get consortium
//
// Every number and text marked PLACEHOLDER is re-derived from the beta-week ledger (PRICE_TABLE 8). No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

// Cents earned at the terminal per tier (PRICE_TABLE 6, RANKS 1.1), PLACEHOLDER [S]. The single source of truth: the
// mod receives the same table through publishRankTiers, consortium_quests.js reads it at call time. Harness lever
// (RANKS 8): { operator: 2000, engineer: 4000, director: 6000, shareholder: 8000 } in the srvdev copy only.
const CONSORTIUM_RANK_THRESHOLDS = { operator: 25000, engineer: 250000, director: 750000, shareholder: 1500000 }
const CONSORTIUM_RANK_ORDER = ['default', 'operator', 'engineer', 'director', 'shareholder']
const CONSORTIUM_RANK_NAMES = { default: 'Recruit', operator: 'Operator', engineer: 'Engineer', director: 'Director', shareholder: 'Shareholder' }
// Perk texts told once per new tier (PLACEHOLDER wording; the mechanisms are LuckPerms group meta and the Discord
// processes of DISCORD D9, nothing here grants a command).
const CONSORTIUM_RANK_PERKS = {
  operator: '32 claim chunks, the daily contract premium',
  engineer: '48 claim chunks, one free chunk loader (a phase 3 item), the aqua tag',
  director: '64 claim chunks, the Wednesday contract two hours early in #directors',
  shareholder: '96 claim chunks, a vote on the Saturday programme in #shareholders, the light purple tag',
}
const CONSORTIUM_RANK_TRACK = 'progression'
const CONSORTIUM_RANK_LOADER_ITEM = 'chunkloaders:single_chunk_loader' // the shop's chunk_loader_single item, a phase 3 item
const CONSORTIUM_RANK_LOADER_STAGE = 'consortium:phase_3'
const CONSORTIUM_RANK_LOADER_TIER = 'engineer'
const CONSORTIUM_RANK_CHECK_TICKS = 6000 // the online reconcile, offset from the phase engine's own 5-minute check
const CONSORTIUM_RANK_RULE = 'Ranks count credits earned at the terminal (Gap Contract units at 50 %); quest, event and referral payouts and shop refunds never count.'

// ---- Consortium Core API probes (shared by every script of this batch) ------------------------------------------

let consortiumCoreApiCache = {}

// True when the ConsortiumCore binding exists and exposes a static method of that name. A missing member of a Java
// class binding throws in Rhino (NativeJavaClass.get reports "member not found"), hence the try: the probe is cached
// per name and reset by /reload with the script scope.
function consortiumCoreHas(name) {
  if (typeof ConsortiumCore === 'undefined') return false
  if (Object.prototype.hasOwnProperty.call(consortiumCoreApiCache, name)) return consortiumCoreApiCache[name]
  let has = false
  try { has = typeof ConsortiumCore[name] === 'function' } catch (err) { has = false }
  consortiumCoreApiCache[name] = has
  return has
}

// "1,234.56 CC" through the mod when present (its currency symbol), a plain fallback otherwise.
function consortiumCcFmt(cents) {
  let n = Math.round(Number(cents) || 0)
  if (typeof ConsortiumCore !== 'undefined') {
    try { return String(ConsortiumCore.format(n)) } catch (err) { /* fall through */ }
  }
  let whole = Math.floor(Math.abs(n) / 100)
  let frac = String(Math.abs(n) % 100)
  return (n < 0 ? '-' : '') + consortiumFmt(whole) + '.' + (frac.length < 2 ? '0' + frac : frac) + ' CC'
}

// A java.util.UUID from a lowercase string or a UUID (the API takes UUIDs, the engine keeps strings).
function consortiumJavaUuidOf(uuid) {
  return typeof uuid === 'string' ? CONSORTIUM_UUID.fromString(uuid) : uuid
}

// ---- tiers -----------------------------------------------------------------------------------------------

function consortiumRankIndex(key) {
  let i = CONSORTIUM_RANK_ORDER.indexOf(String(key))
  return i < 0 ? 0 : i
}

function consortiumRankName(key) {
  return CONSORTIUM_RANK_NAMES[String(key)] || String(key)
}

// Tier key by threshold for an amount of rank credit in cents ('default' below the first threshold).
function consortiumRankTierOfCents(cents) {
  let c = Number(cents) || 0
  let tier = 'default'
  for (let i = 1; i < CONSORTIUM_RANK_ORDER.length; i++) {
    let key = CONSORTIUM_RANK_ORDER[i]
    if (c >= CONSORTIUM_RANK_THRESHOLDS[key]) tier = key
  }
  return tier
}

function consortiumRankCredit(uuid) {
  if (typeof ConsortiumCore === 'undefined') return 0
  try { return Number(ConsortiumCore.rankCredit(consortiumJavaUuidOf(uuid))) || 0 } catch (err) { return 0 }
}

// The JSON the mod's RankTiers parser expects (RANKS 4.1): ascending credits, group and display name per tier. Built by
// hand so the credits are integers (Rhino's JSON.stringify prints an integral double as "2000.0").
function consortiumRankTiersJson() {
  let tiers = []
  for (let i = 1; i < CONSORTIUM_RANK_ORDER.length; i++) {
    let key = CONSORTIUM_RANK_ORDER[i]
    tiers.push('{"group":' + JSON.stringify(key) + ',"name":' + JSON.stringify(consortiumRankName(key)) + ',"credits":' + Math.round(CONSORTIUM_RANK_THRESHOLDS[key]) + '}')
  }
  return '{"track":' + JSON.stringify(CONSORTIUM_RANK_TRACK) + ',"tiers":[' + tiers.join(',') + ']}'
}

let consortiumRankPublished = ''   // last JSON accepted by the mod this boot
let consortiumRankPublishSaid = false

// Hands the tier table to the mod (publishRankTiers, 0.4.0). Called from ServerEvents.loaded (when the runtime is
// ready) and from every 5-minute check; the mod dedups identical payloads, this side logs the first acceptance once
// per boot and says once when the API is absent (a 0.3.1 jar: no promotion, tiers by threshold only on this side).
function consortiumRankPublish(server) {
  if (typeof ConsortiumCore === 'undefined') return false
  if (!consortiumCoreHas('publishRankTiers')) {
    if (!consortiumRankPublishSaid) {
      consortiumRankPublishSaid = true
      console.info('[Consortium] ranks: Consortium Core has no publishRankTiers (0.4.0 API): tiers by threshold on the engine side only, no promotion')
    }
    return false
  }
  try {
    if (!ConsortiumCore.ready()) return false
    let json = consortiumRankTiersJson()
    let ok = ConsortiumCore.publishRankTiers(json)
    if (!ok) {
      if (consortiumRankPublished !== 'refused') console.warn('[Consortium] ranks: tier table refused by Consortium Core (see its log): ' + json)
      consortiumRankPublished = 'refused'
      return false
    }
    if (consortiumRankPublished !== json) {
      consortiumRankPublished = json
      console.info('[Consortium] ranks: tiers published to Consortium Core: ' + json)
    }
    return true
  } catch (err) {
    console.error('[Consortium] ranks: tier publish failed: ' + err)
    return false
  }
}

// ---- state -----------------------------------------------------------------------------------------------

function consortiumRankTag(server, uuid) {
  return consortiumSub(consortiumSub(consortiumState(server), 'ranks'), String(uuid).toLowerCase())
}

// The progression group the player holds in LuckPerms (rankGroup, 0.4.0: a staff parent set carries its perks), else
// the tier by threshold.
function consortiumRankHeld(uuid) {
  if (consortiumCoreHas('rankGroup')) {
    try {
      let g = String(ConsortiumCore.rankGroup(consortiumJavaUuidOf(uuid)))
      if (CONSORTIUM_RANK_ORDER.indexOf(g) >= 0) return g
    } catch (err) { /* fall through to the threshold */ }
  }
  return consortiumRankTierOfCents(consortiumRankCredit(uuid))
}

// { key, credits } of the next tier above `tier`, or null at the top.
function consortiumRankNext(tier) {
  let i = consortiumRankIndex(tier)
  if (i >= CONSORTIUM_RANK_ORDER.length - 1) return null
  let key = CONSORTIUM_RANK_ORDER[i + 1]
  return { key: key, credits: CONSORTIUM_RANK_THRESHOLDS[key] }
}

// ---- the perk reconcile (RANKS 1.3) --------------------------------------------------------------------------

// Compares the held tier with the stamped one for an online player: refreshes the FTB Chunks allowance and tells one
// perk line per tier crossed, stamps the tier, then the Engineer loader (once, and only when the team holds phase 3:
// a locked loader would be thrown out of the inventory by Chapters and lost). Idempotent, never takes anything back.
function consortiumRankReconcile(server, player) {
  if (typeof ConsortiumCore === 'undefined') return false
  let uuid = String(player.uuid).toLowerCase()
  let name = String(player.username)
  let rec = consortiumRankTag(server, uuid)
  let held = consortiumRankHeld(player.uuid)
  let heldIdx = consortiumRankIndex(held)
  let stamped = String(rec.getString('tier'))
  let stampedIdx = CONSORTIUM_RANK_ORDER.indexOf(stamped) < 0 ? 0 : CONSORTIUM_RANK_ORDER.indexOf(stamped)
  let changed = false
  if (heldIdx > stampedIdx) {
    for (let i = stampedIdx + 1; i <= heldIdx; i++) {
      let key = CONSORTIUM_RANK_ORDER[i]
      server.runCommandSilent('ftbchunks admin extra_claim_chunks ' + name + ' add 0') // FTB Chunks caches the allowance until a relog
      let next = consortiumRankNext(key)
      player.tell(Text.of(consortiumRankName(key) + ' perks: ' + (CONSORTIUM_RANK_PERKS[key] || 'none') + '. '
        + (next === null ? 'You hold the top rank.' : 'Next: ' + consortiumRankName(next.key) + ' at ' + consortiumCcFmt(next.credits) + ' earned.')).gold())
    }
    rec.putString('tier', held)
    console.info('[Consortium] ranks: ' + name + ' reconciled to ' + held + ' (was ' + (stamped || 'default') + ')')
    changed = true
  }
  if (heldIdx >= consortiumRankIndex(CONSORTIUM_RANK_LOADER_TIER) && rec.getLong('loaderAt') === 0) {
    rec.putBoolean('loaderDue', true)
    let team = consortiumTeamOf(player)
    if (team !== null && consortiumTeamHasStage(team, CONSORTIUM_RANK_LOADER_STAGE)) {
      let stack = Item.of(CONSORTIUM_RANK_LOADER_ITEM)
      if (!stack.isEmpty()) {
        player.give(stack)
        rec.putLong('loaderAt', Date.now())
        rec.putBoolean('loaderDue', false)
        player.tell(Text.of('Engineer perk: your free chunk loader is in your inventory (one per season).').green())
        console.info('[Consortium] ranks: Engineer chunk loader given to ' + name)
        changed = true
      } else {
        console.warn('[Consortium] ranks: ' + CONSORTIUM_RANK_LOADER_ITEM + ' is unknown, the Engineer loader of ' + name + ' stays due')
      }
    } else if (!rec.getBoolean('loaderTold')) {
      rec.putBoolean('loaderTold', true)
      player.tell(Text.of('Your free chunk loader unlocks with phase 3.').gray())
    }
  }
  return changed
}

// ---- leaderboard and status texts (RANKS 1.4) ------------------------------------------------------------------

// The lines of the leaderboard in the mod's one entry format, or a note when the API is absent.
function consortiumRankLeaderboardLines(n) {
  let count = Math.max(1, Math.min(25, Math.floor(Number(n) || 10)))
  let out = []
  if (consortiumCoreHas('leaderboardText')) {
    try {
      let text = String(ConsortiumCore.leaderboardText(count))
      let parts = text.split('\n')
      for (let i = 0; i < parts.length; i++) if (parts[i].length) out.push(parts[i])
      return out
    } catch (err) { console.error('[Consortium] ranks: leaderboardText failed: ' + err) }
  }
  if (consortiumCoreHas('leaderboard')) {
    try {
      let i = 0
      for (let e of ConsortiumCore.leaderboard(count)) {
        i++
        out.push(i + '. ' + String(e.name) + ' (' + String(e.tier) + ') ' + consortiumCcFmt(e.rankCredit))
      }
      return out
    } catch (err) { console.error('[Consortium] ranks: leaderboard failed: ' + err) }
  }
  out.push('The leaderboard needs Consortium Core 0.4.0 (leaderboard API absent).')
  return out
}

// 1-based position of a uuid in the leaderboard, 0 when unranked or without the API.
function consortiumRankPosition(uuid) {
  if (!consortiumCoreHas('rankPosition')) return 0
  try { return Number(ConsortiumCore.rankPosition(consortiumJavaUuidOf(uuid))) || 0 } catch (err) { return 0 }
}

// Number of ranked accounts (offline included), 0 without the API.
function consortiumRankCount() {
  // rankedCount (0.4.0) counts every account with rank credit; leaderboard(n) is clamped to 25 entries by the mod
  if (consortiumCoreHas('rankedCount')) { try { return Number(ConsortiumCore.rankedCount()) || 0 } catch (err) { return 0 } }
  if (!consortiumCoreHas('leaderboard')) return 0
  try { return Number(ConsortiumCore.leaderboard(25).size()) || 0 } catch (err) { return 0 }
}

// Resolves "<name>" to { id, name } through the mod's account index (uuidOf, 0.4.0), else FTB Teams' known players.
function consortiumRankResolve(server, text) {
  if (consortiumCoreHas('uuidOf')) {
    try {
      let id = ConsortiumCore.uuidOf(String(text))
      if (id !== null && id !== undefined) return { id: String(id).toLowerCase(), name: String(text) }
    } catch (err) { /* fall through */ }
  }
  return consortiumResolvePlayer(server, text)
}

// ---- the shared object -------------------------------------------------------------------------------------

Consortium.ranks = {
  thresholds: CONSORTIUM_RANK_THRESHOLDS,
  order: CONSORTIUM_RANK_ORDER,
  names: CONSORTIUM_RANK_NAMES,

  // Tier key by threshold applied to the account's rank credit.
  tierOf: (uuid) => consortiumRankTierOfCents(consortiumRankCredit(uuid)),

  // { key, credits } of the next tier, or null at the top.
  nextOf: (uuid) => consortiumRankNext(consortiumRankTierOfCents(consortiumRankCredit(uuid))),

  // The progression group held in LuckPerms (0.4.0), else the tier by threshold.
  heldOf: (uuid) => consortiumRankHeld(uuid),

  reconcile: (server, player) => consortiumRankReconcile(server, player),
  publish: (server) => consortiumRankPublish(server),
  resolve: (server, text) => consortiumRankResolve(server, text),

  // Text lines of /consortium ranks for { id, name } (`self` = the caller asks about their own account).
  status: (server, who, self) => {
    let lines = []
    if (typeof ConsortiumCore === 'undefined') {
      lines.push(Text.of('Consortium Core is absent: no ledger, no ranks here.').gray())
      return lines
    }
    let cents = consortiumRankCredit(who.id)
    let tier = consortiumRankTierOfCents(cents)
    let next = consortiumRankNext(tier)
    let pos = consortiumRankPosition(who.id)
    let total = pos > 0 ? consortiumRankCount() : 0
    let head = (self ? 'Your rank: ' : who.name + ': ') + consortiumRankName(tier) + ' (' + consortiumCcFmt(cents) + ' earned at the terminal'
      + (pos > 0 ? ', #' + pos + (total > 0 ? ' of ' + total : '') : '') + '). '
      + (next === null ? 'Top rank reached.' : 'Next: ' + consortiumRankName(next.key) + ' at ' + consortiumCcFmt(next.credits) + ' (' + consortiumCcFmt(Math.max(0, next.credits - cents)) + ' to go).')
    lines.push(Text.of(head).gold())
    lines.push(Text.of(CONSORTIUM_RANK_RULE).gray())
    return lines
  },

  // Text lines of /consortium leaderboard [n]; `uuid` (lowercase string or null) adds the caller's own line.
  leaderboard: (server, n, uuid) => {
    let count = Math.max(1, Math.min(25, Math.floor(Number(n) || 10)))
    let lines = []
    if (typeof ConsortiumCore === 'undefined') {
      lines.push(Text.of('Consortium Core is absent: no ledger, no leaderboard here.').gray())
      return lines
    }
    lines.push(Text.of('Top ' + count + ' by credits earned:').gold())
    let rows = consortiumRankLeaderboardLines(count)
    for (let i = 0; i < rows.length; i++) lines.push(Text.of(rows[i]).white())
    if (uuid) {
      let pos = consortiumRankPosition(uuid)
      let cents = consortiumRankCredit(uuid)
      lines.push(Text.of((pos > 0 ? 'You are #' + pos + ' with ' : 'You have earned ') + consortiumCcFmt(cents) + '.').gray())
    }
    return lines
  },
}

// ---- listeners -------------------------------------------------------------------------------------------

if (typeof ConsortiumCore !== 'undefined') {
  // Login + 60 ticks: after the mod's own 40-tick login check (a promotion of an offline threshold crossing) and after
  // FTB Teams assigned the team (the phase 3 stage of the loader rule).
  PlayerEvents.loggedIn((event) => {
    let player = event.player
    let server = player.server
    server.scheduleInTicks(60, () => {
      try { consortiumRankReconcile(server, player) } catch (err) { console.error('[Consortium] ranks: login reconcile for ' + player.username + ' failed: ' + err) }
    })
  })

  // Every 5 minutes (offset from the engine's check): online players, which hands out the loader when phase 3 opens.
  ServerEvents.tick((event) => {
    if (event.server.tickCount % CONSORTIUM_RANK_CHECK_TICKS !== 1200) return
    for (let p of event.server.players) {
      try { consortiumRankReconcile(event.server, p) } catch (err) { console.error('[Consortium] ranks: reconcile for ' + p.username + ' failed: ' + err) }
    }
  })

  // RankPromoteEvent (0.4.0): the perk lines right after the announcement when the player is online; an offline
  // promotion is reconciled at the next login. The class is probed first: NativeEvents.onEvent on a class name a
  // 0.3.x jar lacks would fail the whole script at load.
  let consortiumRankPromoteEvent = false
  try {
    let cls = Java.tryLoadClass('org.consortium.core.api.event.RankPromoteEvent')
    consortiumRankPromoteEvent = cls !== null && cls !== undefined
  } catch (err) { consortiumRankPromoteEvent = false }
  if (consortiumRankPromoteEvent) {
    NativeEvents.onEvent('org.consortium.core.api.event.RankPromoteEvent', (e) => {
      try {
        let p = e.player
        if (p === null || p === undefined) return
        consortiumRankReconcile(p.server, p)
      } catch (err) { console.error('[Consortium] ranks: promote event handling failed: ' + err) }
    })
    console.info('[Consortium] ranks registered (tiers published to the mod, perk reconcile, RankPromoteEvent listener)')
  } else {
    console.info('[Consortium] ranks registered (tiers by threshold; RankPromoteEvent absent, Consortium Core 0.3.x)')
  }
} else {
  console.info('[Consortium] Consortium Core absent: ranks off')
}
