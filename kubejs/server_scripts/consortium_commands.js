// priority: 0
// The Consortium - commands of the phase engine (consortium_phases.js, consortium_charters.js).
//
//   /consortium phase                       anyone: phase, quota table, days since the last delivery
//   /consortium phase set <n>               op 2: staff lever, jump to phase n (every team reconciled, progress kept)
//   /consortium phase resync                op 2: reconcile every FTB team (phases, charters, staff)
//   /consortium phase reset WIPE            op 4: wipe phase and charter state (staff list kept)
//   /consortium charter                     anyone: your charter and your party's
//   /consortium charter <charter>           anyone: choose extraction, energy or logistics, once per player
//   /consortium charter set <player> <charter|none>   op 2: staff switch (old charter stages stripped at once);
//                                           refused while the player's team holds a licence stage, after the
//                                           one switch of the season or within 7 days of the choice (section 9.1);
//                                           "none" clears the record and is always allowed
//   /consortium staff list|add|remove ...   op 4: the staff list (staff-only teams get consortium:staff)
//   /consortium contribute <item> <count>   op 2: test delivery through Consortium.record
//   /consortium teams                       op 2: every FTB team with the consortium stages it holds
//   /consortium check                       op 2: run the 5 minute maintenance now
//   /consortium debug daily                 op 4: run the daily snapshot and summary now
//   /consortium debug stall                 op 4: fake a 5 day flat quota, then run "debug daily" to see the notice
//   /consortium debug clearprogress         op 4: wipe the delivery progress of the current phase
// The economy block at the end of this file (a second commandRegistry listener, CONTENT_BATCH_2_INTERFACES 2)
// adds licence, season, event ticket, perk, title, sale, gap, debug vacancy, quest and contract; the events
// block of the events engine adds the other children of "event". Brigadier merges the literals.
// Announcements still go to every player and to Discord, so test on the local server, not live.

ServerEvents.commandRegistry((event) => {
  const { commands: Commands, arguments: Arguments } = event
  let reply = (ctx, text) => ctx.source.sendSystemMessage(text)
  let op = (level) => (source) => source.hasPermission(level)
  let charterLabels = 'extraction, energy or logistics'

  let showPhase = (ctx) => {
    let server = ctx.source.server
    let n = Consortium.phase(server)
    let def = Consortium.def(n)
    let prog = Consortium.progress(server, n)
    let tag = Consortium.phaseTag(server, n)
    reply(ctx, Text.of('Phase ' + n + ' of 5: ' + def.name).gold().bold()
      .append(Text.of(' (season day ' + Consortium.seasonDay(server) + ' of 84), quota ' + consortiumPct(prog.c) + ' %'
        + (tag.getLong('completedAt') > 0 ? ', complete' : tag.getBoolean('stalled') ? ', stalled' : '')).yellow()))
    for (let i = 0; i < prog.lines.length; i++) {
      let l = prog.lines[i]
      let pct = Text.of(' (' + consortiumPct(l.ratio) + ' %)')
      reply(ctx, Text.of('  ' + l.line.label + ': ').gray()
        .append(Text.of(consortiumFmt(l.delivered) + ' / ' + consortiumFmt(l.line.amount)).white())
        .append(l.ratio >= 1 ? pct.green() : l.ratio >= 0.6 ? pct.yellow() : pct.red()))
    }
    let last = tag.getLong('lastProgressAt')
    let since = last > 0 ? Math.floor((Date.now() - last) / 86400000) : -1
    reply(ctx, Text.of(since < 0 ? 'No delivery yet in this phase.' : 'Last delivery: ' + (since === 0 ? 'today' : since + ' day(s) ago') + '.').gray())
    return 1
  }

  // Resolves the <player> argument or replies with an error. Returns { id, name } or null.
  let resolve = (ctx) => {
    let text = Arguments.WORD.getResult(ctx, 'player')
    let who = consortiumResolvePlayer(ctx.source.server, text)
    if (who === null) reply(ctx, Text.of('Unknown player "' + text + '": use the name of a player who has joined before, or a UUID.').red())
    return who
  }

  let chooseCharter = (charter) => (ctx) => {
    if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Only a player can choose a charter; staff use /consortium charter set <player> <charter>.').red()); return 0 }
    reply(ctx, consortiumChooseCharter(ctx.source.player, charter))
    return 1
  }

  let setCharter = (charter) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let result = consortiumSetCharter(ctx.source.server, who.id, who.name, charter)
    if (!result.ok) { reply(ctx, Text.of(result.reason).red()); return 0 }
    reply(ctx, Text.of('Charter of ' + who.name + ' set to ' + (charter === null ? 'none' : Consortium.charters[charter].label) + ' (' + result.changes + ' stage change(s)' + (result.changes === 0 ? ', applied at the next login if the team is unknown' : '') + ').').green())
    return 1
  }

  let setStaff = (add) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let changes = consortiumSetStaff(ctx.source.server, who.id, who.name, add)
    reply(ctx, Text.of(who.name + (add ? ' added to' : ' removed from') + ' the staff list (' + changes + ' stage change(s)).').green())
    return 1
  }

  let charterNode = Commands.literal('charter')
    .executes((ctx) => {
      if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Charters are per player: /consortium charter set <player> <' + charterLabels.replace(/, | or /g, '|') + '|none>.').gray()); return 1 }
      reply(ctx, consortiumCharterStatus(ctx.source.server, ctx.source.player))
      return 1
    })
  let setNode = Commands.literal('set').requires(op(2))
  let playerNode = Commands.argument('player', Arguments.WORD.create(event))
  for (let i = 0; i < CONSORTIUM_CHARTER_IDS.length; i++) {
    let id = CONSORTIUM_CHARTER_IDS[i]
    charterNode = charterNode.then(Commands.literal(id).executes(chooseCharter(id)))
    playerNode = playerNode.then(Commands.literal(id).executes(setCharter(id)))
  }
  playerNode = playerNode.then(Commands.literal('none').executes(setCharter(null)))
  charterNode = charterNode.then(setNode.then(playerNode))

  event.register(Commands.literal('consortium')
    .then(Commands.literal('phase')
      .executes(showPhase)
      .then(Commands.literal('set').requires(op(2))
        .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes((ctx) => {
          let n = Arguments.INTEGER.getResult(ctx, 'n')
          let max = Consortium.phases.length
          if (n < 1 || n > max) { reply(ctx, Text.of('Phase must be 1 to ' + max + '.').red()); return 0 }
          let changes = Consortium.setPhase(ctx.source.server, n)
          reply(ctx, Text.of('Phase set to ' + n + ' (' + Consortium.def(n).name + '), ' + changes + ' team stage change(s).').green())
          return 1
        })))
      .then(Commands.literal('resync').requires(op(2)).executes((ctx) => {
        let changes = Consortium.resync(ctx.source.server)
        reply(ctx, Text.of('Resync done: ' + changes + ' stage change(s) across ' + consortiumForEachTeam(() => {}) + ' team(s).').green())
        return 1
      }))
      .then(Commands.literal('reset').requires(op(4))
        .then(Commands.argument('confirm', Arguments.WORD.create(event)).executes((ctx) => {
          if (Arguments.WORD.getResult(ctx, 'confirm') !== 'WIPE') { reply(ctx, Text.of('This wipes all phase and charter progress. Run: /consortium phase reset WIPE').red()); return 0 }
          Consortium.reset(ctx.source.server)
          reply(ctx, Text.of('Phase and charter state wiped: back to phase 1, season day 1. Staff list kept.').green())
          return 1
        }))))
    .then(charterNode)
    .then(Commands.literal('staff').requires(op(4))
      .then(Commands.literal('list').executes((ctx) => {
        let staff = consortiumStaffList(ctx.source.server)
        let names = []
        for (let key of staff.getAllKeys()) names.push(staff.getString(key) + ' (' + key + ')')
        reply(ctx, Text.of(names.length ? 'Staff: ' + names.join(', ') : 'The staff list is empty.').gray())
        return 1
      }))
      .then(Commands.literal('add').then(Commands.argument('player', Arguments.WORD.create(event)).executes(setStaff(true))))
      .then(Commands.literal('remove').then(Commands.argument('player', Arguments.WORD.create(event)).executes(setStaff(false)))))
    .then(Commands.literal('contribute').requires(op(2))
      .then(Commands.argument('item', Arguments.ITEM_STACK.create(event))
        .then(Commands.argument('count', Arguments.INTEGER.create(event)).executes((ctx) => {
          let id = Arguments.ITEM_STACK.getResult(ctx, 'item').createItemStack(1, false).id
          let count = Arguments.INTEGER.getResult(ctx, 'count')
          let who = ctx.source.isPlayer() ? ctx.source.player.username : 'console'
          let accepted = Consortium.record(ctx.source.server, who, id, count)
          reply(ctx, accepted > 0 ? Text.of('Recorded ' + accepted + ' x ' + id + '.').green() : Text.of(id + ' is not in the current phase quota (or the phase is complete).').red())
          return accepted > 0 ? 1 : 0
        }))))
    .then(Commands.literal('teams').requires(op(2)).executes((ctx) => {
      let server = ctx.source.server
      let count = consortiumForEachTeam((team) => {
        let held = consortiumTeamStages(team).filter((s) => s.indexOf('consortium:') === 0).map((s) => s.slice('consortium:'.length)).sort()
        let kind = team.isPartyTeam() ? 'party' : team.isPlayerTeam() ? 'solo' : 'server'
        let flags = (consortiumIsStaffTeam(server, team) ? ', staff' : '') + (team.isPlayerTeam() || team.isPartyTeam() ? ', owner charter ' + (consortiumCharterOf(server, consortiumTeamOwner(team)) || 'none') : '')
        reply(ctx, Text.of('  ' + team.getShortName() + ' (' + kind + ', ' + team.getOnlineMembers().size() + '/' + team.getMembers().size() + ' online' + flags + '): ').gray()
          .append(Text.of(held.length ? held.join(', ') : 'no stage').white()))
      })
      reply(ctx, Text.of(count + ' team(s).').green())
      return 1
    }))
    .then(Commands.literal('check').requires(op(2)).executes((ctx) => {
      Consortium.check(ctx.source.server)
      reply(ctx, Text.of('Maintenance check done (team stages, boss bar, daily step if due).').green())
      return 1
    }))
    .then(Commands.literal('debug').requires(op(4))
      .then(Commands.literal('daily').executes((ctx) => {
        Consortium.daily(ctx.source.server)
        reply(ctx, Text.of('Daily step run: snapshot taken, summary posted, stall rule evaluated.').green())
        return 1
      }))
      .then(Commands.literal('stall').executes((ctx) => {
        let server = ctx.source.server
        let n = Consortium.phase(server)
        let tag = Consortium.phaseTag(server, n)
        let day = Consortium.seasonDay(server)
        tag.putLong('startedAt', Date.now() - 6 * 86400000)
        tag.getCompound('history').putInt(String(day - 5), Math.round(Consortium.progress(server, n).c * 1000))
        reply(ctx, Text.of('Phase ' + n + ' backdated by 6 days with a flat snapshot 5 days ago; run /consortium debug daily to see the stall notice (deliver 5 % or more, then run it again to see it clear).').green())
        return 1
      }))
      .then(Commands.literal('clearprogress').executes((ctx) => {
        Consortium.clearProgress(ctx.source.server)
        reply(ctx, Text.of('Delivery progress of the current phase wiped.').green())
        return 1
      }))))
})

// ==== ECONOMY BLOCK (owner: economy implementer; SHOP 5.9, QUESTS 5.3 and 5.5) ====
// A second commandRegistry listener: Brigadier merges the `consortium`, `event` and `debug` literals across
// register calls, so the base tree above (phase, charter, staff, contribute, teams, check, debug daily |
// stall | clearprogress) is untouched. The events block registers every other child of `event`.
//
//   /consortium licence grant <player> <charter> [tx]     op 2: SHOP 5.5, announced, idempotent on tx
//   /consortium licence revoke <player> <charter>         op 2: record removed, stage stripped
//   /consortium licence list                              op 2: records and the vacancy state per charter
//   /consortium season                                    anyone: fund status (5.6)
//   /consortium season contribute <player> <credits> [tx] op 2: the shop already debited; 1..100000 CC
//   /consortium season target <credits>                   op 4: sets the target (announced)
//   /consortium event ticket <player> add <n> [tx]        op 2: n 1..9, idempotent on tx (also "ticket add <player> <n> [tx]")
//   /consortium event ticket get [player]                 anyone for self, op 2 for others
//   /consortium event ticket take <player> <n>            op 2: refund or manual consume, floor 0 (also "ticket <player> take <n>")
//   /consortium perk grant <player> <perk> [tx]           op 2: 5.10, idempotent
//   /consortium perk revoke <player> <perk>               op 2
//   /consortium perk list [player]                        anyone for self, op 2 for others
//   /consortium perk resync <player>                      op 2: re-issues the LuckPerms lines and the title
//   /consortium title <key> | none | list [player]        anyone (list of others: op 2): 5.11
//   /consortium title grant <player> <key> [tx]           op 2: key of CONSORTIUM_TITLES, or any key with [tx]
//   /consortium title revoke <player> <key>               op 2
//   /consortium sale open <stage> [hours] | close <stage> | list   op 2: 5.2
//   /consortium gap                                       anyone: the Gap Contract status
//   /consortium gap buy <item> <units>                    player: 5.8
//   /consortium debug vacancy <charter> [clear]           op 4: harness lever for 5.5
//   /consortium quest flag|unflag <players> <key>, count <players> <key> <n>   op 2: wrappers over ConsortiumQuests
//   /consortium contract | contract set <family> <units> [days] | contract clear   QUESTS 5.5 wrappers
// Keys with a namespace (quest keys such as shop:any) are resource-location arguments; a key typed without
// one loses the implicit minecraft: prefix (referral stays referral).

ServerEvents.commandRegistry((event) => {
  const { commands: Commands, arguments: Arguments } = event
  let reply = (ctx, text) => ctx.source.sendSystemMessage(text)
  let op = (level) => (source) => source.hasPermission(level)
  let ok = (ctx, text) => { reply(ctx, Text.of(text).green()); return 1 }
  let fail = (ctx, text) => { reply(ctx, Text.of(text).red()); return 0 }

  let resolve = (ctx) => {
    let text = Arguments.WORD.getResult(ctx, 'player')
    let who = consortiumResolvePlayer(ctx.source.server, text)
    if (who === null) reply(ctx, Text.of('Unknown player "' + text + '": use the name of a player who has joined before, or a UUID.').red())
    return who
  }
  let selfOrArg = (ctx, hasArg) => {
    if (hasArg) return resolve(ctx)
    if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Name a player: the console has no account.').red()); return null }
    return { id: String(ctx.source.player.uuid).toLowerCase(), name: String(ctx.source.player.username) }
  }
  let txOf = (ctx, hasTx) => (hasTx ? String(Arguments.WORD.getResult(ctx, 'tx')) : '')
  // A quest or contract key typed as a resource location: "shop:any" stays, "referral" loses "minecraft:".
  let keyArg = (ctx, name) => {
    let s = String(Arguments.RESOURCE_LOCATION.getResult(ctx, name))
    return s.indexOf('minecraft:') === 0 ? s.slice('minecraft:'.length) : s
  }
  let profiles = (ctx) => {
    let out = []
    for (let gp of Arguments.GAME_PROFILE.getResult(ctx, 'players')) out.push({ id: String(gp.getId()).toLowerCase(), name: String(gp.getName()) })
    return out
  }
  let quests = () => (typeof ConsortiumQuests !== 'undefined' ? ConsortiumQuests : null)

  // ---- licence ----
  let licenceGrant = (charter, hasTx) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let by = ctx.source.isPlayer() ? 'staff:' + ctx.source.player.username : (hasTx ? 'shop' : 'staff:console')
    let r = Consortium.licences.grant(ctx.source.server, who.id, who.name, charter, txOf(ctx, hasTx), by)
    if (!r.ok) return fail(ctx, r.reason)
    return ok(ctx, r.already ? 'Already applied: that transaction granted the ' + consortiumCharterLabel(charter) + ' licence to ' + who.name + ' before.'
      : consortiumCharterLabel(charter) + ' licence granted to ' + who.name + ' (' + r.changes + ' stage change(s)).')
  }
  let licenceRevoke = (charter) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    if (!Consortium.licences.revoke(ctx.source.server, who.id, who.name, charter)) return fail(ctx, who.name + ' holds no ' + consortiumCharterLabel(charter) + ' licence record.')
    return ok(ctx, consortiumCharterLabel(charter) + ' licence revoked from ' + who.name + '.')
  }
  let licenceNode = Commands.literal('licence').requires(op(2))
  let grantPlayer = Commands.argument('player', Arguments.WORD.create(event))
  let revokePlayer = Commands.argument('player', Arguments.WORD.create(event))
  for (let i = 0; i < CONSORTIUM_CHARTER_IDS.length; i++) {
    let c = CONSORTIUM_CHARTER_IDS[i]
    grantPlayer = grantPlayer.then(Commands.literal(c).executes(licenceGrant(c, false))
      .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(licenceGrant(c, true))))
    revokePlayer = revokePlayer.then(Commands.literal(c).executes(licenceRevoke(c)))
  }
  licenceNode = licenceNode
    .then(Commands.literal('grant').then(grantPlayer))
    .then(Commands.literal('revoke').then(revokePlayer))
    .then(Commands.literal('list').executes((ctx) => {
      let server = ctx.source.server
      let records = consortiumLicenceRecords(server)
      let n = 0
      for (let uuid of records.getAllKeys()) {
        let held = records.getCompound(uuid)
        for (let c of held.getAllKeys()) {
          let rec = held.getCompound(c)
          n++
          reply(ctx, Text.of('  ' + String(c) + ': ' + String(uuid) + ' by ' + String(rec.getString('by')) + ' on day ' + Math.max(1, consortiumSeasonDayAt(server, rec.getLong('grantedAt'))) + (String(rec.getString('tx')) ? ', tx ' + rec.getString('tx') : '')).gray())
        }
      }
      reply(ctx, Text.of(n + ' licence record(s).').green())
      for (let i = 0; i < CONSORTIUM_CHARTER_IDS.length; i++) {
        let c = CONSORTIUM_CHARTER_IDS[i]
        let v = consortiumVacancyTag(server, c)
        let last = consortiumActivityTag(server, c).getLong('lastDeliveryAt')
        reply(ctx, Text.of('  ' + consortiumCharterLabel(c) + ': last delivery ' + (last > 0 ? 'day ' + Math.max(1, consortiumSeasonDayAt(server, last)) : 'none') + ', '
          + (v.getLong('openSince') > 0 ? 'licence ON SALE' : v.getLong('inactiveSince') > 0 ? 'idle notice given' : 'active') + '.').gray())
      }
      return 1
    }))

  // ---- season ----
  let seasonContribute = (hasTx) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let credits = Arguments.INTEGER.getResult(ctx, 'credits')
    if (credits < 1 || credits > 100000) return fail(ctx, 'Credits must be 1 to 100000.')
    let r = Consortium.season.contribute(ctx.source.server, who.id, who.name, credits * 100, txOf(ctx, hasTx))
    if (!r.ok) return fail(ctx, r.reason)
    if (r.already) return ok(ctx, 'Already applied: that transaction was counted before.')
    return ok(ctx, who.name + ' contributed ' + ConsortiumCore.format(credits * 100) + ' (' + ConsortiumCore.format(r.mine) + ' in total); fund ' + ConsortiumCore.format(r.fund) + ' of ' + ConsortiumCore.format(r.target) + '.')
  }
  let seasonNode = Commands.literal('season')
    .executes((ctx) => {
      let server = ctx.source.server
      let s = Consortium.season.status(server)
      reply(ctx, Text.of('Season fund: ' + ConsortiumCore.format(s.fund) + ' of ' + ConsortiumCore.format(s.target) + ' (' + consortiumPct(s.fund / s.target) + ' %). Benefactor title at 500 CC contributed; plaques at 1,000, 3,000 and 6,000 CC.').gold())
      for (let i = 0; i < Math.min(3, s.contributors.length); i++) {
        let c = s.contributors[i]
        reply(ctx, Text.of('  ' + (i + 1) + '. ' + c.name + ': ' + ConsortiumCore.format(c.cents) + (c.tier > 0 ? ' (' + CONSORTIUM_PLAQUE_TIERS[c.tier - 1].label + ' plaque)' : '')).gray())
      }
      if (ctx.source.isPlayer()) {
        let uuid = String(ctx.source.player.uuid).toLowerCase()
        let mine = 0
        for (let i = 0; i < s.contributors.length; i++) if (s.contributors[i].uuid === uuid) mine = s.contributors[i].cents
        reply(ctx, Text.of('Your share: ' + ConsortiumCore.format(mine) + '. The HQ shop sells contributions of 100, 500 and 2,000 CC.').gray())
      }
      return 1
    })
    .then(Commands.literal('contribute').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event))
        .then(Commands.argument('credits', Arguments.INTEGER.create(event)).executes(seasonContribute(false))
          .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(seasonContribute(true))))))
    .then(Commands.literal('target').requires(op(4))
      .then(Commands.argument('credits', Arguments.INTEGER.create(event)).executes((ctx) => {
        let credits = Arguments.INTEGER.getResult(ctx, 'credits')
        if (credits < 1) return fail(ctx, 'The target must be positive.')
        Consortium.season.setTarget(ctx.source.server, credits * 100)
        return ok(ctx, 'Season fund target set to ' + ConsortiumCore.format(credits * 100) + '.')
      })))

  // ---- event ticket (the only child this block puts under `event`) ----
  let ticketAdd = (hasTx) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let n = Arguments.INTEGER.getResult(ctx, 'n')
    if (n < 1 || n > 9) return fail(ctx, 'n must be 1 to 9.')
    let after = Consortium.tickets.grant(ctx.source.server, who.id, n, txOf(ctx, hasTx))
    if (after < 0) return ok(ctx, 'Already applied: that transaction was counted before (' + Consortium.tickets.count(ctx.source.server, who.id) + ' unused).')
    consortiumTellPlayer(ctx.source.server, who.id, 'Event ticket received (' + after + ' unused). The Friday Zone takes one when its waves start.', 'green')
    return ok(ctx, who.name + ' now holds ' + after + ' event ticket(s).')
  }
  let ticketGet = (hasArg) => (ctx) => {
    let who = selfOrArg(ctx, hasArg)
    if (who === null) return 0
    let n = Consortium.tickets.count(ctx.source.server, who.id)
    reply(ctx, Text.of(who.name + ': ' + n + ' unused event ticket(s).' + (n === 0 ? ' The Board sells them at the HQ shop (30 CC).' : '')).gray())
    return 1
  }
  let ticketTake = (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let after = Consortium.tickets.take(ctx.source.server, who.id, Arguments.INTEGER.getResult(ctx, 'n'))
    return ok(ctx, who.name + ' now holds ' + after + ' event ticket(s).')
  }
  // Both orders are accepted: "ticket <player> add <n> [tx]" (the catalogue entry, SHOP 5.9) and
  // "ticket add <player> <n> [tx]" (SHOP 9.5); same for take.
  let eventNode = Commands.literal('event')
    .then(Commands.literal('ticket')
      .then(Commands.literal('get').executes(ticketGet(false))
        .then(Commands.argument('player', Arguments.WORD.create(event)).requires(op(2)).executes(ticketGet(true))))
      .then(Commands.literal('add').requires(op(2))
        .then(Commands.argument('player', Arguments.WORD.create(event))
          .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes(ticketAdd(false))
            .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(ticketAdd(true))))))
      .then(Commands.literal('take').requires(op(2))
        .then(Commands.argument('player', Arguments.WORD.create(event))
          .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes(ticketTake))))
      .then(Commands.argument('player', Arguments.WORD.create(event)).requires(op(2))
        .then(Commands.literal('add')
          .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes(ticketAdd(false))
            .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(ticketAdd(true)))))
        .then(Commands.literal('take')
          .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes(ticketTake)))))

  // ---- perk ----
  let perkGrant = (hasTx) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let perk = String(Arguments.WORD.getResult(ctx, 'perk'))
    let r = Consortium.perks.grant(ctx.source.server, who.id, who.name, perk, txOf(ctx, hasTx))
    if (!r.ok) return fail(ctx, r.reason)
    return ok(ctx, r.already ? 'Already applied: that transaction granted ' + perk + ' to ' + who.name + ' before.' : 'Perk ' + perk + (r.fresh ? ' granted to ' : ' re-applied for ') + who.name + '.')
  }
  let perkList = (hasArg) => (ctx) => {
    let who = selfOrArg(ctx, hasArg)
    if (who === null) return 0
    let held = Consortium.perks.held(ctx.source.server, who.id)
    reply(ctx, Text.of(who.name + ': ' + (held.length ? held.join(', ') : 'no perk') + '.').gray())
    return 1
  }
  let perkNode = Commands.literal('perk')
    .then(Commands.literal('grant').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event))
        .then(Commands.argument('perk', Arguments.WORD.create(event)).executes(perkGrant(false))
          .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(perkGrant(true))))))
    .then(Commands.literal('revoke').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event))
        .then(Commands.argument('perk', Arguments.WORD.create(event)).executes((ctx) => {
          let who = resolve(ctx)
          if (who === null) return 0
          let perk = String(Arguments.WORD.getResult(ctx, 'perk'))
          if (!Consortium.perks.revoke(ctx.source.server, who.id, who.name, perk)) return fail(ctx, who.name + ' does not hold ' + perk + '.')
          return ok(ctx, 'Perk ' + perk + ' revoked from ' + who.name + '.')
        }))))
    .then(Commands.literal('list').executes(perkList(false))
      .then(Commands.argument('player', Arguments.WORD.create(event)).requires(op(2)).executes(perkList(true))))
    .then(Commands.literal('resync').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event)).executes((ctx) => {
        let who = resolve(ctx)
        if (who === null) return 0
        let n = Consortium.perks.resync(ctx.source.server, who.id, who.name)
        let t = Consortium.titles.resync(ctx.source.server, who.id, who.name)
        return ok(ctx, who.name + ': ' + n + ' perk(s) re-issued' + (t ? ', title re-issued' : '') + '.')
      })))

  // ---- title ----
  let titleGrant = (hasTx) => (ctx) => {
    let who = resolve(ctx)
    if (who === null) return 0
    let key = String(Arguments.WORD.getResult(ctx, 'key'))
    let r = Consortium.titles.grant(ctx.source.server, who.id, who.name, key, null, txOf(ctx, hasTx))
    if (!r.ok) return fail(ctx, r.reason)
    return ok(ctx, r.already ? 'Already applied: that transaction granted the title ' + key + ' to ' + who.name + ' before.' : 'Title ' + key + (r.fresh ? ' granted to ' : ' re-activated for ') + who.name + '.')
  }
  let titleList = (hasArg) => (ctx) => {
    let who = selfOrArg(ctx, hasArg)
    if (who === null) return 0
    let held = Consortium.titles.held(ctx.source.server, who.id)
    let active = Consortium.titles.active(ctx.source.server, who.id)
    let parts = []
    for (let k in held) parts.push(k + ' (' + held[k] + ')' + (k === active ? ' [active]' : ''))
    reply(ctx, Text.of(who.name + ': ' + (parts.length ? parts.join(', ') : 'no title') + '.').gray())
    return 1
  }
  let titleNode = Commands.literal('title')
    .executes((ctx) => {
      reply(ctx, Text.of('Usage: /consortium title <key> puts a held title on, /consortium title none hides it, /consortium title list shows what you hold.').gray())
      return 1
    })
    .then(Commands.literal('none').executes((ctx) => {
      if (!ctx.source.isPlayer()) return fail(ctx, 'Only a player can switch titles.')
      let p = ctx.source.player
      Consortium.titles.activate(ctx.source.server, String(p.uuid).toLowerCase(), String(p.username), 'none')
      return ok(ctx, 'Title hidden.')
    }))
    .then(Commands.literal('list').executes(titleList(false))
      .then(Commands.argument('player', Arguments.WORD.create(event)).requires(op(2)).executes(titleList(true))))
    .then(Commands.literal('grant').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event))
        .then(Commands.argument('key', Arguments.WORD.create(event)).executes(titleGrant(false))
          .then(Commands.argument('tx', Arguments.WORD.create(event)).executes(titleGrant(true))))))
    .then(Commands.literal('revoke').requires(op(2))
      .then(Commands.argument('player', Arguments.WORD.create(event))
        .then(Commands.argument('key', Arguments.WORD.create(event)).executes((ctx) => {
          let who = resolve(ctx)
          if (who === null) return 0
          let key = String(Arguments.WORD.getResult(ctx, 'key'))
          if (!Consortium.titles.revoke(ctx.source.server, who.id, who.name, key)) return fail(ctx, who.name + ' does not hold the title ' + key + '.')
          return ok(ctx, 'Title ' + key + ' revoked from ' + who.name + '.')
        }))))
    .then(Commands.argument('key', Arguments.WORD.create(event)).executes((ctx) => {
      if (!ctx.source.isPlayer()) return fail(ctx, 'Only a player can switch titles; staff use /consortium title grant <player> <key>.')
      let p = ctx.source.player
      let key = String(Arguments.WORD.getResult(ctx, 'key'))
      let r = Consortium.titles.activate(ctx.source.server, String(p.uuid).toLowerCase(), String(p.username), key)
      if (!r.ok) return fail(ctx, r.reason)
      return ok(ctx, 'Title ' + key + ' is on.')
    }))

  // ---- sale ----
  let saleNode = Commands.literal('sale').requires(op(2))
    .then(Commands.literal('open')
      .then(Commands.argument('stage', Arguments.RESOURCE_LOCATION.create(event)).executes((ctx) => {
        let stage = String(Arguments.RESOURCE_LOCATION.getResult(ctx, 'stage'))
        let changes = Consortium.sales.open(ctx.source.server, stage, 0, ctx.source.isPlayer() ? 'staff:' + ctx.source.player.username : 'staff:console')
        return ok(ctx, 'Sale of ' + stage + ' open until closed (' + changes + ' stage change(s)).')
      })
        .then(Commands.argument('hours', Arguments.INTEGER.create(event)).executes((ctx) => {
          let stage = String(Arguments.RESOURCE_LOCATION.getResult(ctx, 'stage'))
          let hours = Arguments.INTEGER.getResult(ctx, 'hours')
          if (hours < 1) return fail(ctx, 'Hours must be positive (omit it for an open-ended sale).')
          let changes = Consortium.sales.open(ctx.source.server, stage, Date.now() + hours * 3600000, ctx.source.isPlayer() ? 'staff:' + ctx.source.player.username : 'staff:console')
          return ok(ctx, 'Sale of ' + stage + ' open for ' + hours + ' hour(s) (' + changes + ' stage change(s)).')
        }))))
    .then(Commands.literal('close')
      .then(Commands.argument('stage', Arguments.RESOURCE_LOCATION.create(event)).executes((ctx) => {
        let stage = String(Arguments.RESOURCE_LOCATION.getResult(ctx, 'stage'))
        let changes = Consortium.sales.close(ctx.source.server, stage)
        return ok(ctx, 'Sale of ' + stage + ' closed (' + changes + ' stage change(s)).')
      })))
    .then(Commands.literal('list').executes((ctx) => {
      let list = Consortium.sales.list(ctx.source.server)
      for (let i = 0; i < list.length; i++) reply(ctx, Text.of('  ' + list[i].stage + ': ' + (list[i].until > 0 ? 'until ' + new Date(list[i].until).toISOString() : 'until closed') + ', by ' + list[i].by).gray())
      reply(ctx, Text.of(list.length + ' sale(s) open.').green())
      return 1
    }))

  // ---- gap ----
  let gapNode = Commands.literal('gap')
    .executes((ctx) => {
      let uuid = ctx.source.isPlayer() ? String(ctx.source.player.uuid).toLowerCase() : null
      let lines = Consortium.gap.status(ctx.source.server, uuid)
      for (let i = 0; i < lines.length; i++) reply(ctx, lines[i].color === 'gold' ? Text.of(lines[i].text).gold() : Text.of(lines[i].text).gray())
      return 1
    })
    .then(Commands.literal('buy')
      .then(Commands.argument('item', Arguments.ITEM_STACK.create(event))
        .then(Commands.argument('units', Arguments.INTEGER.create(event)).executes((ctx) => {
          if (!ctx.source.isPlayer()) return fail(ctx, 'Only a player can buy from the Gap Contract (the debit needs an account).')
          if (typeof ConsortiumCore === 'undefined') return fail(ctx, 'Consortium Core is absent: no credits here.')
          let id = Arguments.ITEM_STACK.getResult(ctx, 'item').createItemStack(1, false).id
          let units = Arguments.INTEGER.getResult(ctx, 'units')
          let r = Consortium.gap.buy(ctx.source.server, ctx.source.player, String(id), units)
          if (!r.ok) return fail(ctx, r.reason)
          return ok(ctx, 'Sourced ' + r.units + ' ' + r.label + ' for ' + ConsortiumCore.format(r.cents) + '; they count for the quota under your name and for your rank at 50 %.')
        }))))

  // ---- debug vacancy (its own `debug` literal carries op 4 too, whichever block registers first) ----
  let debugVacancy = (clear) => (ctx) => {
    let c = String(Arguments.WORD.getResult(ctx, 'charter')).toLowerCase()
    if (!CONSORTIUM_CHARTERS[c]) return fail(ctx, 'Charter must be extraction, energy or logistics.')
    return ok(ctx, consortiumDebugVacancy(ctx.source.server, c, clear))
  }
  let debugNode = Commands.literal('debug').requires(op(4))
    .then(Commands.literal('vacancy')
      .then(Commands.argument('charter', Arguments.WORD.create(event)).executes(debugVacancy(false))
        .then(Commands.literal('clear').executes(debugVacancy(true)))))

  // ---- quest flags (wrappers over ConsortiumQuests, QUESTS 5.3) ----
  let questCall = (what) => (ctx) => {
    let q = quests()
    if (q === null) return fail(ctx, 'The quests script is not loaded (consortium_quests.js).')
    let key = keyArg(ctx, 'key')
    let who = profiles(ctx)
    let n = what === 'count' ? Arguments.INTEGER.getResult(ctx, 'n') : 0
    for (let i = 0; i < who.length; i++) {
      if (what === 'flag') q.flag(who[i].id, key)
      else if (what === 'unflag') q.unflag(who[i].id, key)
      else q.count(who[i].id, key, n)
    }
    return ok(ctx, what + ' ' + key + (what === 'count' ? ' +' + n : '') + ' applied to ' + who.length + ' player(s).')
  }
  let questNode = Commands.literal('quest').requires(op(2))
    .then(Commands.literal('flag').then(Commands.argument('players', Arguments.GAME_PROFILE.create(event))
      .then(Commands.argument('key', Arguments.RESOURCE_LOCATION.create(event)).executes(questCall('flag')))))
    .then(Commands.literal('unflag').then(Commands.argument('players', Arguments.GAME_PROFILE.create(event))
      .then(Commands.argument('key', Arguments.RESOURCE_LOCATION.create(event)).executes(questCall('unflag')))))
    .then(Commands.literal('count').then(Commands.argument('players', Arguments.GAME_PROFILE.create(event))
      .then(Commands.argument('key', Arguments.RESOURCE_LOCATION.create(event))
        .then(Commands.argument('n', Arguments.INTEGER.create(event)).executes(questCall('count'))))))

  // ---- weekly contract (wrappers over ConsortiumQuests.contract, QUESTS 5.5) ----
  let contractSet = (hasDays) => (ctx) => {
    let q = quests()
    if (q === null || !q.contract) return fail(ctx, 'The quests script is not loaded (consortium_quests.js).')
    let family = String(Arguments.RESOURCE_LOCATION.getResult(ctx, 'family'))
    let units = Arguments.INTEGER.getResult(ctx, 'units')
    let days = hasDays ? Arguments.INTEGER.getResult(ctx, 'days') : 7
    let by = ctx.source.isPlayer() ? String(ctx.source.player.username) : 'console'
    let refusal = q.contract.set(ctx.source.server, family, units, days, by)
    if (refusal) return fail(ctx, String(refusal))
    return ok(ctx, 'Weekly contract set: ' + units + ' x ' + family + ' for ' + days + ' day(s).')
  }
  let contractNode = Commands.literal('contract')
    .executes((ctx) => {
      let q = quests()
      if (q === null || !q.contract) return fail(ctx, 'The quests script is not loaded (consortium_quests.js).')
      let uuid = ctx.source.isPlayer() ? String(ctx.source.player.uuid).toLowerCase() : null
      reply(ctx, Text.of(String(q.contract.status(ctx.source.server, uuid))).gray())
      return 1
    })
    .then(Commands.literal('set').requires(op(2))
      .then(Commands.argument('family', Arguments.RESOURCE_LOCATION.create(event))
        .then(Commands.argument('units', Arguments.INTEGER.create(event)).executes(contractSet(false))
          .then(Commands.argument('days', Arguments.INTEGER.create(event)).executes(contractSet(true))))))
    .then(Commands.literal('clear').requires(op(2)).executes((ctx) => {
      let q = quests()
      if (q === null || !q.contract) return fail(ctx, 'The quests script is not loaded (consortium_quests.js).')
      q.contract.clear(ctx.source.server)
      return ok(ctx, 'Weekly contract cleared.')
    }))

  event.register(Commands.literal('consortium')
    .then(licenceNode)
    .then(seasonNode)
    .then(eventNode)
    .then(perkNode)
    .then(titleNode)
    .then(saleNode)
    .then(gapNode)
    .then(debugNode)
    .then(questNode)
    .then(contractNode))
})
// ==== END ECONOMY BLOCK ====

// ==== EVENTS BLOCK (owner: events implementer; EVENTS 6) ====
// /consortium event ... (docs/EVENTS.md 6). Its own commandRegistry listener: Brigadier merges the `consortium`
// and `event` literals across register calls, so the economy block's `event ticket` subtree and this block's
// children coexist under `event`. Only this block puts an `executes` on the bare `event` literal (the status line).
// Without CONSORTIUM_EVENTS_ON (Consortium Core or FTB Chunks absent, consortium_events_lib.js) only the status
// node is registered. Optional trailing arguments of `start` and `next` are one GREEDY_STRING split on spaces
// (a WORD stops at the colon of a resource location; the greedy string takes `apotheosis:overworld/zombie
// apotheosis:rare arena` whole and the engine validates every piece).
//
//   /consortium event                                   anyone: the running event, slot, stage, your opt-in and bonus room
//   /consortium event join|leave                        anyone: invasion opt-in, or the Friday Zone muster (ticket in hand)
//   /consortium event slot <friday|saturday|none>       op 2: override the running event's slot (participant stamp)
//   /consortium event list                              op 2: the catalogue with cooldowns and eligibility
//   /consortium event start <id> [args]                 op 2: forced start (market_crash <family>, bounty [<boss> <rarity>] [arena], supply_drop [meteor])
//   /consortium event stop                              op 2: end the active event now (stop order of EVENTS 2.3)
//   /consortium event next [<id> <hour> <minute> [args]] | next clear   op 2: the queue (minus 60 and minus 5 reminders)
//   /consortium event arena here [<radius>] | set <x> <y> <z> | team <player> | show   op 2: the HQ arena record
//   /consortium event pause|resume                      op 2: the random scheduler (paused by default)
//   /consortium event debug roll [<id>] | muster | stage | paid <player> <cents> | wednesday | clear   op 4

ServerEvents.commandRegistry((event) => {
  const { commands: Commands, arguments: Arguments } = event
  let reply = (ctx, text) => ctx.source.sendSystemMessage(text)
  let op = (level) => (source) => source.hasPermission(level)
  let byName = (ctx) => ctx.source.isPlayer() ? String(ctx.source.player.username) : 'console'

  let eventNode = Commands.literal('event').executes((ctx) => {
    let lines = consortiumEventStatus(ctx.source.server, ctx.source.isPlayer() ? ctx.source.player : null)
    for (let i = 0; i < lines.length; i++) reply(ctx, lines[i])
    return 1
  })

  if (CONSORTIUM_EVENTS_ON) {
    let splitArgs = (ctx, name) => {
      let raw = ''
      try { raw = String(Arguments.GREEDY_STRING.getResult(ctx, name)) } catch (err) { raw = '' }
      return raw.split(/\s+/).filter((a) => a.length > 0)
    }
    let idArg = (ctx) => {
      let id = String(Arguments.WORD.getResult(ctx, 'id'))
      if (!CONSORTIUM_EVENT_DEFS[id]) { reply(ctx, Text.of('Unknown event "' + id + '". Ids: ' + CONSORTIUM_EVENT_IDS.join(', ') + '.').red()); return null }
      return id
    }
    let start = (ctx, args) => {
      let id = idArg(ctx)
      if (id === null) return 0
      let result = consortiumStartEvent(ctx.source.server, id, true, args, byName(ctx))
      if (!result.ok) { reply(ctx, Text.of('Not started: ' + result.reason + '.').red()); return 0 }
      reply(ctx, Text.of(result.name + ' started by ' + byName(ctx) + '.').green())
      return 1
    }
    let queue = (ctx, args) => {
      let id = idArg(ctx)
      if (id === null) return 0
      let hour = Arguments.INTEGER.getResult(ctx, 'hour')
      let minute = Arguments.INTEGER.getResult(ctx, 'minute')
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) { reply(ctx, Text.of('Time must be <hour> 0..23 and <minute> 0..59 (server time).').red()); return 0 }
      let now = new Date()
      let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0)
      if (at.getTime() <= now.getTime()) { reply(ctx, Text.of('That time has passed today; queue events for later today only.').red()); return 0 }
      let q = NBT.compoundTag()
      q.putString('id', id)
      q.putLong('at', at.getTime())
      q.putString('calendar', consortiumEventCalendar(id, true, at.getTime()))
      let list = NBT.listTag()
      for (let i = 0; i < args.length; i++) list.add(NBT.stringTag(args[i]))
      q.put('args', list)
      q.putBoolean('reminded60', at.getTime() - now.getTime() <= 3600000)
      q.putBoolean('reminded5', at.getTime() - now.getTime() <= 300000)
      consortiumEvents(ctx.source.server).put('queued', q)
      console.info('[Consortium] ' + byName(ctx) + ' queued ' + id + ' at ' + consortiumClock(at.getTime()))
      reply(ctx, Text.of(CONSORTIUM_EVENT_DEFS[id].name + ' queued for ' + consortiumClock(at.getTime()) + ' (slot ' + q.getString('calendar') + '). Reminders at minus 60 and minus 5 minutes.').green())
      return 1
    }
    let resolvePlayer = (ctx) => {
      let text = Arguments.WORD.getResult(ctx, 'player')
      let who = consortiumResolvePlayer(ctx.source.server, text)
      if (who === null) reply(ctx, Text.of('Unknown player "' + text + '": use the name of a player who has joined before, or a UUID.').red())
      return who
    }
    let arenaShow = (ctx) => {
      let arena = consortiumArena(ctx.source.server)
      reply(ctx, arena === null ? Text.of('Arena unset: stand at its centre and run /consortium event arena here [<radius>].').gray()
        : Text.of('Arena: ' + arena.dim + ' ' + arena.x + ' ' + arena.y + ' ' + arena.z + ', team ' + arena.team + ', radius ' + arena.radius + ' chunk(s).').gray())
      return 1
    }
    let arenaHere = (ctx, radius) => {
      if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Stand at the arena centre: this form needs a player (or use arena set <x> <y> <z> and arena team <player>).').red()); return 0 }
      let p = ctx.source.player
      let team = consortiumTeamOf(p)
      if (team === null) { reply(ctx, Text.of('FTB Teams has no team for you yet.').red()); return 0 }
      let a = NBT.compoundTag()
      // KubeJS exposes level.dimension as the ResourceLocation property (the vanilla dimension() method is
      // shadowed, see consortium_events_lib.js): calling it as a method throws "not a function".
      a.putString('dim', String(p.level.dimension))
      let pos = p.blockPosition()
      a.putInt('x', pos.getX()); a.putInt('y', pos.getY()); a.putInt('z', pos.getZ())
      a.putString('team', String(team.getId()).toLowerCase())
      a.putInt('radius', Math.max(1, Math.min(8, radius)))
      consortiumEvents(ctx.source.server).put('arena', a)
      console.info('[Consortium] ' + byName(ctx) + ' set the arena at ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' radius ' + a.getInt('radius'))
      return arenaShow(ctx)
    }
    let answer = (ctx, ok, text) => { reply(ctx, ok ? Text.of(text).green() : Text.of(text).red()); return ok ? 1 : 0 }

    eventNode = eventNode
      .then(Commands.literal('join').executes((ctx) => {
        if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Only a player can join.').red()); return 0 }
        reply(ctx, consortiumEventJoin(ctx.source.server, ctx.source.player, true)); return 1
      }))
      .then(Commands.literal('leave').executes((ctx) => {
        if (!ctx.source.isPlayer()) { reply(ctx, Text.of('Only a player can leave.').red()); return 0 }
        reply(ctx, consortiumEventJoin(ctx.source.server, ctx.source.player, false)); return 1
      }))
      .then(Commands.literal('list').requires(op(2)).executes((ctx) => {
        let server = ctx.source.server
        let ev = consortiumEvents(server)
        for (let i = 0; i < CONSORTIUM_EVENT_IDS.length; i++) {
          let id = CONSORTIUM_EVENT_IDS[i]
          let def = CONSORTIUM_EVENT_DEFS[id]
          let last = ev.getCompound('cooldowns').getLong(id)
          let left = last > 0 ? Math.max(0, last + def.cooldownHours * 3600000 - Date.now()) : 0
          let why = def.staffOnly ? 'staff only' : ev.getBoolean('paused') ? 'no (paused)' : consortiumEventEligibility(server, id, false)
          let eligible = why === null ? 'yes' : (why === 'staff only' || why.indexOf('no (') === 0) ? why : 'no (' + why + ')'
          let phaseText = 'phase ' + def.minPhase + '+' + (def.staffMinPhase && def.staffMinPhase < def.minPhase ? ' (staff from ' + def.staffMinPhase + ')' : '')
          reply(ctx, Text.of('  ' + id + ' (' + def.name + ', ' + def.kind + ', ' + def.minutes + ' min, weight ' + def.weight + ', ' + phaseText + '): ').gray()
            .append(Text.of('cooldown ' + (left > 0 ? Math.ceil(left / 60000) + ' min left' : 'none') + ', eligible: ' + eligible).white()))
        }
        reply(ctx, Text.of(CONSORTIUM_EVENT_IDS.length + ' event(s).').green())
        return 1
      }))
      .then(Commands.literal('slot').requires(op(2))
        .then(Commands.argument('slot', Arguments.WORD.create(event)).executes((ctx) => {
          let slot = String(Arguments.WORD.getResult(ctx, 'slot'))
          if (CONSORTIUM_EVENT_CALENDARS.indexOf(slot) < 0) { reply(ctx, Text.of('Slot must be friday, saturday or none.').red()); return 0 }
          let active = consortiumActiveEvent(ctx.source.server)
          if (active === null) { reply(ctx, Text.of('No event is running.').red()); return 0 }
          active.putString('calendar', slot)
          console.info('[Consortium] ' + byName(ctx) + ' set the running event slot to ' + slot)
          reply(ctx, Text.of('Slot of the running event set to ' + slot + '.').green())
          return 1
        })))
      .then(Commands.literal('start').requires(op(2))
        .then(Commands.argument('id', Arguments.WORD.create(event)).executes((ctx) => start(ctx, []))
          .then(Commands.argument('args', Arguments.GREEDY_STRING.create(event)).executes((ctx) => start(ctx, splitArgs(ctx, 'args'))))))
      .then(Commands.literal('stop').requires(op(2)).executes((ctx) => {
        if (consortiumActiveEvent(ctx.source.server) === null) { reply(ctx, Text.of('No event is running.').red()); return 0 }
        console.info('[Consortium] ' + byName(ctx) + ' stopped the running event')
        consortiumStopEvent(ctx.source.server, 'stop', null)
        reply(ctx, Text.of('Event stopped.').green())
        return 1
      }))
      .then(Commands.literal('next').requires(op(2))
        .executes((ctx) => {
          let ev = consortiumEvents(ctx.source.server)
          reply(ctx, Text.of('Random window: ' + consortiumEventNextWindowText(Date.now()) + (ev.getBoolean('paused') ? ' (scheduler paused)' : '') + '. Next Board slot: ' + consortiumNextSlot() + ' 20:00.').gray())
          if (ev.contains('queued')) {
            let q = ev.getCompound('queued')
            reply(ctx, Text.of('Queued: ' + q.getString('id') + ' at ' + consortiumClock(q.getLong('at')) + ', slot ' + q.getString('calendar') + '.').gray())
          } else {
            reply(ctx, Text.of('Nothing queued. /consortium event next <id> <hour> <minute> [args]').gray())
          }
          return 1
        })
        .then(Commands.literal('clear').executes((ctx) => {
          let ev = consortiumEvents(ctx.source.server)
          if (!ev.contains('queued')) { reply(ctx, Text.of('Nothing queued.').red()); return 0 }
          ev.remove('queued')
          reply(ctx, Text.of('Queue cleared.').green())
          return 1
        }))
        .then(Commands.argument('id', Arguments.WORD.create(event))
          .then(Commands.argument('hour', Arguments.INTEGER.create(event))
            .then(Commands.argument('minute', Arguments.INTEGER.create(event)).executes((ctx) => queue(ctx, []))
              .then(Commands.argument('args', Arguments.GREEDY_STRING.create(event)).executes((ctx) => queue(ctx, splitArgs(ctx, 'args'))))))))
      .then(Commands.literal('arena').requires(op(2))
        .then(Commands.literal('here').executes((ctx) => arenaHere(ctx, 3))
          .then(Commands.argument('radius', Arguments.INTEGER.create(event)).executes((ctx) => arenaHere(ctx, Arguments.INTEGER.getResult(ctx, 'radius')))))
        .then(Commands.literal('set').then(Commands.argument('pos', Arguments.BLOCK_POS.create(event)).executes((ctx) => {
          let pos = Arguments.BLOCK_POS.getResult(ctx, 'pos')
          let ev = consortiumEvents(ctx.source.server)
          let a = ev.contains('arena') ? ev.getCompound('arena') : NBT.compoundTag()
          a.putString('dim', 'minecraft:overworld')
          a.putInt('x', pos.getX()); a.putInt('y', pos.getY()); a.putInt('z', pos.getZ())
          if (!a.contains('radius')) a.putInt('radius', 3)
          ev.put('arena', a)
          let team = a.contains('team') && String(a.getString('team')).length ? String(a.getString('team')) : 'unset, run arena team <player>'
          reply(ctx, Text.of('Arena centre set to ' + pos.getX() + ' ' + pos.getY() + ' ' + pos.getZ() + ' (overworld). Team: ' + team + '.').green())
          return 1
        })))
        .then(Commands.literal('team').then(Commands.argument('player', Arguments.WORD.create(event)).executes((ctx) => {
          let who = resolvePlayer(ctx)
          if (who === null) return 0
          let team = consortiumTeamOfId(who.id)
          if (team === null) { reply(ctx, Text.of('FTB Teams has no team for ' + who.name + '.').red()); return 0 }
          let ev = consortiumEvents(ctx.source.server)
          let a = ev.contains('arena') ? ev.getCompound('arena') : NBT.compoundTag()
          a.putString('team', String(team.getId()).toLowerCase())
          if (!a.contains('radius')) a.putInt('radius', 3)
          if (!a.contains('dim')) a.putString('dim', 'minecraft:overworld')
          ev.put('arena', a)
          reply(ctx, Text.of('Arena team set to the team of ' + who.name + ' (' + a.getString('team') + ').').green())
          return 1
        })))
        .then(Commands.literal('show').executes(arenaShow)))
      .then(Commands.literal('pause').requires(op(2)).executes((ctx) => {
        consortiumEvents(ctx.source.server).putBoolean('paused', true)
        console.info('[Consortium] ' + byName(ctx) + ' paused the random events')
        reply(ctx, Text.of('Random events paused (staff starts and the queue still work).').green())
        return 1
      }))
      .then(Commands.literal('resume').requires(op(2)).executes((ctx) => {
        consortiumEvents(ctx.source.server).putBoolean('paused', false)
        console.info('[Consortium] ' + byName(ctx) + ' resumed the random events')
        reply(ctx, Text.of('Random events resumed: rolls every half hour inside the windows.').green())
        return 1
      }))
      .then(Commands.literal('debug').requires(op(4))
        .then(Commands.literal('roll').executes((ctx) => answer(ctx, true, consortiumEventRoll(ctx.source.server, null, true)))
          .then(Commands.argument('id', Arguments.WORD.create(event)).executes((ctx) => {
            let id = idArg(ctx)
            if (id === null) return 0
            return answer(ctx, true, consortiumEventRoll(ctx.source.server, id, true))
          })))
        .then(Commands.literal('muster').executes((ctx) => {
          let active = consortiumActiveEvent(ctx.source.server)
          if (active === null || String(active.getString('id')) !== 'invasion' || String(active.getString('stage')) !== 'muster') return answer(ctx, false, 'No invasion muster is running.')
          active.putLong('stageEndsAt', Date.now())
          return answer(ctx, true, 'Muster ends at the next 5 s step.')
        }))
        .then(Commands.literal('stage').executes((ctx) => {
          let active = consortiumActiveEvent(ctx.source.server)
          if (active === null || String(active.getString('id')) !== 'friday_zone') return answer(ctx, false, 'No Friday Zone is running.')
          active.putLong('stageEndsAt', Date.now())
          return answer(ctx, true, 'Stage ' + active.getString('stage') + ' ends at the next 5 s step.')
        }))
        .then(Commands.literal('paid').then(Commands.argument('player', Arguments.WORD.create(event)).then(Commands.argument('cents', Arguments.INTEGER.create(event)).executes((ctx) => {
          let who = resolvePlayer(ctx)
          if (who === null) return 0
          let cents = Math.max(0, Arguments.INTEGER.getResult(ctx, 'cents'))
          let d = consortiumDailyPaid(ctx.source.server, who.id)
          d.putLong('cents', cents)
          d.putLong('weekCents', Math.max(cents, d.getLong('weekCents')))
          return answer(ctx, true, 'dailyPaid of ' + who.name + ' set to ' + cents + ' cents today (room now ' + ConsortiumCore.format(consortiumEventRoom(ctx.source.server, who.id)) + ').')
        }))))
        .then(Commands.literal('wednesday').executes((ctx) => answer(ctx, true, consortiumEventWednesday(ctx.source.server, consortiumEvents(ctx.source.server), false))))
        .then(Commands.literal('clear').executes((ctx) => {
          let server = ctx.source.server
          if (consortiumActiveEvent(server) !== null) consortiumStopEvent(server, 'stop', null)
          let ev = consortiumEvents(server)
          let keep = NBT.compoundTag()
          if (ev.contains('arena')) keep.put('arena', ev.getCompound('arena').copy())
          if (ev.contains('tickets')) keep.put('tickets', ev.getCompound('tickets').copy())
          let summaryDay = ev.getInt('summaryDay')
          let wednesdayWeek = ev.contains('wednesdayWeek') ? ev.getInt('wednesdayWeek') : -1
          consortiumState(server).remove('events')
          let fresh = consortiumEvents(server)
          if (keep.contains('arena')) fresh.put('arena', keep.getCompound('arena'))
          if (keep.contains('tickets')) fresh.put('tickets', keep.getCompound('tickets'))
          fresh.putInt('summaryDay', summaryDay) // no spurious "Events yesterday" line after a wipe
          if (wednesdayWeek >= 0) fresh.putInt('wednesdayWeek', wednesdayWeek)
          consortiumBloodMoonClear(server)
          server.runCommandSilent('bossbar remove ' + CONSORTIUM_EVENT_BAR)
          consortiumKillTagged(server)
          consortiumPublishBoard(server, true)
          return answer(ctx, true, 'Events state wiped (arena and tickets kept), bar removed, tagged mobs killed.')
        })))
  }

  event.register(Commands.literal('consortium').then(eventNode))
})
// ==== END EVENTS BLOCK ====
