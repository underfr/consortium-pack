// priority: 40
// The Consortium - money modifiers on Consortium Core deliveries (docs/PROGRESSION.md 9.1 and 12,
// docs/CONSORTIUM_CORE_V02.md section 6). Needs consortium_lib.js (FTB Teams helpers),
// consortium_charters.js (consortiumCharterOf) and consortium_phases.js (consortiumState), all loaded
// before this file. Does nothing when the Consortium Core mod is absent (no ConsortiumCore binding).
//
// The mod posts org.consortium.core.api.event.DeliveryQuoteEvent twice per delivery (at quote time,
// up to once per tick per open terminal, and again at confirm): the handler below is pure, never logs
// per call, and multiplies BOTH factors into ONE setMultiplier call per line (a second call overwrites
// the first). Modifiers touch credits only, never the quota count the engine records.
//
//   charter (9.1): the effective charter is the OWNER's record of the player's current FTB team (a
//                  party uses its owner's charter), else the player's own record; +15 % on the charter's
//                  own family, -5 % on the two others, neutral families untouched. The family of a line is
//                  the charter_family of its price family (consortium_prices/*.json).
//   newcomer (12): +25 % for the first 7 days after the account's first login, paid only while the
//                  starting-capital state is GRANTED (an alt refused by the same-connection check gets
//                  none). The launch cohort (first login on season day 1) is not a newcomer
//                  (DECISIONS.md 2026-09-16): a catch-up rule, not a launch bonus. The cap
//                  newcomer_bonus_max_credits of CONSORTIUM_CORE.md 11 has no value yet and is not applied.
//
// The receipt shows the factor ("x115 %", "x144 %" for 1.15 x 1.25), which is how a test reads it.

const CONSORTIUM_CHARTER_MODIFIERS = {
  extraction: { raw: 1.15, power: 0.95, transport: 0.95, neutral: 1 },
  energy: { raw: 0.95, power: 1.15, transport: 0.95, neutral: 1 },
  logistics: { raw: 0.95, power: 0.95, transport: 1.15, neutral: 1 },
}
const CONSORTIUM_NEWCOMER_DAYS = 7
const CONSORTIUM_NEWCOMER_BONUS = 1.25

// Effective charter of an online player: the owner's record of the current FTB team, else the player's own record.
function consortiumEffectiveCharter(server, player) {
  let team = consortiumTeamOf(player)
  if (team !== null) return consortiumCharterOf(server, consortiumTeamOwner(team))
  return consortiumCharterOf(server, String(player.uuid).toLowerCase())
}

// PROGRESSION 12: 1.25 during the first 7 days after the first login, GRANTED accounts only, launch cohort excluded.
function consortiumNewcomerFactor(server, uuid) {
  let first = ConsortiumCore.firstLogin(uuid)
  if (first <= 0 || Date.now() - first >= CONSORTIUM_NEWCOMER_DAYS * CONSORTIUM_DAY_MS) return 1
  if (first < consortiumState(server).getLong('startedAt') + CONSORTIUM_DAY_MS) return 1
  return String(ConsortiumCore.grant(uuid)) === 'GRANTED' ? CONSORTIUM_NEWCOMER_BONUS : 1
}

// The combined factor of one line: charter table x newcomer bonus (1 when nothing applies).
function consortiumLineMultiplier(table, charterFamily, newcomer) {
  let charter = table === null ? 1 : (table[String(charterFamily)] || 1)
  return charter * newcomer
}

if (typeof ConsortiumCore !== 'undefined') {
  NativeEvents.onEvent('org.consortium.core.api.event.DeliveryQuoteEvent', (e) => {
    try {
      let player = e.player
      let server = player.server
      let charter = consortiumEffectiveCharter(server, player)
      let table = charter === null ? null : (CONSORTIUM_CHARTER_MODIFIERS[charter] || null)
      let newcomer = consortiumNewcomerFactor(server, player.uuid)
      for (let line of e.lines) {
        let m = consortiumLineMultiplier(table, line.charterFamily, newcomer)
        if (m !== 1) e.setMultiplier(line.index, m)
      }
    } catch (err) {
      console.error('[Consortium] delivery quote modifiers failed: ' + err)
    }
  })
  console.info('[Consortium] money modifiers registered (charter families, newcomer bonus)')
} else {
  console.info('[Consortium] Consortium Core absent: money modifiers off')
}
