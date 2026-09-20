// priority: 30
// The Consortium - newcomer onboarding: the starter kit, the referral flow and the first-credit stopwatch
// (docs/RANKS_AND_CONTRACTS.md 3, docs/BATCH_3_INTERFACES.md 4 and 7; PROJECT_RULES 4.3, 4.5, 4.7; PROGRESSION 12).
// Needs consortium_lib.js, consortium_charters.js (consortiumSub), consortium_phases.js (Consortium, consortiumState);
// consortium_ranks.js (CONSORTIUM_RANK_THRESHOLDS, consortiumCoreHas, consortiumCcFmt) and consortium_rules.js
// (consortiumRulebookStack) are read at call time only. Inert without the Consortium Core binding.
//
// Starter kit (3.1): at login + 40 ticks (the mod's login hook shares PlayerLoggedInEvent with no order guarantee),
// a GRANTED account (starting capital paid, the same-connection check passed) with no kitAt stamp receives the
// CONSORTIUM_STARTER_KIT stacks plus the Consortium Rulebook (consortiumRulebookStack, typeof-guarded) and one chat
// line; DENIED alts get nothing, NONE retries at the next login. /consortium kit re-claims the items once (no second
// book: /rules book is the lost-book path), /consortium kit reset <player> clears both stamps. No kit item has a
// price (bread, torches, a bed, stone tools and a written book belong to no family of starter.json), so the kit and
// its reissue cannot become credits. FTB Essentials kits stay off (world data, autogrant ignores the identity check).
//
// Referral (3.2): /consortium referral <name> by a newcomer inside its first 7 days names its recruiter, guards in
// the documented order (window, launch cohort, grant state, one record, recruiter validity and the veteran rule, the
// connection check through ConsortiumCore.sameConnection: SAME refused and logged on the staff lane, UNKNOWN pending a
// moderator's approval, DIFFERENT active). Payout on milestones that cost play: stage 1 when the newcomer's rank
// credit reaches the Operator threshold (100 CC PLACEHOLDER to the recruiter, ledger reason referral:stage1:<uuid>,
// capped at 2 stage-1 payments per recruiter per season week, beyond it stamped stage1Skipped), stage 2 at Engineer
// (250 CC PLACEHOLDER, referral:stage2:<uuid>, uncapped). Every payment goes through ConsortiumCore.credit
// (API_CREDIT), never addRankCredit (rule 4.3), and is stamped only when the ledger answers SUCCESS. The Recruiter and
// Talent Scout quests advance through ConsortiumQuests.count(recruiter, 'referral', 1).
//
// First credit (3.3, rule 4.5 "a first credit within 30 minutes" as a measured metric): the mod owns the canonical
// stopwatch from 0.4.0 (Account.firstCreditAt, firstCreditPlayMinutes, printed by the weekly report); this script keeps
// an engine-side copy in onboarding.<uuid> (session time while no credit was paid, wall and play minutes at the first
// receipt with a total above 0) and logs one console line, so the harness reads the figure on a 0.3.1 jar too.
//
// State (server.persistentData consortium, saved with the world): onboarding.<uuid> { kitAt, reclaimAt, playMs, referralRefusedAt,
// firstCreditAt, firstCreditWallMinutes, firstCreditPlayMinutes }, referrals.<newcomer uuid> { referrer, referrerName,
// newcomerName, at, status: active | pending, stage1PaidAt, stage2PaidAt, stage1Skipped }, referrals_week.<referrer
// uuid>.<season week> (int). A refusal writes no record; clear deletes it. Inspect with: /kubejs persistent-data
// server get consortium
//
// Every number marked PLACEHOLDER is re-derived from the beta-week ledger. No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

// Kit contents, PLACEHOLDER (modest and phase-neutral: stone tools are free forever per PROGRESSION 3, no ore).
const CONSORTIUM_STARTER_KIT = [
  { item: 'minecraft:stone_pickaxe', count: 1, name: 'Field Office Pickaxe' },
  { item: 'minecraft:stone_axe', count: 1 },
  { item: 'minecraft:stone_shovel', count: 1 },
  { item: 'minecraft:bread', count: 16 },
  { item: 'minecraft:torch', count: 32 },
  { item: 'minecraft:white_bed', count: 1 },
]
// Referral rules, PLACEHOLDER: the declaration window, the two payouts in cents and the weekly cap of stage 1
// payments per recruiter. Harness lever (RANKS 8): weeklyCap = 1 in the srvdev copy only.
const CONSORTIUM_REFERRAL = { windowDays: 7, stage1PayCents: 10000, stage2PayCents: 25000, weeklyCap: 2 }
const CONSORTIUM_REFERRAL_POLL_TICKS = 6000 // the 5-minute poll, offset from the phase engine's check
const CONSORTIUM_ONBOARDING_KIT_DELAY = 40
const CONSORTIUM_ONBOARDING_TEXT_DENIED = 'Starting capital was already paid to an account on your connection. Sharing a connection? Ask a moderator.'
const CONSORTIUM_ONBOARDING_TEXT_NONE = 'Your account is still being checked, try again at your next login.'

let consortiumOnboardingSessions = {} // uuid -> session start (epoch ms), in memory
let consortiumOnboardingServer = null
let consortiumOnboardingBookWarned = false

// ---- helpers -----------------------------------------------------------------------------------------------

function consortiumOnboardingTag(server, uuid) {
  return consortiumSub(consortiumSub(consortiumState(server), 'onboarding'), String(uuid).toLowerCase())
}

function consortiumReferralRecords(server) {
  return consortiumSub(consortiumState(server), 'referrals')
}

function consortiumOnboardingWeek(server) {
  return Math.floor((Consortium.seasonDay(server) - 1) / 7)
}

function consortiumOnboardingSnbt(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function consortiumOnboardingFmt(cents) {
  if (typeof consortiumCcFmt === 'function') return consortiumCcFmt(cents)
  return (Number(cents) / 100).toFixed(2) + ' CC'
}

function consortiumOnboardingHas(name) {
  return typeof consortiumCoreHas === 'function' && consortiumCoreHas(name)
}

function consortiumOnboardingThresholds() {
  return typeof CONSORTIUM_RANK_THRESHOLDS !== 'undefined' ? CONSORTIUM_RANK_THRESHOLDS : { operator: 25000, engineer: 250000 }
}

function consortiumOnboardingReady() {
  if (typeof ConsortiumCore === 'undefined') return false
  try { return ConsortiumCore.ready() } catch (err) { return false }
}

function consortiumOnboardingGrant(uuid) {
  try { return String(ConsortiumCore.grant(typeof uuid === 'string' ? CONSORTIUM_UUID.fromString(uuid) : uuid)) } catch (err) { return 'NONE' }
}

function consortiumOnboardingFirstLogin(uuid) {
  try { return Number(ConsortiumCore.firstLogin(typeof uuid === 'string' ? CONSORTIUM_UUID.fromString(uuid) : uuid)) || 0 } catch (err) { return 0 }
}

function consortiumOnboardingRankCredit(uuid) {
  try { return Number(ConsortiumCore.rankCredit(typeof uuid === 'string' ? CONSORTIUM_UUID.fromString(uuid) : uuid)) || 0 } catch (err) { return 0 }
}

function consortiumOnboardingOnline(server, uuid) {
  for (let p of server.players) {
    if (String(p.uuid).toLowerCase() === uuid) return p
  }
  return null
}

// A staff-lane notice: ConsortiumCore.discordStaff (0.4.0, WHITELIST lane) when present; the console always has it.
function consortiumOnboardingStaff(server, text) {
  console.warn('[Consortium] staff: ' + text)
  if (consortiumOnboardingHas('discordStaff')) {
    try { ConsortiumCore.discordStaff(text) } catch (err) { console.error('[Consortium] discordStaff failed: ' + err) }
  }
}

// Resolves a typed name to { id, name } through the mod's account index when present, else FTB Teams' known players.
function consortiumOnboardingResolve(server, text) {
  if (typeof Consortium.ranks !== 'undefined' && Consortium.ranks && typeof Consortium.ranks.resolve === 'function') return Consortium.ranks.resolve(server, text)
  return consortiumResolvePlayer(server, text)
}

// ---- the starter kit (RANKS 3.1) ---------------------------------------------------------------------------------

function consortiumKitStack(entry) {
  if (!Item.exists(entry.item)) return null
  let spec = entry.item
  if (entry.name) spec += '[minecraft:custom_name=' + consortiumOnboardingSnbt(JSON.stringify({ text: entry.name, italic: false })) + ']'
  let stack = Item.of(spec)
  if (stack.isEmpty()) return null
  return entry.count > 1 ? stack.withCount(entry.count) : stack
}

// Gives the kit stacks (`reason` 'first' adds the rulebook, 'reissue' does not), stamps the record, tells the player.
function consortiumKitGive(server, player, reason) {
  let uuid = String(player.uuid).toLowerCase()
  let rec = consortiumOnboardingTag(server, uuid)
  let given = 0
  for (let i = 0; i < CONSORTIUM_STARTER_KIT.length; i++) {
    let stack = null
    try { stack = consortiumKitStack(CONSORTIUM_STARTER_KIT[i]) } catch (err) { console.error('[Consortium] kit stack ' + CONSORTIUM_STARTER_KIT[i].item + ' failed: ' + err) }
    if (stack === null) { console.warn('[Consortium] kit: ' + CONSORTIUM_STARTER_KIT[i].item + ' is unknown, skipped'); continue }
    player.give(stack) // drops at the feet when the inventory is full
    given++
  }
  let book = false
  if (reason === 'first') {
    if (typeof consortiumRulebookStack === 'function') {
      try {
        let stack = consortiumRulebookStack()
        if (stack !== null && stack !== undefined && !stack.isEmpty()) { player.give(stack); book = true }
      } catch (err) { console.error('[Consortium] kit: rulebook stack failed: ' + err) }
    }
    if (!book && !consortiumOnboardingBookWarned) {
      consortiumOnboardingBookWarned = true
      console.warn('[Consortium] kit: rulebook absent (consortium_rules.js missing or its JSON unreadable), the kit ships without the book')
    }
    rec.putLong('kitAt', Date.now())
    player.tell(Text.of('Your starter kit is in your inventory. Read the Rulebook, then head to the Field Office.').gold())
  } else {
    rec.putLong('reclaimAt', Date.now())
    player.tell(Text.of('Your starter kit was reissued (once per season). Lost the rulebook too? /rules book gives a copy.').gold())
  }
  console.info('[Consortium] starter kit (' + reason + ') given to ' + player.username + ': ' + given + ' stack(s)' + (book ? ' plus the rulebook' : ''))
  return given
}

Consortium.kit = {
  give: (server, player, reason) => consortiumKitGive(server, player, reason || 'first'),

  reset: (server, uuid) => {
    let rec = consortiumOnboardingTag(server, uuid)
    let had = rec.getLong('kitAt') > 0 || rec.getLong('reclaimAt') > 0
    rec.putLong('kitAt', 0)
    rec.putLong('reclaimAt', 0)
    return had
  },

  // The login path: GRANTED, ready and never given. Returns true when the kit went out.
  onLogin: (server, player) => {
    if (!consortiumOnboardingReady()) return false
    let uuid = String(player.uuid).toLowerCase()
    if (consortiumOnboardingGrant(player.uuid) !== 'GRANTED') return false
    if (consortiumOnboardingTag(server, uuid).getLong('kitAt') > 0) return false
    consortiumKitGive(server, player, 'first')
    return true
  },

  // /consortium kit by a player: the same grant condition as the login give, then one reissue. { ok, text }.
  claim: (server, player) => {
    if (!consortiumOnboardingReady()) return { ok: false, text: 'The Board is not ready yet, try again in a minute.' }
    let grant = consortiumOnboardingGrant(player.uuid)
    if (grant === 'DENIED') return { ok: false, text: CONSORTIUM_ONBOARDING_TEXT_DENIED }
    if (grant !== 'GRANTED') return { ok: false, text: CONSORTIUM_ONBOARDING_TEXT_NONE }
    let rec = consortiumOnboardingTag(server, String(player.uuid).toLowerCase())
    if (rec.getLong('kitAt') === 0) { consortiumKitGive(server, player, 'first'); return { ok: true, text: 'Starter kit given.' } }
    if (rec.getLong('reclaimAt') === 0) { consortiumKitGive(server, player, 'reissue'); return { ok: true, text: 'Starter kit reissued once.' } }
    return { ok: false, text: 'Your starter kit was already reissued once; ask a moderator.' }
  },

  status: (server, uuid) => {
    let rec = consortiumOnboardingTag(server, uuid)
    return { kitAt: rec.getLong('kitAt'), reclaimAt: rec.getLong('reclaimAt'), firstCreditAt: rec.getLong('firstCreditAt'),
      firstCreditPlayMinutes: rec.getInt('firstCreditPlayMinutes'), firstCreditWallMinutes: rec.getInt('firstCreditWallMinutes') }
  },
}

// ---- referrals (RANKS 3.2) -----------------------------------------------------------------------------------

function consortiumReferralWeekTag(server, referrer) {
  return consortiumSub(consortiumSub(consortiumState(server), 'referrals_week'), String(referrer).toLowerCase())
}

// Checks the milestones of one active record and pays what is due (stamps on SUCCESS only).
function consortiumReferralPollOne(server, id, rec) {
  if (String(rec.getString('status')) !== 'active') return
  if (!consortiumOnboardingReady()) return
  let referrer = String(rec.getString('referrer'))
  let referrerName = String(rec.getString('referrerName'))
  let newcomerName = String(rec.getString('newcomerName'))
  let credit = consortiumOnboardingRankCredit(id)
  let th = consortiumOnboardingThresholds()
  let now = Date.now()
  let refUuid = CONSORTIUM_UUID.fromString(referrer)
  if (rec.getLong('stage1PaidAt') === 0 && rec.getLong('stage1Skipped') === 0 && credit >= th.operator) {
    let week = consortiumOnboardingWeek(server)
    let wk = consortiumReferralWeekTag(server, referrer)
    let n = wk.getInt(String(week))
    if (n >= CONSORTIUM_REFERRAL.weeklyCap) {
      rec.putLong('stage1Skipped', now)
      if (typeof ConsortiumQuests !== 'undefined' && typeof ConsortiumQuests.count === 'function') ConsortiumQuests.count(referrer, 'referral', 1)
      console.info('[Consortium] referral stage 1 for ' + id + ' not paid: weekly cap reached by ' + referrerName + ' (' + referrer + ', ' + n + ' this week)')
      let p = consortiumOnboardingOnline(server, referrer)
      if (p !== null) p.tell(Text.of('Referral for ' + newcomerName + ' not paid: weekly cap reached (' + CONSORTIUM_REFERRAL.weeklyCap + ' per week).').yellow())
    } else {
      let result = ConsortiumCore.credit(refUuid, CONSORTIUM_REFERRAL.stage1PayCents, 'referral:stage1:' + id)
      if (String(result) === 'SUCCESS') {
        rec.putLong('stage1PaidAt', now)
        wk.putInt(String(week), n + 1)
        if (typeof ConsortiumQuests !== 'undefined' && typeof ConsortiumQuests.count === 'function') ConsortiumQuests.count(referrer, 'referral', 1)
        console.info('[Consortium] referral stage 1 paid: ' + consortiumOnboardingFmt(CONSORTIUM_REFERRAL.stage1PayCents) + ' to ' + referrerName + ' for ' + newcomerName + ' (' + id + ')')
        consortiumBroadcast(server, referrerName + ' recruited ' + newcomerName + ', who just made Operator: ' + consortiumOnboardingFmt(CONSORTIUM_REFERRAL.stage1PayCents) + ' referral bonus paid.')
      } else {
        console.warn('[Consortium] referral stage 1 for ' + id + ' not paid yet (' + result + '), retried at the next poll')
      }
    }
  }
  if (rec.getLong('stage2PaidAt') === 0 && credit >= th.engineer) {
    let result = ConsortiumCore.credit(refUuid, CONSORTIUM_REFERRAL.stage2PayCents, 'referral:stage2:' + id)
    if (String(result) === 'SUCCESS') {
      rec.putLong('stage2PaidAt', now)
      console.info('[Consortium] referral stage 2 paid: ' + consortiumOnboardingFmt(CONSORTIUM_REFERRAL.stage2PayCents) + ' to ' + referrerName + ' for ' + newcomerName + ' (' + id + ')')
      consortiumBroadcast(server, referrerName + '\'s recruit ' + newcomerName + ' made Engineer: ' + consortiumOnboardingFmt(CONSORTIUM_REFERRAL.stage2PayCents) + ' referral bonus paid.')
    } else {
      console.warn('[Consortium] referral stage 2 for ' + id + ' not paid yet (' + result + '), retried at the next poll')
    }
  }
}

function consortiumReferralRecordView(id, rec) {
  return { newcomer: id, referrer: String(rec.getString('referrer')), referrerName: String(rec.getString('referrerName')),
    newcomerName: String(rec.getString('newcomerName')), at: rec.getLong('at'), status: String(rec.getString('status')),
    stage1PaidAt: rec.getLong('stage1PaidAt'), stage2PaidAt: rec.getLong('stage2PaidAt'), stage1Skipped: rec.getLong('stage1Skipped') }
}

Consortium.referrals = {
  rules: CONSORTIUM_REFERRAL,

  // The record of a newcomer uuid (lowercase string), or null.
  recordOf: (server, uuid) => {
    let all = consortiumReferralRecords(server)
    let id = String(uuid).toLowerCase()
    return all.contains(id) ? consortiumReferralRecordView(id, all.getCompound(id)) : null
  },

  // /consortium referral <name> by `caller` (an online player). Returns a refusal string, or null once recorded (read
  // recordOf for the status). A refusal never writes a record.
  declare: (server, caller, name) => {
    if (!consortiumOnboardingReady()) return 'The Board is not ready yet, try again in a minute.'
    let uuid = String(caller.uuid).toLowerCase()
    let callerName = String(caller.username)
    let now = Date.now()
    let startedAt = consortiumState(server).getLong('startedAt')
    let first = consortiumOnboardingFirstLogin(caller.uuid)
    // 1. the window
    if (first <= 0 || now - first >= CONSORTIUM_REFERRAL.windowDays * CONSORTIUM_DAY_MS) return 'Referrals can only be declared during your first ' + CONSORTIUM_REFERRAL.windowDays + ' days.'
    // 2. the launch cohort (the newcomer-bonus rule of DECISIONS 2026-09-16, policy PLACEHOLDER)
    if (first < startedAt + CONSORTIUM_DAY_MS) return 'The launch crew was recruited by the Board itself.'
    // 3. the grant state
    let grant = consortiumOnboardingGrant(caller.uuid)
    if (grant === 'DENIED') return 'Referrals are not available on a shared connection.'
    if (grant !== 'GRANTED') return CONSORTIUM_ONBOARDING_TEXT_NONE
    // 4. one record per newcomer
    let all = consortiumReferralRecords(server)
    if (all.contains(uuid)) {
      let existing = all.getCompound(uuid)
      let status = String(existing.getString('status'))
      if (status === 'active' || status === 'pending') return 'You already named ' + existing.getString('referrerName') + ' as your recruiter.'
    }
    // 5. the recruiter
    let who = consortiumOnboardingResolve(server, name)
    let recruiterFirst = who === null ? 0 : consortiumOnboardingFirstLogin(who.id)
    if (who === null || recruiterFirst <= 0) return 'No account named ' + String(name) + ' has joined this server.'
    if (who.id === uuid) return 'You cannot refer yourself.'
    if (all.contains(who.id) && String(all.getCompound(who.id).getString('referrer')) === uuid) return 'You cannot recruit your own recruiter.'
    let veteran = recruiterFirst < startedAt + CONSORTIUM_DAY_MS || recruiterFirst <= first - CONSORTIUM_REFERRAL.windowDays * CONSORTIUM_DAY_MS
    if (!veteran) return who.name + ' is too new to be a recruiter.'
    // 6. the connection
    let same = 'UNKNOWN'
    if (consortiumOnboardingHas('sameConnection')) {
      try { same = String(ConsortiumCore.sameConnection(caller.uuid, CONSORTIUM_UUID.fromString(who.id))) } catch (err) { console.error('[Consortium] sameConnection failed: ' + err); same = 'UNKNOWN' }
    }
    if (same === 'SAME') {
      // the staff lane hears about a same-connection refusal once per caller and day; repeating the command only
      // logs to the console (review 2026-09-20: no way to flood the alerts channel)
      let tag = consortiumOnboardingTag(server, uuid)
      let refusedAt = tag.getLong('referralRefusedAt')
      if (refusedAt === 0 || now - refusedAt >= CONSORTIUM_DAY_MS) {
        tag.putLong('referralRefusedAt', now)
        consortiumOnboardingStaff(server, 'Referral refused: ' + callerName + ' named ' + who.name + ' on the same connection.')
      } else {
        console.warn('[Consortium] referral refused again (same connection): ' + callerName + ' named ' + who.name)
      }
      return 'Referrals need two different connections.'
    }
    let rec = NBT.compoundTag()
    rec.putString('referrer', who.id)
    rec.putString('referrerName', who.name)
    rec.putString('newcomerName', callerName)
    rec.putLong('at', now)
    rec.putString('status', same === 'DIFFERENT' ? 'active' : 'pending')
    rec.putLong('stage1PaidAt', 0)
    rec.putLong('stage2PaidAt', 0)
    rec.putLong('stage1Skipped', 0)
    all.put(uuid, rec)
    console.info('[Consortium] referral ' + rec.getString('status') + ': ' + callerName + ' (' + uuid + ') named ' + who.name + ' (' + who.id + '), connection ' + same)
    if (same !== 'DIFFERENT') consortiumOnboardingStaff(server, 'Referral pending: ' + callerName + ' named ' + who.name + ', connection unknown: /consortium referral approve ' + callerName)
    return null
  },

  // Every active record (the 5-minute poll); one uuid after its delivery.
  poll: (server) => {
    let all = consortiumReferralRecords(server)
    let ids = []
    for (let key of all.getAllKeys()) ids.push(String(key))
    for (let i = 0; i < ids.length; i++) {
      try { consortiumReferralPollOne(server, ids[i], all.getCompound(ids[i])) } catch (err) { console.error('[Consortium] referral poll of ' + ids[i] + ' failed: ' + err) }
    }
    return ids.length
  },
  pollOne: (server, uuid) => {
    let all = consortiumReferralRecords(server)
    let id = String(uuid).toLowerCase()
    if (!all.contains(id)) return false
    consortiumReferralPollOne(server, id, all.getCompound(id))
    return true
  },

  // Staff: pending -> active (then polled at once). Returns a refusal string or null.
  approve: (server, uuid) => {
    let all = consortiumReferralRecords(server)
    let id = String(uuid).toLowerCase()
    if (!all.contains(id)) return 'No referral record for that player.'
    let rec = all.getCompound(id)
    if (String(rec.getString('status')) !== 'pending') return 'That referral is ' + rec.getString('status') + ', nothing to approve.'
    rec.putString('status', 'active')
    console.info('[Consortium] referral approved: ' + rec.getString('newcomerName') + ' (' + id + ') recruited by ' + rec.getString('referrerName'))
    consortiumReferralPollOne(server, id, rec)
    return null
  },

  // Staff: deletes the record (the reversal of a payout is /credits take, see the staff charter).
  clear: (server, uuid) => {
    let all = consortiumReferralRecords(server)
    let id = String(uuid).toLowerCase()
    if (!all.contains(id)) return false
    all.remove(id)
    console.info('[Consortium] referral record of ' + id + ' cleared')
    return true
  },

  // One text line about a player's record (as a newcomer) plus their recruits.
  status: (server, uuid) => {
    let id = String(uuid).toLowerCase()
    let all = consortiumReferralRecords(server)
    let parts = []
    if (all.contains(id)) {
      let r = consortiumReferralRecordView(id, all.getCompound(id))
      parts.push('recruited by ' + r.referrerName + ' (' + r.status + ', stage 1 ' + (r.stage1PaidAt > 0 ? 'paid' : r.stage1Skipped > 0 ? 'skipped, weekly cap' : 'open') + ', stage 2 ' + (r.stage2PaidAt > 0 ? 'paid' : 'open') + ')')
    } else {
      parts.push('no recruiter named')
    }
    let recruits = 0
    let paid = 0
    for (let key of all.getAllKeys()) {
      let r = all.getCompound(key)
      if (String(r.getString('referrer')) !== id) continue
      recruits++
      if (r.getLong('stage1PaidAt') > 0) paid += CONSORTIUM_REFERRAL.stage1PayCents
      if (r.getLong('stage2PaidAt') > 0) paid += CONSORTIUM_REFERRAL.stage2PayCents
    }
    parts.push(recruits + ' recruit(s), ' + consortiumOnboardingFmt(paid) + ' of referral bonuses paid')
    return parts.join('; ')
  },

  // Every record as a JS array of views.
  list: (server) => {
    let all = consortiumReferralRecords(server)
    let out = []
    for (let key of all.getAllKeys()) out.push(consortiumReferralRecordView(String(key), all.getCompound(key)))
    out.sort((a, b) => a.at - b.at)
    return out
  },

  // Balancing journal figures over the last `days` days: { recorded, payments, paidCents }.
  window: (server, days) => {
    let all = consortiumReferralRecords(server)
    let since = Date.now() - days * CONSORTIUM_DAY_MS
    let out = { recorded: 0, payments: 0, paidCents: 0 }
    for (let key of all.getAllKeys()) {
      let r = all.getCompound(key)
      if (r.getLong('at') >= since) out.recorded++
      if (r.getLong('stage1PaidAt') >= since && r.getLong('stage1PaidAt') > 0) { out.payments++; out.paidCents += CONSORTIUM_REFERRAL.stage1PayCents }
      if (r.getLong('stage2PaidAt') >= since && r.getLong('stage2PaidAt') > 0) { out.payments++; out.paidCents += CONSORTIUM_REFERRAL.stage2PayCents }
    }
    return out
  },
}

// ---- listeners -------------------------------------------------------------------------------------------

if (typeof ConsortiumCore !== 'undefined') {
  ServerEvents.loaded((event) => {
    consortiumOnboardingServer = event.server
    consortiumOnboardingSessions = {}
  })

  PlayerEvents.loggedIn((event) => {
    let player = event.player
    let server = player.server
    let uuid = String(player.uuid).toLowerCase()
    consortiumOnboardingSessions[uuid] = Date.now()
    server.scheduleInTicks(CONSORTIUM_ONBOARDING_KIT_DELAY, () => {
      try { Consortium.kit.onLogin(server, player) } catch (err) { console.error('[Consortium] starter kit for ' + player.username + ' failed: ' + err) }
    })
  })

  // Session time before the first credit (the engine-side stopwatch).
  PlayerEvents.loggedOut((event) => {
    try {
      let player = event.player
      let uuid = String(player.uuid).toLowerCase()
      let start = consortiumOnboardingSessions[uuid]
      delete consortiumOnboardingSessions[uuid]
      if (!start) return
      let rec = consortiumOnboardingTag(player.server, uuid)
      if (rec.getLong('firstCreditAt') > 0) return
      rec.putLong('playMs', rec.getLong('playMs') + Math.max(0, Date.now() - start))
    } catch (err) { console.error('[Consortium] onboarding logout stamp failed: ' + err) }
  })

  // First receipt with a total above 0: the stopwatch; then the referral milestones of that player.
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      let total = Number(e.totalCents)
      if (total > 0) {
        let rec = consortiumOnboardingTag(server, uuid)
        if (rec.getLong('firstCreditAt') === 0) {
          let now = Date.now()
          let first = consortiumOnboardingFirstLogin(player.uuid)
          let start = consortiumOnboardingSessions[uuid] || now
          let playMs = rec.getLong('playMs') + Math.max(0, now - start)
          rec.putLong('firstCreditAt', now)
          rec.putInt('firstCreditPlayMinutes', Math.round(playMs / 60000))
          rec.putInt('firstCreditWallMinutes', first > 0 ? Math.round((now - first) / 60000) : 0)
          console.info('[Consortium] first credit: ' + player.username + ' after ' + Math.round(playMs / 60000) + ' min of play (' + (first > 0 ? Math.round((now - first) / 60000) : '?') + ' min since the first login), ' + consortiumOnboardingFmt(total))
        }
      }
      Consortium.referrals.pollOne(server, uuid)
    } catch (err) { console.error('[Consortium] onboarding delivery hook failed: ' + err) }
  })

  // The 5-minute poll (offset from the phase engine's check): the Gap Contract path of rank credit is covered here.
  ServerEvents.tick((event) => {
    if (event.server.tickCount % CONSORTIUM_REFERRAL_POLL_TICKS !== 2400) return
    try { Consortium.referrals.poll(event.server) } catch (err) { console.error('[Consortium] referral poll failed: ' + err) }
  })

  // Weekly report line (ReportEvent, Consortium Core 0.4.0): "Referrals (7 d): R recorded, P stage payments, X CC".
  let consortiumOnboardingReportEvent = false
  try {
    let cls = Java.tryLoadClass('org.consortium.core.api.event.ReportEvent')
    consortiumOnboardingReportEvent = cls !== null && cls !== undefined
  } catch (err) { consortiumOnboardingReportEvent = false }
  if (consortiumOnboardingReportEvent) {
    NativeEvents.onEvent('org.consortium.core.api.event.ReportEvent', (e) => {
      try {
        if (Number(e.windowDays) < 7 || consortiumOnboardingServer === null) return
        let w = Consortium.referrals.window(consortiumOnboardingServer, 7)
        e.addLine('Referrals (7 d): ' + w.recorded + ' recorded, ' + w.payments + ' stage payments, ' + consortiumOnboardingFmt(w.paidCents))
      } catch (err) { console.error('[Consortium] referrals report line failed: ' + err) }
    })
  }
  console.info('[Consortium] onboarding registered (starter kit at login, referrals, first-credit stopwatch)')
} else {
  console.info('[Consortium] Consortium Core absent: onboarding off')
}
