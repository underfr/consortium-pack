// priority: 10
// The Consortium - the rulebook in game (docs/DISCORD_AND_COMMUNITY.md 7, docs/BATCH_3_INTERFACES.md 4; PROJECT_RULES
// safety rule on chat). Needs consortium_lib.js (CONSORTIUM_HAS_SDLINK, consortiumResolvePlayer) and
// consortium_phases.js (consortiumState) through consortium_charters.js (consortiumSub). No mod dependency.
//
// One source, kubejs/data/consortium/consortium_rules/rulebook.json ({ title, author, sections[] { id, title, lines[] } },
// the words are the docs-and-server implementer's; tools/rulebook-md.mjs renders the Discord pin from the same file),
// three renderings here:
//   /rules                 the index: one clickable line per section, the Discord invite line where SDLink runs
//   /rules <section id>    the lines of a section, then [index] and [next: ...] links
//   /rules book            a fresh copy of the written book, one per player per day (rules.book.<uuid> = epoch day)
// and two exports for the other scripts: consortiumRulebookStack() (the written book as an ItemStack, or null when the
// JSON is missing: the starter kit of consortium_onboarding.js gives it once at the first login) and
// consortiumRulebookGive(player) (the give plus its grey line: /rules book and /consortium rules give). This script has
// no PlayerEvents.loggedIn handler on purpose: the kit is the single first-login path, /rules book the lost-book path.
//
// The book model is the one of tools/rulebook-md.mjs (its four functions are copied below, so a page counted there is
// a page in game): a section's lines are joined by one blank line and word-wrapped greedily at 18 characters, a page
// holds 14 lines (12 body lines under a section title), page 1 is the cover with change_page links, every page is one
// JSON text component serialised as an SNBT string inside minecraft:written_book_content (syntax verified on the
// harness). The client wraps by pixel width while this model counts characters: the owner reads the last line of every
// page in the Test phase (DISCORD 13 step 4); the 18-character wrap and the 12-page budget are PLACEHOLDER.
//
// State: consortium.rules.book.<uuid> (int epoch day of the last /rules book copy). No em dashes.
// Rhino note: `const` only at file top level or as the first statements of a function; `let` in blocks.

const CONSORTIUM_RULES_PATH = 'kubejs/data/consortium/consortium_rules/rulebook.json'
const CONSORTIUM_RULES_WRAP = 18             // PLACEHOLDER (tools/rulebook-md.mjs WRAP)
const CONSORTIUM_RULES_PAGE_LINES = 14       // tools/rulebook-md.mjs PAGE_LINES
const CONSORTIUM_RULES_TITLE_PAGE_LINES = 12 // tools/rulebook-md.mjs TITLE_PAGE_LINES
const CONSORTIUM_RULES_MAX_PAGES = 12        // PLACEHOLDER budget after the cover (a warning, never a refusal)
const CONSORTIUM_RULES_COVER = 'THE CONSORTIUM\nSeason 1 rulebook\n\n'
const CONSORTIUM_RULES_BOOK_LINE = 'Your copy of the rulebook is in your inventory. /rules shows it in chat at any time.'
const CONSORTIUM_RULES_BOOK_REFUSAL = 'You already got a copy today; /rules shows it in chat at any time.'

let consortiumRulesCache = null    // { title, author, sections: [{ id, title, lines }] } or null
let consortiumRulesTried = false

// ---- source -----------------------------------------------------------------------------------------------

// Tolerant reads of the map JsonIO.read returns (a Java map in Rhino: both `o.get(k)` and `o[k]` are tried).
function consortiumRulesGet(o, k) {
  if (o === null || o === undefined) return undefined
  try {
    if (typeof o.get === 'function') {
      let v = o.get(k)
      if (v !== null && v !== undefined) return v
    }
  } catch (err) { /* not a map */ }
  try { return o[k] } catch (err) { return undefined }
}

function consortiumRulesArray(v) {
  let out = []
  if (v === null || v === undefined) return out
  try {
    if (typeof v.size === 'function' && typeof v.get === 'function') {
      for (let i = 0; i < v.size(); i++) out.push(v.get(i))
      return out
    }
  } catch (err) { /* not a list */ }
  if (typeof v.length === 'number') for (let i = 0; i < v.length; i++) out.push(v[i])
  return out
}

// The rulebook as plain JS, read once per script load (a /reload re-reads it); null with one WARN when missing or bad.
function consortiumRulesData() {
  if (consortiumRulesTried) return consortiumRulesCache
  consortiumRulesTried = true
  let raw = null
  try { raw = JsonIO.read(CONSORTIUM_RULES_PATH) } catch (err) { console.warn('[Consortium] rules: ' + CONSORTIUM_RULES_PATH + ' unreadable (' + err + '): /rules and the rulebook are off'); return null }
  if (raw === null || raw === undefined) { console.warn('[Consortium] rules: ' + CONSORTIUM_RULES_PATH + ' missing: /rules and the rulebook are off'); return null }
  let book = { title: String(consortiumRulesGet(raw, 'title') || 'Consortium Rulebook'), author: String(consortiumRulesGet(raw, 'author') || 'The Board'), sections: [] }
  let sections = consortiumRulesArray(consortiumRulesGet(raw, 'sections'))
  for (let i = 0; i < sections.length; i++) {
    let s = sections[i]
    let id = String(consortiumRulesGet(s, 'id') || '')
    if (!/^[a-z][a-z0-9_]*$/.test(id) || id === 'book') { console.warn('[Consortium] rules: section ' + (i + 1) + ' has a bad id "' + id + '", skipped'); continue }
    let lines = []
    let rawLines = consortiumRulesArray(consortiumRulesGet(s, 'lines'))
    for (let j = 0; j < rawLines.length; j++) {
      let l = String(rawLines[j]).trim()
      if (l.length) lines.push(l)
    }
    if (!lines.length) { console.warn('[Consortium] rules: section ' + id + ' has no line, skipped'); continue }
    book.sections.push({ id: id, title: String(consortiumRulesGet(s, 'title') || id), lines: lines })
  }
  if (!book.sections.length) { console.warn('[Consortium] rules: no usable section in ' + CONSORTIUM_RULES_PATH); return null }
  consortiumRulesCache = book
  return book
}

// ---- book model (copied from tools/rulebook-md.mjs: wrapLine, sectionBodyLines, paginateSection, buildBook) ------

function consortiumRulesWrap(text, width) {
  let out = []
  let cur = ''
  let words = String(text).trim().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    let w = words[i]
    while (w.length > width) {
      if (cur) { out.push(cur); cur = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out
}

function consortiumRulesBodyLines(section) {
  let body = []
  for (let i = 0; i < section.lines.length; i++) {
    if (i > 0) body.push('')
    let wrapped = consortiumRulesWrap(section.lines[i], CONSORTIUM_RULES_WRAP)
    for (let j = 0; j < wrapped.length; j++) body.push(wrapped[j])
  }
  return body
}

function consortiumRulesAllBlank(lines, from) {
  for (let i = from; i < lines.length; i++) if (lines[i] !== '') return false
  return true
}

function consortiumRulesPaginate(section) {
  let body = consortiumRulesBodyLines(section)
  let pages = []
  let i = 0
  let first = true
  do {
    let cap = first ? CONSORTIUM_RULES_TITLE_PAGE_LINES : CONSORTIUM_RULES_PAGE_LINES
    while (!first && i < body.length && body[i] === '') i++
    let chunk = body.slice(i, i + cap)
    i += chunk.length
    while (chunk.length && chunk[chunk.length - 1] === '') chunk.pop()
    pages.push({ title: first ? section.title : null, lines: chunk })
    first = false
  } while (i < body.length && !consortiumRulesAllBlank(body, i))
  return pages
}

// { sections: [{ id, title, lines, pages, firstPage }], pages: [component objects] }, page 1 = the cover.
function consortiumRulesBuild(book) {
  let sections = []
  let pageNo = 2
  for (let i = 0; i < book.sections.length; i++) {
    let s = book.sections[i]
    let pages = consortiumRulesPaginate(s)
    sections.push({ id: s.id, title: s.title, lines: s.lines, pages: pages, firstPage: pageNo })
    pageNo += pages.length
  }
  let cover = { text: CONSORTIUM_RULES_COVER, bold: true, extra: [] }
  for (let i = 0; i < sections.length; i++) {
    cover.extra.push({ text: (i + 1) + '. ' + sections[i].title + '\n', bold: false, underlined: true, color: 'dark_blue',
      clickEvent: { action: 'change_page', value: String(sections[i].firstPage) } })
  }
  cover.extra.push({ text: '\n[rules]', bold: false, underlined: true, color: 'dark_blue', clickEvent: { action: 'run_command', value: '/rules' } })
  let pages = [cover]
  for (let i = 0; i < sections.length; i++) {
    let ps = sections[i].pages
    for (let j = 0; j < ps.length; j++) {
      let p = ps[j]
      if (p.title) pages.push({ text: p.title + '\n\n', bold: true, extra: [{ text: p.lines.join('\n'), bold: false }] })
      else pages.push({ text: p.lines.join('\n') })
    }
  }
  return { sections: sections, pages: pages }
}

// An SNBT double-quoted string (a copy of consortiumSnbtString of consortium_quests.js, never a cross-file call).
function consortiumRulesSnbt(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

let consortiumRulesSpecCache = null
let consortiumRulesPages = 0 // pages after the cover, set with the spec

// The item spec of the written book, '' when the JSON is missing. Built once per script load.
function consortiumRulebookSpec() {
  if (consortiumRulesSpecCache !== null) return consortiumRulesSpecCache
  let book = consortiumRulesData()
  if (book === null) { consortiumRulesSpecCache = ''; return '' }
  let built = consortiumRulesBuild(book)
  let pages = []
  for (let i = 0; i < built.pages.length; i++) pages.push(consortiumRulesSnbt(JSON.stringify(built.pages[i])))
  consortiumRulesPages = built.pages.length - 1
  if (built.pages.length - 1 > CONSORTIUM_RULES_MAX_PAGES) console.warn('[Consortium] rules: the book renders to ' + (built.pages.length - 1) + ' pages after the cover (budget ' + CONSORTIUM_RULES_MAX_PAGES + ')')
  consortiumRulesSpecCache = 'minecraft:written_book[minecraft:written_book_content={title:' + consortiumRulesSnbt(book.title) + ',author:' + consortiumRulesSnbt(book.author)
    + ',pages:[' + pages.join(',') + ']}]'
  console.info('[Consortium] rules: rulebook built, ' + built.sections.length + ' sections, cover plus ' + (built.pages.length - 1) + ' pages, spec ' + consortiumRulesSpecCache.length + ' chars')
  return consortiumRulesSpecCache
}

// Pages after the cover of the last built spec (0 before the first build).
function consortiumRulebookPageCount() {
  consortiumRulebookSpec()
  return consortiumRulesPages
}

// The written book as an ItemStack, or null (JSON missing, or the spec refused by the item parser).
function consortiumRulebookStack() {
  let spec = consortiumRulebookSpec()
  if (!spec.length) return null
  try {
    let stack = Item.of(spec)
    return stack.isEmpty() ? null : stack
  } catch (err) {
    console.error('[Consortium] rules: written book spec refused: ' + err)
    return null
  }
}

// Gives a copy with its grey line. Returns false (and says why) when no book can be built.
function consortiumRulebookGive(player) {
  let stack = consortiumRulebookStack()
  if (stack === null) {
    player.tell(Text.of('The rulebook is not available right now; /rules shows it in chat.').red())
    return false
  }
  player.give(stack)
  player.tell(Text.of(CONSORTIUM_RULES_BOOK_LINE).gray())
  return true
}

// ---- chat renderings --------------------------------------------------------------------------------------------

function consortiumRulesBookTag(server) {
  return consortiumSub(consortiumSub(consortiumState(server), 'rules'), 'book')
}

function consortiumRulesEpochDay() {
  return Math.floor(Date.now() / 86400000)
}

// Rich lines to a player (tellraw carries the click events), plain text to the console.
function consortiumRulesTell(source, parts) {
  if (source.isPlayer()) {
    source.server.runCommandSilent('tellraw ' + source.player.username + ' ' + JSON.stringify(parts))
  } else {
    let plain = ''
    for (let i = 0; i < parts.length; i++) plain += typeof parts[i] === 'string' ? parts[i] : String(parts[i].text || '')
    source.sendSystemMessage(Text.of(plain))
  }
}

function consortiumRulesLink(text, command, hover) {
  return { text: text, color: 'aqua', underlined: true, clickEvent: { action: 'run_command', value: command }, hoverEvent: { action: 'show_text', contents: hover } }
}

function consortiumRulesIndex(source) {
  let book = consortiumRulesData()
  if (book === null) { source.sendSystemMessage(Text.of('The rulebook is not loaded (kubejs/data/consortium/consortium_rules/rulebook.json).').red()); return 0 }
  consortiumRulesTell(source, ['', { text: book.title, color: 'gold', bold: true }, { text: ' by ' + book.author + '. Click a section:', color: 'gray' }])
  for (let i = 0; i < book.sections.length; i++) {
    let s = book.sections[i]
    consortiumRulesTell(source, ['', { text: '  ' + (i + 1) + '. ', color: 'gray' }, consortiumRulesLink(s.title, '/rules ' + s.id, 'Read ' + s.title)])
  }
  let tail = ['', { text: 'A written copy: ', color: 'gray' }, consortiumRulesLink('/rules book', '/rules book', 'One copy per day')]
  if (CONSORTIUM_HAS_SDLINK) {
    tail.push({ text: '. Discord: ', color: 'gray' })
    tail.push(consortiumRulesLink('[join the server]', '/discord', 'Prints the invite link'))
  }
  consortiumRulesTell(source, tail)
  return 1
}

function consortiumRulesSection(source, id) {
  let book = consortiumRulesData()
  if (book === null) { source.sendSystemMessage(Text.of('The rulebook is not loaded.').red()); return 0 }
  let idx = -1
  for (let i = 0; i < book.sections.length; i++) if (book.sections[i].id === id) idx = i
  if (idx < 0) { source.sendSystemMessage(Text.of('Unknown section "' + id + '": /rules lists them.').red()); return 0 }
  let s = book.sections[idx]
  consortiumRulesTell(source, ['', { text: (idx + 1) + '. ' + s.title, color: 'gold', bold: true }])
  for (let i = 0; i < s.lines.length; i++) consortiumRulesTell(source, ['', { text: '  ' + s.lines[i], color: 'yellow' }])
  let tail = ['', consortiumRulesLink('[index]', '/rules', 'Back to the index')]
  if (idx + 1 < book.sections.length) {
    let next = book.sections[idx + 1]
    tail.push({ text: ' ', color: 'gray' })
    tail.push(consortiumRulesLink('[next: ' + next.title + ']', '/rules ' + next.id, 'Read ' + next.title))
  }
  consortiumRulesTell(source, tail)
  return 1
}

// /rules book: one copy per player per day.
function consortiumRulesBook(source) {
  if (!source.isPlayer()) { source.sendSystemMessage(Text.of('Only a player can receive the book; /rules prints it here.').red()); return 0 }
  let player = source.player
  let server = source.server
  let uuid = String(player.uuid).toLowerCase()
  let tag = consortiumRulesBookTag(server)
  let today = consortiumRulesEpochDay()
  if (tag.getInt(uuid) === today) { player.tell(Text.of(CONSORTIUM_RULES_BOOK_REFUSAL).yellow()); return 0 }
  if (!consortiumRulebookGive(player)) return 0
  tag.putInt(uuid, today)
  console.info('[Consortium] rules: book copy given to ' + player.username)
  return 1
}

// Staff helpers for the DISCORD BLOCK of consortium_commands.js.
function consortiumRulesResetStamp(server, uuid) {
  let tag = consortiumRulesBookTag(server)
  let had = tag.contains(String(uuid).toLowerCase())
  tag.remove(String(uuid).toLowerCase())
  return had
}

// ---- the /rules literal ------------------------------------------------------------------------------------------

// One executor per section id (a factory, so the closure holds its own id whatever the loop scoping does).
function consortiumRulesSectionExecutor(id) {
  return (ctx) => consortiumRulesSection(ctx.source, id)
}

ServerEvents.commandRegistry((event) => {
  const { commands: Commands } = event
  let book = consortiumRulesData()
  let root = Commands.literal('rules')
    .executes((ctx) => consortiumRulesIndex(ctx.source))
    .then(Commands.literal('book').executes((ctx) => consortiumRulesBook(ctx.source)))
  if (book !== null) {
    for (let i = 0; i < book.sections.length; i++) {
      root = root.then(Commands.literal(book.sections[i].id).executes(consortiumRulesSectionExecutor(book.sections[i].id)))
    }
  }
  event.register(root)
})

ServerEvents.loaded((event) => {
  let book = consortiumRulesData()
  if (book !== null) console.info('[Consortium] rules loaded: ' + book.sections.length + ' sections (/rules, /rules <section>, /rules book)')
})
