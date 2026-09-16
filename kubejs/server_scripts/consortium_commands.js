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
