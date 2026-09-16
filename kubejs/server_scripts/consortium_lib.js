// priority: 100
// The Consortium - shared helpers for the progression engine (PROJECT_RULES 4.4 and 4.5).
//
// Loaded before consortium_phases.js, consortium_charters.js and consortium_commands.js. Plain
// functions in the shared server-script scope; at load time it only resolves the FTB Teams classes.
//
// Chat: every announcement goes through "tellraw @a" (relayed by Simple Discord Link when
// relayTellRaw is on, experimental) or "say" (relayed when sendSayCommand is on, the safe path);
// server.tell() is never relayed (verified).
//
// Stages: writes NEVER go through /ftbteams teamstage or TeamStagesHelper.addTeamStage. Both mutate
// FTB Teams' shared default HashSet in place on any team created since the last restart (the stage is
// then invisible to Chapters until a restart and leaks into other new teams). Safe writers are
// PlayerStages.of(player).add/remove (Chapters' own copy-on-write bridge) for a member online whose
// effective team is the team being written, and, otherwise, the same copy-on-write done here by
// hand (it mirrors Chapters' FtbTeamsBridge.commitStages: copy, setProperty, PROPERTIES_CHANGED, sync).
//
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_HAS_TEAMS = Platform.isLoaded('ftbteams')
const CONSORTIUM_HAS_CHAPTERS = Platform.isLoaded('chapters')
const CONSORTIUM_HAS_SDLINK = Platform.isLoaded('sdlink') // server-only mod, absent in singleplayer

// FTB Teams classes, loaded once (KubeJS logs every Java.loadClass call).
const CONSORTIUM_FTB_API = CONSORTIUM_HAS_TEAMS ? Java.loadClass('dev.ftb.mods.ftbteams.api.FTBTeamsAPI') : null
const CONSORTIUM_STAGES_HELPER = CONSORTIUM_HAS_TEAMS ? Java.loadClass('dev.ftb.mods.ftbteams.api.TeamStagesHelper') : null
const CONSORTIUM_TEAM_PROPERTIES = CONSORTIUM_HAS_TEAMS ? Java.loadClass('dev.ftb.mods.ftbteams.api.property.TeamProperties') : null
const CONSORTIUM_TEAM_EVENT = CONSORTIUM_HAS_TEAMS ? Java.loadClass('dev.ftb.mods.ftbteams.api.event.TeamEvent') : null
const CONSORTIUM_PROPS_CHANGED = CONSORTIUM_HAS_TEAMS ? Java.loadClass('dev.ftb.mods.ftbteams.api.event.TeamPropertiesChangedEvent') : null
const CONSORTIUM_HASHSET = Java.loadClass('java.util.HashSet')
const CONSORTIUM_UUID = Java.loadClass('java.util.UUID')

// 1,234,567 style formatting (Rhino has no reliable toLocaleString).
function consortiumFmt(n) {
  let s = String(Math.floor(Math.abs(n)))
  let out = ''
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out
    s = s.slice(0, -3)
  }
  return (n < 0 ? '-' : '') + s + out
}

function consortiumPct(ratio) {
  return Math.floor(Math.min(1, Math.max(0, ratio)) * 100)
}

// Next event slot (rule 4.6): Wednesday, Friday or Saturday at 20:00 server time, as "Friday 18/9".
function consortiumNextSlot() {
  let now = new Date()
  let names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  for (let i = 0; i < 8; i++) {
    let c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 20, 0, 0)
    let d = c.getDay()
    if ((d === 3 || d === 5 || d === 6) && c.getTime() > now.getTime()) return names[d] + ' ' + c.getDate() + '/' + (c.getMonth() + 1)
  }
  return 'the next event evening'
}

// Announcement for players: gold "[Consortium]" prefix, yellow body. `extra` is an optional list of
// extra JSON text parts (for example a clickable link). Reaches Discord only through relayTellRaw.
function consortiumSay(server, body, extra) {
  let parts = ['', { text: '[Consortium] ', color: 'gold', bold: true }, { text: body, color: 'yellow' }]
  if (extra) {
    for (let i = 0; i < extra.length; i++) parts.push(extra[i])
  }
  server.runCommandSilent('tellraw @a ' + JSON.stringify(parts))
  console.info('[Consortium] ' + body)
}

// Plain line for the Discord chat channel (SDLink relays /say when sendSayCommand is true). Only sent
// where the relay exists, so singleplayer and a server without SDLink do not get a duplicate line.
function consortiumDiscord(server, body) {
  if (!CONSORTIUM_HAS_SDLINK) return
  server.runCommandSilent('say [Consortium] ' + body)
}

// One line for players AND Discord through the safe relay: "say" where SDLink runs (shown in game as
// "[Server] [Consortium] ..." and relayed to the chat channel), tellraw otherwise. Used for the daily
// summary and the stall notices, which must reach Discord even if relayTellRaw misbehaves.
function consortiumBroadcast(server, body) {
  if (CONSORTIUM_HAS_SDLINK) {
    server.runCommandSilent('say [Consortium] ' + body)
    console.info('[Consortium] ' + body)
  } else {
    consortiumSay(server, body)
  }
}

function consortiumTitle(server, title, subtitle) {
  server.runCommandSilent('title @a times 10 70 20')
  server.runCommandSilent('title @a subtitle ' + JSON.stringify({ text: subtitle, color: 'yellow' }))
  server.runCommandSilent('title @a title ' + JSON.stringify({ text: title, color: 'gold', bold: true }))
}

// ---- FTB Teams access ---------------------------------------------------------------------------

function consortiumTeamManager() {
  if (!CONSORTIUM_HAS_TEAMS) return null
  let api = CONSORTIUM_FTB_API.api()
  if (!api.isManagerLoaded()) return null // only valid while a server runs
  return api.getManager()
}

// Calls fn(team) for every FTB team (player, party and server teams). Returns the number of teams.
function consortiumForEachTeam(fn) {
  let mgr = consortiumTeamManager()
  if (mgr === null) return 0
  let n = 0
  for (let team of mgr.getTeams()) {
    if (team.isClientTeam()) continue
    fn(team)
    n++
  }
  return n
}

// The player's current (effective) team, or null: the party while in one, the personal team otherwise.
function consortiumTeamOf(player) {
  let mgr = consortiumTeamManager()
  if (mgr === null) return null
  let t = mgr.getTeamForPlayer(player)
  return t.isPresent() ? t.get() : null
}

// Same by UUID string (offline players included), or null when FTB Teams never saw the player.
function consortiumTeamOfId(uuid) {
  let mgr = consortiumTeamManager()
  if (mgr === null) return null
  let t = mgr.getTeamForPlayerID(CONSORTIUM_UUID.fromString(uuid))
  return t.isPresent() ? t.get() : null
}

// Owner UUID as a lowercase string. A personal team's owner is its player (FTB Teams' PlayerTeam does
// not override getOwner(), which returns the nil UUID there; a party returns its real owner).
function consortiumTeamOwner(team) {
  return String(team.isPlayerTeam() ? team.getId() : team.getOwner()).toLowerCase()
}

// Member UUIDs of a team as lowercase strings (a personal team lists its player; a party its members).
function consortiumTeamMembers(team) {
  let out = []
  for (let id of team.getMembers()) out.push(String(id).toLowerCase())
  return out
}

// Read-only check of ftbteams:team_stages (reading is safe; only the FTB writers are buggy).
function consortiumTeamHasStage(team, stageId) {
  return CONSORTIUM_STAGES_HELPER.hasTeamStage(team, stageId)
}

// Every stage the team holds, as a JS array of strings.
function consortiumTeamStages(team) {
  let out = []
  for (let s of CONSORTIUM_STAGES_HELPER.getStages(team)) out.push(String(s))
  return out
}

// Add (add = true) or remove a stage on one team. Returns true when something changed.
//
// The online shortcut through PlayerStages.of(player) writes to the player's EFFECTIVE team, so it is
// taken only when an online member's effective team is this very team. FTB Teams keeps the personal
// team of every party member in its team map and PlayerTeam.getOnlineMembers() returns the owner
// whenever online, party or not: without this check the inactive personal team of a party member
// was never written (the write landed on the party and returned false), and a player leaving the
// party came back to a stale team whose inventory Chapters audits at once (review F3).
function consortiumSetTeamStage(team, stageId, add) {
  if (!CONSORTIUM_HAS_CHAPTERS) return false
  let online = team.getOnlineMembers()
  if (online.size() > 0) {
    let p = online.iterator().next()
    let eff = consortiumTeamOf(p)
    if (eff !== null && eff.getId().equals(team.getId())) {
      let stages = PlayerStages.of(p)
      return add ? stages.add(stageId) : stages.remove(stageId)
    }
  }
  // Nobody online on this exact team: copy-on-write of ftbteams:team_stages, mirroring Chapters'
  // FtbTeamsBridge.commitStages. The shared FTB default set is copied (normally empty) and never mutated.
  if (consortiumTeamHasStage(team, stageId) === add) return false
  let next = new CONSORTIUM_HASHSET()
  for (let s of CONSORTIUM_STAGES_HELPER.getStages(team)) next.add(s)
  if (add) next.add(stageId)
  else next.remove(stageId)
  let old = team.getProperties().copy()
  team.setProperty(CONSORTIUM_TEAM_PROPERTIES.TEAM_STAGES, next) // marks the team dirty, saved with the world
  CONSORTIUM_TEAM_EVENT.PROPERTIES_CHANGED.invoker().accept(new CONSORTIUM_PROPS_CHANGED(team, old))
  team.syncOnePropertyToTeam(CONSORTIUM_TEAM_PROPERTIES.TEAM_STAGES, next)
  return true
}

// Grants stages to one online player's current team through Chapters (fallback when FTB Teams has
// not assigned a team yet, right at login).
function consortiumGrantToPlayer(player, stageIds) {
  if (!CONSORTIUM_HAS_CHAPTERS) return 0
  let stages = PlayerStages.of(player)
  let added = 0
  for (let i = 0; i < stageIds.length; i++) {
    if (stages.add(stageIds[i])) added++
  }
  return added
}

function consortiumPlayerHasStage(player, stageId) {
  if (!CONSORTIUM_HAS_CHAPTERS) return true
  return PlayerStages.of(player).has(stageId)
}

// Resolves "<name>" or "<uuid>" to { id: lowercase uuid string, name } for online players, players FTB
// Teams has seen before (offline) and raw UUIDs; null when nothing matches.
function consortiumResolvePlayer(server, text) {
  let wanted = String(text)
  for (let p of server.players) {
    if (String(p.username).toLowerCase() === wanted.toLowerCase()) return { id: String(p.getUUID()).toLowerCase(), name: String(p.username) }
  }
  let mgr = consortiumTeamManager()
  if (mgr !== null) {
    for (let entry of mgr.getKnownPlayerTeams().entrySet()) {
      let name = String(entry.getValue().getPlayerName())
      if (name.toLowerCase() === wanted.toLowerCase()) return { id: String(entry.getKey()).toLowerCase(), name: name }
    }
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) return { id: wanted.toLowerCase(), name: wanted.toLowerCase() }
  return null
}
