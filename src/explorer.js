// File explorer: a searchable folder tree for opening and creating documents.
//
//   Type to fuzzy-search every document in every subfolder.
//   ↑/↓ move · Enter open · →/← expand/collapse · Esc close
//   Typing a name that doesn't exist offers to create it (use / for subfolders).

const $ = s => document.querySelector(s)
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const baseName = p => p.split('/').pop()
const dirName = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
const stripExt = p => p.replace(/\.html?$/i, '')

const ICON = {
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
  other: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
}

function ago(ms) {
  if (!ms) return ''
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  const d = new Date(ms)
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

// Subsequence match scored like editor quick-open: consecutive runs, word starts
// and matches in the file name (rather than the folder path) score higher.
function fuzzy(query, text) {
  // Prefer a match inside the file name itself; fall back to the whole path.
  const cut = text.lastIndexOf('/') + 1
  if (cut) {
    const m = fuzzyFrom(query, text.slice(cut))
    if (m) return { score: m.score + 15, hits: m.hits.map(h => h + cut) }
  }
  return fuzzyFrom(query, text)
}
function fuzzyFrom(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase()
  const nameStart = t.lastIndexOf('/') + 1
  let ti = 0, score = 0, run = 0
  const hits = []
  for (const ch of q) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, ti)
    if (i < 0) return null
    run = i === ti && hits.length ? run + 1 : 0
    score += 1 + run * 2
    if (i === 0 || '/ -_.'.includes(t[i - 1])) score += 3
    if (i >= nameStart) score += 2
    hits.push(i)
    ti = i + 1
  }
  if (t.slice(nameStart).startsWith(q)) score += 10
  return { score: score - t.length * 0.02, hits }
}
function highlight(text, hits, offset = 0) {
  const set = new Set(hits)
  return [...text].map((c, i) => set.has(i + offset) ? `<mark>${esc(c)}</mark>` : esc(c)).join('')
}
// "week3/essay.html" -> dimmed folder part + name without extension, with search hits marked.
function pathLabel(r) {
  const cut = r.path.lastIndexOf('/') + 1
  const dir = r.path.slice(0, cut)
  const file = r.kind === 'doc' ? stripExt(r.path.slice(cut)) : r.path.slice(cut)
  const hits = r.hits || []
  return `${dir ? `<span class="ex-dir">${highlight(dir, hits)}</span>` : ''}${highlight(file, hits, cut)}`
}

export function createExplorer({ onOpen }) {
  const root = $('#explorer')
  const input = root.querySelector('.ex-search')
  const list = root.querySelector('.ex-list')
  const showAllBox = root.querySelector('.ex-showall')

  let entries = []            // { path, dir?, doc?, mtime? }
  let folderKey = ''
  let folderName = ''
  let current = null
  let closable = true
  let rows = []               // what is rendered
  let sel = -1
  let expanded = new Set()
  let showAll = false

  const docs = () => entries.filter(e => e.doc)
  const recents = () => store.get(`prosedesk.recent.${folderKey}`, []).filter(p => entries.some(e => e.path === p))

  function addRecent(p) {
    const r = [p, ...store.get(`prosedesk.recent.${folderKey}`, []).filter(x => x !== p)].slice(0, 12)
    store.set(`prosedesk.recent.${folderKey}`, r)
  }

  // Folders that contain at least one document somewhere below them.
  function docFolders() {
    const set = new Set()
    for (const e of docs()) {
      let d = dirName(e.path)
      while (d) { set.add(d); d = dirName(d) }
    }
    return set
  }

  function buildRows() {
    const q = input.value.trim()
    const out = []
    if (q) {
      const pool = entries.filter(e => !e.dir && (e.doc || showAll))
      const scored = []
      for (const e of pool) {
        const m = fuzzy(q, e.path)
        if (m) scored.push({ e, ...m })
      }
      scored.sort((a, b) => (b.e.doc - a.e.doc) || b.score - a.score)
      for (const s of scored.slice(0, 200)) {
        out.push({ kind: s.e.doc ? 'doc' : 'other', path: s.e.path, mtime: s.e.mtime, depth: 0, hits: s.hits, flat: true })
      }
      // Offer to create a document with this name if there isn't one already.
      const wanted = /\.html?$/i.test(q) ? q : q + '.html'
      if (!entries.some(e => e.path.toLowerCase() === wanted.toLowerCase())) {
        out.push({ kind: 'create', path: wanted, depth: 0 })
      }
      return out
    }

    const recent = recents().slice(0, 6)
    if (recent.length) {
      out.push({ kind: 'header', label: 'Recent' })
      for (const p of recent) {
        const e = entries.find(x => x.path === p)
        out.push({ kind: 'doc', path: p, mtime: e?.mtime, depth: 0, flat: true, recent: true })
      }
      out.push({ kind: 'header', label: folderName || 'Files' })
    }

    const withDocs = docFolders()
    const children = new Map()
    for (const e of entries) {
      if (e.dir && !showAll && !withDocs.has(e.path)) continue
      if (!e.dir && !e.doc && !showAll) continue
      const parent = dirName(e.path)
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(e)
    }
    const walk = (dir, depth) => {
      const kids = (children.get(dir) || []).sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || byName(baseName(a.path), baseName(b.path)))
      for (const e of kids) {
        if (e.dir) {
          const open = expanded.has(e.path)
          out.push({ kind: 'folder', path: e.path, depth, open })
          if (open) walk(e.path, depth + 1)
        } else {
          out.push({ kind: e.doc ? 'doc' : 'other', path: e.path, mtime: e.mtime, depth })
        }
      }
    }
    walk('', 0)
    if (!out.some(r => r.kind === 'doc' || r.kind === 'folder')) out.push({ kind: 'empty' })
    return out
  }

  const selectable = r => r && r.kind !== 'header' && r.kind !== 'empty'

  function render(keepPath) {
    const prev = keepPath ?? rows[sel]?.path
    rows = buildRows()
    sel = rows.findIndex(r => selectable(r) && r.path === prev && !r.recent)
    if (sel < 0) sel = rows.findIndex(r => selectable(r) && r.path === prev)
    if (sel < 0) sel = rows.findIndex(r => selectable(r) && (r.kind === 'doc' || r.kind === 'create'))
    if (sel < 0) sel = rows.findIndex(selectable)

    list.innerHTML = rows.map((r, i) => {
      if (r.kind === 'header') return `<div class="ex-header">${esc(r.label)}</div>`
      if (r.kind === 'empty') return `<div class="ex-empty">No documents here yet. Type a name above and press Enter to create one.</div>`
      const pad = `style="padding-left:${12 + r.depth * 18}px"`
      const cls = ['ex-row', r.kind, i === sel ? 'sel' : '', r.path === current ? 'current' : ''].join(' ')
      if (r.kind === 'create') {
        return `<div class="${cls}" data-i="${i}" ${pad}><span class="ex-icon">${ICON.plus}</span>
          <span class="ex-name">New document <b>${esc(stripExt(r.path))}</b></span><span class="ex-meta">Enter</span></div>`
      }
      if (r.kind === 'folder') {
        return `<div class="${cls} ${r.open ? 'open' : ''}" data-i="${i}" ${pad}><span class="ex-chevron">${ICON.chevron}</span>
          <span class="ex-icon">${ICON.folder}</span><span class="ex-name">${esc(baseName(r.path))}</span></div>`
      }
      const label = r.flat ? pathLabel(r) : esc(r.kind === 'doc' ? stripExt(baseName(r.path)) : baseName(r.path))
      return `<div class="${cls}" data-i="${i}" ${pad}><span class="ex-chevron"></span><span class="ex-icon">${ICON[r.kind]}</span>
        <span class="ex-name">${label}${r.path === current ? ' <span class="ex-open">open</span>' : ''}</span>
        <span class="ex-meta">${r.kind === 'other' ? 'Claude can read' : ago(r.mtime)}</span></div>`
    }).join('')
    scrollToSel()
  }

  function scrollToSel() {
    list.querySelector('.ex-row.sel')?.scrollIntoView({ block: 'nearest' })
  }

  function move(step) {
    if (!rows.some(selectable)) return
    let i = sel
    do { i = (i + step + rows.length) % rows.length } while (!selectable(rows[i]))
    sel = i
    list.querySelectorAll('.ex-row').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === sel))
    scrollToSel()
  }

  function toggleFolder(p, open) {
    if (open ?? !expanded.has(p)) expanded.add(p); else expanded.delete(p)
    store.set(`prosedesk.expanded.${folderKey}`, [...expanded])
    render(p)
  }

  function activate(r) {
    if (!r) return
    if (r.kind === 'folder') return toggleFolder(r.path)
    if (r.kind === 'doc') { onOpen(r.path, false); return }
    if (r.kind === 'create') { onOpen(r.path, true); return }
  }

  input.addEventListener('input', () => render())
  input.addEventListener('keydown', e => {
    const r = rows[sel]
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); activate(r) }
    else if (e.key === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; render() } else close() }
    else if (e.key === 'ArrowRight' && !input.value && r?.kind === 'folder') { e.preventDefault(); toggleFolder(r.path, true) }
    else if (e.key === 'ArrowLeft' && !input.value && r) {
      e.preventDefault()
      if (r.kind === 'folder' && r.open) toggleFolder(r.path, false)
      else if (dirName(r.path)) { toggleFolder(dirName(r.path), false) }
    }
  })
  list.addEventListener('mousedown', e => e.preventDefault())   // keep typing focus in the search box
  list.addEventListener('click', e => {
    const el = e.target.closest('.ex-row')
    if (!el) return
    sel = Number(el.dataset.i)
    activate(rows[sel])
  })
  showAllBox.addEventListener('change', () => {
    showAll = showAllBox.checked
    store.set(`prosedesk.showAll.${folderKey}`, showAll)
    render()
    input.focus()
  })
  root.querySelector('.ex-new').addEventListener('click', () => {
    // Start a new document in the folder of the selected row.
    const r = rows[sel]
    const dir = r?.kind === 'folder' ? r.path : r?.path && !r.recent ? dirName(r.path) : ''
    input.value = dir ? dir + '/' : ''
    input.placeholder = 'Name the new document, then Enter'
    render()
    input.focus()
  })
  root.addEventListener('mousedown', e => { if (e.target === root && closable) close() })

  function open({ closable: c = true } = {}) {
    closable = c && !!current
    root.classList.toggle('locked', !closable)
    root.classList.remove('hidden')
    input.value = ''
    input.placeholder = 'Search documents…'
    render(current || recents()[0])
    input.focus()
  }
  // `force` is used once a document has opened, which always ends the picker.
  function close(force = false) {
    if (!closable && !force) return
    root.classList.add('hidden')
  }

  return {
    get isOpen() { return !root.classList.contains('hidden') },
    open,
    close,
    setFolder(key, name) {
      if (key === folderKey) return
      folderKey = key
      folderName = name
      expanded = new Set(store.get(`prosedesk.expanded.${key}`, []))
      showAll = store.get(`prosedesk.showAll.${key}`, false)
      showAllBox.checked = showAll
      root.querySelector('.ex-folder').textContent = name
      root.querySelector('.ex-folder').title = key
    },
    setEntries(list, truncated) {
      entries = list
      root.querySelector('.ex-truncated').classList.toggle('hidden', !truncated)
      if (this.isOpen) render()
    },
    setCurrent(p) {
      current = p
      if (!p) return
      addRecent(p)
      // Reveal the open document in the tree.
      let d = dirName(p)
      while (d) { expanded.add(d); d = dirName(d) }
      store.set(`prosedesk.expanded.${folderKey}`, [...expanded])
    },
    error(message) {
      list.insertAdjacentHTML('afterbegin', `<div class="ex-error">${esc(message)}</div>`)
      setTimeout(() => list.querySelector('.ex-error')?.remove(), 3000)
    },
  }
}
