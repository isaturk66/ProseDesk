// Turns (old HTML, new HTML) into one merged HTML document where differences are
// marked as tracked changes:
//   <del data-cid="N">removed words</del>   <ins data-cid="N">added words</ins>
//   <p data-track-block="del:N">…</p>        whole blocks added / removed
// Both inputs should be normalized by the same editor schema first.
//
// Strategy: diff top-level blocks, pair up edited blocks by word similarity, then
// diff paired blocks word-by-word. Inside a paired block the merged tag sequence
// is always the NEW block's tags (removed text is spliced in as <del>), so the
// output nests correctly; formatting-only changes are applied silently.
import { diffArrays } from 'diff'

const TOKEN_RE = /<[^>]+>|&[#\w]+;|[\p{L}\p{N}'’]+|\s+|[^\s<&]|&/gu
const tokenize = s => s.match(TOKEN_RE) || []
const isTag = t => t.charCodeAt(0) === 60 /* < */
const isSpace = t => /^\s+$/.test(t)
const BLOCK_CLOSE = /^<\/(p|li|h[1-6]|blockquote|pre|td|th)>$/i

export function topBlocks(html) {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  return [...body.children].map(el => el.outerHTML)
}

const tagName = html => (html.match(/^<([a-z0-9]+)/i) || [])[1]?.toLowerCase()
const words = html => html.replace(/<[^>]+>/g, ' ').toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || []

function similarity(a, b) {
  const wa = words(a), wb = words(b)
  if (!wa.length && !wb.length) return 1
  const counts = new Map()
  wa.forEach(w => counts.set(w, (counts.get(w) || 0) + 1))
  let common = 0
  wb.forEach(w => { const c = counts.get(w); if (c) { common++; counts.set(w, c - 1) } })
  return (2 * common) / (wa.length + wb.length)
}

export function buildMerged(oldHtml, newHtml) {
  let nextId = 1
  const out = []
  const oldBlocks = topBlocks(oldHtml)
  const newBlocks = topBlocks(newHtml)

  // Whole block added or removed: tag the block and wrap all of its text.
  const wholeBlock = (html, kind) => {
    const id = nextId++
    const tag = kind === 'del' ? 'del' : 'ins'
    const toks = tokenize(html)
    toks[0] = toks[0].replace(/^<([a-z0-9]+)/i, `<$1 data-track-block="${kind}:${id}"`)
    return wrapTextRuns(toks, tag, id).join('')
  }

  const parts = diffArrays(oldBlocks, newBlocks)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p.added && !p.removed) { out.push(...p.value); continue }
    // Gather one contiguous change region (removed + added blocks).
    const removed = [], added = []
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      (parts[i].added ? added : removed).push(...parts[i].value)
      i++
    }
    i--
    let j = 0
    for (const r of removed) {
      let k = -1
      for (let x = j; x < added.length; x++) {
        if (tagName(added[x]) === tagName(r) && similarity(r, added[x]) >= 0.35) { k = x; break }
      }
      if (k < 0) { out.push(wholeBlock(r, 'del')); continue }
      for (; j < k; j++) out.push(wholeBlock(added[j], 'ins'))
      out.push(mergeInline(r, added[k], () => nextId++))
      j = k + 1
    }
    for (; j < added.length; j++) out.push(wholeBlock(added[j], 'ins'))
  }
  return { html: out.join(''), count: nextId - 1 }
}

function wrapTextRuns(tokens, tag, id) {
  const res = []
  let run = []
  const flush = () => { if (run.length) res.push(`<${tag} data-cid="${id}">${run.join('')}</${tag}>`); run = [] }
  for (const t of tokens) {
    if (isTag(t)) { flush(); res.push(t) } else run.push(t)
  }
  flush()
  return res
}

function mergeInline(oldBlock, newBlock, newId) {
  const segs = []
  for (const p of diffArrays(tokenize(oldBlock), tokenize(newBlock))) {
    if (!p.added && !p.removed) { segs.push({ eq: true, tokens: p.value }); continue }
    let last = segs[segs.length - 1]
    if (!last || last.eq) segs.push(last = { eq: false, removed: [], added: [] })
    ;(p.added ? last.added : last.removed).push(...p.value)
  }
  // Absorb single spaces between two changes so "a b c" -> "x y z" reads as one change.
  for (let i = 1; i < segs.length - 1; i++) {
    const s = segs[i]
    if (s.eq && s.tokens.every(isSpace) && !segs[i - 1].eq && !segs[i + 1].eq) {
      const a = segs[i - 1], b = segs[i + 1]
      a.removed.push(...s.tokens, ...b.removed)
      a.added.push(...s.tokens, ...b.added)
      segs.splice(i, 2)
      i--
    }
  }

  const out = []
  for (const s of segs) {
    if (s.eq) { out.push(...s.tokens); continue }
    const removedText = s.removed.filter(t => !isTag(t)).join('')
    const addedText = s.added.filter(t => !isTag(t)).join('')
    if (!removedText.trim() && !addedText.trim()) { out.push(...s.added); continue }
    const id = newId()
    if (removedText.trim()) {
      const del = `<del data-cid="${id}">${removedText}</del>`
      // Never leave text dangling between block tags (e.g. after </li>).
      let at = out.length
      while (at > 0 && BLOCK_CLOSE.test(out[at - 1])) at--
      out.splice(at, 0, del)
    }
    out.push(...wrapTextRuns(s.added, 'ins', id))
  }
  return out.join('')
}
