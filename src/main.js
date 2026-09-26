import { Editor } from '@tiptap/core'
import { marked } from 'marked'
import { makeExtensions, attachKey } from './extensions.js'
import { buildMerged, topBlocks } from './diff.js'
import './style.css'

const $ = s => document.querySelector(s)
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
}

// ------------------------------------------------------------------ state
let ws = null
let docName = null
let pending = false      // tracked changes are on screen, document is read-only
let baseline = ''        // the user's accepted document while changes are pending
let saveTimer = null
let attached = null      // { text, context, from, to } — selection sent along with chat
let busy = false
let mode = store.get('prosedesk.mode', 'edit')

// ------------------------------------------------------------------ editor
const editor = new Editor({
  element: $('#editor'),
  extensions: makeExtensions(),
  content: '',
  onUpdate: () => { if (!pending) scheduleSave(); updateStatus() },
  onSelectionUpdate: () => onSelection(),
  onTransaction: () => updateToolbar(),
  onFocus: () => editor.view.dispatch(editor.state.tr.setMeta(attachKey, null)),
  onBlur: () => {
    if (attached) editor.view.dispatch(editor.state.tr.setMeta(attachKey, { from: attached.from, to: attached.to }))
  },
})

// A second, invisible editor that normalizes any HTML through the same schema,
// so the diff compares like with like.
const normEditor = new Editor({ element: document.createElement('div'), extensions: makeExtensions({ placeholder: false }) })
function normalize(html) {
  normEditor.commands.setContent(html || '<p></p>', { emitUpdate: false })
  return normEditor.getHTML()
}
const pretty = html => topBlocks(html).join('\n') + '\n'

function setDoc(html) {
  editor.chain().setMeta('addToHistory', false).setContent(html, { emitUpdate: false }).run()
  updateStatus()
}

// ------------------------------------------------------------------ saving
function scheduleSave() {
  clearTimeout(saveTimer)
  $('#saveStatus').textContent = 'Editing…'
  saveTimer = setTimeout(save, 400)
}
function save() {
  clearTimeout(saveTimer)
  if (pending || !docName) return
  wsSend({ type: 'save', name: docName, html: pretty(editor.getHTML()) })
  $('#saveStatus').textContent = 'Saved'
}

function updateStatus() {
  const n = editor.storage.characterCount?.words?.() ?? 0
  $('#wordCount').textContent = `${n} word${n === 1 ? '' : 's'}`
}

// ------------------------------------------------------------------ tracked changes
function onExternal(html) {
  const proposed = normalize(html)
  if (!pending) { clearTimeout(saveTimer); baseline = editor.getHTML() }
  if (proposed === baseline) { if (pending) finishReview(); return }

  const { html: merged, count } = buildMerged(baseline, proposed)
  if (!count) {
    // Only formatting changed: apply it directly.
    pending = false
    editor.setEditable(true, false)
    setDoc(proposed)
    baseline = proposed
    hideReview()
    return
  }
  pending = true
  editor.setEditable(false, false)
  setDoc(merged)
  showReview()
}

function changeIds() {
  const ids = []
  const add = c => { if (c && !ids.includes(c)) ids.push(c) }
  editor.state.doc.descendants(node => {
    if (node.attrs?.trackBlock) add(node.attrs.trackBlock.split(':')[1])
    for (const m of node.marks) if (m.type.name === 'insertion' || m.type.name === 'deletion') add(m.attrs.cid)
  })
  return ids
}

function resolve(cids, accept) {
  const match = c => cids === 'all' || cids.includes(c)
  const tr = editor.state.tr.setMeta('addToHistory', false)

  // Whole blocks first, back to front so positions stay valid.
  const blocks = []
  editor.state.doc.descendants((node, pos) => {
    const tb = node.attrs?.trackBlock
    if (tb && match(tb.split(':')[1])) blocks.push({ node, pos, kind: tb.split(':')[0] })
  })
  for (const b of blocks.reverse()) {
    if ((b.kind === 'del') === accept) tr.delete(b.pos, b.pos + b.node.nodeSize)
    else tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, trackBlock: null })
  }

  // Then inline insertions/deletions.
  const ranges = []
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.marks) {
      if ((m.type.name === 'insertion' || m.type.name === 'deletion') && match(m.attrs.cid))
        ranges.push({ from: pos, to: pos + node.nodeSize, mark: m })
    }
  })
  for (const r of ranges.reverse()) {
    if ((r.mark.type.name === 'deletion') === accept) tr.delete(r.from, r.to)
    else tr.removeMark(r.from, r.to, r.mark)
  }
  editor.view.dispatch(tr)
  hidePop()
  if (changeIds().length) showReview()
  else finishReview()
}

function finishReview() {
  pending = false
  editor.setEditable(true, false)
  baseline = editor.getHTML()
  hideReview()
  save()
}

// ------------------------------------------------------------------ review UI
let navIndex = -1
function showReview() {
  const n = changeIds().length
  $('#reviewBar .review-count').textContent = `Claude suggested ${n} change${n === 1 ? '' : 's'}`
  $('#reviewBar').classList.remove('hidden')
  document.body.classList.add('reviewing')
}
function hideReview() {
  $('#reviewBar').classList.add('hidden')
  document.body.classList.remove('reviewing')
  hidePop()
  navIndex = -1
}

const changeEls = cid => editor.view.dom.querySelectorAll(`[data-cid="${cid}"], [data-track-block$=":${cid}"]`)
const cidOf = el => el.dataset.cid || el.dataset.trackBlock?.split(':')[1]

function goto(step) {
  const ids = changeIds()
  if (!ids.length) return
  navIndex = (navIndex + step + ids.length) % ids.length
  const el = changeEls(ids[navIndex])[0]
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setTimeout(() => showPop(ids[navIndex], el), 250)
}

let popCid = null
function showPop(cid, el) {
  popCid = cid
  const r = el.getBoundingClientRect()
  const pop = $('#changePop')
  pop.classList.remove('hidden')
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`
  pop.style.top = `${r.bottom + 6}px`
  highlightGroup(cid, 'tc-active')
}
function hidePop() {
  popCid = null
  $('#changePop').classList.add('hidden')
  highlightGroup(null, 'tc-active')
}
function highlightGroup(cid, cls) {
  editor.view.dom.querySelectorAll('.' + cls).forEach(e => e.classList.remove(cls))
  if (cid) changeEls(cid).forEach(e => e.classList.add(cls))
}

editor.view.dom.addEventListener('click', e => {
  if (!pending) return
  const el = e.target.closest('[data-cid], [data-track-block]')
  if (el) showPop(cidOf(el), el)
  else hidePop()
})
editor.view.dom.addEventListener('mouseover', e => {
  if (!pending) return
  const el = e.target.closest('[data-cid], [data-track-block]')
  highlightGroup(el ? cidOf(el) : null, 'tc-hot')
})
$('#changePop .accept').onclick = () => popCid && resolve([popCid], true)
$('#changePop .reject').onclick = () => popCid && resolve([popCid], false)
$('#acceptAll').onclick = () => resolve('all', true)
$('#rejectAll').onclick = () => resolve('all', false)
$('#prevChange').onclick = () => goto(-1)
$('#nextChange').onclick = () => goto(1)
$('#docArea').addEventListener('scroll', hidePop)

// ------------------------------------------------------------------ selection → chat
let selTimer = null
function onSelection() {
  const { from, to, empty, $from, $to } = editor.state.selection
  if (empty) { setAttached(null); return }
  const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim()
  if (!text) { setAttached(null); return }
  const context = $from.sameParent($to) ? $from.parent.textContent : ''
  setAttached({ text, context, from, to })
}
function setAttached(sel) {
  attached = sel
  const chip = $('#selChip')
  chip.classList.toggle('hidden', !sel)
  if (sel) chip.querySelector('.sel-text').textContent = `“${sel.text.length > 90 ? sel.text.slice(0, 90) + '…' : sel.text}”`
  clearTimeout(selTimer)
  selTimer = setTimeout(() => wsSend({ type: 'selection', selection: sel ? { text: sel.text, context: sel.context } : { text: '' } }), 300)
}
$('#selChip button').onclick = () => {
  setAttached(null)
  editor.view.dispatch(editor.state.tr.setMeta(attachKey, null))
}

// ------------------------------------------------------------------ chat
const messages = $('#messages')
let turn = null   // { el, seg, text }

function scrollChat() { messages.scrollTop = messages.scrollHeight }

function addUserMsg(text, selText, m) {
  messages.querySelector('.hint')?.remove()
  const el = document.createElement('div')
  el.className = 'msg user'
  if (selText) {
    const q = document.createElement('div')
    q.className = 'quote'
    q.textContent = selText.length > 160 ? selText.slice(0, 160) + '…' : selText
    el.append(q)
  }
  const body = document.createElement('div')
  body.textContent = text
  el.append(body)
  const tag = document.createElement('span')
  tag.className = `mode-tag ${m}`
  tag.textContent = m === 'ask' ? 'Ask' : 'Edit'
  el.append(tag)
  messages.append(el)
  scrollChat()
}

function startTurn() {
  const el = document.createElement('div')
  el.className = 'msg assistant'
  el.innerHTML = '<div class="thinking">Thinking…</div>'
  messages.append(el)
  turn = { el, seg: null, text: '', raf: 0 }
  scrollChat()
}
function newSegment() {
  if (!turn) startTurn()
  turn.el.querySelector('.thinking')?.remove()
  turn.seg = document.createElement('div')
  turn.seg.className = 'md'
  turn.el.append(turn.seg)
  turn.text = ''
}
function appendDelta(text) {
  if (!turn?.seg) newSegment()
  turn.text += text
  if (!turn.raf) turn.raf = requestAnimationFrame(() => {
    turn.raf = 0
    turn.seg.innerHTML = marked.parse(turn.text)
    scrollChat()
  })
}
const TOOL_LABEL = { Read: 'Reading', Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', Glob: 'Looking for', Grep: 'Searching' }
function addTool(name, target) {
  if (!turn) startTurn()
  turn.el.querySelector('.thinking')?.remove()
  const chip = document.createElement('div')
  chip.className = `tool ${name === 'Edit' || name === 'Write' || name === 'MultiEdit' ? 'edit' : ''}`
  chip.textContent = `${TOOL_LABEL[name] || name} ${target}`
  turn.el.append(chip)
  turn.seg = null
  scrollChat()
}
function endTurn(err, stopped) {
  if (turn) {
    turn.el.querySelector('.thinking')?.remove()
    if (turn.seg && turn.text) turn.seg.innerHTML = marked.parse(turn.text)
    if (err || stopped) {
      const e = document.createElement('div')
      e.className = err ? 'error' : 'muted small'
      e.textContent = err || 'Stopped.'
      turn.el.append(e)
    }
  }
  turn = null
  setBusy(false)
  scrollChat()
}

function setBusy(b) {
  busy = b
  const btn = $('#sendBtn')
  btn.textContent = b ? 'Stop' : 'Send'
  btn.classList.toggle('danger', b)
  btn.classList.toggle('primary', !b)
}

function sendChat(text, m = mode, sel = attached) {
  text = text.trim()
  if (!text || busy) return false
  if (!ws || ws.readyState !== 1) { alertLine('Not connected to ProseDesk server.'); return false }
  if (!pending) save()
  addUserMsg(text, sel?.text, m)
  wsSend({ type: 'chat', text, mode: m, selection: sel ? { text: sel.text, context: sel.context } : null })
  setBusy(true)
  startTurn()
  return true
}

function alertLine(t) {
  const e = document.createElement('div')
  e.className = 'error'
  e.textContent = t
  messages.append(e)
  scrollChat()
}

$('#sendBtn').onclick = () => {
  if (busy) return wsSend({ type: 'chat-stop' })
  if (sendChat($('#chatInput').value)) $('#chatInput').value = ''
}
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    if (sendChat(e.target.value)) e.target.value = ''
  }
})
$('#newChatBtn').onclick = () => {
  wsSend({ type: 'chat-reset' })
}

function setMode(m) {
  mode = m
  store.set('prosedesk.mode', m)
  document.querySelectorAll('#modeToggle button').forEach(b => b.classList.toggle('on', b.dataset.mode === m))
}
document.querySelectorAll('#modeToggle button').forEach(b => { b.onclick = () => setMode(b.dataset.mode) })
setMode(mode)

// ------------------------------------------------------------------ Ctrl+K inline prompt
const cmdk = $('#cmdk')
const cmdkInput = cmdk.querySelector('input')
let cmdkSel = null

function openCmdK() {
  if (pending) return
  const { from, to, empty, $from } = editor.state.selection
  // With nothing selected, the request is about the paragraph the cursor is in.
  cmdkSel = empty
    ? { text: '', context: $from.parent.textContent, from, to }
    : { text: editor.state.doc.textBetween(from, to, '\n', ' ').trim(), context: $from.parent.textContent, from, to }
  const c = editor.view.coordsAtPos(to)
  cmdk.classList.remove('hidden')
  cmdk.style.left = `${Math.max(8, Math.min(c.left - 40, innerWidth - cmdk.offsetWidth - 8))}px`
  cmdk.style.top = `${Math.min(c.bottom + 8, innerHeight - 90)}px`
  cmdkInput.placeholder = empty ? 'Ask about this paragraph, or tell Claude what to write…' : 'Edit selection…'
  cmdkInput.value = ''
  cmdkInput.focus()
}
function closeCmdK(refocus = true) {
  cmdk.classList.add('hidden')
  if (refocus) editor.commands.focus()
}
cmdkInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeCmdK() }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (sendChat(cmdkInput.value, e.ctrlKey || e.metaKey ? 'ask' : 'edit', cmdkSel)) closeCmdK(false)
  }
})
cmdkInput.addEventListener('blur', () => setTimeout(() => closeCmdK(false), 100))

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'k' && editor.isFocused) { e.preventDefault(); openCmdK() }
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#chatInput').focus() }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save() }
  if (pending && e.target === document.body && !mod) {
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); goto(1) }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); goto(-1) }
    if (popCid && (e.key === 'y' || e.key === 'Enter')) { e.preventDefault(); resolve([popCid], true); goto(0) }
    if (popCid && (e.key === 'n' || e.key === 'Backspace')) { e.preventDefault(); resolve([popCid], false); goto(0) }
  }
})

// ------------------------------------------------------------------ toolbar
const ICON = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  left: '<path d="M4 6h16M4 12h10M4 18h14"/>',
  center: '<path d="M4 6h16M7 12h10M5 18h14"/>',
  right: '<path d="M4 6h16M10 12h10M6 18h14"/>',
  justify: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  bullet: '<circle cx="5" cy="7" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="17" r="1"/><path d="M9 7h11M9 12h11M9 17h11"/>',
  ordered: '<path d="M10 7h10M10 12h10M10 17h10"/><path d="M4 5h1v4M4 9h2"/><path d="M4 14.5c0-.8 2-.8 2 0 0 .9-2 1.5-2 2.5h2"/>',
  quote: '<path d="M6 17c-1.5 0-2.5-1-2.5-3 0-3 2-6 5-7M15 17c-1.5 0-2.5-1-2.5-3 0-3 2-6 5-7"/>',
  clear: '<path d="M4 7V5h14v2M11 5l-3 14M6 19h6"/><path d="m15 14 5 5m0-5-5 5"/>',
}
const icon = n => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`

const FONTS = ['Times New Roman', 'Georgia', 'Garamond', 'Cambria', 'Arial', 'Calibri', 'Helvetica', 'Verdana', 'Courier New']
const SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36']

const run = fn => () => { if (!pending) fn(editor.chain().focus()).run() }
const tb = $('#toolbar')
tb.innerHTML = `
  <button data-a="undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
  <button data-a="redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
  <span class="sep"></span>
  <select data-s="block" title="Paragraph style">
    <option value="p">Normal text</option><option value="h1">Title</option><option value="h2">Heading 1</option>
    <option value="h3">Heading 2</option><option value="h4">Heading 3</option><option value="quote">Quote</option>
  </select>
  <select data-s="font" title="Font">
    <option value="">Default font</option>${FONTS.map(f => `<option style="font-family:'${f}'">${f}</option>`).join('')}
  </select>
  <select data-s="size" title="Font size">
    <option value="">Size</option>${SIZES.map(s => `<option value="${s}pt">${s}</option>`).join('')}
  </select>
  <span class="sep"></span>
  <button data-a="bold" title="Bold (Ctrl+B)"><b>B</b></button>
  <button data-a="italic" title="Italic (Ctrl+I)"><i>I</i></button>
  <button data-a="underline" title="Underline (Ctrl+U)"><u>U</u></button>
  <button data-a="strike" title="Strikethrough"><s>S</s></button>
  <label class="color" title="Text color"><span class="swatch-a">A</span><input type="color" data-c="color" value="#c0392b"></label>
  <label class="color" title="Highlight"><span class="swatch-h">H</span><input type="color" data-c="highlight" value="#fff176"></label>
  <span class="sep"></span>
  <button data-a="left" title="Align left">${icon('left')}</button>
  <button data-a="center" title="Center">${icon('center')}</button>
  <button data-a="right" title="Align right">${icon('right')}</button>
  <button data-a="justify" title="Justify">${icon('justify')}</button>
  <span class="sep"></span>
  <button data-a="bullet" title="Bulleted list">${icon('bullet')}</button>
  <button data-a="ordered" title="Numbered list">${icon('ordered')}</button>
  <select data-s="spacing" title="Line spacing (whole document)">
    <option value="1.15">Spacing 1.15</option><option value="1.5">Spacing 1.5</option><option value="2">Spacing 2.0</option><option value="1">Spacing 1.0</option>
  </select>
  <span class="sep"></span>
  <button data-a="clear" title="Clear formatting">${icon('clear')}</button>
`
const ACTIONS = {
  undo: run(c => c.undo()),
  redo: run(c => c.redo()),
  bold: run(c => c.toggleBold()),
  italic: run(c => c.toggleItalic()),
  underline: run(c => c.toggleUnderline()),
  strike: run(c => c.toggleStrike()),
  left: run(c => c.setTextAlign('left')),
  center: run(c => c.setTextAlign('center')),
  right: run(c => c.setTextAlign('right')),
  justify: run(c => c.setTextAlign('justify')),
  bullet: run(c => c.toggleBulletList()),
  ordered: run(c => c.toggleOrderedList()),
  clear: run(c => c.unsetAllMarks().clearNodes()),
}
tb.querySelectorAll('button[data-a]').forEach(b => {
  b.onmousedown = e => e.preventDefault()
  b.onclick = ACTIONS[b.dataset.a]
})
tb.querySelector('[data-s="block"]').onchange = e => {
  const v = e.target.value
  run(c => v === 'p' ? c.setParagraph() : v === 'quote' ? c.setParagraph().toggleBlockquote() : c.setHeading({ level: Number(v[1]) }))()
}
tb.querySelector('[data-s="font"]').onchange = e => run(c => e.target.value ? c.setFontFamily(e.target.value) : c.unsetFontFamily())()
tb.querySelector('[data-s="size"]').onchange = e => run(c => e.target.value ? c.setFontSize(e.target.value) : c.unsetFontSize())()
tb.querySelector('[data-c="color"]').oninput = e => run(c => c.setColor(e.target.value))()
tb.querySelector('[data-c="highlight"]').oninput = e => run(c => c.setHighlight({ color: e.target.value }))()
const spacingSel = tb.querySelector('[data-s="spacing"]')
spacingSel.onchange = e => {
  document.documentElement.style.setProperty('--line', e.target.value)
  if (docName) store.set(`prosedesk.spacing.${docName}`, e.target.value)
}

function updateToolbar() {
  const is = (n, a) => editor.isActive(n, a)
  const active = {
    bold: is('bold'), italic: is('italic'), underline: is('underline'), strike: is('strike'),
    left: is({ textAlign: 'left' }), center: is({ textAlign: 'center' }), right: is({ textAlign: 'right' }), justify: is({ textAlign: 'justify' }),
    bullet: is('bulletList'), ordered: is('orderedList'),
  }
  tb.querySelectorAll('button[data-a]').forEach(b => b.classList.toggle('on', !!active[b.dataset.a]))
  const block = is('blockquote') ? 'quote' : [1, 2, 3, 4].find(l => is('heading', { level: l }))
  tb.querySelector('[data-s="block"]').value = block === 'quote' ? 'quote' : block ? `h${block}` : 'p'
  const ts = editor.getAttributes('textStyle')
  tb.querySelector('[data-s="font"]').value = ts.fontFamily?.replace(/["']/g, '') || ''
  tb.querySelector('[data-s="size"]').value = ts.fontSize || ''
  tb.classList.toggle('disabled', pending)
}

// ------------------------------------------------------------------ files
const fileSelect = $('#fileSelect')
fileSelect.onchange = () => { save(); wsSend({ type: 'open', name: fileSelect.value }) }
$('#newDocBtn').onclick = () => {
  $('#newDocBtn').classList.add('hidden')
  const i = $('#newDocInput')
  i.classList.remove('hidden')
  i.value = ''
  i.focus()
}
$('#newDocInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) { save(); wsSend({ type: 'open', name: e.target.value.trim() }) }
  if (e.key === 'Enter' || e.key === 'Escape') { e.target.classList.add('hidden'); $('#newDocBtn').classList.remove('hidden') }
})
$('#newDocInput').addEventListener('blur', e => { e.target.classList.add('hidden'); $('#newDocBtn').classList.remove('hidden') })
$('#printBtn').onclick = () => window.print()

let folder = ''
function onFiles({ files, current, folder: dir }) {
  folder = dir
  const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir
  $('#folderName').textContent = name
  $('#folderName').title = `${dir}\n\nClaude works in this folder and can read the files in it.`
  fileSelect.innerHTML = files.map(f => `<option value="${f}">${f.replace(/\.html?$/i, '')}</option>`).join('')
  if (current) fileSelect.value = current
  else {
    const last = store.get(`prosedesk.lastDoc.${folder}`, '')
    wsSend({ type: 'open', name: files.includes(last) ? last : files[0] || 'untitled' })
  }
}

function onDoc({ name, html }) {
  docName = name
  store.set(`prosedesk.lastDoc.${folder}`, name)
  fileSelect.value = name
  document.title = `${name.replace(/\.html?$/i, '')} — ProseDesk`
  pending = false
  editor.setEditable(true, false)
  hideReview()
  setDoc(html)
  baseline = editor.getHTML()
  const sp = store.get(`prosedesk.spacing.${name}`, '1.5')
  spacingSel.value = sp
  document.documentElement.style.setProperty('--line', sp)
  $('#saveStatus').textContent = 'Saved'
}

// ------------------------------------------------------------------ socket
function wsSend(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)) }

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onopen = () => $('#saveStatus').textContent = ''
  ws.onclose = () => {
    $('#saveStatus').textContent = 'Disconnected — retrying…'
    if (busy) endTurn('Connection lost.')
    setTimeout(connect, 1000)
  }
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'files': onFiles(msg); break
      case 'doc': onDoc(msg); break
      case 'external': if (msg.name === docName) onExternal(msg.html); break
      case 'chat-meta': $('#modelName').textContent = msg.model || ''; break
      case 'chat-block': newSegment(); break
      case 'chat-delta': appendDelta(msg.text); break
      case 'chat-tool': addTool(msg.name, msg.target); break
      case 'chat-done': endTurn(msg.error, msg.stopped); break
      case 'chat-cleared':
        messages.innerHTML = '<div class="hint">New conversation. Claude has forgotten the previous chat; the document is unchanged.</div>'
        if (busy) endTurn(null, true)
        break
    }
  }
}
connect()
updateToolbar()
