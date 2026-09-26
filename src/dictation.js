// Mic buttons: press to start talking, press again to stop; the text lands in the
// target input at the cursor. Uses the server's OpenAI transcription when a key is
// configured, otherwise the browser's built-in speech recognition (Chrome/Edge).

let useServer = false
let active = null   // { button, stop, cancel }

export function setDictationConfig({ transcribe }) { useServer = !!transcribe }
export const isRecording = button => active?.button === button && active.state === 'rec'
export function stopRecording() { if (active?.state === 'rec') active.stop() }

export function attachMic(button, getTarget) {
  button.innerHTML = `<svg class="mic-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg><span class="mic-spin"></span><canvas class="mic-wave"></canvas><span class="mic-time"></span>`
  setState(button, 'idle')
  button.addEventListener('mousedown', e => e.preventDefault())   // keep focus in the text box
  button.addEventListener('click', () => {
    if (active?.button === button) { if (active.state === 'rec') active.stop(); return }
    active?.cancel()
    const el = getTarget()
    ;(useServer ? recordForServer : browserSpeech)(button, el)
  })
}

function setState(button, state) {
  button.dataset.state = state
  button.title = state === 'rec' ? 'Stop dictation' : state === 'busy' ? 'Transcribing…' : 'Dictate'
  if (state !== 'rec') button.querySelector('.mic-time').textContent = ''
  if (active?.button === button) active.state = state
}

function startTimer(button) {
  const t0 = Date.now()
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000)
    button.querySelector('.mic-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  tick()
  return setInterval(tick, 500)
}

// Tiny scrolling level meter drawn from the live mic stream, so you can see the
// mic is actually picking you up. Returns a function that stops it.
function startMeter(button, stream) {
  const canvas = button.querySelector('.mic-wave')
  const g = canvas.getContext('2d')
  const BARS = 12, BAR = 2, GAP = 1, W = BARS * (BAR + GAP) - GAP, H = 16
  const dpr = window.devicePixelRatio || 1
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`

  const ac = new AudioContext()
  const source = ac.createMediaStreamSource(stream)
  const analyser = ac.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const levels = new Array(BARS).fill(0)
  let raf = 0, last = 0

  const draw = t => {
    raf = requestAnimationFrame(draw)
    if (t - last < 60) return
    last = t
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const v of samples) sum += v * v
    const rms = Math.sqrt(sum / samples.length)
    levels.push(Math.min(1, rms * 6) ** 0.6)   // boost quiet speech so it's visible
    levels.shift()
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    g.fillStyle = getComputedStyle(button).color
    levels.forEach((l, i) => {
      const h = Math.max(2, l * H)
      g.fillRect(i * (BAR + GAP), (H - h) / 2, BAR, h)
    })
  }
  raf = requestAnimationFrame(draw)

  return () => {
    cancelAnimationFrame(raf)
    source.disconnect()
    ac.close()
    g.clearRect(0, 0, canvas.width, canvas.height)
  }
}

function insert(el, text) {
  text = text.trim()
  if (!text || !el) return
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const before = el.value.slice(0, start)
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  el.value = before + sep + text + el.value.slice(end)
  const pos = (before + sep + text).length
  el.focus()
  el.setSelectionRange(pos, pos)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function toast(button, message) {
  const t = document.createElement('div')
  t.className = 'mic-toast'
  t.textContent = message
  document.body.append(t)
  const r = button.getBoundingClientRect()
  t.style.left = `${Math.max(8, Math.min(r.right - t.offsetWidth, innerWidth - t.offsetWidth - 8))}px`
  t.style.top = `${Math.max(8, r.top - t.offsetHeight - 8)}px`
  setTimeout(() => t.remove(), 5000)
}

// ---------------------------------------------------------------- OpenAI via server
async function recordForServer(button, el) {
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    toast(button, 'Microphone access was blocked. Allow it in the address bar.')
    return
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m))
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks = []
  let cancelled = false
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  const timer = startTimer(button)
  const stopMeter = startMeter(button, stream)

  rec.onstop = async () => {
    clearInterval(timer)
    stopMeter()
    stream.getTracks().forEach(t => t.stop())
    if (cancelled || !chunks.length) { setState(button, 'idle'); active = null; return }
    setState(button, 'busy')
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`)
      insert(el, data.text || '')
    } catch (err) {
      toast(button, err.message)
    }
    setState(button, 'idle')
    active = null
  }

  active = { button, state: 'rec', stop: () => rec.stop(), cancel: () => { cancelled = true; rec.stop() } }
  setState(button, 'rec')
  rec.start(1000)
}

// ---------------------------------------------------------------- browser fallback
async function browserSpeech(button, el) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) { toast(button, 'Dictation needs an OpenAI key in .env, or Chrome / Edge.'); return }
  // Speech recognition doesn't expose its audio, so open the mic separately for the meter.
  let stopMeter = () => {}
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stopMeter = startMeter(button, stream)
  } catch {}
  const r = new SR()
  r.continuous = true
  r.interimResults = false
  r.lang = navigator.language || 'en-US'
  r.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++)
      if (e.results[i].isFinal) insert(el, e.results[i][0].transcript)
  }
  r.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(button, `Dictation error: ${e.error}`) }
  const timer = startTimer(button)
  r.onend = () => {
    clearInterval(timer)
    stopMeter()
    stream?.getTracks().forEach(t => t.stop())
    if (active?.button === button) active = null
    setState(button, 'idle')
  }
  active = { button, state: 'rec', stop: () => r.stop(), cancel: () => r.abort() }
  setState(button, 'rec')
  r.start()
}
