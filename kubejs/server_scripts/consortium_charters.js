// priority: 60
// The Consortium - charters and staff stages (docs/PROGRESSION.md sections 9.1, 9.2, 10 and 12).
// Needs consortium_lib.js (helpers) and consortium_quotas.js (CONSORTIUM_PHASES); the phase engine
// (consortium_phases.js) calls consortiumApplyTeam / consortiumApplyPlayer at login, at every phase
// unlock, in the 1 second player sweep and in the 5 minute check. Commands are in consortium_commands.js.
//
// State (server.persistentData "consortium", see consortium_phases.js):
//   charters.<uuid>: { charter (string), chosenAt (long), switchedAt (long, 0 until a switch),
//                      switches (int), name (string) }                       one record per player UUID
//   staff.<uuid>: name (string)                                             the STAFF list (section 10)
//
// What a team should hold (consortiumWantedStages), reconciled by consortiumApplyTeam:
//   every team        consortium:phase_1 .. phase_<current>
//   charter team      <charter>_p1 .. _p<current> (early access repeats the next phase file) and
//                     licence_<charter> from the phase of section 9.2 (Extraction 3, Energy 4, Logistics 4).
//                     A team's charter is its OWNER's record (a party uses its owner's charter, members'
//                     own records stay stored and come back on their personal team, section 9.1)
//   staff team        every member is in the staff list: staff + every phase, licence and charter stage
//                     so the Chapters auditor never strips an admin (section 10)
// Any other consortium:* stage a team holds is stripped (stale charter after a switch, staff on a team
// with a non-staff member, phases above the current one), so no /ftbteams write is ever needed.
//
// Charter switch (section 9.1, staff command /consortium charter set): a player's own choice happens
// once; a switch is refused while the player's effective or personal team holds any licence stage,
// after CONSORTIUM_SWITCHES_PER_SEASON switches, or within CONSORTIUM_SWITCH_COOLDOWN_DAYS of the last
// charter change. "none" (staff clearing the record) is always allowed and starts the player over.

const CONSORTIUM_CHARTERS = {
  extraction: { label: 'Extraction', licencePhase: 3, bonus: '+15 % on raw materials' },
  energy: { label: 'Energy', licencePhase: 4, bonus: '+15 % on power items' },
  logistics: { label: 'Logistics', licencePhase: 4, bonus: '+15 % on transport and storage' },
}
const CONSORTIUM_CHARTER_IDS = ['extraction', 'energy', 'logistics']
const CONSORTIUM_STAGE_STAFF = 'consortium:staff'
const CONSORTIUM_STAGE_LICENCE_PREFIX = 'consortium:licence_'
const CONSORTIUM_SWITCHES_PER_SEASON = 1 // section 9.1: one switch per season
const CONSORTIUM_SWITCH_COOLDOWN_DAYS = 7 // section 9.1: 7-day cooldown after the choice (or the last switch)

// ---- state --------------------------------------------------------------------------------------

function consortiumSub(tag, key) {
  if (!tag.contains(key)) tag.put(key, NBT.compoundTag())
  return tag.getCompound(key)
}

function consortiumCharterRecords(server) {
  return consortiumSub(consortiumState(server), 'charters')
}

function consortiumStaffList(server) {
  return consortiumSub(consortiumState(server), 'staff')
}

// Charter id of a player UUID (lowercase string), or null.
function consortiumCharterOf(server, uuid) {
  let records = consortiumCharterRecords(server)
  if (!records.contains(uuid)) return null
  let c = String(records.getCompound(uuid).getString('charter'))
  return CONSORTIUM_CHARTERS[c] ? c : null
}

function consortiumIsStaff(server, uuid) {
  return consortiumStaffList(server).contains(uuid)
}

// A staff member's personal team, or a party whose members are all staff (section 10). A personal team
// is judged by its player, not its member list: FTB Teams empties that list while the player is in a
// party, and the team must already hold the staff stages the second the player leaves. Server teams and
// empty parties never count.
function consortiumIsStaffTeam(server, team) {
  if (team.isPlayerTeam()) return consortiumIsStaff(server, String(team.getId()).toLowerCase())
  if (!team.isPartyTeam()) return false
  let members = consortiumTeamMembers(team)
  if (members.length === 0) return false
  for (let i = 0; i < members.length; i++) {
    if (!consortiumIsStaff(server, members[i])) return false
  }
  return true
}

// ---- stage sets -----------------------------------------------------------------------------------

// Stages a charter gives at phase n: <charter>_p1..p<n> plus the licence from its phase.
function consortiumCharterStages(charter, n) {
  let out = []
  for (let i = 1; i <= n; i++) out.push('consortium:' + charter + '_p' + i)
  if (n >= CONSORTIUM_CHARTERS[charter].licencePhase) out.push(CONSORTIUM_STAGE_LICENCE_PREFIX + charter)
  return out
}

// { stageId: true } for everything the team should hold right now.
function consortiumWantedStages(server, team) {
  let want = {}
  let n = Consortium.phase(server)
  let max = CONSORTIUM_PHASES.length
  if (consortiumIsStaffTeam(server, team)) {
    for (let i = 1; i <= max; i++) want[consortiumDef(i).stage] = true
    want[CONSORTIUM_STAGE_STAFF] = true
    for (let c = 0; c < CONSORTIUM_CHARTER_IDS.length; c++) {
      let all = consortiumCharterStages(CONSORTIUM_CHARTER_IDS[c], max)
      for (let i = 0; i < all.length; i++) want[all[i]] = true
    }
    return want
  }
  for (let i = 1; i <= n; i++) want[consortiumDef(i).stage] = true
  let charter = consortiumCharterOf(server, consortiumTeamOwner(team))
  if (charter !== null) {
    let stages = consortiumCharterStages(charter, n)
    for (let i = 0; i < stages.length; i++) want[stages[i]] = true
  }
  return want
}

// Reconciles one team: strips consortium:* stages it should not hold, grants the missing ones.
// Returns the number of stage changes. Strips are logged (they are rare and always meaningful).
function consortiumApplyTeam(server, team) {
  if (!CONSORTIUM_HAS_CHAPTERS) return 0
  let want = consortiumWantedStages(server, team)
  let held = consortiumTeamStages(team)
  let changes = 0
  for (let i = 0; i < held.length; i++) {
    let s = held[i]
    if (s.indexOf('consortium:') !== 0 || want[s]) continue
    try {
      if (consortiumSetTeamStage(team, s, false)) {
        changes++
        console.info('[Consortium] stripped ' + s + ' from team ' + team.getShortName())
      }
    } catch (err) { console.error('[Consortium] strip ' + s + ' from team ' + team.getShortName() + ' failed: ' + err) }
  }
  for (let s in want) {
    if (held.indexOf(s) >= 0) continue
    try {
      if (consortiumSetTeamStage(team, s, true)) changes++
    } catch (err) { console.error('[Consortium] grant ' + s + ' to team ' + team.getShortName() + ' failed: ' + err) }
  }
  return changes
}

// Reconciles every team. Returns the number of stage changes.
function consortiumApplyAllTeams(server) {
  let changes = 0
  consortiumForEachTeam((team) => { changes += consortiumApplyTeam(server, team) })
  return changes
}

// Reconciles an online player's current team; falls back to a direct phase grant when FTB Teams has
// not assigned the team yet (first ticks of a login).
function consortiumApplyPlayer(server, player) {
  let team = consortiumTeamOf(player)
  if (team !== null) return consortiumApplyTeam(server, team)
  return consortiumGrantToPlayer(player, consortiumStagesUpTo(Consortium.phase(server)))
}

// The effective team and the personal team of a player UUID, as a JS array without duplicates (one
// entry when the player is not in a party, none when FTB Teams never saw the player). Both matter:
// the personal team of a party member must be current for the day the player leaves the party.
function consortiumTeamsOfId(uuid) {
  let mgr = consortiumTeamManager()
  if (mgr === null) return []
  let id = CONSORTIUM_UUID.fromString(uuid)
  let both = [mgr.getTeamForPlayerID(id), mgr.getPlayerTeamForPlayerID(id)]
  let out = []
  let seen = {}
  for (let i = 0; i < both.length; i++) {
    if (!both[i].isPresent()) continue
    let team = both[i].get()
    let key = String(team.getId())
    if (seen[key]) continue
    seen[key] = true
    out.push(team)
  }
  return out
}

// Reconciles the effective team and the personal team of a player UUID.
function consortiumApplyPlayerId(server, uuid) {
  let teams = consortiumTeamsOfId(uuid)
  let changes = 0
  for (let i = 0; i < teams.length; i++) changes += consortiumApplyTeam(server, teams[i])
  return changes
}

// True when the 1 second sweep must reconcile this online player's team: it lacks the current phase
// stage (a fresh or freshly left party, review F3), or its consortium:staff does not match the staff
// rule (a non-staff player joined a staff party and must lose the staff stages within a second, or a
// staff-only team lost the stage), review G2. A staff member in a mixed party legitimately lacks the
// stage and is not swept.
function consortiumPlayerNeedsSweep(server, player, phaseStage) {
  if (!consortiumPlayerHasStage(player, phaseStage)) return true
  let team = consortiumTeamOf(player)
  let shouldHoldStaff = team !== null && consortiumIsStaffTeam(server, team)
  return consortiumPlayerHasStage(player, CONSORTIUM_STAGE_STAFF) !== shouldHoldStaff
}

// ---- charter records --------------------------------------------------------------------------------

// The first consortium:licence_* stage held by the effective or personal team of a player UUID, or
// null. Staff teams are skipped: their licences come from the staff rule, not from a charter.
function consortiumLicenceHeldBy(server, uuid) {
  let teams = consortiumTeamsOfId(uuid)
  for (let i = 0; i < teams.length; i++) {
    if (consortiumIsStaffTeam(server, teams[i])) continue
    let held = consortiumTeamStages(teams[i])
    for (let j = 0; j < held.length; j++) {
      if (held[j].indexOf(CONSORTIUM_STAGE_LICENCE_PREFIX) === 0) return held[j]
    }
  }
  return null
}

// Writes the record of a player UUID and reconciles the player's teams (effective and personal).
//   charter = null   clears the record (staff only, always allowed; the player starts over)
//   no record yet    the choice: chosenAt = now, no switch used
//   record exists    a switch (section 9.1): refused with a reason while a licence stage is held, once
//                    the switch of the season is used, or inside the cooldown; otherwise switchedAt and
//                    switches are updated and the old charter stages are stripped at once
// Returns { ok: true, changes } (stage changes, 0 when FTB Teams does not know the player yet) or
// { ok: false, reason } with the English refusal to show the caller.
function consortiumSetCharter(server, uuid, name, charter) {
  let records = consortiumCharterRecords(server)
  let now = Date.now()
  let current = charter === null ? null : consortiumCharterOf(server, uuid)
  if (charter === null) {
    records.remove(uuid)
    console.info('[Consortium] charter of ' + name + ' (' + uuid + ') cleared')
  } else if (current === null) {
    let rec = NBT.compoundTag()
    rec.putString('charter', charter)
    rec.putLong('chosenAt', now)
    rec.putLong('switchedAt', 0)
    rec.putInt('switches', 0)
    rec.putString('name', name)
    records.put(uuid, rec)
    console.info('[Consortium] charter of ' + name + ' (' + uuid + ') set to ' + charter)
  } else {
    let rec = records.getCompound(uuid)
    let label = CONSORTIUM_CHARTERS[current].label
    if (current === charter) {
      return { ok: false, reason: name + ' already holds the ' + label + ' charter; nothing changed.' }
    }
    let licence = consortiumLicenceHeldBy(server, uuid)
    if (licence !== null) {
      return { ok: false, reason: 'Switch refused: the team of ' + name + ' holds ' + licence + '. A charter is final once its team holds any licence stage (placed licence machines would keep running).' }
    }
    let switches = rec.getInt('switches')
    if (switches >= CONSORTIUM_SWITCHES_PER_SEASON) {
      return { ok: false, reason: 'Switch refused: ' + name + ' already switched charter on day ' + Math.max(1, consortiumSeasonDayAt(server, rec.getLong('switchedAt'))) + ' (' + CONSORTIUM_SWITCHES_PER_SEASON + ' switch per season). Clear it with "none" only if the Board grants an exception.' }
    }
    let last = Math.max(rec.getLong('chosenAt'), rec.getLong('switchedAt'))
    let cooldown = CONSORTIUM_SWITCH_COOLDOWN_DAYS * CONSORTIUM_DAY_MS
    if (now - last < cooldown) {
      let left = Math.ceil((cooldown - (now - last)) / CONSORTIUM_DAY_MS)
      return { ok: false, reason: 'Switch refused: ' + name + ' took the ' + label + ' charter on day ' + Math.max(1, consortiumSeasonDayAt(server, last)) + '; the ' + CONSORTIUM_SWITCH_COOLDOWN_DAYS + '-day cooldown ends in ' + left + ' day(s).' }
    }
    rec.putString('charter', charter)
    rec.putString('name', name)
    rec.putLong('switchedAt', now)
    rec.putInt('switches', switches + 1)
    console.info('[Consortium] charter of ' + name + ' (' + uuid + ') switched from ' + current + ' to ' + charter + ' (switch ' + (switches + 1) + ' of ' + CONSORTIUM_SWITCHES_PER_SEASON + ' this season)')
  }
  return { ok: true, changes: consortiumApplyPlayerId(server, uuid) }
}

function consortiumSetStaff(server, uuid, name, add) {
  let staff = consortiumStaffList(server)
  if (add) staff.putString(uuid, name)
  else staff.remove(uuid)
  console.info('[Consortium] staff ' + (add ? 'added: ' : 'removed: ') + name + ' (' + uuid + ')')
  return consortiumApplyPlayerId(server, uuid)
}

// Self-service choice (once per player). Returns the Text to show the player.
function consortiumChooseCharter(player, charter) {
  let server = player.server
  let uuid = String(player.uuid).toLowerCase()
  let current = consortiumCharterOf(server, uuid)
  if (current !== null) {
    let day = Math.max(1, consortiumSeasonDayAt(server, consortiumCharterRecords(server).getCompound(uuid).getLong('chosenAt')))
    return Text.of('You already chose the ' + CONSORTIUM_CHARTERS[current].label + ' charter on day ' + day + '. Switching charters goes through staff: ask at HQ.').red()
  }
  let result = consortiumSetCharter(server, uuid, String(player.username), charter)
  if (!result.ok) return Text.of(result.reason).red()
  let def = CONSORTIUM_CHARTERS[charter]
  let text = Text.of('Charter recorded: ').green().append(Text.of(def.label).gold().bold())
    .append(Text.of('. Deliveries pay ' + def.bonus + '; your early-access items are open now.').green())
  let team = consortiumTeamOf(player)
  if (team !== null && team.isPartyTeam() && consortiumTeamOwner(team) !== uuid) {
    text = text.append(Text.of(' Your party uses its owner\'s charter while you stay in it; yours applies to your own team.').gray())
  }
  return text
}

// Short status line for the login message and /consortium charter.
function consortiumCharterStatus(server, player) {
  let uuid = String(player.uuid).toLowerCase()
  let own = consortiumCharterOf(server, uuid)
  let team = consortiumTeamOf(player)
  let active = team !== null ? consortiumCharterOf(server, consortiumTeamOwner(team)) : own
  if (own === null && active === null) {
    return Text.of('No charter yet. Choose one with ').gray()
      .append(Text.of('/consortium charter extraction').aqua().clickSuggestCommand('/consortium charter extraction'))
      .append(Text.of(', energy or logistics (once per player).').gray())
  }
  let line = Text.of('Your charter: ' + (own === null ? 'none' : CONSORTIUM_CHARTERS[own].label) + '.').gray()
  if (team !== null && team.isPartyTeam()) {
    line = line.append(Text.of(' Party charter (owner\'s): ' + (active === null ? 'none' : CONSORTIUM_CHARTERS[active].label) + '.').gray())
  }
  return line
}
