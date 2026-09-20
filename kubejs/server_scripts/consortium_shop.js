// priority: 30
// The Consortium - shop side of the economy (docs/SHOP_CATALOGUE.md section 5, PROGRESSION 9.4 and 11,
// CONTENT_BATCH_2_INTERFACES 3 and 4). Loads after consortium_money.js (40) and before the commands (0).
// Needs consortium_lib.js, consortium_charters.js (charter records, licence records, stage reconciliation)
// and consortium_phases.js (state, season day, quotas, board). Everything that touches money or the mod's
// events is off when the Consortium Core binding is absent (singleplayer); the state API still works.
//
// What lives here (every function is reachable through the shared Consortium object, commands in the
// economy block of consortium_commands.js):
//   Consortium.sales     open / close / isOpen / list: sale stages every team holds while a sale is open
//                        (consortium:vacancy_<charter>, SHOP 5.2); consortiumOpenSaleStages feeds the
//                        wanted-stage set of consortium_charters.js
//   Consortium.licences  grant / revoke / held: purchased or staff-granted licences (SHOP 5.5), the record
//                        consortium_charters.js reads so the licence stage survives the 1 second sweep
//   vacancy detection    consortiumShopDaily (called by the engine's daily step): a charter nobody delivers
//                        for 7 days gets a notice, after 7 more days its licence goes on sale (SHOP 5.5)
//   Consortium.season    contribute / status / setTarget: the season fund counter, milestones, the
//                        Benefactor title, the plaque tiers, the board line (SHOP 5.6)
//   Consortium.tickets   grant / count / consume / take: Friday Zone tickets (SHOP 5.7; the events engine
//                        consumes them at the wave start)
//   Consortium.titles    grant / activate / revoke / resync / held: one LuckPerms suffix at priority 60
//                        for every player title, shop or quest (SHOP 5.11)
//   Consortium.perks     grant / revoke / resync / held: LuckPerms-backed perks run through the server's
//                        own console source (SHOP 5.10): home slots, the Board warp pass, the nickname
//   Consortium.gap       status / buy, and Consortium.onCatchUp: the Gap Contract (SHOP 5.8, PROGRESSION 11)
//   pre-check            BalanceChangeEvent listener: every shop refusal happens BEFORE the debit, because
//                        a failed effect is never refunded (SHOP 5.4)
//   quest flags          ShopPurchaseEvent listener: shop:* flags through ConsortiumQuests (SHOP 5.12)
//   activity stamp       DeliveryEvent listener: activity.<charter>.lastDeliveryAt for the vacancy rule
//   login hook           re-issues the held perks and the active title (LuckPerms is asynchronous and
//                        always reports success, so the engine record is the source of truth)
//
// State (server.persistentData "consortium", SHOP 5.1):
//   licences.<uuid>.<charter> { grantedAt, tx, by }        activity.<charter> { lastDeliveryAt }
//   vacancy.<charter> { inactiveSince, openSince }          sales.<stage id> { until, by }
//   season { fund, target, milestone, contributors.<uuid> { cents, name, tier } }
//   events.tickets.<uuid> (int)                              perks.<uuid>.<perk> { grantedAt, tx }
//   titles.<uuid> { active, held.<key> }                     gap.<phase> { day, today, total, buyers }
//   txs.<tx> { at, what }                                    (pruned after 30 days by the daily step)
// Every engine command behind a shop entry is idempotent on {tx} (txs.<tx> seen = "already applied", the
// command still returns success so the mod never reports an effect failure) and never refuses after the
// pre-check: a broken state goes to console.error and to the online ops.
//
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_HAS_LUCKPERMS = Platform.isLoaded('luckperms')
const CONSORTIUM_SHOP_HAS_FTBCHUNKS = Platform.isLoaded('ftbchunks')
const CONSORTIUM_SHOP_FTBCHUNKS_API = CONSORTIUM_SHOP_HAS_FTBCHUNKS ? Java.loadClass('dev.ftb.mods.ftbchunks.api.FTBChunksAPI') : null

// Season fund (SHOP 3.6): target 30,000 CC PLACEHOLDER (7 median players at 3,000 CC plus the Energy surplus),
// written into season.target at the first contribution; /consortium season target overrides it.
const CONSORTIUM_SEASON_TARGET_CENTS = 3000000
const CONSORTIUM_SEASON_MILESTONES = [25, 50, 75, 100]
const CONSORTIUM_BENEFACTOR_CENTS = 50000 // Benefactor title at 500 CC contributed (cumulative)
const CONSORTIUM_PLAQUE_TIERS = [
  { tier: 1, cents: 100000, label: 'Bronze' }, // PLACEHOLDER tiers, PRICE_TABLE 6 / SHOP 3.6
  { tier: 2, cents: 300000, label: 'Silver' },
  { tier: 3, cents: 600000, label: 'Gold' },
]

// Titles (SHOP 5.11): the four sold or engine-granted keys with their suffix text; the quests script passes
// its own text for its six keys. Rule 4.3: grey text only, one suffix at priority 60 (staff suffixes 100, 110).
const CONSORTIUM_TITLES = { foundry: 'of the Foundry', orbital: 'Orbital', horizon: 'of the Event Horizon', benefactor: 'Benefactor', bug_hunter: 'Bug Hunter' } // bug_hunter: the staff charter's thanks for a bug report (DISCORD 8.6), tx staff:bug:<date>:<uuid>
const CONSORTIUM_TITLE_PRIORITY = 60

// Perks (SHOP 5.10): home slots set the LuckPerms meta ftbessentials.home.max to the number of slots held;
// the pass and the nickname set a command node. Revoke resets the value.
const CONSORTIUM_PERKS = {
  home_slot_1: { label: 'Home slot 1', home: true, requires: null },
  home_slot_2: { label: 'Home slot 2', home: true, requires: 'home_slot_1' },
  home_slot_3: { label: 'Home slot 3', home: true, requires: 'home_slot_2' },
  warp_pass: { label: 'Board warp pass', node: 'command.warp' },
  nickname: { label: 'Nickname right', node: 'command.nickname' },
}
// Shop keys whose pre-check is a perk rule (catalogue key -> perk id).
const CONSORTIUM_PERK_ENTRIES = { home_slot_1: 'home_slot_1', home_slot_2: 'home_slot_2', home_slot_3: 'home_slot_3', warp_pass: 'warp_pass', nickname_right: 'nickname' }

// Vacancy rule (PROGRESSION 9.4, SHOP 5.5): idle 7 days = notice, 7 more days = licence on sale.
const CONSORTIUM_VACANCY_IDLE_DAYS = 7
const CONSORTIUM_VACANCY_NOTICE_DAYS = 7
// Licence prices quoted in the vacancy notice: PLACEHOLDER, mirrors consortium_shop/catalogue.json (the
// engine cannot read the catalogue; keep both in step).
const CONSORTIUM_LICENCE_PRICES = { extraction: 3900, energy: 5300, logistics: 5300 }

// Gap Contract (PROGRESSION 11, SHOP 5.8): global 10 % of the quota per line per day, 30 % per phase, and
// 10 % per buyer per line per phase (PLACEHOLDER); packs of 10 on lines with a quota of at least 500.
const CONSORTIUM_GAP_DAILY_SHARE = 0.10
const CONSORTIUM_GAP_PHASE_SHARE = 0.30
const CONSORTIUM_GAP_BUYER_SHARE = 0.10
const CONSORTIUM_GAP_PACK_MIN_QUOTA = 500
const CONSORTIUM_GAP_MIN_UNIT_CENTS = 100 // the 1 CC floor of "units x max(1, 2 x base)"

const CONSORTIUM_TX_KEEP_DAYS = 30
const CONSORTIUM_CLAIM_HARD_LIMIT = 200 // pack/config/ftbchunks-world.snbt hard_team_claim_limit
const CONSORTIUM_CLAIM_PACK = 10

let consortiumShopServer = null // the running server, for the mod events that carry a UUID only

// ---- small helpers ------------------------------------------------------------------------------------

function consortiumShopState(server, key) {
  return consortiumSub(consortiumState(server), key)
}

function consortiumOnlinePlayer(server, uuid) {
  for (let p of server.players) {
    if (String(p.uuid).toLowerCase() === uuid) return p
  }
  return null
}

// Tells an online player (red) and logs; used for refusals and for broken states after the debit.
function consortiumTellPlayer(server, uuid, text, color) {
  let p = consortiumOnlinePlayer(server, uuid)
  if (p === null) return false
  let t = Text.of(text)
  p.tell(color === 'green' ? t.green() : color === 'gold' ? t.gold() : t.red())
  return true
}

// A broken state after the debit: never refunded automatically, the ops get the line (SHOP 5.4).
function consortiumAlertOps(server, text) {
  console.error('[Consortium] ' + text)
  for (let p of server.players) {
    if (p.hasPermissions(2)) p.tell(Text.of('[Consortium] ' + text).red())
  }
}

function consortiumJavaUuid(uuid) {
  return CONSORTIUM_UUID.fromString(uuid)
}

// True when the transaction id was applied before (nothing to do); records it otherwise. An empty tx is
// never recorded (staff commands without one always apply).
function consortiumTxSeen(server, tx, what) {
  if (!tx) return false
  let txs = consortiumShopState(server, 'txs')
  let key = String(tx)
  if (txs.contains(key)) return true
  let rec = NBT.compoundTag()
  rec.putLong('at', Date.now())
  rec.putString('what', what)
  txs.put(key, rec)
  return false
}

function consortiumTxPrune(server) {
  let txs = consortiumShopState(server, 'txs')
  let cutoff = Date.now() - CONSORTIUM_TX_KEEP_DAYS * CONSORTIUM_DAY_MS
  let old = []
  for (let key of txs.getAllKeys()) {
    if (txs.getCompound(key).getLong('at') < cutoff) old.push(String(key))
  }
  for (let i = 0; i < old.length; i++) txs.remove(old[i])
  return old.length
}

// LuckPerms through the server's own console source (the shop's synthetic source is refused by LuckPerms,
// SHOP 5.10). LuckPerms runs asynchronously and always reports success: the engine record is the truth.
function consortiumLp(server, line) {
  if (!CONSORTIUM_HAS_LUCKPERMS) {
    console.info('[Consortium] LuckPerms absent, skipped: lp ' + line)
    return false
  }
  server.runCommandSilent('lp ' + line)
  return true
}

function consortiumCharterLabel(c) {
  return CONSORTIUM_CHARTERS[c] ? CONSORTIUM_CHARTERS[c].label : c
}

// Quest flags (SHOP 5.12, QUESTS 5.3): typeof-guarded at call time, the quests script is a sibling.
function consortiumQuestFlag(uuid, key) {
  if (typeof ConsortiumQuests === 'undefined' || typeof ConsortiumQuests.flag !== 'function') return false
  try {
    ConsortiumQuests.flag(uuid, key)
    return true
  } catch (err) {
    console.error('[Consortium] quest flag ' + key + ' for ' + uuid + ' failed: ' + err)
    return false
  }
}

// ---- sale stages (SHOP 5.2) ------------------------------------------------------------------------------

// Stage ids on sale right now, as a JS array (read by consortiumWantedStages in consortium_charters.js).
function consortiumOpenSaleStages(server) {
  let sales = consortiumShopState(server, 'sales')
  let now = Date.now()
  let out = []
  for (let key of sales.getAllKeys()) {
    let until = sales.getCompound(key).getLong('until')
    if (until === 0 || until > now) out.push(String(key))
  }
  return out
}

// 5 minute maintenance (called by Consortium.check before its resync): expired sales close.
function consortiumShopCheck(server) {
  let sales = consortiumShopState(server, 'sales')
  let now = Date.now()
  let expired = []
  for (let key of sales.getAllKeys()) {
    let until = sales.getCompound(key).getLong('until')
    if (until > 0 && until <= now) expired.push(String(key))
  }
  for (let i = 0; i < expired.length; i++) {
    sales.remove(expired[i])
    console.info('[Consortium] sale of ' + expired[i] + ' expired')
  }
  return expired.length
}

// ---- vacancy (SHOP 5.5) ----------------------------------------------------------------------------------

function consortiumVacancyStage(c) {
  return 'consortium:vacancy_' + c
}

function consortiumVacancyTag(server, c) {
  return consortiumSub(consortiumShopState(server, 'vacancy'), c)
}

function consortiumActivityTag(server, c) {
  return consortiumSub(consortiumShopState(server, 'activity'), c)
}

function consortiumStampActivity(server, c, when) {
  consortiumActivityTag(server, c).putLong('lastDeliveryAt', when)
}

// Daily duties: the vacancy rule for every charter whose licence phase is open, then the tx prune.
function consortiumShopDaily(server, day) {
  let n = Consortium.phase(server)
  let now = Date.now()
  let phaseStart = Consortium.phaseTag(server, n).getLong('startedAt')
  let idleMs = CONSORTIUM_VACANCY_IDLE_DAYS * CONSORTIUM_DAY_MS
  let openMs = (CONSORTIUM_VACANCY_IDLE_DAYS + CONSORTIUM_VACANCY_NOTICE_DAYS) * CONSORTIUM_DAY_MS
  for (let i = 0; i < CONSORTIUM_CHARTER_IDS.length; i++) {
    let c = CONSORTIUM_CHARTER_IDS[i]
    if (CONSORTIUM_CHARTERS[c].licencePhase > n) continue
    let label = consortiumCharterLabel(c)
    let last = Math.max(consortiumActivityTag(server, c).getLong('lastDeliveryAt'), phaseStart)
    let idle = now - last
    let v = consortiumVacancyTag(server, c)
    let stage = consortiumVacancyStage(c)
    if (idle >= idleMs && v.getLong('inactiveSince') === 0) {
      v.putLong('inactiveSince', last + idleMs)
      consortiumBroadcast(server, 'The ' + label + ' charter has been idle for ' + CONSORTIUM_VACANCY_IDLE_DAYS + ' days. The Board opens its licence for sale in ' + CONSORTIUM_VACANCY_NOTICE_DAYS + ' days unless a holder delivers.')
    }
    if (idle >= openMs && v.getLong('openSince') === 0) {
      v.putLong('openSince', now)
      Consortium.sales.open(server, stage, 0, 'vacancy')
      consortiumBroadcast(server, 'Vacancy: the Board sells the ' + label + ' licence at HQ for ' + consortiumFmt(CONSORTIUM_LICENCE_PRICES[c]) + ' CC to any team owner with a charter.')
    }
    if (idle < idleMs && (v.getLong('inactiveSince') !== 0 || v.getLong('openSince') !== 0)) {
      v.putLong('inactiveSince', 0)
      v.putLong('openSince', 0)
      Consortium.sales.close(server, stage)
      consortiumBroadcast(server, 'The ' + label + ' charter is active again; the Board withdraws its licence.')
    }
  }
  let pruned = consortiumTxPrune(server)
  if (pruned > 0) console.info('[Consortium] pruned ' + pruned + ' shop transaction id(s) older than ' + CONSORTIUM_TX_KEEP_DAYS + ' days')
}

// Harness lever (op 4): backdate the activity and the phase so the next daily step opens the sale in one
// pass; `clear` stamps a delivery now so the "active again" branch runs.
function consortiumDebugVacancy(server, c, clear) {
  if (clear) {
    consortiumStampActivity(server, c, Date.now())
    return 'Activity of the ' + consortiumCharterLabel(c) + ' charter stamped now; run /consortium debug daily to see the withdrawal.'
  }
  let n = Consortium.phase(server)
  let tag = Consortium.phaseTag(server, n)
  let back = Date.now() - 15 * CONSORTIUM_DAY_MS
  consortiumStampActivity(server, c, back)
  if (tag.getLong('startedAt') > back) tag.putLong('startedAt', back)
  let v = consortiumVacancyTag(server, c)
  v.putLong('inactiveSince', 0)
  v.putLong('openSince', 0)
  return 'The ' + consortiumCharterLabel(c) + ' charter is now idle for 15 days (phase ' + n + ' backdated); run /consortium debug daily to see the notice and the sale.'
}

// ---- the Consortium object: shop APIs -------------------------------------------------------------------

Consortium.sales = {
  // Opens a sale stage for every team (untilMs 0 = until closed); reconciles at once.
  open: (server, stageId, untilMs, by) => {
    let sales = consortiumShopState(server, 'sales')
    let rec = NBT.compoundTag()
    rec.putLong('until', untilMs > 0 ? untilMs : 0)
    rec.putString('by', by ? String(by) : 'staff')
    sales.put(stageId, rec)
    console.info('[Consortium] sale opened: ' + stageId + (untilMs > 0 ? ' until ' + new Date(untilMs).toISOString() : ' until closed'))
    return Consortium.resync(server)
  },
  close: (server, stageId) => {
    let sales = consortiumShopState(server, 'sales')
    if (!sales.contains(stageId)) return 0
    sales.remove(stageId)
    console.info('[Consortium] sale closed: ' + stageId)
    return Consortium.resync(server)
  },
  isOpen: (server, stageId) => consortiumOpenSaleStages(server).indexOf(stageId) >= 0,
  list: (server) => {
    let sales = consortiumShopState(server, 'sales')
    let out = []
    for (let key of sales.getAllKeys()) {
      let rec = sales.getCompound(key)
      out.push({ stage: String(key), until: rec.getLong('until'), by: String(rec.getString('by')) })
    }
    return out
  },
}

Consortium.licences = {
  held: (server, uuid) => consortiumLicencesOf(server, uuid),

  // Grants licence_<charter> to the player's team through the record consortium_charters.js reads. `by` is
  // 'shop' (sets the quest flag licence:purchased) or 'staff:<name>'. Idempotent on a non-empty tx.
  grant: (server, uuid, name, charter, tx, by) => {
    if (!CONSORTIUM_CHARTERS[charter]) return { ok: false, reason: 'Unknown charter ' + charter + '.' }
    if (consortiumTxSeen(server, tx, 'licence:' + charter + ':' + uuid)) return { ok: true, already: true, changes: 0 }
    let records = consortiumSub(consortiumLicenceRecords(server), uuid)
    let fresh = !records.contains(charter)
    let rec = NBT.compoundTag()
    rec.putLong('grantedAt', Date.now())
    rec.putString('tx', tx ? String(tx) : '')
    rec.putString('by', by ? String(by) : 'staff')
    records.put(charter, rec)
    // The vacancy closes: the licence is in use again, and the grant counts as activity so the sale does
    // not reopen the next morning.
    let v = consortiumVacancyTag(server, charter)
    v.putLong('inactiveSince', 0)
    v.putLong('openSince', 0)
    consortiumStampActivity(server, charter, Date.now())
    let changes = Consortium.sales.close(server, consortiumVacancyStage(charter))
    changes += consortiumApplyPlayerId(server, uuid)
    console.info('[Consortium] licence ' + charter + ' granted to ' + name + ' (' + uuid + ') by ' + (by || 'staff') + (tx ? ', tx ' + tx : ''))
    if (fresh) {
      consortiumSay(server, name + ' holds the ' + consortiumCharterLabel(charter) + ' licence from today, granted by the Board.')
      consortiumDiscord(server, name + ' holds the ' + consortiumCharterLabel(charter) + ' licence from today.')
    }
    if (by === 'shop') consortiumQuestFlag(uuid, 'licence:purchased')
    return { ok: true, already: false, changes: changes }
  },

  // Removes the record; the stage is stripped by the next reconciliation (immediately here).
  revoke: (server, uuid, name, charter) => {
    let all = consortiumLicenceRecords(server)
    if (!all.contains(uuid) || !all.getCompound(uuid).contains(charter)) return false
    all.getCompound(uuid).remove(charter)
    console.info('[Consortium] licence ' + charter + ' revoked from ' + name + ' (' + uuid + ')')
    consortiumApplyPlayerId(server, uuid)
    return true
  },
}

Consortium.season = {
  status: (server) => {
    let season = consortiumShopState(server, 'season')
    let contributors = consortiumSub(season, 'contributors')
    let list = []
    for (let key of contributors.getAllKeys()) {
      let c = contributors.getCompound(key)
      list.push({ uuid: String(key), name: String(c.getString('name')), cents: c.getLong('cents'), tier: c.getInt('tier') })
    }
    list.sort((a, b) => b.cents - a.cents)
    let target = season.getLong('target')
    return { fund: season.getLong('fund'), target: target > 0 ? target : CONSORTIUM_SEASON_TARGET_CENTS, milestone: season.getInt('milestone'), contributors: list }
  },

  setTarget: (server, cents) => {
    let season = consortiumShopState(server, 'season')
    season.putLong('target', cents)
    consortiumSay(server, 'The Board set the season fund target to ' + ConsortiumCore.format(cents) + '.')
    consortiumPublishBoard(server, true)
  },

  // A contribution the shop already debited (or a staff grant): fund, contributor, milestones, the
  // Benefactor title, the plaque tiers, then the board. Idempotent on a non-empty tx.
  contribute: (server, uuid, name, cents, tx) => {
    if (cents <= 0) return { ok: false, reason: 'A contribution must be positive.' }
    if (consortiumTxSeen(server, tx, 'season:' + uuid + ':' + cents)) return { ok: true, already: true }
    let season = consortiumShopState(server, 'season')
    if (season.getLong('target') <= 0) season.putLong('target', CONSORTIUM_SEASON_TARGET_CENTS)
    let target = season.getLong('target')
    let fund = season.getLong('fund') + cents
    season.putLong('fund', fund)
    let contributors = consortiumSub(season, 'contributors')
    let c = consortiumSub(contributors, uuid)
    let mine = c.getLong('cents') + cents
    c.putLong('cents', mine)
    c.putString('name', name)
    console.info('[Consortium] season fund: ' + name + ' contributed ' + ConsortiumCore.format(cents) + ' (' + ConsortiumCore.format(mine) + ' in total), fund ' + ConsortiumCore.format(fund) + ' of ' + ConsortiumCore.format(target) + (tx ? ', tx ' + tx : ''))
    // Milestones at 25, 50, 75 and 100 % of the target, announced once each.
    let pct = Math.floor(fund * 100 / target)
    let milestone = season.getInt('milestone')
    for (let i = 0; i < CONSORTIUM_SEASON_MILESTONES.length; i++) {
      let m = CONSORTIUM_SEASON_MILESTONES[i]
      if (pct >= m && milestone < m) {
        milestone = m
        season.putInt('milestone', m)
        let text = m >= 100 ? 'The season fund reached its target of ' + ConsortiumCore.format(target) + '. The season project is funded.'
          : 'The season fund is at ' + m + ' % of its target (' + ConsortiumCore.format(fund) + ' of ' + ConsortiumCore.format(target) + ').'
        consortiumSay(server, text)
        consortiumDiscord(server, text)
        consortiumFireworks(server)
      }
    }
    // Benefactor title at 500 CC contributed (the one contribution title, shared with the quests).
    if (mine >= CONSORTIUM_BENEFACTOR_CENTS && !Consortium.titles.held(server, uuid).benefactor) {
      Consortium.titles.grant(server, uuid, name, 'benefactor', null, 'season:benefactor:' + uuid)
    }
    // Plaque tiers (a build at HQ, staff engrave the name): announced when crossed.
    let tier = c.getInt('tier')
    for (let i = 0; i < CONSORTIUM_PLAQUE_TIERS.length; i++) {
      let t = CONSORTIUM_PLAQUE_TIERS[i]
      if (mine >= t.cents && tier < t.tier) {
        tier = t.tier
        c.putInt('tier', tier)
        let text = name + ' reaches the ' + t.label + ' plaque of the season fund (' + ConsortiumCore.format(t.cents) + ' contributed).'
        consortiumSay(server, text)
        consortiumDiscord(server, text)
      }
    }
    consortiumPublishBoard(server, false)
    return { ok: true, already: false, fund: fund, target: target, mine: mine }
  },
}

Consortium.tickets = {
  count: (server, uuid) => consortiumSub(consortiumShopState(server, 'events'), 'tickets').getInt(uuid),

  // Adds n tickets; idempotent on a non-empty tx. Returns the new count, or -1 when the tx was seen.
  grant: (server, uuid, n, tx) => {
    if (n <= 0) return Consortium.tickets.count(server, uuid)
    if (consortiumTxSeen(server, tx, 'ticket:' + uuid + ':' + n)) return -1
    let tickets = consortiumSub(consortiumShopState(server, 'events'), 'tickets')
    let after = tickets.getInt(uuid) + n
    tickets.putInt(uuid, after)
    console.info('[Consortium] ' + n + ' event ticket(s) granted to ' + uuid + ' (' + after + ' unused)' + (tx ? ', tx ' + tx : ''))
    return after
  },

  // Takes n tickets if the player holds them (true), else nothing happens (false). The events engine's path.
  consume: (server, uuid, n) => {
    let tickets = consortiumSub(consortiumShopState(server, 'events'), 'tickets')
    let have = tickets.getInt(uuid)
    if (n <= 0 || have < n) return false
    tickets.putInt(uuid, have - n)
    console.info('[Consortium] ' + n + ' event ticket(s) consumed from ' + uuid + ' (' + (have - n) + ' left)')
    return true
  },

  // Staff refund or manual consume: removes up to n, floor 0. Returns the new count.
  take: (server, uuid, n) => {
    let tickets = consortiumSub(consortiumShopState(server, 'events'), 'tickets')
    let after = Math.max(0, tickets.getInt(uuid) - Math.max(0, n))
    tickets.putInt(uuid, after)
    console.info('[Consortium] event tickets of ' + uuid + ' set to ' + after + ' (took ' + n + ')')
    return after
  },
}

// ---- titles (SHOP 5.11) -----------------------------------------------------------------------------------

function consortiumTitlesTag(server, uuid) {
  return consortiumSub(consortiumShopState(server, 'titles'), uuid)
}

// Re-issues the LuckPerms suffix of the active title (absolute set: remove the priority, set it again).
function consortiumTitleApply(server, uuid, name) {
  let tag = consortiumTitlesTag(server, uuid)
  let active = String(tag.getString('active'))
  let held = consortiumSub(tag, 'held')
  consortiumLp(server, 'user ' + uuid + ' meta removesuffix ' + CONSORTIUM_TITLE_PRIORITY)
  if (active && held.contains(active)) {
    consortiumLp(server, 'user ' + uuid + ' meta setsuffix ' + CONSORTIUM_TITLE_PRIORITY + ' " &7' + String(held.getString(active)) + '"')
  }
}

Consortium.titles = {
  held: (server, uuid) => {
    let held = consortiumSub(consortiumTitlesTag(server, uuid), 'held')
    let out = {}
    for (let key of held.getAllKeys()) out[String(key)] = String(held.getString(key))
    return out
  },
  active: (server, uuid) => String(consortiumTitlesTag(server, uuid).getString('active')),

  // Grants a title and makes it the active one. `text` may be omitted for the CONSORTIUM_TITLES keys.
  // Idempotent on a non-empty tx, keyed per player (tx + ':' + uuid: one tx string shared by several players,
  // such as a team quest reward, still grants each of them once); a title already held is only re-activated.
  grant: (server, uuid, name, key, text, tx) => {
    let label = text ? String(text) : CONSORTIUM_TITLES[key]
    if (!label) return { ok: false, reason: 'Unknown title ' + key + ' and no text given.' }
    if (!/^[a-z0-9_]{1,32}$/.test(String(key))) return { ok: false, reason: 'A title key is [a-z0-9_]{1,32}.' }
    if (consortiumTxSeen(server, tx ? String(tx) + ':' + uuid : '', 'title:' + key + ':' + uuid)) return { ok: true, already: true }
    let tag = consortiumTitlesTag(server, uuid)
    let held = consortiumSub(tag, 'held')
    let fresh = !held.contains(key)
    held.putString(key, label)
    tag.putString('active', key)
    consortiumTitleApply(server, uuid, name)
    console.info('[Consortium] title ' + key + ' (' + label + ') ' + (fresh ? 'granted to ' : 're-activated for ') + name + ' (' + uuid + ')' + (tx ? ', tx ' + tx : ''))
    consortiumTellPlayer(server, uuid, 'Title ' + label + ' is now yours' + (fresh ? '' : ' again') + '. Switch with /consortium title <key>.', 'green')
    return { ok: true, already: false, fresh: fresh }
  },

  // Activates a held title, or 'none' to hide the suffix.
  activate: (server, uuid, name, key) => {
    let tag = consortiumTitlesTag(server, uuid)
    if (key === 'none') {
      tag.putString('active', '')
      consortiumTitleApply(server, uuid, name)
      return { ok: true }
    }
    if (!consortiumSub(tag, 'held').contains(key)) return { ok: false, reason: 'You do not hold the title ' + key + '.' }
    tag.putString('active', key)
    consortiumTitleApply(server, uuid, name)
    return { ok: true }
  },

  revoke: (server, uuid, name, key) => {
    let tag = consortiumTitlesTag(server, uuid)
    let held = consortiumSub(tag, 'held')
    if (!held.contains(key)) return false
    held.remove(key)
    if (String(tag.getString('active')) === key) tag.putString('active', '')
    consortiumTitleApply(server, uuid, name)
    console.info('[Consortium] title ' + key + ' revoked from ' + name + ' (' + uuid + ')')
    return true
  },

  // Login: the suffix of the active title is re-issued (cheap, self-healing).
  resync: (server, uuid, name) => {
    let titles = consortiumShopState(server, 'titles')
    if (!titles.contains(uuid)) return false
    consortiumTitleApply(server, uuid, name)
    return true
  },
}

// ---- perks (SHOP 5.10) -----------------------------------------------------------------------------------

function consortiumPerksTag(server, uuid) {
  return consortiumSub(consortiumShopState(server, 'perks'), uuid)
}

function consortiumHomeSlots(server, uuid) {
  let tag = consortiumPerksTag(server, uuid)
  let n = 0
  for (let perk in CONSORTIUM_PERKS) {
    if (CONSORTIUM_PERKS[perk].home && tag.contains(perk)) n++
  }
  return n
}

// Re-issues every LuckPerms value the held perks imply (absolute sets), the homes as one meta value.
function consortiumPerksApply(server, uuid, name) {
  let tag = consortiumPerksTag(server, uuid)
  consortiumLp(server, 'user ' + uuid + ' meta set ftbessentials.home.max ' + consortiumHomeSlots(server, uuid))
  for (let perk in CONSORTIUM_PERKS) {
    let def = CONSORTIUM_PERKS[perk]
    if (!def.node) continue
    consortiumLp(server, 'user ' + uuid + ' permission ' + (tag.contains(perk) ? 'set ' + def.node + ' true' : 'unset ' + def.node))
  }
}

Consortium.perks = {
  held: (server, uuid) => {
    let tag = consortiumPerksTag(server, uuid)
    let out = []
    for (let perk in CONSORTIUM_PERKS) {
      if (tag.contains(perk)) out.push(perk)
    }
    return out
  },

  // Refusal string when the perk cannot be bought (pre-check), else null.
  check: (server, uuid, perk) => {
    let def = CONSORTIUM_PERKS[perk]
    if (!def) return 'Unknown perk ' + perk + '.'
    let tag = consortiumPerksTag(server, uuid)
    if (tag.contains(perk)) return 'You already hold that perk.'
    if (def.requires && !tag.contains(def.requires)) return 'Buy ' + CONSORTIUM_PERKS[def.requires].label.toLowerCase() + ' before ' + def.label.toLowerCase().replace('home slot', 'slot') + '.'
    return null
  },

  // Records the perk and runs the LuckPerms line(s). Idempotent on a non-empty tx; never refuses after
  // the pre-check (a perk already held is re-applied, a missing prerequisite is reported to the ops).
  grant: (server, uuid, name, perk, tx) => {
    let def = CONSORTIUM_PERKS[perk]
    if (!def) return { ok: false, reason: 'Unknown perk ' + perk + ' (home_slot_1, home_slot_2, home_slot_3, warp_pass, nickname).' }
    if (consortiumTxSeen(server, tx, 'perk:' + perk + ':' + uuid)) return { ok: true, already: true }
    let tag = consortiumPerksTag(server, uuid)
    let fresh = !tag.contains(perk)
    if (def.requires && !tag.contains(def.requires)) consortiumAlertOps(server, 'perk ' + perk + ' granted to ' + name + ' without ' + def.requires + ' (the pre-check should have refused it); check the ledger and /consortium perk list ' + name)
    let rec = NBT.compoundTag()
    rec.putLong('grantedAt', Date.now())
    rec.putString('tx', tx ? String(tx) : '')
    tag.put(perk, rec)
    consortiumPerksApply(server, uuid, name)
    console.info('[Consortium] perk ' + perk + (fresh ? ' granted to ' : ' re-applied for ') + name + ' (' + uuid + ')' + (tx ? ', tx ' + tx : ''))
    consortiumTellPlayer(server, uuid, def.label + ' is active' + (def.home ? ': /sethome and /home' : perk === 'warp_pass' ? ': /warp hq' : perk === 'nickname' ? ': /nickname <name>' : '') + '.', 'green')
    return { ok: true, already: false, fresh: fresh }
  },

  revoke: (server, uuid, name, perk) => {
    let tag = consortiumPerksTag(server, uuid)
    if (!tag.contains(perk)) return false
    tag.remove(perk)
    consortiumPerksApply(server, uuid, name)
    console.info('[Consortium] perk ' + perk + ' revoked from ' + name + ' (' + uuid + ')')
    return true
  },

  // Login and staff lever: re-issues every held perk. Returns the number of held perks.
  resync: (server, uuid, name) => {
    let perks = consortiumShopState(server, 'perks')
    if (!perks.contains(uuid)) return 0
    consortiumPerksApply(server, uuid, name)
    return Consortium.perks.held(server, uuid).length
  },
}

// ---- Gap Contract (SHOP 5.8, PROGRESSION 11) --------------------------------------------------------------

function consortiumGapTag(server, n) {
  let tag = consortiumSub(consortiumShopState(server, 'gap'), String(n))
  let day = Consortium.seasonDay(server)
  if (tag.getInt('day') !== day) {
    tag.putInt('day', day)
    tag.put('today', NBT.compoundTag())
  }
  return tag
}

// Open while the current phase is flagged stalled and not complete.
function consortiumGapOpen(server) {
  let n = Consortium.phase(server)
  let tag = Consortium.phaseTag(server, n)
  return tag.getBoolean('stalled') && tag.getLong('completedAt') === 0
}

function consortiumGapPack(line) {
  return line.amount >= CONSORTIUM_GAP_PACK_MIN_QUOTA ? 10 : 1
}

// Unit price in cents: max(1 CC, 2 x the family base of the item), read from PriceView.baseCents (the
// current datapack base, never the degressive unit price). A quota-only family (base 0) pays the floor.
// Answers -1 (refuse) when the item has no price family, the family has no PriceView or the lookup throws:
// the floor only ever stands on a real base, never in place of a missing one (an expensive family whose
// lookup failed would otherwise sell at 1.00 CC per unit).
function consortiumGapUnitCents(itemId) {
  try {
    // Item.exists / Item.getItem, not Item.of: KubeJS's Item.of throws an error a JS catch cannot hold on an unknown id.
    if (!Item.exists(itemId)) return -1
    let fam = ConsortiumCore.familyOf(Item.getItem(itemId))
    if (!fam.isPresent()) return -1
    let view = ConsortiumCore.price(fam.get())
    if (!view.isPresent()) return -1
    return Math.max(CONSORTIUM_GAP_MIN_UNIT_CENTS, 2 * Number(view.get().baseCents()))
  } catch (err) {
    console.error('[Consortium] gap unit price of ' + itemId + ' failed: ' + err)
    return -1
  }
}

function consortiumGapUnpriced(itemId) {
  return 'The Board cannot price ' + itemId + ' right now, try again later.'
}

function consortiumGapFirstItem(line) {
  if (line.items && line.items.length) return line.items[0]
  return line.id
}

Consortium.gap = {
  isOpen: (server) => consortiumGapOpen(server),

  // Status lines for /consortium gap: open or closed, and per line the unit price, the pack size and the
  // units left today, over the phase and for the caller (uuid may be null).
  status: (server, uuid) => {
    let n = Consortium.phase(server)
    let out = []
    if (!consortiumGapOpen(server)) {
      out.push({ text: 'The Gap Contract is closed: the Board only sources deliveries while a phase has stalled for ' + CONSORTIUM_STALL_DAYS + ' days.', color: 'gray' })
      return out
    }
    let tag = consortiumGapTag(server, n)
    let today = consortiumSub(tag, 'today')
    let total = consortiumSub(tag, 'total')
    let mine = uuid ? consortiumSub(consortiumSub(tag, 'buyers'), uuid) : null
    out.push({ text: 'Gap Contract open on Phase ' + n + ': the Board sources missing deliveries at twice the base price (/consortium gap buy <item> <units>). Units count for the quota under your name and for ranks at 50 %.', color: 'gold' })
    let def = Consortium.def(n)
    for (let i = 0; i < def.quota.length; i++) {
      let line = def.quota[i]
      let key = consortiumLineKey(line)
      let itemId = consortiumGapFirstItem(line)
      let unit = consortiumGapUnitCents(itemId)
      let leftToday = Math.max(0, Math.floor(line.amount * CONSORTIUM_GAP_DAILY_SHARE) - today.getLong(key))
      let leftPhase = Math.max(0, Math.floor(line.amount * CONSORTIUM_GAP_PHASE_SHARE) - total.getLong(key))
      let leftMine = mine === null ? -1 : Math.max(0, Math.floor(line.amount * CONSORTIUM_GAP_BUYER_SHARE) - mine.getLong(key))
      out.push({ text: '  ' + consortiumLabelCase(line.label) + ' (' + itemId + '): ' + (unit < 0 ? 'no price right now (the Board refuses this line)' : ConsortiumCore.format(unit) + ' per unit') + ', packs of ' + consortiumGapPack(line)
        + ', left today ' + consortiumFmt(leftToday) + ', this phase ' + consortiumFmt(leftPhase) + (leftMine >= 0 ? ', yours ' + consortiumFmt(leftMine) : '') + '.', color: 'gray' })
    }
    return out
  },

  // A purchase by an online player: every refusal before the debit, then debit, record (Board-sourced),
  // rank credit at 50 %, counters, the quest flag and the announcement. Returns { ok, reason }.
  buy: (server, player, itemId, units) => {
    let n = Consortium.phase(server)
    let uuid = String(player.uuid).toLowerCase()
    let name = String(player.username)
    if (!consortiumGapOpen(server)) return { ok: false, reason: 'The Gap Contract is closed: Phase ' + n + ' deliveries have resumed.' }
    let line = Consortium.lineFor(server, itemId)
    if (line === null) return { ok: false, reason: itemId + ' is not a Phase ' + n + ' quota line.' }
    let pack = consortiumGapPack(line)
    if (units <= 0 || units % pack !== 0) return { ok: false, reason: 'Units come in packs of ' + pack + '.' }
    let unit = consortiumGapUnitCents(itemId)
    if (unit < 0) return { ok: false, reason: consortiumGapUnpriced(itemId) } // no family, no PriceView or a failed lookup: never the floor, never a debit
    let tag = consortiumGapTag(server, n)
    let key = consortiumLineKey(line)
    let label = consortiumLabelCase(line.label)
    let today = consortiumSub(tag, 'today')
    let total = consortiumSub(tag, 'total')
    let mine = consortiumSub(consortiumSub(tag, 'buyers'), uuid)
    if (today.getLong(key) + units > Math.floor(line.amount * CONSORTIUM_GAP_DAILY_SHARE)) return { ok: false, reason: 'The Board has sourced today\'s share of ' + label + ' (10 % of the quota per day); try again after 06:00.' }
    if (total.getLong(key) + units > Math.floor(line.amount * CONSORTIUM_GAP_PHASE_SHARE)) return { ok: false, reason: 'The Board has sourced the phase limit of ' + label + ' (30 % of the quota).' }
    if (mine.getLong(key) + units > Math.floor(line.amount * CONSORTIUM_GAP_BUYER_SHARE)) return { ok: false, reason: 'You have sourced your share of ' + label + ' this phase (10 % of the quota per buyer).' }
    let cents = units * unit
    let balance = ConsortiumCore.balance(player.uuid)
    if (balance < cents) return { ok: false, reason: 'Not enough credits: ' + units + ' ' + label + ' costs ' + ConsortiumCore.format(cents) + ', you have ' + ConsortiumCore.format(balance) + '.' }
    let result = ConsortiumCore.debit(player.uuid, cents, 'gap:' + key)
    if (!result.ok()) return { ok: false, reason: 'The Board could not take the payment (' + String(result) + '); nothing was sourced.' }
    let recorded = Consortium.record(server, name, itemId, units, 'board')
    if (recorded <= 0) consortiumAlertOps(server, 'gap buy by ' + name + ' debited ' + ConsortiumCore.format(cents) + ' but recorded 0 units of ' + itemId + ' (phase complete or line gone); refund with /credits add')
    ConsortiumCore.addRankCredit(player.uuid, Math.floor(cents / 2), 'gap')
    today.putLong(key, today.getLong(key) + units)
    total.putLong(key, total.getLong(key) + units)
    mine.putLong(key, mine.getLong(key) + units)
    consortiumQuestFlag(uuid, 'contract:gap')
    console.info('[Consortium] gap: ' + name + ' sourced ' + units + ' ' + itemId + ' for ' + ConsortiumCore.format(cents) + ' (rank credit ' + ConsortiumCore.format(Math.floor(cents / 2)) + ')')
    consortiumSay(server, name + ' sourced ' + consortiumFmt(units) + ' ' + label + ' through the Board.')
    consortiumDiscord(server, name + ' sourced ' + consortiumFmt(units) + ' ' + label + ' through the Board.')
    return { ok: true, cents: cents, units: units, label: label }
  },
}

// The phase engine's stall branch: the day's counters start fresh and the notice carries the link.
Consortium.onCatchUp = (server, n) => {
  let tag = consortiumGapTag(server, n)
  tag.put('today', NBT.compoundTag())
  let link = [{ text: ' [Gap Contract]', color: 'aqua', underlined: true,
    clickEvent: { action: 'run_command', value: '/consortium gap' },
    hoverEvent: { action: 'show_text', contents: 'Click to see the lines, prices and shares' } }]
  consortiumSay(server, 'Gap Contract open on Phase ' + n + ': the Board sources missing deliveries at twice the base price, 10 % of each line per day, 30 % per phase. Sourced units count for the quota and for ranks at 50 %.', link)
}

// ---- the mod's events -----------------------------------------------------------------------------------

// Pre-checks (SHOP 5.4): catalogue key -> (server, uuid, name) => refusal string or null.
function consortiumShopCheckFor(key) {
  if (key === 'claim_chunks_10') {
    return (server, uuid, name) => {
      if (CONSORTIUM_SHOP_FTBCHUNKS_API === null) return null
      let team = consortiumTeamOfId(uuid)
      if (team === null) return null
      let max = CONSORTIUM_SHOP_FTBCHUNKS_API.api().getManager().getOrCreateData(team).getMaxClaimChunks()
      if (max + CONSORTIUM_CLAIM_PACK > CONSORTIUM_CLAIM_HARD_LIMIT) return 'Your team is at the claim limit (' + CONSORTIUM_CLAIM_HARD_LIMIT + ' chunks): the Board cannot extend it further.'
      return null
    }
  }
  if (CONSORTIUM_PERK_ENTRIES[key]) {
    let perk = CONSORTIUM_PERK_ENTRIES[key]
    return (server, uuid, name) => Consortium.perks.check(server, uuid, perk)
  }
  if (key.indexOf('licence_') === 0) {
    let c = key.slice('licence_'.length)
    if (!CONSORTIUM_CHARTERS[c]) return null
    return (server, uuid, name) => {
      let label = consortiumCharterLabel(c)
      if (!Consortium.sales.isOpen(server, consortiumVacancyStage(c))) return 'The Board is not selling the ' + label + ' licence right now.'
      let team = consortiumTeamOfId(uuid)
      if (team !== null && consortiumTeamOwner(team) !== uuid) return 'Only the owner of your team can buy a licence (a party\'s licence follows its owner).'
      let own = consortiumCharterOf(server, uuid)
      if (own === null) return 'Choose a charter first: a licence adds to a charter, it does not replace one.'
      if (own === c || consortiumLicencesOf(server, uuid).indexOf(c) >= 0 || (team !== null && (consortiumIsStaffTeam(server, team) || consortiumTeamHasStage(team, CONSORTIUM_STAGE_LICENCE_PREFIX + c)))) return 'Your team already holds the ' + label + ' licence.'
      return null
    }
  }
  if (key.indexOf('title_') === 0) {
    let t = key.slice('title_'.length)
    return (server, uuid, name) => Consortium.titles.held(server, uuid)[t] ? 'You already hold that title: /consortium title ' + t + ' puts it on.' : null
  }
  return null // tickets, season packs, items: never refused here
}

if (typeof ConsortiumCore !== 'undefined') {
  // The veto point: posted before the debit with counterpart shop:<key> and reason <key>.
  NativeEvents.onEvent('org.consortium.core.api.event.BalanceChangeEvent', (e) => {
    try {
      let counterpart = String(e.counterpart)
      if (counterpart.indexOf('shop:') !== 0 || consortiumShopServer === null) return
      let key = counterpart.slice('shop:'.length)
      let check = consortiumShopCheckFor(key)
      if (check === null) return
      let uuid = String(e.player).toLowerCase()
      let reason = check(consortiumShopServer, uuid, String(e.name))
      if (reason === null) return
      consortiumTellPlayer(consortiumShopServer, uuid, reason, 'red')
      console.info('[Consortium] shop purchase ' + key + ' by ' + e.name + ' refused before the debit: ' + reason)
      e.setCanceled(true)
    } catch (err) {
      console.error('[Consortium] shop pre-check failed (the purchase is vetoed): ' + err)
      e.setCanceled(true)
    }
  })

  // After the commit: the quest flags by key prefix (SHOP 5.12).
  NativeEvents.onEvent('org.consortium.core.api.event.ShopPurchaseEvent', (e) => {
    try {
      let uuid = String(e.player.uuid).toLowerCase()
      let key = String(e.key)
      consortiumQuestFlag(uuid, 'shop:any')
      if (key.indexOf('chunk_loader_') === 0) consortiumQuestFlag(uuid, 'shop:chunk_loader')
      else if (key.indexOf('claim_chunks') === 0) consortiumQuestFlag(uuid, 'shop:claim_chunks')
      else if (key.indexOf('waystone_') === 0) consortiumQuestFlag(uuid, 'shop:waystone')
      else if (key.indexOf('season_') === 0) consortiumQuestFlag(uuid, 'shop:season_contribution')
      else if (key.indexOf('ticket_') === 0) consortiumQuestFlag(uuid, 'shop:ticket')
    } catch (err) {
      console.error('[Consortium] shop purchase follow-up failed: ' + err)
    }
  })

  // After each terminal delivery: the activity stamp of the vacancy rule (non-staff players only), for the
  // effective charter and for every licence the team owner holds.
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      if (consortiumIsStaff(server, uuid)) return
      let team = consortiumTeamOf(player)
      if (team !== null && consortiumIsStaffTeam(server, team)) return
      let owner = team !== null ? consortiumTeamOwner(team) : uuid
      let now = Date.now()
      let charter = consortiumCharterOf(server, owner)
      if (charter !== null) {
        consortiumStampActivity(server, charter, now)
        let records = consortiumCharterRecords(server)
        if (records.contains(owner)) records.getCompound(owner).putLong('lastDeliveryAt', now)
      }
      let bought = consortiumLicencesOf(server, owner)
      for (let i = 0; i < bought.length; i++) consortiumStampActivity(server, bought[i], now)
    } catch (err) {
      console.error('[Consortium] delivery activity stamp failed: ' + err)
    }
  })
  console.info('[Consortium] shop engine registered (pre-checks, quest flags, activity stamp)')
} else {
  console.info('[Consortium] Consortium Core absent: shop pre-checks off')
}

ServerEvents.loaded((event) => {
  consortiumShopServer = event.server
})

// Login: the held perks and the active title are re-issued once FTB Teams and LuckPerms have the player.
PlayerEvents.loggedIn((event) => {
  let player = event.player
  let server = player.server
  let uuid = String(player.uuid).toLowerCase()
  let name = String(player.username)
  server.scheduleInTicks(60, () => {
    try {
      let perks = Consortium.perks.resync(server, uuid, name)
      let title = Consortium.titles.resync(server, uuid, name)
      if (perks > 0 || title) console.info('[Consortium] perks resynced for ' + name + ' (' + perks + ' perk(s)' + (title ? ', title' : '') + ')')
    } catch (err) {
      console.error('[Consortium] perk resync for ' + name + ' failed: ' + err)
    }
  })
})
