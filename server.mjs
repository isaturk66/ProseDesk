#!/usr/bin/env node
// ProseDesk — a Word-style editor with Claude Code in the loop.
//
//   prosedesk              open the current folder
//   prosedesk essay.html   open (or create) a document in the current folder
//   prosedesk some/folder  open another folder
//
// The folder becomes the workspace: the editor lists its .html documents and the
// embedded Claude Code session runs with it as the working directory, so it can
// read any reference material that lives there.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.join(os.homedir(), '.prosedesk')
const SELECTION_FILE = path.join(STATE_DIR, 'selection.json')
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// ---------------------------------------------------------------- cli
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: prosedesk [file.html | folder] [--no-open] [--port N] [--model NAME]

  prosedesk              open the current folder
  prosedesk essay.html   open (or create) essay.html in the current folder
  prosedesk ../course    open another folder

Options:
  --no-open      don't open the browser
  --port N       port to use (default 5178, next free port if taken)
  --model NAME   model for the built-in chat, e.g. sonnet or opus
  --hook         print the current editor selection (for a Claude Code hook)`)
  process.exit(0)
}

// Used as a UserPromptSubmit hook in a terminal Claude Code session: tells it what
// is highlighted in the ProseDesk editor opened on the same folder.
if (argv.includes('--hook')) {
  try {
    const sel = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'))
    const here = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    if (sel.text && samePath(sel.folder, here) && Date.now() - sel.at < 60 * 60 * 1000) {
      console.log(`ProseDesk selection in ${sel.file}: """${sel.text}"""`)
      if (sel.context && sel.context !== sel.text) console.log(`(inside the paragraph: """${sel.context}""")`)
    }
  } catch {}
  process.exit(0)
}

const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const flagValues = new Set(['--port', '--model'].map(flag))
const target = argv.find(a => !a.startsWith('--') && !flagValues.has(a))

let DOCS = path.resolve(process.env.PROSEDESK_DOCS || process.cwd())
let initialDoc = null
if (target) {
  const abs = path.resolve(target)
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) DOCS = abs
  else {
    DOCS = path.dirname(abs)
    initialDoc = path.basename(abs).replace(/\.html?$/i, '') + (/\.htm$/i.test(abs) ? '.htm' : '.html')
  }
}
if (!fs.existsSync(DOCS)) { console.error(`Folder not found: ${DOCS}`); process.exit(1) }

const PORT = Number(flag('--port') || process.env.PORT || 5178)
const MODEL = flag('--model') || process.env.PROSEDESK_MODEL || ''
const OPEN = !argv.includes('--no-open')

// Loaded after argument handling so `--hook` stays fast.
const { WebSocketServer } = await import('ws')
const { createServer: createVite } = await import('vite')

// ---------------------------------------------------------------- web + ws
const vite = await createVite({
  root: ROOT,
  appType: 'spa',
  logLevel: 'warn',
  server: { middlewareMode: true, hmr: false },
})
const server = http.createServer((req, res) => vite.middlewares(req, res))
const wss = new WebSocketServer({ server, path: '/ws' })

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
const broadcast = msg => wss.clients.forEach(ws => send(ws, msg))

// ---------------------------------------------------------------- documents
let current = null        // file name of the open document
let lastKnown = ''        // last content we wrote or already forwarded (echo guard)

const isDoc = f => /\.html?$/i.test(f)
const listFiles = () => fs.readdirSync(DOCS).filter(isDoc).sort((a, b) => a.localeCompare(b))
const filesMsg = () => ({ type: 'files', files: listFiles(), current, folder: DOCS })

const safeName = name => {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '')
  if (!n.replace(/\.html?$/i, '')) return null
  return isDoc(n) ? n : n + '.html'
}

function openDoc(name) {
  const file = path.join(DOCS, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, '<p></p>\n')
  current = name
  lastKnown = fs.readFileSync(file, 'utf8')
  broadcast({ type: 'doc', name, html: lastKnown })
}

let watchTimer = null
fs.watch(DOCS, (_event, filename) => {
  if (filename && isDoc(filename) && filename !== current) broadcast(filesMsg())
  if (!current || (filename && filename !== current)) return
  clearTimeout(watchTimer)
  watchTimer = setTimeout(() => {
    let content
    try { content = fs.readFileSync(path.join(DOCS, current), 'utf8') } catch { return }
    if (content === lastKnown) return
    lastKnown = content
    broadcast({ type: 'external', name: current, html: content })
  }, 150)
})

// A short map of the folder, sent with the first message of each conversation so
// Claude knows what reference material exists without being asked to look.
function folderListing(limit = 150) {
  const out = []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const rel = path.relative(DOCS, path.join(dir, e.name)).replaceAll('\\', '/')
      if (e.isDirectory()) {
        out.push(rel + '/')
        if (depth < 3) walk(path.join(dir, e.name), depth + 1)
      } else out.push(rel)
    }
  }
  walk(DOCS, 0)
  return out
}

// ---------------------------------------------------------------- claude
let proc = null
let sessionId = null
let freshSession = true
let busy = false
let outBuf = ''

function startClaude() {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', 'Read,Edit,Write,Glob,Grep',
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--append-system-prompt-file', path.join(ROOT, 'prompt.md'),
  ]
  if (MODEL) args.push('--model', MODEL)
  if (sessionId) args.push('--resume', sessionId)

  proc = spawn('claude', args, {
    cwd: DOCS,
    env: { ...process.env, PROSEDESK_EMBEDDED: '1' },
    windowsHide: true,
  })
  outBuf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    outBuf += chunk
    let i
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i).trim()
      outBuf = outBuf.slice(i + 1)
      if (!line) continue
      try { handleClaudeEvent(JSON.parse(line)) } catch { console.error('[claude] bad line', line.slice(0, 200)) }
    }
  })
  proc.stderr.on('data', d => console.error('[claude]', d.toString().trim()))
  proc.on('error', err => {
    const hint = err.code === 'ENOENT' ? ' — is Claude Code installed and on your PATH?' : ''
    console.error(`[claude] failed to start: ${err.message}${hint}`)
    proc = null
    finishTurn(`Could not start claude: ${err.message}${hint}`)
  })
  proc.on('exit', code => {
    proc = null
    if (busy) finishTurn(code ? `Claude exited (code ${code})` : null)
  })
}

function finishTurn(error, extra = {}) {
  busy = false
  broadcast({ type: 'chat-done', error, ...extra })
}

function handleClaudeEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'init') {
    sessionId = ev.session_id
    broadcast({ type: 'chat-meta', model: ev.model })
  } else if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
    const e = ev.event
    if (e.type === 'content_block_start' && e.content_block?.type === 'text') broadcast({ type: 'chat-block' })
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') broadcast({ type: 'chat-delta', text: e.delta.text })
  } else if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type !== 'tool_use') continue
      const target = c.input?.file_path || c.input?.pattern || c.input?.path || ''
      broadcast({ type: 'chat-tool', name: c.name, target: path.basename(String(target)) })
    }
  } else if (ev.type === 'result') {
    finishTurn(ev.is_error ? String(ev.result || ev.subtype || 'error') : null)
  }
}

function chat({ text, mode, selection }) {
  if (busy) return
  if (!proc) startClaude()
  busy = true
  const lines = [`[ProseDesk] Open document: ${current || '(none)'}`]
  if (freshSession) {
    lines.push('Files in the working folder (documents and reference material):', ...folderListing().map(f => `  ${f}`))
    freshSession = false
  }
  lines.push(mode === 'ask'
    ? 'Mode: ASK — do not modify any file. Answer in chat only.'
    : 'Mode: EDIT — make the change directly in the document with small, targeted edits.')
  if (selection?.text) {
    lines.push(`Selected text: """${selection.text}"""`)
    if (selection.context && selection.context !== selection.text)
      lines.push(`(inside the paragraph: """${selection.context}""")`)
  } else if (selection?.context) {
    lines.push(`Nothing selected; the cursor is in the paragraph: """${selection.context}"""`)
  }
  lines.push('', text)
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] } }
  proc.stdin.write(JSON.stringify(msg) + '\n')
}

function stopClaude(reset) {
  if (proc) { proc.removeAllListeners('exit'); proc.kill(); proc = null }
  if (reset) { sessionId = null; freshSession = true }
  if (busy) finishTurn(null, { stopped: true })
}

// ---------------------------------------------------------------- protocol
wss.on('connection', ws => {
  send(ws, filesMsg())
  if (current) send(ws, { type: 'doc', name: current, html: lastKnown })

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.type) {
      case 'open': {
        const name = safeName(msg.name)
        if (name) openDoc(name)
        broadcast(filesMsg())
        break
      }
      case 'save': {
        if (!current || msg.name !== current) break
        lastKnown = msg.html
        fs.writeFileSync(path.join(DOCS, current), msg.html)
        break
      }
      case 'selection': {
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true })
          fs.writeFileSync(SELECTION_FILE, JSON.stringify({ folder: DOCS, file: current, ...msg.selection, at: Date.now() }, null, 2))
        } catch {}
        break
      }
      case 'chat': chat(msg); break
      case 'chat-stop': stopClaude(false); break
      case 'chat-reset': stopClaude(true); broadcast({ type: 'chat-cleared' }); break
    }
  })
})

// ---------------------------------------------------------------- start
if (initialDoc) openDoc(initialDoc)

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = err => reject(err)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(port) })
  })
}
let port = PORT
for (;;) {
  try { await listen(port); break } catch (err) {
    if (err.code !== 'EADDRINUSE' || port > PORT + 20) throw err
    port++
  }
}

const url = `http://localhost:${port}`
console.log(`ProseDesk  ${url}`)
console.log(`Folder     ${DOCS}`)
console.log('Press Ctrl+C to stop.')
if (OPEN) {
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(opener)
}

process.on('exit', () => proc?.kill())
process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())
