// priority: 40
// The Consortium - money modifiers on Consortium Core deliveries (docs/PROGRESSION.md 9.1, 11 and 12,
// docs/PRICE_TABLE.md 1.4, 6 and 9, docs/CONSORTIUM_CORE_V02.md section 6). Needs consortium_lib.js
// (FTB Teams helpers), consortium_charters.js (consortiumCharterOf) and consortium_phases.js
// (consortiumState, consortiumSeasonDay), all loaded before this file. Does nothing when the Consortium
// Core mod is absent (no ConsortiumCore binding).
//
// The mod posts org.consortium.core.api.event.DeliveryQuoteEvent twice per delivery (at quote time,
// up to once per tick per open terminal, and again at confirm): the handler below is pure, never logs
// per call, and multiplies EVERY factor into ONE setMultiplier call per line (a second call overwrites
// the first). Modifiers touch credits only, never the quota count the engine records. Factor order
// (CONTENT_BATCH_2_INTERFACES 3): charter x newcomer x event x paycheck scale.
//
//   charter (9.1):  the effective charter is the OWNER's record of the player's current FTB team (a
//                   party uses its owner's charter), else the player's own record; +15 % on the charter's
//                   own family, -5 % on the two others, neutral families untouched. The family of a line
//                   is the charter_family of its price family (consortium_prices/*.json).
//   newcomer (12):  +25 % for the first 7 days after the account's first login, paid only while the
//                   starting-capital state is GRANTED (an alt refused by the same-connection check gets
//                   none). The launch cohort (first login on season day 1) is not a newcomer
//                   (DECISIONS.md 2026-09-16): a catch-up rule, not a launch bonus. The bonus stops once
//                   its cumulative share reaches NEWCOMER_BONUS_CAP[phase] (PRICE_TABLE 6, the
//                   newcomer_bonus_max_credits of CONSORTIUM_CORE.md 11): consortium.newcomer.<uuid>.bonusCents
//                   accumulates cents - cents / 1.25 of every receipt the factor applied to.
//   event (EVENTS 2.1): consortiumEventFactor, a typeof-guarded wrapper over ConsortiumEvents.quoteFactor
//                   (market events: Ore Rush, Power Surge, Logistics Week, Market Crash); 1 without the
//                   events engine, looked up at quote time, never at load time. The engine clips a boost to
//                   the player's remaining event room (EVENTS 4) from the line's cents after charter x
//                   newcomer, sharing the room across the receipt's boosted lines in order.
//   paycheck (PRICE_TABLE 1.4, DECISIONS 2026-09-17): per player and per season day (06:00 server time)
//                   the terminal pays at most DAILY_PAYCHECK_CAP[phase] credits; consortium.paycheck.<uuid>
//                   { day, cents } is fed by the DeliveryEvent listener, and at quote time every line factor
//                   is scaled by max(0, (cap - paid) / projected) when the receipt would cross the cap
//                   (0 when nothing is left). Units beyond the cap count for the quota only; saturation
//                   still advances by the paid units (mod behaviour). One chat line per player per day.
//
// The receipt shows the factor ("x115 %", "x144 %" for 1.15 x 1.25), which is how a test reads it.
// Harness step PRICE_TABLE 5.3 p: set DAILY_PAYCHECK_CAP[1] = 100 in the srvdev copy, run /ccore selftest
// twice, expect the reduced percentage and the chat line, restore the constant.

const CONSORTIUM_CHARTER_MODIFIERS = {
  extraction: { raw: 1.15, power: 0.95, transport: 0.95, neutral: 1 },
  energy: { raw: 0.95, power: 1.15, transport: 0.95, neutral: 1 },
  logistics: { raw: 0.95, power: 0.95, transport: 1.15, neutral: 1 },
}
const CONSORTIUM_NEWCOMER_DAYS = 7
const CONSORTIUM_NEWCOMER_BONUS = 1.25
// PRICE_TABLE 1.4 [S]: 3 x the design income of the best-paid charter of the phase, in CC. PLACEHOLDER
// until the beta-week ledger read (PRICE_TABLE 8); re-derived from the simulation medians.
const DAILY_PAYCHECK_CAP = { 1: 560, 2: 1100, 3: 830, 4: 1130, 5: 2750 }
// PRICE_TABLE 6 [S]: 25 % of 7 design days at the median income of the phase the newcomer joins in, in CC.
// PLACEHOLDER until the beta-week ledger read.
const NEWCOMER_BONUS_CAP = { 1: 310, 2: 630, 3: 460, 4: 630, 5: 550 }

// Effective charter of an online player: the owner's record of the current FTB team, else the player's own record.
function consortiumEffectiveCharter(server, player) {
  let team = consortiumTeamOf(player)
  if (team !== null) return consortiumCharterOf(server, consortiumTeamOwner(team))
  return consortiumCharterOf(server, String(player.uuid).toLowerCase())
}

function consortiumMoneySub(server, key, uuid) {
  let st = consortiumState(server)
  if (!st.contains(key)) st.put(key, NBT.compoundTag())
  let all = st.getCompound(key)
  if (!all.contains(uuid)) all.put(uuid, NBT.compoundTag())
  return all.getCompound(uuid)
}

// Cents the terminal paid this season day (06:00 boundary): consortium.paycheck.<uuid> { day, cents }.
function consortiumPaycheckPaid(server, uuid) {
  let rec = consortiumMoneySub(server, 'paycheck', uuid)
  return rec.getInt('day') === consortiumSeasonDay(server) ? rec.getLong('cents') : 0
}

function consortiumPaycheckAdd(server, uuid, cents) {
  let rec = consortiumMoneySub(server, 'paycheck', uuid)
  let day = consortiumSeasonDay(server)
  if (rec.getInt('day') !== day) {
    rec.putInt('day', day)
    rec.putLong('cents', 0)
    rec.putInt('notifiedDay', 0)
  }
  rec.putLong('cents', rec.getLong('cents') + cents)
}

function consortiumPaycheckCapCents(server) {
  let cap = DAILY_PAYCHECK_CAP[Consortium.phase(server)]
  return cap ? Math.round(cap * 100) : 0
}

// PROGRESSION 12: 1.25 during the first 7 days after the first login, GRANTED accounts only, launch cohort
// excluded, and only until the cumulative bonus reaches NEWCOMER_BONUS_CAP of the current phase.
function consortiumNewcomerFactor(server, uuid) {
  let first = ConsortiumCore.firstLogin(uuid)
  if (first <= 0 || Date.now() - first >= CONSORTIUM_NEWCOMER_DAYS * CONSORTIUM_DAY_MS) return 1
  if (first < consortiumState(server).getLong('startedAt') + CONSORTIUM_DAY_MS) return 1
  if (String(ConsortiumCore.grant(uuid)) !== 'GRANTED') return 1
  let cap = NEWCOMER_BONUS_CAP[Consortium.phase(server)]
  if (cap && consortiumMoneySub(server, 'newcomer', String(uuid).toLowerCase()).getLong('bonusCents') >= Math.round(cap * 100)) return 1
  return CONSORTIUM_NEWCOMER_BONUS
}

// Market event factor of one line (EVENTS 2.1): 1 without the events engine or on any failure. `cents` is the
// line's credits before the event factor (base x charter x newcomer) and `quote` one { used } object per quote
// event: the engine clips the factor to the player's remaining event room (EVENTS 4) and shares that room across
// the boosted lines of the receipt in line order.
function consortiumEventFactor(server, uuid, family, charterFamily, cents, quote) {
  if (typeof ConsortiumEvents === 'undefined' || typeof ConsortiumEvents.quoteFactor !== 'function') return 1
  try {
    let f = Number(ConsortiumEvents.quoteFactor(server, uuid, family, charterFamily, cents, quote))
    return isFinite(f) && f >= 0 ? f : 1
  } catch (err) {
    console.error('[Consortium] event quote factor failed: ' + err)
    return 1
  }
}

// The charter x newcomer factor of one line (1 when nothing applies).
function consortiumLineMultiplier(table, charterFamily, newcomer) {
  let charter = table === null ? 1 : (table[String(charterFamily)] || 1)
  return charter * newcomer
}

if (typeof ConsortiumCore !== 'undefined') {
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryQuoteEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      let charter = consortiumEffectiveCharter(server, player)
      let table = charter === null ? null : (CONSORTIUM_CHARTER_MODIFIERS[charter] || null)
      let newcomer = consortiumNewcomerFactor(server, player.uuid)
      let factors = []
      let projected = 0
      let quote = { used: 0 } // event bonus cents already reserved by earlier lines of this quote
      for (let line of e.lines) {
        let own = consortiumLineMultiplier(table, line.charterFamily, newcomer)
        let m = own * consortiumEventFactor(server, player.uuid, line.family, line.charterFamily, Number(line.cents) * own, quote)
        factors[line.index] = m
        projected += line.cents * m
      }
      // Daily paycheck cap (PRICE_TABLE 1.4): scale every line so the receipt stops at the cap.
      let scale = 1
      let cap = consortiumPaycheckCapCents(server)
      if (cap > 0 && projected > 0) {
        let paid = consortiumPaycheckPaid(server, uuid)
        if (paid + projected > cap) {
          scale = Math.max(0, (cap - paid) / projected)
          let rec = consortiumMoneySub(server, 'paycheck', uuid)
          let day = consortiumSeasonDay(server)
          if (rec.getInt('notifiedDay') !== day) {
            rec.putInt('notifiedDay', day)
            player.tell(Text.of('Daily paycheck cap reached (' + consortiumFmt(cap / 100) + ' CC): further deliveries count for the quota only until 06:00.').gold())
            console.info('[Consortium] ' + player.username + ' reached the daily paycheck cap (' + consortiumFmt(cap / 100) + ' CC, season day ' + day + ')')
          }
        }
      }
      for (let line of e.lines) {
        let m = factors[line.index] * scale
        if (m !== 1) e.setMultiplier(line.index, m)
      }
    } catch (err) {
      console.error('[Consortium] delivery quote modifiers failed: ' + err)
    }
  })

  // Post-commit bookkeeping: the paycheck counter and the newcomer bonus share (exact because the factors
  // multiply: the bonus share of a receipt the 1.25 factor applied to is cents - cents / 1.25).
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let uuid = String(player.uuid).toLowerCase()
      let total = Number(e.totalCents)
      if (total > 0) {
        consortiumPaycheckAdd(server, uuid, total)
        if (consortiumNewcomerFactor(server, player.uuid) === CONSORTIUM_NEWCOMER_BONUS) {
          let rec = consortiumMoneySub(server, 'newcomer', uuid)
          rec.putLong('bonusCents', rec.getLong('bonusCents') + Math.round(total - total / CONSORTIUM_NEWCOMER_BONUS))
        }
      }
    } catch (err) {
      console.error('[Consortium] delivery bookkeeping failed: ' + err)
    }
  })
  console.info('[Consortium] money modifiers registered (charter families, newcomer bonus and cap, event factor, daily paycheck cap)')
} else {
  console.info('[Consortium] Consortium Core absent: money modifiers off')
}
