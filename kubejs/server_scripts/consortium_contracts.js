// priority: 30
// The Consortium - daily contracts (docs/RANKS_AND_CONTRACTS.md 2, docs/BATCH_3_INTERFACES.md 4; PROJECT_RULES 4.1,
// 4.2, 4.3; PRODUCTION_CHECKLIST Phase 4 "Contracts: Daily"). Needs consortium_lib.js, consortium_charters.js
// (consortiumSub), consortium_phases.js (Consortium, consortiumState, consortiumLineIcon, consortiumPublishBoard) loaded
// before this file; consortium_ranks.js (CONSORTIUM_RANK_THRESHOLDS, consortiumCcFmt, consortiumCoreHas) loads after
// it (same priority, alphabetical order) and is read at call time only. Inert without the Consortium Core binding.
//
// Three contracts a day, picked once per season day (06:00 server time, Consortium.seasonDay) among the open quota
// lines of the current phase (ratio < 1, priced, not quota-only, not a family of the day before), weighted by the
// shortfall 1 - ratio. A contract on family i pays a FLAT premium per paid unit, premium_i = round(0.25 x baseCents_i)
// (the datapack base, never the degressive unit price), on the first N_i = min(half_volume_i, floor(pot / premium_i))
// paid units server-wide (N floored to a multiple of 8 from 32 up), first come first served, Operator rank and above
// (rank_credit >= CONSORTIUM_RANK_THRESHOLDS.operator, read at quote time). Bound: a contract pays at most N x premium
// <= pot whatever the saturation, charter, newcomer or event factor, three contracts at most 3 x pot a day, under 10 %
// of the design daily income in both readings of RANKS 2.2 (pots 35 / 75 / 55 / 70 / 70 CC, PLACEHOLDER [S]).
//
// Quote and consumption (RANKS 2.3): consortium_money.js adds the premium as an ADDITIVE term to its single
// setMultiplier call (m += bonus / cents, bonus = floor(min(room, paidUnits) x premium), read-only: the quote event
// fires on every grid change) through the typeof-guarded consortiumContractBonus -> Consortium.contracts.quoteBonus,
// which stashes { bonus, units } per "uuid|family". The DeliveryEvent listener below (post-commit, not cancellable)
// consumes the stashed units only when a bonus was priced (the stash rule: a delivery that crosses the Operator
// threshold at commit consumed nothing because nobody was paid for it), closes a filled contract with the
// "Contract filled" line and republishes the board. The premium travels inside the delivery receipt (its multiplier),
// counts toward rank_credit like a charter bonus, and is invisible to the mod's weekly report by type: paidCents,
// seasonCents and history keep the engine's own balancing journal.
//
// State (server.persistentData consortium.contracts, saved with the world): day (season day of the list), reason
// ('' | 'rest' | 'target' | 'cleared'), previous [family keys of the list before], list [{ family, line, label, icon,
// premiumCents, units, filled, paidCents, closedAt, closedBy, setBy }], seasonCents (long, every premium paid this
// season), history.<season day> { count, filled, paidCents } (closed lists, pruned after 30 days).
// Inspect with: /kubejs persistent-data server get consortium
//
// Every number marked PLACEHOLDER is re-derived from the beta-week ledger (PRICE_TABLE 8). No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

// Pot per contract in CC, PLACEHOLDER [S] (RANKS 2.2: 10 % of the smaller design daily income reading over three
// contracts, rounded down to 5 CC).
const CONSORTIUM_CONTRACT_POT = { 1: 35, 2: 75, 3: 55, 4: 70, 5: 70 }
const CONSORTIUM_CONTRACT_PREMIUM = 0.25       // PLACEHOLDER: share of the datapack base paid per paid unit
const CONSORTIUM_CONTRACTS_PER_DAY = 3
const CONSORTIUM_CONTRACT_TEXT_MAX = 140       // the contracts string (board payload, {contracts} token, digest)
const CONSORTIUM_CONTRACT_ROUND_FROM = 32      // N is floored to a multiple of ROUND_TO from this size up
const CONSORTIUM_CONTRACT_ROUND_TO = 8
const CONSORTIUM_CONTRACT_HISTORY_DAYS = 30
const CONSORTIUM_CONTRACT_OPERATOR_FALLBACK = 25000 // cents, only if consortium_ranks.js is missing
const CONSORTIUM_CONTRACT_BOARD_ICON_FALLBACK = 'minecraft:paper'

// The bonus quoteBonus last priced per "uuid|family" (transient: the DeliveryEvent listener consumes it).
let consortiumContractLastBonus = {}
let consortiumContractServer = null // the running server, for the mod events that carry no player (ReportEvent)

// ---- state -----------------------------------------------------------------------------------------------

function consortiumContractsTag(server) {
  let tag = consortiumSub(consortiumState(server), 'contracts')
  if (!tag.contains('list')) tag.put('list', NBT.listTag())
  if (!tag.contains('previous')) tag.put('previous', NBT.listTag())
  if (!tag.contains('history')) tag.put('history', NBT.compoundTag())
  return tag
}

function consortiumContractOperatorCents() {
  return typeof CONSORTIUM_RANK_THRESHOLDS !== 'undefined' ? CONSORTIUM_RANK_THRESHOLDS.operator : CONSORTIUM_CONTRACT_OPERATOR_FALLBACK
}

function consortiumContractFmt(cents) {
  if (typeof consortiumCcFmt === 'function') return consortiumCcFmt(cents)
  return (Number(cents) / 100).toFixed(2) + ' CC'
}

function consortiumContractReady() {
  if (typeof ConsortiumCore === 'undefined') return false
  try { return ConsortiumCore.ready() } catch (err) { return false }
}

// The NBT list of today's contracts after the lazy day check: a stored day that differs from the season day triggers
// the pick (the consortiumGapTag pattern), so a 06:00:30 quote already sees the new contracts while the summary line
// follows from the daily step within 5 minutes. Idempotent on the day.
function consortiumContractList(server) {
  let tag = consortiumContractsTag(server)
  let day = Consortium.seasonDay(server)
  if (tag.getInt('day') !== day) consortiumContractPick(server, day, 'day')
  return tag.getList('list', 10)
}

// JS view of one list entry.
function consortiumContractEntry(list, i) {
  let c = list.getCompound(i)
  return { index: i, family: String(c.getString('family')), line: String(c.getString('line')), label: String(c.getString('label')),
    icon: String(c.getString('icon')), premiumCents: c.getInt('premiumCents'), units: c.getInt('units'), filled: c.getDouble('filled'),
    paidCents: c.getLong('paidCents'), closedAt: c.getLong('closedAt'), closedBy: String(c.getString('closedBy')), setBy: String(c.getString('setBy')) }
}

function consortiumContractEntries(server) {
  let list = consortiumContractList(server)
  let out = []
  for (let i = 0; i < list.size(); i++) out.push(consortiumContractEntry(list, i))
  return out
}

// The open contract (not closed) on a price family, as { entry, compound }, or null.
function consortiumContractOpenOn(server, family) {
  let list = consortiumContractList(server)
  for (let i = 0; i < list.size(); i++) {
    let c = list.getCompound(i)
    if (String(c.getString('family')) === String(family) && c.getLong('closedAt') === 0) return { entry: consortiumContractEntry(list, i), compound: c }
  }
  return null
}

// ---- sizing (RANKS 2.2) ----------------------------------------------------------------------------------------

// The price family fed by a quota line (its first priced member), or null. Computed on demand (a few calls per day),
// never cached: the price index answers empty before the mod's runtime is ready.
function consortiumContractFamilyOfLine(line) {
  let ids = line.items && line.items.length ? line.items : [line.id]
  for (let i = 0; i < ids.length; i++) {
    let id = String(ids[i])
    if (id.charAt(0) === '#') continue
    try {
      if (!Item.exists(id)) continue
      let fam = ConsortiumCore.familyOf(Item.getItem(id))
      if (fam.isPresent()) return String(fam.get())
    } catch (err) { /* unknown or unpriced id */ }
  }
  return null
}

// The PriceView of a family key, or null.
function consortiumContractView(family) {
  try {
    let pv = ConsortiumCore.price(String(family))
    return pv.isPresent() ? pv.get() : null
  } catch (err) { return null }
}

function consortiumContractPremiumOf(view) {
  return Math.round(CONSORTIUM_CONTRACT_PREMIUM * Number(view.baseCents()))
}

// N = min(half_volume, floor(pot / premium)), floored to a multiple of 8 from 32 up, at least 1.
function consortiumContractSizeOf(server, view, premiumCents) {
  let pot = CONSORTIUM_CONTRACT_POT[Consortium.phase(server)] || CONSORTIUM_CONTRACT_POT[1]
  let n = Math.min(Math.floor(Number(view.halfVolume())), Math.floor(pot * 100 / premiumCents))
  if (n >= CONSORTIUM_CONTRACT_ROUND_FROM) n -= n % CONSORTIUM_CONTRACT_ROUND_TO
  return Math.max(1, n)
}

// Candidates of the current phase: open lines (ratio < 1) whose price family exists, is not quota-only and has a
// positive premium. Each: { family, line, view, premiumCents, weight }.
function consortiumContractCandidates(server) {
  let n = Consortium.phase(server)
  let prog = Consortium.progress(server, n)
  let out = []
  for (let i = 0; i < prog.lines.length; i++) {
    let l = prog.lines[i]
    if (l.ratio >= 1) continue
    let family = consortiumContractFamilyOfLine(l.line)
    if (family === null) continue
    let view = consortiumContractView(family)
    if (view === null || view.quotaOnly()) continue
    let premium = consortiumContractPremiumOf(view)
    if (premium <= 0) continue
    out.push({ family: family, line: l.line, view: view, premiumCents: premium, weight: 1 - l.ratio })
  }
  return out
}

// Weighted draw of k candidates without replacement (Math.random).
function consortiumContractDraw(cands, k) {
  let pool = cands.slice()
  let out = []
  while (out.length < k && pool.length > 0) {
    let total = 0
    for (let i = 0; i < pool.length; i++) total += Math.max(0.001, pool[i].weight)
    let r = Math.random() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(0.001, pool[i].weight)
      if (r < 0) { idx = i; break }
    }
    out.push(pool[idx])
    pool.splice(idx, 1)
  }
  return out
}

// The board icon of a contract: the quota line's icon, else the family key when it is an item, else paper.
function consortiumContractIcon(line, family) {
  if (line) return consortiumLineIcon(line)
  try { if (Item.exists(String(family))) return String(family) } catch (err) { /* not an item id */ }
  return CONSORTIUM_CONTRACT_BOARD_ICON_FALLBACK
}

function consortiumContractCompound(family, line, view, premiumCents, units, setBy) {
  let c = NBT.compoundTag()
  c.putString('family', String(family))
  c.putString('line', line ? String(line.id) : '')
  c.putString('label', String(view.name()))
  c.putString('icon', consortiumContractIcon(line, family))
  c.putInt('premiumCents', premiumCents)
  c.putInt('units', units)
  c.putDouble('filled', 0)
  c.putLong('paidCents', 0)
  c.putLong('closedAt', 0)
  c.putString('closedBy', '')
  c.putString('setBy', setBy || '')
  return c
}

// ---- the pick (RANKS 2.1) --------------------------------------------------------------------------------------

// Closes the stored list: its families become `previous`, its counters land in history.<day>, old history is pruned.
function consortiumContractCloseList(tag, day) {
  let old = tag.getList('list', 10)
  let oldDay = tag.getInt('day')
  let prev = NBT.listTag()
  let paid = 0
  let filled = 0
  for (let i = 0; i < old.size(); i++) {
    let c = old.getCompound(i)
    prev.add(NBT.stringTag(String(c.getString('family'))))
    paid += c.getLong('paidCents')
    if (c.getLong('closedAt') > 0) filled++
  }
  tag.put('previous', prev)
  if (old.size() > 0 && oldDay > 0) {
    let h = consortiumSub(tag.getCompound('history'), String(oldDay))
    // a same-day close (reroll, set, clear) keeps the money and the fills but does not count the list a second
    // time as offered contracts, so the weekly report reads "F of N filled" with N the contracts actually offered
    if (oldDay !== day) h.putInt('count', h.getInt('count') + old.size())
    h.putInt('filled', h.getInt('filled') + filled)
    h.putLong('paidCents', h.getLong('paidCents') + paid)
  }
  let history = tag.getCompound('history')
  let stale = []
  for (let key of history.getAllKeys()) {
    if (parseInt(String(key), 10) < day - CONSORTIUM_CONTRACT_HISTORY_DAYS) stale.push(String(key))
  }
  for (let i = 0; i < stale.length; i++) history.remove(stale[i])
  tag.put('list', NBT.listTag())
}

// Picks the contracts of season day `day` (`why`: 'day' from the lazy check or the daily step, 'reroll' from staff).
// Skipped, without stamping the day, while the mod's runtime is not ready (the price index answers empty then), so
// the next read retries. Never announces: the daily step and the reroll command do.
function consortiumContractPick(server, day, why) {
  if (!consortiumContractReady()) return false
  let tag = consortiumContractsTag(server)
  consortiumContractCloseList(tag, day)
  tag.putInt('day', day)
  consortiumContractLastBonus = {}
  let all = consortiumContractCandidates(server)
  let prev = {}
  let prevList = tag.getList('previous', 8)
  for (let i = 0; i < prevList.size(); i++) prev[String(prevList.getString(i))] = true
  let fresh = []
  for (let i = 0; i < all.length; i++) if (!prev[all[i].family]) fresh.push(all[i])
  let picks = consortiumContractDraw(fresh, CONSORTIUM_CONTRACTS_PER_DAY)
  let list = NBT.listTag()
  let names = []
  for (let i = 0; i < picks.length; i++) {
    let p = picks[i]
    let units = consortiumContractSizeOf(server, p.view, p.premiumCents)
    list.add(consortiumContractCompound(p.family, p.line, p.view, p.premiumCents, units, why))
    names.push(String(p.view.name()) + ' ' + units + ' x ' + p.premiumCents + ' c')
  }
  tag.put('list', list)
  tag.putString('reason', all.length === 0 ? 'target' : fresh.length === 0 ? 'rest' : '')
  console.info('[Consortium] contracts: season day ' + day + ' pick (' + why + ', phase ' + Consortium.phase(server) + '): ' + (names.length ? names.join(', ') : 'none (' + tag.getString('reason') + ')')
    + '; previous ' + (prevList.size() ? Object.keys(prev).join(', ') : 'none'))
  return true
}

// ---- texts (RANKS 2.4) -----------------------------------------------------------------------------------------

function consortiumContractPremiumText(cents, compact) {
  return '+' + consortiumContractFmt(cents) + (compact ? '/unit' : ' per unit')
}

// The no-contract line of the daily summary and the status command.
function consortiumContractNoneText(tag) {
  let reason = String(tag.getString('reason'))
  if (reason === 'rest') return 'No daily contract today: yesterday\'s lines rest, new contracts tomorrow at 06:00.'
  if (reason === 'cleared') return 'No daily contract today (cleared by staff), new contracts tomorrow at 06:00.'
  return 'No daily contract today: every open line is on target.'
}

// The summary line: "Daily contracts until 06:00: Iron +0.25 CC per unit on the first 136 units, Coal ... (Operator rank
// and above, /consortium contracts)." or one of the no-contract lines.
function consortiumContractSummaryText(server) {
  let entries = consortiumContractEntries(server)
  if (entries.length === 0) return consortiumContractNoneText(consortiumContractsTag(server))
  let parts = []
  for (let i = 0; i < entries.length; i++) {
    let e = entries[i]
    parts.push(e.label + ' ' + consortiumContractPremiumText(e.premiumCents, false) + ' on the first ' + consortiumFmt(e.units) + (i === 0 ? ' units' : ''))
  }
  return 'Daily contracts until 06:00: ' + parts.join(', ') + ' (Operator rank and above, /consortium contracts).'
}

// The compact string of the board payload, the {contracts} tab token and the digest: "Iron +0.25 CC/unit 40/136,
// Coal +0.13 CC/unit 0/264", at most 140 characters (cut at a comma), empty without a contract.
function consortiumContractText(server) {
  let entries = consortiumContractEntries(server)
  let parts = []
  for (let i = 0; i < entries.length; i++) {
    let e = entries[i]
    parts.push(e.label + ' ' + consortiumContractPremiumText(e.premiumCents, true) + ' ' + Math.floor(e.filled) + '/' + e.units)
  }
  let text = parts.join(', ')
  while (text.length > CONSORTIUM_CONTRACT_TEXT_MAX && parts.length > 1) {
    parts.pop()
    text = parts.join(', ')
  }
  return text.length > CONSORTIUM_CONTRACT_TEXT_MAX ? text.slice(0, CONSORTIUM_CONTRACT_TEXT_MAX) : text
}

// Extra board lines next to season_fund: key contract_<family sanitised>, label under the 48-character cap, the
// line's icon, current = floor(filled), target = units (a filled contract renders as done).
function consortiumContractBoardLinesOf(server) {
  let entries = consortiumContractEntries(server)
  let out = []
  for (let i = 0; i < entries.length; i++) {
    let e = entries[i]
    let label = 'Contract: ' + e.label + ' ' + consortiumContractPremiumText(e.premiumCents, true)
    out.push({ key: 'contract_' + e.family.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 56), label: label.length > 48 ? label.slice(0, 48) : label,
      icon: e.icon, current: Math.floor(e.filled), target: Math.max(1, e.units) })
  }
  return out
}

function consortiumContractEligible(uuid) {
  if (typeof ConsortiumCore === 'undefined') return false
  try {
    let id = typeof uuid === 'string' ? CONSORTIUM_UUID.fromString(uuid) : uuid
    return Number(ConsortiumCore.rankCredit(id)) >= consortiumContractOperatorCents()
  } catch (err) { return false }
}

// ---- the shared object -------------------------------------------------------------------------------------

Consortium.contracts = {
  pot: CONSORTIUM_CONTRACT_POT,
  premium: CONSORTIUM_CONTRACT_PREMIUM,

  pick: (server, day) => consortiumContractPick(server, day || Consortium.seasonDay(server), 'day'),
  today: (server) => consortiumContractEntries(server),
  eligible: (uuid) => consortiumContractEligible(uuid),
  text: (server) => consortiumContractText(server),
  boardLines: (server) => consortiumContractBoardLinesOf(server),
  summary: (server) => consortiumContractSummaryText(server),

  // Daily step hook (consortiumContractsDaily in consortium_phases.js, right after consortiumShopDaily): the pick if
  // the lazy check did not run yet, then the summary line through the say relay. `debug daily` re-runs the summary and
  // never re-picks (the pick is idempotent on the day).
  daily: (server, day) => {
    consortiumContractList(server)
    consortiumBroadcast(server, consortiumContractSummaryText(server))
    consortiumPublishBoard(server, true)
  },

  // The read-only bonus of one quote line in cents: floor(min(room, paidUnits) x premium) while a contract on the
  // family is open, the player is Operator or above and paid units exist; 0 otherwise. Stashes { bonus, units } per
  // "uuid|family" (the confirm re-quotes, so the stash always holds the priced quote).
  quoteBonus: (server, uuid, family, paidUnits) => {
    let who = String(uuid).toLowerCase()
    let key = who + '|' + String(family)
    let paid = Math.floor(Number(paidUnits) || 0)
    let open = paid > 0 ? consortiumContractOpenOn(server, family) : null
    if (open === null) { delete consortiumContractLastBonus[key]; return 0 }
    let room = open.entry.units - open.entry.filled
    if (room <= 0 || !consortiumContractEligible(who)) { delete consortiumContractLastBonus[key]; return 0 }
    let take = Math.min(room, paid)
    let bonus = Math.floor(take * open.entry.premiumCents)
    if (bonus <= 0) { delete consortiumContractLastBonus[key]; return 0 }
    consortiumContractLastBonus[key] = { bonus: bonus, units: take }
    return bonus
  },

  // Status lines of /consortium contracts (uuid: lowercase string or null for the console).
  status: (server, uuid) => {
    let lines = []
    if (typeof ConsortiumCore === 'undefined') {
      lines.push(Text.of('Consortium Core is absent: no terminal, no contracts here.').gray())
      return lines
    }
    let entries = consortiumContractEntries(server)
    if (entries.length === 0) {
      lines.push(Text.of(consortiumContractNoneText(consortiumContractsTag(server))).gray())
    } else {
      lines.push(Text.of('Daily contracts (first come, first served, until 06:00 server time):').gold())
      for (let i = 0; i < entries.length; i++) {
        let e = entries[i]
        let taken = Math.min(e.units, Math.floor(e.filled))
        lines.push(Text.of('  ' + e.label + ' ' + consortiumContractPremiumText(e.premiumCents, false) + ': ' + consortiumFmt(taken) + ' of ' + consortiumFmt(e.units) + ' units taken'
          + (e.closedAt > 0 ? ', filled' + (e.closedBy ? ' (last units by ' + e.closedBy + ')' : '') + '.' : ', until 06:00.')).white())
      }
    }
    if (uuid) {
      let cents = 0
      try { cents = Number(ConsortiumCore.rankCredit(CONSORTIUM_UUID.fromString(uuid))) } catch (err) { cents = 0 }
      let need = consortiumContractOperatorCents()
      lines.push(cents >= need ? Text.of('Operator rank and above; you are eligible.').green()
        : Text.of('Earn ' + consortiumContractFmt(need) + ' at the terminal to unlock daily contracts (you have ' + consortiumContractFmt(cents) + ').').yellow())
    } else {
      lines.push(Text.of('Operator rank and above (' + consortiumContractFmt(consortiumContractOperatorCents()) + ' earned at the terminal).').gray())
    }
    return lines
  },

  // Staff: a new pick for today, announced. Returns the summary text.
  reroll: (server, byName) => {
    if (!consortiumContractReady()) return 'Consortium Core is not ready: no price index to pick from.'
    consortiumContractPick(server, Consortium.seasonDay(server), 'reroll')
    console.info('[Consortium] contracts rerolled by ' + (byName || 'staff'))
    let text = consortiumContractSummaryText(server)
    consortiumBroadcast(server, text)
    consortiumPublishBoard(server, true)
    return text
  },

  // Staff: replaces today's list with one contract on `family` (units default to the computed N). Refusal or null.
  set: (server, family, units, byName) => {
    if (!consortiumContractReady()) return 'Consortium Core is not ready: no price index.'
    let key = String(family)
    let view = consortiumContractView(key)
    if (view === null) return 'Unknown price family "' + key + '": use a key of /prices list (for example minecraft:iron_ingot).'
    if (view.quotaOnly()) return key + ' is a quota-only family (no price): nothing to pay a premium on.'
    let premium = consortiumContractPremiumOf(view)
    if (premium <= 0) return key + ' has no base price to derive a premium from.'
    let n = Math.floor(Number(units) || 0)
    if (n <= 0) n = consortiumContractSizeOf(server, view, premium)
    let line = null
    let prog = Consortium.progress(server, Consortium.phase(server))
    for (let i = 0; i < prog.lines.length; i++) {
      if (consortiumContractFamilyOfLine(prog.lines[i].line) === key) { line = prog.lines[i].line; break }
    }
    let tag = consortiumContractsTag(server)
    let day = Consortium.seasonDay(server)
    consortiumContractCloseList(tag, day)
    tag.putInt('day', day)
    consortiumContractLastBonus = {}
    let list = NBT.listTag()
    list.add(consortiumContractCompound(key, line, view, premium, n, 'staff:' + (byName || 'console')))
    tag.put('list', list)
    tag.putString('reason', '')
    console.info('[Consortium] contract set by ' + (byName || 'staff') + ': ' + key + ' ' + n + ' units at ' + premium + ' c per unit')
    consortiumBroadcast(server, consortiumContractSummaryText(server))
    consortiumPublishBoard(server, true)
    return null
  },

  // Staff: empties today's list until tomorrow or a reroll.
  clear: (server, byName) => {
    let tag = consortiumContractsTag(server)
    let day = Consortium.seasonDay(server)
    let had = tag.getList('list', 10).size()
    consortiumContractCloseList(tag, day)
    tag.putInt('day', day)
    tag.putString('reason', 'cleared')
    consortiumContractLastBonus = {}
    console.info('[Consortium] contracts cleared by ' + (byName || 'staff') + ' (' + had + ' contract(s))')
    consortiumPublishBoard(server, true)
    return had
  },

  // Balancing journal figures over the last `days` season days (history plus the live list): { count, filled, paidCents }.
  window: (server, days) => {
    let tag = consortiumContractsTag(server)
    let day = Consortium.seasonDay(server)
    let out = { count: 0, filled: 0, paidCents: 0 }
    let history = tag.getCompound('history')
    for (let key of history.getAllKeys()) {
      let d = parseInt(String(key), 10)
      if (d < day - days + 1) continue
      let h = history.getCompound(key)
      out.count += h.getInt('count')
      out.filled += h.getInt('filled')
      out.paidCents += h.getLong('paidCents')
    }
    let list = tag.getList('list', 10)
    for (let i = 0; i < list.size(); i++) {
      let c = list.getCompound(i)
      out.count++
      if (c.getLong('closedAt') > 0) out.filled++
      out.paidCents += c.getLong('paidCents')
    }
    return out
  },
}

// ---- listeners -------------------------------------------------------------------------------------------

if (typeof ConsortiumCore !== 'undefined') {
  // Post-commit consumption (RANKS 2.3): stash-gated, paid units only, then the "Contract filled" line.
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      let name = String(player.username)
      let changed = false
      let tag = consortiumContractsTag(server)
      for (let line of e.lines) {
        let family = String(line.family)
        let key = uuid + '|' + family
        let stash = consortiumContractLastBonus[key]
        delete consortiumContractLastBonus[key]
        if (!stash || stash.bonus <= 0 || Number(line.cents) <= 0) continue
        let open = consortiumContractOpenOn(server, family)
        if (open === null) continue
        let c = open.compound
        let room = c.getInt('units') - c.getDouble('filled')
        if (room <= 0) continue
        let consume = Math.min(room, stash.units)
        let paid = Math.floor(consume * c.getInt('premiumCents'))
        c.putDouble('filled', c.getDouble('filled') + consume)
        c.putLong('paidCents', c.getLong('paidCents') + paid)
        tag.putLong('seasonCents', tag.getLong('seasonCents') + paid)
        changed = true
        console.info('[Consortium] contract ' + family + ': ' + name + ' took ' + consume + ' unit(s) for ' + paid + ' c of premium (' + Math.floor(c.getDouble('filled')) + '/' + c.getInt('units') + ')')
        if (c.getDouble('filled') >= c.getInt('units')) {
          c.putLong('closedAt', Date.now())
          c.putString('closedBy', name)
          consortiumSay(server, 'Contract filled: ' + c.getString('label') + ' ' + consortiumContractPremiumText(c.getInt('premiumCents'), false) + ' (' + consortiumFmt(c.getInt('units')) + ' units), last units by ' + name + '.')
        }
      }
      if (changed) consortiumPublishBoard(server, false)
    } catch (err) {
      console.error('[Consortium] contract consumption failed: ' + err)
    }
  })

  // Weekly report line (ReportEvent, Consortium Core 0.4.0): "Contracts (7 d): F of C filled, X CC of premiums".
  let consortiumContractReportEvent = false
  try {
    let cls = Java.tryLoadClass('org.consortium.core.api.event.ReportEvent')
    consortiumContractReportEvent = cls !== null && cls !== undefined
  } catch (err) { consortiumContractReportEvent = false }
  if (consortiumContractReportEvent) {
    NativeEvents.onEvent('org.consortium.core.api.event.ReportEvent', (e) => {
      try {
        if (Number(e.windowDays) < 7 || consortiumContractServer === null) return
        let w = Consortium.contracts.window(consortiumContractServer, 7)
        e.addLine('Contracts (7 d): ' + w.filled + ' of ' + w.count + ' filled, ' + consortiumContractFmt(w.paidCents) + ' of premiums')
      } catch (err) { console.error('[Consortium] contracts report line failed: ' + err) }
    })
  }

  // The optional day-boundary check of RANKS 2.1: the mod's [market] day_boundary_hour (family caps, shop daily limits)
  // and the engine's CONSORTIUM_DAILY_HOUR (season day, contracts, paycheck cap) are both 06:00 and never change alone.
  ServerEvents.loaded((event) => {
    let server = event.server
    consortiumContractServer = server
    server.scheduleInTicks(120, () => {
      try {
        let cfg = Java.tryLoadClass('org.consortium.core.config.ServerConfig')
        if (cfg === null || cfg === undefined) { console.info('[Consortium] contracts: day boundary check skipped (ServerConfig class not reachable)'); return }
        let hour = Number(cfg.dayBoundaryHour())
        if (hour !== CONSORTIUM_DAILY_HOUR) console.warn('[Consortium] contracts: day boundary mismatch, the mod resets family caps at ' + hour + ':00 while the engine day starts at ' + CONSORTIUM_DAILY_HOUR + ':00 (CONFIG_DECISIONS: both are 06:00 and never change alone)')
        else console.info('[Consortium] contracts: day boundary ' + hour + ':00 on both sides (mod family caps and engine season day)')
      } catch (err) { console.info('[Consortium] contracts: day boundary check skipped (' + err + ')') }
    })
  })
  console.info('[Consortium] daily contracts registered (pick at the 06:00 boundary, quote premium through consortium_money.js, consumption on DeliveryEvent)')
} else {
  console.info('[Consortium] Consortium Core absent: daily contracts off')
}
