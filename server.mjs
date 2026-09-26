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
import { spawn, exec, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHistory } from './history.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.join(os.homedir(), '.prosedesk')
const SELECTION_FILE = path.join(STATE_DIR, 'selection.json')
const INSTANCES_DIR = path.join(STATE_DIR, 'instances')
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// ---------------------------------------------------------------- instances
// Every running server registers itself in ~/.prosedesk/instances/<pid>.json.
// Before stopping anything we confirm the PID is really a ProseDesk server (its
// command line runs server.mjs), so a stale file can never kill an unrelated
// process that happens to reuse the PID.
function nodeProcesses() {
  try {
    let out
    if (process.platform === 'win32') {
      const ps = '$ProgressPreference = "SilentlyContinue"; Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
      out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } else {
      out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    }
    return out.split(/\r?\n/).map(line => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      return m && { pid: Number(m[1]), cmd: m[2] }
    }).filter(p => p && p.pid !== process.pid && /server\.mjs/i.test(p.cmd))
  } catch {
    return []
  }
}

function runningInstances() {
  const procs = nodeProcesses()
  const registered = []
  let files = []
  try { files = fs.readdirSync(INSTANCES_DIR) } catch {}
  for (const f of files) {
    const file = path.join(INSTANCES_DIR, f)
    let info = null
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (info && procs.some(p => p.pid === info.pid)) registered.push(info)
    else fs.rmSync(file, { force: true })
  }
  // Servers started before instances were registered.
  const unregistered = procs
    .filter(p => /prosedesk/i.test(p.cmd) && !registered.some(r => r.pid === p.pid))
    .map(p => ({ pid: p.pid }))
  return [...registered, ...unregistered]
}

function describe(i) {
  return i.folder ? `${i.folder}  ${i.url}` : `older ProseDesk process (PID ${i.pid})`
}

async function stopInstances(list) {
  for (const i of list) {
    try {
      // /T also ends the Claude Code child process on Windows.
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(i.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(i.pid, 'SIGTERM')
    } catch {}
    fs.rmSync(path.join(INSTANCES_DIR, `${i.pid}.json`), { force: true })
  }
  // Wait for the ports to be released.
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let t = 0; t < 30 && list.some(i => alive(i.pid)); t++) await new Promise(r => setTimeout(r, 100))
}

function openBrowser(url) {
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(opener)
}

// ---------------------------------------------------------------- cli
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: prosedesk [file.html | folder] [--no-open] [--port N] [--model NAME]

  prosedesk              open the current folder
  prosedesk essay.html   open (or create) essay.html in the current folder
  prosedesk ../notes     open another folder

  prosedesk list         show running instances
  prosedesk stop         stop the instance for the current folder
  prosedesk stopall      stop every running instance

Options:
  --no-open      don't open the browser
  --new          start a new instance without asking, even if one is running
  --port N       port to use (default 5178, next free port if taken)
  --model NAME   model for the built-in chat, e.g. sonnet or opus
  --hook         print the current editor selection (for a Claude Code hook)`)
  process.exit(0)
}

const command = argv[0]
if (command === 'list' || command === 'stop' || command === 'stopall') {
  const all = runningInstances()
  if (command === 'list') {
    console.log(all.length ? all.map(describe).join('\n') : 'No ProseDesk instances running.')
    process.exit(0)
  }
  const here = path.resolve(argv[1] || process.cwd())
  const targets = command === 'stopall' ? all : all.filter(i => i.folder && samePath(i.folder, here))
  if (!targets.length) {
    console.log(command === 'stopall' ? 'No ProseDesk instances running.' : `No ProseDesk instance running for ${here}.`)
    process.exit(0)
  }
  await stopInstances(targets)
  for (const i of targets) console.log(`Stopped ${describe(i)}`)
  process.exit(0)
}

// Used as a UserPromptSubmit hook in a terminal Claude Code session: tells it what
// is highlighted in the ProseDesk editor opened on the same folder.
if (argv.includes('--hook')) {
  // The built-in chat already sends the selection itself.
  if (process.env.PROSEDESK_EMBEDDED) process.exit(0)
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
    // A file inside the current folder keeps the current folder as the workspace
    // (so `prosedesk week3/essay` still sees everything); anything else uses its own folder.
    const file = /\.html?$/i.test(abs) ? abs : abs + '.html'
    if (!file.startsWith(DOCS + path.sep)) DOCS = path.dirname(file)
    initialDoc = path.relative(DOCS, file).replaceAll('\\', '/')
  }
}
if (!fs.existsSync(DOCS)) { console.error(`Folder not found: ${DOCS}`); process.exit(1) }

const PORT = Number(flag('--port') || process.env.PORT || 5178)
const MODEL = flag('--model') || process.env.PROSEDESK_MODEL || ''
const OPEN = !argv.includes('--no-open')

// Already running? Ask what to do instead of silently starting a second copy.
if (!argv.includes('--new')) {
  const running = runningInstances()
  const same = running.find(i => i.folder && samePath(i.folder, DOCS))
  if (running.length) {
    let choice = same ? 'o' : 'n'
    if (process.stdin.isTTY) {
      console.log(`ProseDesk is already running:\n${running.map(i => '  ' + describe(i)).join('\n')}\n`)
      const options = [
        same && `  [o] open the one for this folder${choice === 'o' ? ' (default)' : ''}`,
        `  [s] stop ${running.length > 1 ? 'them' : 'it'} and start fresh here`,
        `  [n] start another one on a free port${choice === 'n' ? ' (default)' : ''}`,
        '  [q] quit',
      ].filter(Boolean)
      console.log(options.join('\n'))
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = (await rl.question('> ')).trim().toLowerCase()
      rl.close()
      if (answer) choice = answer[0]
    }
    if (choice === 'q') process.exit(0)
    if (choice === 'o' && same) {
      if (initialDoc) {
        await fetch(`${same.url}/api/open?name=${encodeURIComponent(initialDoc)}`, { method: 'POST' }).catch(() => {})
      }
      console.log(`Opening ${same.url}`)
      if (OPEN) openBrowser(same.url)
      process.exit(0)
    }
    if (choice === 's') {
      await stopInstances(running)
      console.log(`Stopped ${running.length} instance${running.length > 1 ? 's' : ''}.`)
    }
  }
}

// Loaded after argument handling so `--hook` stays fast.
const { WebSocketServer } = await import('ws')

// ---------------------------------------------------------------- web + ws
// The editor is built once into dist/ and served as static files. It is rebuilt
// automatically whenever index.html or src/ is newer than the build.
const DIST = path.join(ROOT, 'dist')
async function ensureBuilt() {
  const sources = ['index.html', ...fs.readdirSync(path.join(ROOT, 'src')).map(f => path.join('src', f))]
  const newest = Math.max(...sources.map(f => fs.statSync(path.join(ROOT, f)).mtimeMs))
  let built = 0
  try { built = fs.statSync(path.join(DIST, 'index.html')).mtimeMs } catch {}
  if (built >= newest) return
  console.log('Building the editor…')
  const { build } = await import('vite')
  await build({ root: ROOT, logLevel: 'warn', build: { outDir: DIST, emptyOutDir: true } })
}
await ensureBuilt()

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
}
function serveStatic(req, res) {
  let pathname = '/'
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch {}
  const file = path.join(DIST, path.normalize(pathname === '/' ? '/index.html' : pathname))
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end() }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/transcribe' && req.method === 'POST') return transcribe(req, res)
  if (req.url.startsWith('/api/open?') && req.method === 'POST') {
    // Used when `prosedesk file.html` hands a document to an already running instance.
    const name = safeName(new URL(req.url, 'http://x').searchParams.get('name'))
    if (name) { openDoc(name, { create: true }); broadcast(filesMsg()) }
    res.writeHead(name ? 204 : 400)
    return res.end()
  }
  serveStatic(req, res)
})
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('error', () => {})   // listen errors are handled where we pick the port

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
const broadcast = msg => wss.clients.forEach(ws => send(ws, msg))

// ---------------------------------------------------------------- dictation
// Settings live in .env next to server.mjs. It is re-read on every request, so a
// newly pasted key works after a page reload, without restarting.
function readEnv() {
  const env = {}
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {}
  return env
}
const openaiKey = () => readEnv().OPENAI_API_KEY || process.env.OPENAI_API_KEY || ''

async function transcribe(req, res) {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const key = openaiKey()
  if (!key) return reply(400, { error: 'No OPENAI_API_KEY in .env' })
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 25e6) return reply(413, { error: 'Recording is too long (25 MB limit).' })
    chunks.push(c)
  }
  const type = req.headers['content-type'] || 'audio/webm'
  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
  const env = readEnv()
  const { fetch, FormData, ProxyAgent } = await import('undici')
  const form = new FormData()
  form.append('file', new Blob([Buffer.concat(chunks)], { type }), `dictation.${ext}`)
  form.append('model', env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe')
  // OpenAI is not available in every region; route through a proxy if one is set.
  const proxy = env.OPENAI_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return reply(r.status, { error: data.error?.message || `OpenAI error ${r.status}` })
    reply(200, { text: data.text || '' })
  } catch (err) {
    reply(502, { error: `Could not reach OpenAI: ${err.message}` })
  }
}

// ---------------------------------------------------------------- documents
let current = null        // path of the open document, relative to DOCS with "/" separators
let lastKnown = ''        // last content we wrote or already forwarded (echo guard)

const isDoc = f => /\.html?$/i.test(f)
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv'])
const TREE_LIMIT = 10000

// Every file and folder under DOCS (hidden folders and dependency folders skipped),
// for the file explorer. Documents are marked so the explorer can focus on them.
function listTree() {
  const entries = []
  const walk = (dir, depth) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of items) {
      if (entries.length >= TREE_LIMIT) return
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const full = path.join(dir, e.name)
      const rel = path.relative(DOCS, full).replaceAll('\\', '/')
      if (e.isDirectory()) {
        entries.push({ path: rel, dir: true })
        if (depth < 12) walk(full, depth + 1)
      } else if (e.isFile()) {
        let mtime = 0
        try { mtime = fs.statSync(full).mtimeMs } catch {}
        entries.push({ path: rel, doc: isDoc(e.name), mtime })
      }
    }
  }
  walk(DOCS, 0)
  return entries
}

const filesMsg = (entries = listTree()) => ({
  type: 'files',
  entries,
  truncated: entries.length >= TREE_LIMIT,
  current,
  folder: DOCS,
  transcribe: !!openaiKey(),
})

// A document path from the client or the command line: relative, inside DOCS,
// with an .html/.htm extension. Returns null for anything that escapes the folder.
const cleanPath = p => {
  const n = String(p || '').trim().replaceAll('\\', '/').split('/').map(s => s.trim()).filter(Boolean).join('/')
  if (!n || /[:*?"<>|]/.test(n) || n.split('/').some(s => s === '..' || s === '.' || s.startsWith('.'))) return null
  return path.resolve(DOCS, n).startsWith(path.resolve(DOCS) + path.sep) ? n : null
}
const safeName = name => {
  let n = cleanPath(name)
  if (!n || !n.replace(/\.html?$/i, '').split('/').pop()) return null
  if (!isDoc(n)) n += '.html'
  return n
}

// ---------------------------------------------------------------- history
const history = createHistory(DOCS)
const AUTOSAVE_MS = Number(process.env.PROSEDESK_AUTOSAVE_SECONDS || 30) * 1000
let autoTimer = null

const historyMsg = () => ({
  type: 'history',
  name: current,
  enabled: history.enabled,
  items: current ? history.list(current) : [],
})

function snapshot(label) {
  clearTimeout(autoTimer)
  autoTimer = null
  if (current && history.snapshot(current, lastKnown, label)) broadcast(historyMsg())
}

// While you write, keep at most one version every 30 seconds.
function scheduleAutosave() {
  if (!autoTimer) autoTimer = setTimeout(() => snapshot('Autosave'), AUTOSAVE_MS)
}

// Opens a document; creates it only when asked to (a new document from the explorer,
// or a file name given on the command line). Returns false if it doesn't exist.
function openDoc(name, { create = false } = {}) {
  const file = path.join(DOCS, name)
  if (!fs.existsSync(file)) {
    if (!create) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '<p></p>\n')
  }
  if (current && current !== name && autoTimer) snapshot('Autosave')
  current = name
  lastKnown = fs.readFileSync(file, 'utf8')
  history.snapshot(name, lastKnown, 'Opened')
  broadcast({ type: 'doc', name, html: lastKnown })
  broadcast(historyMsg())
  return true
}

let watchTimer = null
let treeTimer = null
fs.watch(DOCS, { recursive: true }, (_event, filename) => {
  const rel = filename ? String(filename).replaceAll('\\', '/') : null
  // Our own history writes, and hidden or dependency folders, are not the user's files.
  if (rel && rel.split('/').some(s => s.startsWith('.') || SKIP_DIRS.has(s))) return
  if (rel !== current) {
    clearTimeout(treeTimer)
    treeTimer = setTimeout(() => broadcast(filesMsg()), 300)
  }
  if (!current || (rel && rel !== current)) return
  clearTimeout(watchTimer)
  watchTimer = setTimeout(() => {
    let content
    try { content = fs.readFileSync(path.join(DOCS, current), 'utf8') } catch { return }
    if (content === lastKnown) return
    // Keep the version from just before someone else (Claude, another editor) changed the file.
    snapshot(busy ? 'Before Claude' : 'Before outside edit')
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
  if (mode !== 'ask') {
    const short = text.replace(/\s+/g, ' ').trim()
    snapshot(`Before Claude: ${short.length > 70 ? short.slice(0, 70) + '…' : short}`)
  }
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
  if (current) {
    send(ws, { type: 'doc', name: current, html: lastKnown })
    send(ws, historyMsg())
  }

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.type) {
      case 'open': {
        const name = safeName(msg.name)
        if (!name || !openDoc(name, { create: !!msg.create })) {
          send(ws, { type: 'open-error', name: msg.name, error: name ? 'That document no longer exists.' : 'Not a valid document name.' })
          break
        }
        broadcast(filesMsg())
        break
      }
      case 'save': {
        if (!current || msg.name !== current) break
        lastKnown = msg.html
        fs.writeFileSync(path.join(DOCS, current), msg.html)
        if (msg.label) snapshot(msg.label)   // end of a review: record it right away
        else scheduleAutosave()
        break
      }
      case 'mkdir': {
        const dir = cleanPath(msg.path)
        try {
          if (!dir) throw new Error('Not a valid folder name.')
          if (fs.existsSync(path.join(DOCS, dir))) throw new Error('That folder already exists.')
          fs.mkdirSync(path.join(DOCS, dir), { recursive: true })
          broadcast(filesMsg())
          send(ws, { type: 'mkdir-done', path: dir })
        } catch (err) {
          send(ws, { type: 'open-error', error: err.message })
        }
        break
      }
      case 'history-list': send(ws, historyMsg()); break
      case 'history-read': {
        const item = current && history.list(current).find(i => i.hash === msg.hash)
        const html = item && history.read(item.hash, current)
        if (html != null) send(ws, { type: 'history-version', name: current, ...item, html })
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
if (initialDoc) {
  const name = safeName(initialDoc)
  if (name) openDoc(name, { create: true })
}

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
    if (err.code !== 'EADDRINUSE') { console.error(`Could not start: ${err.message}`); process.exit(1) }
    if (port >= PORT + 20) { console.error(`Ports ${PORT}-${port} are all in use. Try: prosedesk stopall`); process.exit(1) }
    port++
  }
}

const url = `http://localhost:${port}`
const instanceFile = path.join(INSTANCES_DIR, `${process.pid}.json`)
try {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true })
  fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, port, url, folder: DOCS, started: Date.now() }))
} catch {}

if (port !== PORT) console.log(`Port ${PORT} is busy, using ${port}.`)
console.log(`ProseDesk  ${url}`)
console.log(`Folder     ${DOCS}`)
console.log('Press Ctrl+C to stop.')
if (OPEN) openBrowser(url)

process.on('exit', () => {
  if (autoTimer) snapshot('Autosave')
  proc?.kill()
  try { fs.rmSync(instanceFile, { force: true }) } catch {}
})
process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())
