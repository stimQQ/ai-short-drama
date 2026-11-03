#!/usr/bin/env node
/**
 * ai-short-drama — story → character sheets → shots → one finished episode,
 * on apimodels.app (one API key for the image, voice and video models).
 *
 * Zero dependencies, Node 18+. `voice` and `assemble` also need ffmpeg/ffprobe.
 * Run `node scripts/drama.mjs help`.
 *
 * Everything lives in ONE project.json. The agent writes the story into it
 * (characters, locations, shots); this script does the paid and fiddly parts and
 * writes back what happened — task ids, local files, the amount actually billed.
 * That file is the whole point of the design:
 *   1. A task id is saved the moment the API hands it back, before any waiting.
 *      A crash, a closed laptop or a timeout resumes the SAME task next run —
 *      nothing is ever paid for twice.
 *   2. Finished shots are skipped. Re-running after one shot failed re-renders
 *      that shot only.
 *   3. Results are downloaded into the project folder, because result URLs on
 *      the API expire after 30 days.
 */

import { homedir } from 'node:os'
import { join, dirname, resolve, extname, basename } from 'node:path'
import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Same variable as the apimodels MCP server; also what the offline tests point at a fake API.
const API = (process.env.APIMODELS_BASE_URL || 'https://api.apimodels.app/v1').replace(/\/$/, '')
const CONSOLE_URL = 'https://apimodels.app/console/api-keys'
const CRED_DIR = join(homedir(), '.apimodels')
const CRED_FILE = join(CRED_DIR, 'credentials')
// Where `npx apimodels-mcp login` keeps its key ({ "api_key": "sk_…" }). Read too, so
// one login covers the MCP server and every apimodels skill.
const MCP_CRED_FILE = join(CRED_DIR, 'credentials.json')

/**
 * List prices in USD, checked 2026-09-30 against apimodels.app/pricing. They feed
 * the estimate only. What a run really cost is read back from GET /v1/records
 * after every task and stored next to the result in project.json.
 */
export const VIDEO_PRICES = { // per second of output
  'dreamina-seedance-2-0-mini': { '480p': 0.0225, '720p': 0.048 },
  'dreamina-seedance-2-0-fast': { '480p': 0.0644, '720p': 0.1372 },
  'dreamina-seedance-2-0': { '480p': 0.10, '720p': 0.22, '1080p': 0.55 },
  'seedance-2.0-mini': { '480p': 0.044, '720p': 0.095 },
  'seedance-2.0-fast': { '480p': 0.071, '720p': 0.153 },
  'seedance-2.0': { '480p': 0.092, '720p': 0.197, '1080p': 0.492 },
}
export const IMAGE_PRICES = { // per image
  'nano-banana-2-1': { '1K': 0.022, '2K': 0.036, '4K': 0.06 },
}
export const TTS_PRICES = { // per 1,000 characters
  'minimax-speech-2.8-turbo': 0.04,
  'minimax-speech-02-turbo': 0.04,
}
// Short clips are billed as if they had this many characters: a 15-character line
// came back as $0.004 from /v1/records (2026-11-03).
const TTS_MIN_CHARS = 100
const ttsChars = (text) => Math.max([...(text || '')].length, TTS_MIN_CHARS)

export const ASPECTS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const MAX_REFS = 9 // Seedance reference_image_urls limit
const CONFIRM_ABOVE_USD = 1 // paid commands stop and ask for --yes above this
const NARRATION_DELAY_S = 0.3 // voice-over starts this long after the cut

// Poll pacing: brisk at first, then back off so a slow render does not cost
// hundreds of requests. Videos run p50 ~2.5 min, p90 ~8 min.
const POLL_SCHEDULE_MS = [3000, 3000, 5000, 5000, 5000, 8000, 8000, 10000]
const POLL_TAIL_MS = 15000
const MAX_WAIT_MS = { images: 10 * 60e3, audio: 3 * 60e3, video: 25 * 60e3 }

// Seedance's international (dreamina-*) line refuses references that look like a
// real person, and a photoreal generated face can trip that check. Stylised
// projects get the more affordable line; everything else gets the line that accepts faces.
const STYLISED = /anime|manga|comic|cartoon|chibi|pixar|claymation|cel[- ]shad|watercolou?r|ink wash|pixel art|3d anim|动漫|漫画|漫剧|国漫|二次元|卡通|水墨|动画/i

export const isZh = (lang) => /^(zh|cmn|yue)/i.test(lang || '')
export const defaultVideoModel = (style) => (STYLISED.test(style || '') ? 'dreamina-seedance-2-0-mini' : 'seedance-2.0-mini')

/** Fill in every default and write it into the project, so the choices are visible. */
export function withDefaults(p) {
  const language = p.language || 'en'
  return {
    ...p,
    language,
    aspect: p.aspect || '9:16',
    resolution: p.resolution || '480p',
    mode: p.mode || 'dialogue',
    video_model: p.video_model || defaultVideoModel(p.style),
    image_model: p.image_model || 'nano-banana-2-1',
    image_resolution: p.image_resolution || '1K',
    ...((p.mode === 'narration' || p.narrator) ? {
      narrator: {
        model: 'minimax-speech-2.8-turbo',
        voice_id: isZh(language) ? 'male-qn-qingse' : 'English_Trustworthy_Man',
        ...(p.narrator || {}),
      },
    } : {}),
    characters: p.characters || [],
    locations: p.locations || [],
    shots: p.shots || [],
  }
}

/** Rough speaking time, for estimates before any audio exists. */
export function estimateSpeechSeconds(text) {
  const t = text || ''
  const cjk = (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length
  const words = (t.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[A-Za-z0-9'’-]+/g) || []).length
  return cjk / 4.5 + words / 2.6
}

/**
 * Seconds of video to render for a shot. Narration shots stretch to fit their
 * voice-over (plus a short tail) — but Seedance renders 4–15 s, so a narration
 * longer than ~14 s has to be split across shots, which validate() enforces.
 */
export function shotDuration(p, s) {
  if (p.mode !== 'narration') return s.duration ?? 5
  const speech = s.voice?.seconds ?? (s.narration ? estimateSpeechSeconds(s.narration) : 0)
  const need = speech ? Math.ceil(speech + 0.6) : 0
  return Math.min(15, Math.max(4, s.duration ?? 4, need))
}

export function validate(p) {
  const errors = []
  const warnings = []
  const chars = new Map()
  const locs = new Map()

  if (!ASPECTS.includes(p.aspect)) errors.push(`aspect "${p.aspect}" — use one of: ${ASPECTS.join(' ')}`)
  if (!['dialogue', 'narration'].includes(p.mode)) errors.push(`mode "${p.mode}" — use "dialogue" or "narration"`)
  const vp = VIDEO_PRICES[p.video_model]
  if (!vp) warnings.push(`video_model "${p.video_model}" is not in this script's price table — the estimate leaves it out`)
  else if (!vp[p.resolution]) errors.push(`${p.video_model} does not render ${p.resolution} — use ${Object.keys(vp).join(' / ')}`)

  for (const [list, map, what] of [[p.characters, chars, 'character'], [p.locations, locs, 'location']]) {
    for (const c of list) {
      if (!c.id) { errors.push(`every ${what} needs an "id"`); continue }
      if (map.has(c.id)) errors.push(`duplicate ${what} id "${c.id}"`)
      map.set(c.id, c)
      if (!c.look && !c.sheet_file && !c.sheet_url) {
        errors.push(`${what} "${c.id}": give a "look" (to generate a sheet) or a "sheet_file" / "sheet_url" (to use your own image)`)
      }
    }
  }

  if (!Array.isArray(p.shots) || p.shots.length === 0) errors.push('add at least one shot')
  const seen = new Set()
  for (const s of p.shots || []) {
    if (!s.id) { errors.push('every shot needs an "id"'); continue }
    if (seen.has(s.id)) errors.push(`duplicate shot id "${s.id}"`)
    seen.add(s.id)
    if (!s.prompt) errors.push(`shot ${s.id}: "prompt" is required — describe what we see and how the camera moves`)
    if (s.duration != null && !(Number.isInteger(s.duration) && s.duration >= 4 && s.duration <= 15)) {
      errors.push(`shot ${s.id}: duration must be a whole number of seconds from 4 to 15`)
    }
    for (const id of s.characters || []) if (!chars.has(id)) errors.push(`shot ${s.id}: unknown character "${id}"`)
    if (s.location && !locs.has(s.location)) errors.push(`shot ${s.id}: unknown location "${s.location}"`)
    const refs = (s.characters || []).length + (s.location ? 1 : 0)
    if (refs > MAX_REFS) errors.push(`shot ${s.id}: ${refs} reference images — Seedance takes at most ${MAX_REFS}`)

    if (p.mode === 'dialogue') {
      for (const l of s.dialogue || []) {
        if (!l.line) errors.push(`shot ${s.id}: a dialogue entry has no "line"`)
        if (l.who && !(s.characters || []).includes(l.who)) {
          warnings.push(`shot ${s.id}: "${l.who}" speaks but is not in this shot's characters, so the model has no reference for their face`)
        }
      }
      const talk = (s.dialogue || []).reduce((n, l) => n + estimateSpeechSeconds(l.line), 0)
      if (talk > (s.duration ?? 5) - 0.5) {
        warnings.push(`shot ${s.id}: about ${talk.toFixed(1)} s of dialogue in a ${s.duration ?? 5} s shot — lines may be rushed or cut; raise "duration"`)
      }
    } else {
      if (s.dialogue?.length) warnings.push(`shot ${s.id}: "dialogue" is ignored in narration mode`)
      if (!s.narration) warnings.push(`shot ${s.id}: no narration — it plays with ambient sound only`)
      const speech = s.voice?.seconds ?? estimateSpeechSeconds(s.narration)
      if (speech + 0.6 > 15) {
        errors.push(`shot ${s.id}: about ${speech.toFixed(1)} s of narration, but one shot holds at most 15 s — split it across two shots`)
      }
    }
  }
  return { errors, warnings }
}

const refItems = (p, s) => [
  ...(s.characters || []).map((id) => ({ kind: 'character', item: p.characters.find((c) => c.id === id) })),
  ...(s.location ? [{ kind: 'location', item: p.locations.find((l) => l.id === s.location) }] : []),
]

/** The reference image URLs for a shot, in the order the prompt cites them. */
export function shotRefUrls(p, s) {
  return refItems(p, s).map((r) => r.item?.sheet_url).filter(Boolean)
}

/**
 * The prompt actually sent for a shot. Seedance cites references by POSITION —
 * the first URL is @image1 (图片1), the second @image2 — so the mapping is written
 * out explicitly, together with what to take from each image and what to ignore.
 * Leaving that out is the usual cause of a character sheet's grey backdrop or
 * three-view layout showing up inside the shot.
 */
export function buildShotPrompt(p, s) {
  const zh = isZh(p.language)
  const parts = []
  if (p.style) parts.push(zh ? `画面风格：${p.style}。` : `Visual style: ${p.style}.`)
  refItems(p, s).forEach((r, i) => {
    const tag = zh ? `图片${i + 1}` : `@image${i + 1}`
    const name = r.item?.name || r.item?.id
    if (r.kind === 'character') {
      parts.push(zh
        ? `${tag}是「${name}」的角色设定图：严格保持其脸型、发型和服装，忽略设定图的灰色背景和排版。`
        : `${tag} is the character sheet for ${name}: keep their face, hairstyle and outfit exactly; ignore the sheet's grey background and layout.`)
    } else {
      parts.push(zh
        ? `${tag}是场景「${name}」：沿用它的环境、布景和光线。`
        : `${tag} is the location "${name}": use its setting, set dressing and lighting.`)
    }
  })
  parts.push(s.prompt)

  const lines = p.mode === 'dialogue' ? s.dialogue || [] : []
  for (const l of lines) {
    const c = p.characters.find((x) => x.id === l.who)
    const who = c?.name || l.who
    const voice = c?.voice ? (zh ? `（${c.voice}）` : ` (${c.voice})`) : ''
    if (!who) parts.push(zh ? `画外音："${l.line}"` : `A voice off-screen says: "${l.line}"`)
    else parts.push(zh ? `${who}${voice}说："${l.line}"` : `${who}${voice} says: "${l.line}"`)
  }
  if (!lines.length) parts.push(zh ? '画面中没有人说话，只有环境音。' : 'Nobody speaks in this shot; ambient sound only.')
  parts.push(zh ? '画面中不要出现字幕、文字或水印。' : 'No subtitles, captions, on-screen text or watermarks.')
  return parts.join(' ')
}

/**
 * Prompt for a character or location reference image. A character sheet takes
 * only the RENDERING from the style line: a style such as "snowy night, ink wash"
 * otherwise paints the night into the sheet's backdrop (seen 2026-11-03), and a
 * scenic backdrop on a reference competes with the shot's own location.
 */
export function sheetPrompt(p, item, kind) {
  if (kind === 'character') {
    return [
      `Character reference sheet of ${item.name || item.id}: ${item.look}.`,
      p.style ? `Rendering style: ${p.style} — apply the drawing style only, not any setting, weather or time of day it mentions.` : '',
      'Layout: on the left, a large front-facing head-and-shoulders portrait; on the right, the same person full body in three views — front, side and back — standing in a neutral pose.',
      'Identical face, hair and outfit in every view. Background: flat plain neutral grey, no scenery, no snow, rain or particles; soft even studio light.',
      'No text, no labels, no captions, no watermark.',
    ].filter(Boolean).join(' ')
  }
  return [
    `Establishing shot of ${item.name || item.id}: ${item.look}.`,
    p.style ? `Style: ${p.style}.` : '',
    'No people. No text, no readable signs, no watermark.',
  ].filter(Boolean).join(' ')
}

const shotHash = (p, s) => createHash('sha1')
  .update(JSON.stringify([p.video_model, p.resolution, p.aspect, shotDuration(p, s), buildShotPrompt(p, s), shotRefUrls(p, s)]))
  .digest('hex').slice(0, 12)
const textHash = (t) => createHash('sha1').update(String(t)).digest('hex').slice(0, 12)

const castEntries = (p) => [
  ...p.characters.map((item) => ({ kind: 'character', item })),
  ...p.locations.map((item) => ({ kind: 'location', item })),
]

/** What is left to pay for, by stage. `null` cost = price not known to this script. */
export function estimate(p) {
  const rows = []
  const ip = IMAGE_PRICES[p.image_model]?.[p.image_resolution] ?? null
  const sheets = castEntries(p).filter((e) => !e.item.sheet_url && !e.item.sheet_file).length
  if (sheets) rows.push({ stage: 'cast', what: `${sheets} reference image(s), ${p.image_model} ${p.image_resolution}`, cost: ip == null ? null : sheets * ip })

  if (p.mode === 'narration') {
    const todo = p.shots.filter((s) => s.narration && !(s.voice?.file && s.voice?.text_hash === textHash(s.narration)))
    const chars = todo.reduce((n, s) => n + ttsChars(s.narration), 0)
    const rate = TTS_PRICES[p.narrator.model]
    if (todo.length) rows.push({ stage: 'voice', what: `${todo.length} narration clip(s), ${chars} billed characters, ${p.narrator.model}`, cost: rate == null ? null : (chars / 1000) * rate })
  }

  const shots = p.shots.filter((s) => s.state !== 'done' && !(s.state === 'submitted' && s.task_id))
  const secs = shots.reduce((n, s) => n + shotDuration(p, s), 0)
  const vp = VIDEO_PRICES[p.video_model]?.[p.resolution] ?? null
  if (shots.length) rows.push({ stage: 'shots', what: `${shots.length} shot(s), ${secs} s, ${p.video_model} ${p.resolution}`, cost: vp == null ? null : secs * vp })

  const total = rows.reduce((n, r) => n + (r.cost ?? 0), 0)
  return { rows, total, complete: rows.every((r) => r.cost != null) }
}

/** Sum of what the API actually billed so far, as recorded in the project. */
export function spent(p) {
  let n = 0
  for (const { item } of castEntries(p)) n += item.sheet_cost || 0
  for (const s of p.shots) n += (s.cost || 0) + (s.voice?.cost || 0)
  return n
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

const srtTime = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000))
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

export const splitSentences = (text) =>
  (text || '').split(/(?<=[。！？!?；;…])\s*|(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean)

/**
 * SRT from the dialogue or narration. Timings are an even split inside each shot —
 * Seedance does not report when each line is spoken — so they are close, not exact.
 * timeline: [{ shot, start, duration }] in seconds, in playback order.
 */
export function buildSrt(p, timeline) {
  const cues = []
  for (const { shot: s, start, duration } of timeline) {
    if (p.mode === 'narration') {
      const parts = splitSentences(s.narration)
      if (!parts.length) continue
      const speech = Math.min(s.voice?.seconds ?? duration, duration - NARRATION_DELAY_S)
      const total = parts.reduce((n, x) => n + [...x].length, 0)
      let t = start + NARRATION_DELAY_S
      for (const x of parts) {
        const len = speech * ([...x].length / total)
        cues.push([t, t + len, x])
        t += len
      }
    } else {
      const lines = (s.dialogue || []).filter((l) => l.line)
      lines.forEach((l, i) => {
        const a = start + (duration * i) / lines.length
        const b = start + (duration * (i + 1)) / lines.length
        cues.push([a + 0.2, b - 0.1, l.line])
      })
    }
  }
  return cues.map(([a, b, text], i) => `${i + 1}\n${srtTime(a)} --> ${srtTime(b)}\n${text}\n`).join('\n')
}


export const slugify = (title) =>
  (title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'episode'

// ─── API ─────────────────────────────────────────────────────────────────────

function fail(message, hint, extra) {
  return { ok: false, message, hint: hint ?? null, ...extra }
}

/**
 * The key, in order: APIMODELS_API_KEY (never passes through the conversation),
 * then ~/.apimodels/credentials (written by `login` or `save-key`, mode 0600),
 * then ~/.apimodels/credentials.json (written by the apimodels MCP server's login).
 * There is deliberately no --key flag: arguments end up in transcripts and
 * process listings.
 */
async function resolveKey() {
  const fromEnv = process.env.APIMODELS_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const saved = (await readFile(CRED_FILE, 'utf8')).trim()
    if (saved) return saved
  } catch { /* no saved key */ }
  try {
    const saved = JSON.parse(await readFile(MCP_CRED_FILE, 'utf8'))?.api_key
    if (typeof saved === 'string' && saved.trim()) return saved.trim()
  } catch { /* no MCP login either */ }
  return null
}

const NO_KEY_HINT =
  `No API key found.\n` +
  `  Easiest: node scripts/drama.mjs login   ← one browser click, nothing to type\n` +
  `  Or create one at ${CONSOLE_URL} and either:\n` +
  `    • export APIMODELS_API_KEY=sk_...\n` +
  `    • printf %s "sk_..." | node scripts/drama.mjs save-key   ← for sandboxes with no shell`

async function saveKey() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const key = Buffer.concat(chunks).toString('utf8').trim()
  if (!/^sk_[A-Za-z0-9]{16,}$/.test(key)) {
    console.error('That does not look like an apimodels key (expected sk_…). Nothing was saved.')
    return 2
  }
  await storeKey(key)
  console.log(`✓ saved to ${CRED_FILE} (…${key.slice(-4)}), readable only by you.`)
  return 0
}

async function storeKey(key) {
  await mkdir(CRED_DIR, { recursive: true })
  await writeFile(CRED_FILE, key + '\n', { mode: 0o600 })
  await chmod(CRED_FILE, 0o600).catch(() => {})
}

/**
 * One-click browser authorization (RFC 8252 loopback): a random 127.0.0.1 port
 * and a state nonce; the user clicks Authorize on apimodels.app; the browser
 * redirects back with a single-use code that we exchange for a new key. The key
 * itself never touches the conversation, the shell history or the URL bar.
 */
async function login() {
  const state = randomBytes(16).toString('base64url')
  let settle
  const done = new Promise((r) => { settle = r })
  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>${title}</h2><p style="color:#999">${body}</p></div>`

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('State mismatch', 'This link belongs to a different login attempt. Close this tab and run login again.'))
      return
    }
    try {
      const r = await fetch('https://apimodels.app/api/cli-auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: u.searchParams.get('code') ?? '' }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await r.json().catch(() => null)
      const key = data?.data?.apiKey
      if (!r.ok || !key) throw new Error(data?.msg || `exchange failed (HTTP ${r.status})`)
      await storeKey(key)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('✓ Connected', 'This machine is authorized. Close this tab and go back to your agent.'))
      settle({ ok: true, tail: key.slice(-4), name: data?.data?.name })
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Authorization failed', `${e.message}. Close this tab and run login again.`))
      settle({ ok: false, error: e.message })
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `https://apimodels.app/cli-auth?port=${server.address().port}&state=${state}`
  console.log(`Open this link, log in if asked, and click “Authorize”:\n\n  ${url}\n\nWaiting for the browser… (10 minutes; Ctrl-C to abort)`)
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  execFile(opener, [url], () => {})
  const timer = setTimeout(() => settle({ ok: false, error: 'timed out after 10 minutes' }), 10 * 60e3)
  const result = await done
  clearTimeout(timer)
  server.close()
  if (!result.ok) { console.error(`✗ ${result.error}`); return 2 }
  console.log(`✓ saved to ${CRED_FILE} (…${result.tail}), readable only by you. Key name: ${result.name}`)
  return 0
}

/**
 * One API call. This API can answer HTTP 200 with a failure `code` in the body,
 * so the body decides, not the status line. `transient` marks failures worth
 * retrying while polling (network blips, gateway errors).
 */
async function call(url, init, key) {
  let res
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(init?.timeoutMs ?? 60000),
    })
  } catch (e) {
    return fail(`network error talking to apimodels.app: ${e.message}`, null, { transient: true })
  }
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch {
    return fail(`unexpected non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, null, { transient: res.status >= 500 })
  }
  const code = typeof body?.code === 'number' ? body.code : res.status
  if (code === 401) return fail('API key rejected (401).', `Create a new key at ${CONSOLE_URL}, or run: node scripts/drama.mjs login`)
  if (code === 402) return fail('Not enough balance (402).', 'Top up at https://apimodels.app/console/credits — failed tasks are never charged.')
  if (code !== 200) return fail(`${body?.msg || 'request failed'} (code ${code})`, null, { transient: code >= 500 })
  return { ok: true, data: body.data }
}

/** Plain-language reason and next step for a failed task. */
function explain(message, p) {
  const m = message || ''
  if (/real, identifiable person|real person|真人/i.test(m) && /^dreamina-/.test(p?.video_model || '')) {
    return 'This video line refuses references that look like a real person, and photoreal character sheets can trip it. Set "video_model": "seedance-2.0-mini" in project.json (it accepts realistic faces), then run shots --retry-failed. Not charged.'
  }
  if (/moderation|sensitive|审核|policy/i.test(m)) return 'Refused by content review. Reword the shot prompt or dialogue — retrying the same input will not help. Not charged.'
  if (/busy|overload|capacity|UPSTREAM_BUSY/i.test(m)) return 'The model is busy. Run the same command again in a few minutes. Not charged.'
  if (/timeout|timed out/i.test(m)) return 'The render took too long upstream. Retry with --retry-failed. Not charged.'
  return 'Not charged. Retry with --retry-failed, or adjust the shot.'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitTask(kind, taskId, key, onTick) {
  const started = Date.now()
  let blips = 0
  for (let i = 0; ; i++) {
    await sleep(POLL_SCHEDULE_MS[i] ?? POLL_TAIL_MS)
    const elapsed = Date.now() - started
    if (elapsed > MAX_WAIT_MS[kind]) {
      return fail(`still running after ${Math.round(elapsed / 1000)} s`, 'The task id is saved — run the same command again later to pick it up. Nothing is charged twice.', { pending: true })
    }
    const r = await call(`${API}/${kind}/generations?task_id=${encodeURIComponent(taskId)}`, { method: 'GET' }, key)
    if (!r.ok) {
      if (r.transient && ++blips <= 5) continue
      return { ...r, pending: true }
    }
    blips = 0
    const d = r.data || {}
    if (d.state === 'completed') {
      const urls = d.resultUrls || []
      if (!urls.length) return fail('the task finished but returned no file')
      return { ok: true, taskId, urls, seconds: Math.round(elapsed / 1000) }
    }
    if (d.state === 'failed') return fail(d.failMsg || d.failCode || 'generation failed')
    onTick?.(Math.round(elapsed / 1000))
  }
}

/** Create a task, hand its id to `onTaskId` BEFORE waiting (so it is persisted), then wait. */
async function runTask(kind, body, key, onTaskId, onTick) {
  const created = await call(`${API}/${kind}/generations`, { method: 'POST', body: JSON.stringify(body) }, key)
  if (!created.ok) return created
  const taskId = created.data?.taskId
  if (!taskId) return fail('the API accepted the request but returned no task id')
  await onTaskId(taskId)
  return waitTask(kind, taskId, key, onTick)
}

/** What the API actually billed for a task. null while it is still settling. */
async function billed(taskId, key) {
  for (let i = 0; i < 4; i++) {
    const r = await call(`${API}/records/${encodeURIComponent(taskId)}`, { method: 'GET' }, key)
    if (r.ok && r.data?.settled) return Number(r.data.credits)
    await sleep(3000)
  }
  return null
}

async function upload(file, key) {
  const buf = await readFile(file)
  const ext = extname(file).slice(1).toLowerCase()
  const type = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
  }[ext] || 'application/octet-stream'
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), basename(file))
  // No Content-Type header: fetch has to set the multipart boundary itself.
  const r = await call(`${API}/files`, { method: 'POST', body: form, timeoutMs: 300000 }, key)
  if (!r.ok) return r
  if (!r.data?.publicUrl) return fail('upload succeeded but returned no URL')
  return { ok: true, url: r.data.publicUrl }
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, Buffer.from(await res.arrayBuffer()))
}

const extOf = (url, fallback) => {
  try { return extname(new URL(url).pathname) || fallback } catch { return fallback }
}

// ─── Project file ────────────────────────────────────────────────────────────

async function loadProject(file) {
  const path = resolve(file)
  let raw
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`)
  }
  const data = withDefaults(raw)
  let chain = Promise.resolve()
  // Writes are queued and atomic (temp file + rename), so parallel shots finishing
  // at the same moment cannot interleave or leave a half-written project.json.
  const save = () => (chain = chain.then(async () => {
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
    await rename(tmp, path)
  }))
  await save()
  return { path, dir: dirname(path), data, save }
}

async function pool(items, n, fn) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift())
  }))
}

const usd = (n) => (n == null ? '  ?   ' : `$${n.toFixed(n < 10 ? 3 : 2)}`)

function printEstimate(est) {
  for (const r of est.rows) console.log(`  ${r.stage.padEnd(6)} ${usd(r.cost).padStart(8)}  ${r.what}`)
  console.log(`  total  ${usd(est.total).padStart(8)}${est.complete ? '' : '  (+ items with unknown price)'}`)
}

/** Stop before spending more than CONFIRM_ABOVE_USD unless --yes was given. */
function gate(cost, opts, what) {
  if (cost <= CONFIRM_ABOVE_USD || opts.yes) return true
  console.log(`\n${what} will cost about ${usd(cost)}. Confirm with the user, then re-run with --yes.`)
  return false
}

function checkOrExit(p) {
  const { errors, warnings } = validate(p)
  for (const w of warnings) console.log(`  ! ${w}`)
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`)
    console.error(`\n${errors.length} problem(s) in project.json — fix them and run again.`)
    process.exit(2)
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdCast(proj, key, opts) {
  const p = proj.data
  checkOrExit(p)
  const todo = castEntries(p).filter(({ item }) => opts.redo.has(item.id) || !item.sheet_url)
  if (!todo.length) { console.log('✓ every character and location already has a reference image'); return 0 }
  // Entries with a sheet_file are the user's own image: (re-)uploaded, never generated.
  const generate = todo.filter(({ item }) => !item.sheet_file)
  const ip = IMAGE_PRICES[p.image_model]?.[p.image_resolution]
  const cost = generate.filter(({ item }) => opts.redo.has(item.id) || !item.sheet_task_id).length * (ip ?? 0)
  if (!gate(cost, opts, `Generating ${generate.length} reference image(s)`)) return 3

  let failed = 0
  await pool(todo, opts.concurrency, async ({ kind, item }) => {
    const local = join(proj.dir, 'cast', `${item.id}`)
    if (item.sheet_file) {
      console.log(`▸ ${item.id}: uploading ${item.sheet_file}`)
      const r = await upload(resolve(proj.dir, item.sheet_file), key)
      if (!r.ok) { failed++; console.error(`✗ ${item.id}: ${r.message}`); return }
      item.sheet_url = r.url
      await proj.save()
      console.log(`✓ ${item.id}: uploaded`)
      return
    }
    if (opts.redo.has(item.id)) delete item.sheet_task_id
    const onTaskId = async (id) => { item.sheet_task_id = id; await proj.save() }
    let r
    if (item.sheet_task_id) {
      console.log(`▸ ${item.id}: resuming task ${item.sheet_task_id}`)
      r = await waitTask('images', item.sheet_task_id, key)
    } else {
      console.log(`▸ ${item.id}: generating ${kind} reference (${p.image_model} ${p.image_resolution})`)
      const aspect = kind === 'character' ? '16:9' : (p.aspect === 'adaptive' ? '16:9' : p.aspect)
      r = await runTask('images', { model: p.image_model, prompt: sheetPrompt(p, item, kind), resolution: p.image_resolution, aspect_ratio: aspect }, key, onTaskId)
    }
    if (!r.ok) {
      failed++
      if (!r.pending) delete item.sheet_task_id
      await proj.save()
      console.error(`✗ ${item.id}: ${r.message}\n  ${r.hint || explain(r.message, p)}`)
      return
    }
    const file = `${local}${extOf(r.urls[0], '.png')}`
    try { await download(r.urls[0], file); item.sheet_path = file.slice(proj.dir.length + 1) } catch (e) {
      console.error(`  (${item.id}: could not save locally: ${e.message} — the URL still works for 30 days)`)
    }
    item.sheet_url = r.urls[0]
    item.sheet_cost = await billed(r.taskId, key)
    await proj.save()
    console.log(`✓ ${item.id}: ${item.sheet_path || item.sheet_url}  (${usd(item.sheet_cost)})`)
  })
  console.log(failed ? `\n${failed} failed — fix and run cast again; finished ones are kept.` : '\n✓ cast ready. Look at the images in cast/ before rendering shots — redo any with: cast --redo <id>')
  return failed ? 1 : 0
}

async function cmdVoice(proj, key, opts) {
  const p = proj.data
  if (p.mode !== 'narration') { console.log('This project is in dialogue mode — Seedance voices the lines itself, nothing to do here.'); return 0 }
  checkOrExit(p)
  await needBin('ffprobe')
  const todo = p.shots.filter((s) => s.narration && (opts.redo.has(s.id) || !(s.voice?.file && s.voice?.text_hash === textHash(s.narration))))
  if (!todo.length) { console.log('✓ narration is up to date'); return 0 }
  const rate = TTS_PRICES[p.narrator.model] ?? 0
  const cost = todo.reduce((n, s) => n + (ttsChars(s.narration) / 1000) * rate, 0)
  if (!gate(cost, opts, `Voicing ${todo.length} narration clip(s)`)) return 3

  let failed = 0
  await pool(todo, opts.concurrency, async (s) => {
    const hash = textHash(s.narration)
    const v = s.voice && s.voice.text_hash === hash && !opts.redo.has(s.id) ? s.voice : { text_hash: hash }
    s.voice = v
    const body = { model: p.narrator.model, text: s.narration }
    if (/^fish-/.test(p.narrator.model)) body.reference_id = p.narrator.voice_id
    else body.voice_id = p.narrator.voice_id
    if (p.narrator.speed != null && /^minimax-/.test(p.narrator.model)) body.voice_setting = { voice_id: p.narrator.voice_id, speed: p.narrator.speed }
    const r = v.task_id
      ? await waitTask('audio', v.task_id, key)
      : await runTask('audio', body, key, async (id) => { v.task_id = id; await proj.save() })
    if (!r.ok) {
      failed++
      if (!r.pending) delete v.task_id
      await proj.save()
      console.error(`✗ ${s.id} narration: ${r.message}\n  ${r.hint || explain(r.message, p)}`)
      return
    }
    const file = join(proj.dir, 'audio', `${s.id}${extOf(r.urls[0], '.mp3')}`)
    await download(r.urls[0], file)
    v.file = file.slice(proj.dir.length + 1)
    v.url = r.urls[0]
    v.seconds = Math.round((await probe(file)).duration * 100) / 100
    v.cost = await billed(r.taskId, key)
    await proj.save()
    const stale = s.state === 'done' && s.hash !== shotHash(p, s) ? '  — the shot was rendered for a different length; re-render it with shots --redo ' + s.id : ''
    console.log(`✓ ${s.id}: ${v.seconds} s of narration → shot will be ${shotDuration(p, s)} s  (${usd(v.cost)})${stale}`)
  })
  return failed ? 1 : 0
}

async function cmdShots(proj, key, opts) {
  const p = proj.data
  checkOrExit(p)
  const missing = castEntries(p).filter(({ item }) => !item.sheet_url).map(({ item }) => item.id)
  if (missing.length) { console.error(`✗ no reference image yet for: ${missing.join(', ')} — run cast first.`); return 2 }
  if (p.mode === 'narration') {
    const unvoiced = p.shots.filter((s) => s.narration && !(s.voice?.seconds && s.voice.text_hash === textHash(s.narration))).map((s) => s.id)
    if (unvoiced.length) { console.error(`✗ narration not voiced yet for: ${unvoiced.join(', ')} — run voice first (shot length follows the narration, and edited narration needs a new voice-over).`); return 2 }
  }

  const picked = opts.only.size ? p.shots.filter((s) => opts.only.has(s.id)) : p.shots
  const todo = picked.filter((s) => {
    if (opts.redo.has(s.id)) return true
    if (s.state === 'done') return false
    if (s.state === 'failed') return opts.retryFailed
    return true
  })
  if (!todo.length) {
    const failed = picked.filter((s) => s.state === 'failed').map((s) => s.id)
    console.log(failed.length ? `Nothing to run. Failed shots (${failed.join(', ')}) are retried only with --retry-failed.` : '✓ every shot is rendered — next: assemble')
    return 0
  }
  const vp = VIDEO_PRICES[p.video_model]?.[p.resolution] ?? 0
  const fresh = todo.filter((s) => opts.redo.has(s.id) || !(s.state === 'submitted' && s.task_id))
  const cost = fresh.reduce((n, s) => n + shotDuration(p, s) * vp, 0)
  console.log(`▸ ${todo.length} shot(s) on ${p.video_model} ${p.resolution}${fresh.length < todo.length ? ` (${todo.length - fresh.length} resumed, already paid)` : ''} — about ${usd(cost)}`)
  if (!gate(cost, opts, `Rendering ${fresh.length} shot(s)`)) return 3
  console.log('  Videos usually take 2–8 minutes each; progress prints every minute.')

  let failed = 0
  let pending = 0
  await pool(todo, opts.concurrency, async (s) => {
    let r
    const tick = (sec) => { if (sec % 60 < 15 && sec >= 60) console.log(`  … ${s.id} still rendering (${sec} s)`) }
    if (s.state === 'submitted' && s.task_id && !opts.redo.has(s.id)) {
      console.log(`▸ ${s.id}: resuming task ${s.task_id}`)
      r = await waitTask('video', s.task_id, key, tick)
    } else {
      const prompt = buildShotPrompt(p, s)
      const refs = shotRefUrls(p, s)
      const body = {
        model: p.video_model,
        prompt,
        resolution: p.resolution,
        aspect_ratio: p.aspect,
        duration: shotDuration(p, s),
        generate_audio: p.native_audio !== false,
        ...(refs.length ? { reference_image_urls: refs } : {}),
      }
      Object.assign(s, { state: 'submitting', task_id: null, error: null, prompt_sent: prompt, hash: shotHash(p, s) })
      delete s.cost
      console.log(`▸ ${s.id}: ${body.duration} s, ${refs.length} reference(s)`)
      r = await runTask('video', body, key, async (id) => { s.task_id = id; s.state = 'submitted'; await proj.save() }, tick)
    }
    if (!r.ok) {
      if (r.pending) { pending++; console.error(`… ${s.id}: ${r.message}\n  ${r.hint || ''}`); await proj.save(); return }
      failed++
      s.state = 'failed'
      s.error = r.message
      await proj.save()
      console.error(`✗ ${s.id}: ${r.message}\n  ${explain(r.message, p)}`)
      return
    }
    const file = join(proj.dir, 'shots', `${s.id}${extOf(r.urls[0], '.mp4')}`)
    try { await download(r.urls[0], file); s.file = file.slice(proj.dir.length + 1) } catch (e) {
      console.error(`  (${s.id}: could not save locally: ${e.message} — run shots again to retry the download)`)
    }
    s.url = r.urls[0]
    s.state = s.file ? 'done' : 'submitted'
    s.cost = await billed(r.taskId, key)
    await proj.save()
    console.log(`✓ ${s.id}: ${s.file || s.url} in ${r.seconds} s  (${usd(s.cost)})`)
  })
  console.log(`\nSpent so far on this project: ${usd(spent(p))}`)
  if (failed || pending) {
    console.log(`${failed} failed, ${pending} still rendering. Finished shots are kept — run shots again${failed ? ' --retry-failed' : ''} to continue.`)
    return 1
  }
  console.log('✓ all requested shots rendered — next: assemble')
  return 0
}

function run(cmd, args, opts = {}) {
  return new Promise((ok, no) => {
    execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) no(new Error(`${cmd} failed: ${(stderr || err.message).trim().split('\n').slice(-4).join('\n')}`))
      else ok(stdout)
    })
  })
}

async function needBin(bin) {
  try { await run(bin, ['-version']) } catch {
    console.error(`✗ ${bin} not found. Install ffmpeg (macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg).`)
    process.exit(2)
  }
}

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]))
  const streams = j.streams || []
  const v = streams.find((x) => x.codec_type === 'video')
  return { duration: Number(j.format?.duration) || 0, width: v?.width, height: v?.height, hasAudio: streams.some((x) => x.codec_type === 'audio') }
}

async function cmdAssemble(proj, opts) {
  const p = proj.data
  await needBin('ffmpeg')
  await needBin('ffprobe')
  const notReady = p.shots.filter((s) => s.state !== 'done' || !s.file || !existsSync(join(proj.dir, s.file)))
  if (notReady.length && !opts.allowMissing) {
    console.error(`✗ not rendered yet: ${notReady.map((s) => s.id).join(', ')} — run shots, or pass --allow-missing to cut without them.`)
    return 2
  }
  const shots = p.shots.filter((s) => !notReady.includes(s))
  if (!shots.length) { console.error('✗ no rendered shots to assemble'); return 2 }

  const build = join(proj.dir, 'build')
  await mkdir(build, { recursive: true })
  const first = await probe(join(proj.dir, shots[0].file))
  // Even dimensions keep libx264 happy whatever the source size.
  const W = (first.width || 720) & ~1
  const H = (first.height || 1280) & ~1
  const timeline = []
  let t = 0
  for (const s of shots) {
    const src = join(proj.dir, s.file)
    const info = await probe(src)
    const out = join(build, `${s.id}.mp4`)
    const args = ['-y', '-v', 'error', '-i', src]
    const narration = p.mode === 'narration' && s.voice?.file ? join(proj.dir, s.voice.file) : null
    let audioIn = '0:a'
    if (!info.hasAudio) { args.push('-f', 'lavfi', '-t', String(info.duration), '-i', 'anullsrc=r=48000:cl=stereo'); audioIn = '1:a' }
    const narIdx = info.hasAudio ? 1 : 2
    if (narration) args.push('-i', narration)
    const delay = Math.round(NARRATION_DELAY_S * 1000)
    const fc = [
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v]`,
      `[${audioIn}]aresample=48000,aformat=channel_layouts=stereo${narration ? ',volume=0.3[bg]' : '[a]'}`,
      ...(narration ? [
        `[${narIdx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[nar]`,
        '[bg][nar]amix=inputs=2:duration=first:normalize=0[a]',
      ] : []),
    ].join(';')
    args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', String(info.duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out)
    await run('ffmpeg', args)
    const d = (await probe(out)).duration
    timeline.push({ shot: s, start: t, duration: d })
    t += d
    console.log(`  ✓ ${s.id} (${d.toFixed(1)} s)`)
  }

  const slug = slugify(p.title)
  const list = join(build, 'concat.txt')
  await writeFile(list, timeline.map(({ shot }) => `file '${shot.id}.mp4'`).join('\n') + '\n')
  const final = join(proj.dir, `${slug}.mp4`)
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', final], { cwd: build })

  const srt = buildSrt(p, timeline)
  const srtFile = join(proj.dir, `${slug}.srt`)
  if (srt) await writeFile(srtFile, srt)

  let burned = null
  if (opts.burnSubs && srt) {
    await writeFile(join(build, 'subs.srt'), srt)
    const font = isZh(p.language) ? (process.platform === 'darwin' ? 'PingFang SC' : 'Noto Sans CJK SC') : 'Arial'
    // libass lays out an SRT on a 288-unit-high canvas and scales it to the video, so
    // these are fractions of the frame height, not pixels: 13 ≈ 4.5% (about 12 CJK
    // characters per line on a vertical frame), 16 ≈ 5.6% on a landscape one.
    const size = W < H ? 13 : 16
    burned = join(proj.dir, `${slug}.subtitled.mp4`)
    // Run inside build/ so the subtitles filter sees a bare filename — a full path
    // would need ffmpeg filter escaping for every colon and quote in it.
    await run('ffmpeg', ['-y', '-v', 'error', '-i', final,
      '-vf', `subtitles=subs.srt:force_style='FontName=${font},Fontsize=${size},Outline=1.5,MarginV=${W < H ? 40 : 20}'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', burned], { cwd: build })
  }

  p.output = { file: basename(final), seconds: Math.round(t * 10) / 10, subtitles: srt ? basename(srtFile) : null, ...(burned ? { subtitled: basename(burned) } : {}) }
  await proj.save()
  console.log(`\n✓ ${final}  (${t.toFixed(1)} s, ${shots.length} shots)`)
  if (srt) console.log(`  subtitles → ${srtFile}${opts.burnSubs ? '' : '  (add --burn-subs to burn them in)'}`)
  if (burned) console.log(`  subtitled → ${burned}`)
  if (notReady.length) console.log(`  ! left out (not rendered): ${notReady.map((s) => s.id).join(', ')}`)
  console.log(`  spent on this project: ${usd(spent(p))}`)
  return 0
}

async function cmdStatus(proj, key) {
  const p = proj.data
  // Fill in any cost that had not settled when the task finished. Lookups are free.
  if (key) {
    for (const { item } of castEntries(p)) if (item.sheet_task_id && item.sheet_url && item.sheet_cost == null) item.sheet_cost = await billed(item.sheet_task_id, key)
    for (const s of p.shots) {
      if (s.task_id && s.state === 'done' && s.cost == null) s.cost = await billed(s.task_id, key)
      if (s.voice?.task_id && s.voice.file && s.voice.cost == null) s.voice.cost = await billed(s.voice.task_id, key)
    }
    await proj.save()
  }
  console.log(`${p.title || '(untitled)'} — ${p.mode}, ${p.video_model} ${p.resolution} ${p.aspect}\n`)
  for (const { kind, item } of castEntries(p)) {
    const st = item.sheet_url ? 'ready' : item.sheet_task_id ? 'generating' : 'todo'
    console.log(`  ${kind.padEnd(9)} ${item.id.padEnd(14)} ${st.padEnd(11)} ${item.sheet_cost != null ? usd(item.sheet_cost) : ''}`)
  }
  console.log('')
  for (const s of p.shots) {
    const stale = s.state === 'done' && s.hash && s.hash !== shotHash(p, s) ? '  ⚠ inputs changed since render — shots --redo ' + s.id : ''
    const voice = p.mode === 'narration' && s.narration ? `  voice ${s.voice?.seconds ? s.voice.seconds + ' s' : 'todo'}` : ''
    console.log(`  shot ${s.id.padEnd(10)} ${(s.state || 'todo').padEnd(11)} ${String(shotDuration(p, s)).padStart(2)} s  ${s.cost != null ? usd(s.cost) : '      '}${voice}${s.error ? `  — ${s.error}` : ''}${stale}`)
  }
  console.log(`\n  spent ${usd(spent(p))}`)
  const est = estimate(p)
  if (est.rows.length) { console.log('  still to pay:'); printEstimate(est) }
  if (p.output?.file) console.log(`  output: ${p.output.file} (${p.output.seconds} s)`)
  return 0
}

function cmdEstimate(proj, opts) {
  const p = proj.data
  const { errors, warnings } = validate(p)
  for (const w of warnings) console.log(`  ! ${w}`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.log(`\n${p.title || '(untitled)'} — ${p.shots.length} shot(s), ${p.shots.reduce((n, s) => n + shotDuration(p, s), 0)} s, ${p.mode} mode`)
  console.log(`video ${p.video_model} ${p.resolution} ${p.aspect} · images ${p.image_model} ${p.image_resolution}${p.mode === 'narration' ? ` · narrator ${p.narrator.model} / ${p.narrator.voice_id}` : ''}\n`)
  const est = estimate(p)
  if (est.rows.length) printEstimate(est)
  else console.log('  nothing left to pay for')
  if (spent(p)) console.log(`  already spent ${usd(spent(p))}`)
  if (opts.prompts) {
    for (const s of p.shots) console.log(`\n── ${s.id} (${shotDuration(p, s)} s) refs: ${refItems(p, s).map((r) => r.item?.id).join(', ') || 'none'}\n${buildShotPrompt(p, s)}`)
  }
  if (errors.length) { console.error(`\n${errors.length} problem(s) — fix project.json before generating.`); return 2 }
  return 0
}

function usage() {
  console.log(`
ai-short-drama — story → character sheets → shots → finished episode (apimodels.app)

  node scripts/drama.mjs <command> [project.json] [options]

Commands
  check                 Verify the API key, balance and ffmpeg.
  login                 One-click browser authorization (no key typed anywhere).
  save-key              Read a key from stdin and store it (sandboxes with no shell).
  estimate  [project]   Validate project.json and print what is left to pay. Free.
                          --prompts   also print the exact prompt for every shot
  cast      [project]   Generate (or upload) a reference image per character and location.
  voice     [project]   Narration mode only: synthesize each shot's voice-over.
  shots     [project]   Render the video shots (parallel, resumable).
  assemble  [project]   Normalize, mix narration, join, write .srt. Needs ffmpeg.
                          --burn-subs  also write a copy with subtitles burned in
                          --allow-missing  cut whatever is rendered so far
  status    [project]   Progress, money spent and what is left.
  upload <file>         Upload a local image/audio/video, print its public URL.

Options for cast / voice / shots
  --only a,b            Only these shot ids.
  --redo a,b            Regenerate these ids even if done (paid again).
  --retry-failed        Re-submit shots that failed (failed tasks were not charged).
  --concurrency <n>     Parallel tasks (default 3).
  --yes                 Proceed when the step costs more than $${CONFIRM_ABOVE_USD}.

[project] defaults to ./project.json. Exit codes: 0 ok · 1 some tasks failed or
are still rendering · 2 bad input · 3 needs --yes.

API key: APIMODELS_API_KEY, else ~/.apimodels/credentials(.json). Get one at ${CONSOLE_URL}
`)
}

function parseArgs(argv) {
  const o = { cmd: argv[0], rest: [], only: new Set(), redo: new Set(), concurrency: 3 }
  const list = (v) => new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean))
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') o.only = list(argv[++i])
    else if (a === '--redo') o.redo = list(argv[++i])
    else if (a === '--retry-failed') o.retryFailed = true
    else if (a === '--concurrency') o.concurrency = Math.max(1, parseInt(argv[++i], 10) || 3)
    else if (a === '--yes' || a === '-y') o.yes = true
    else if (a === '--burn-subs') o.burnSubs = true
    else if (a === '--allow-missing') o.allowMissing = true
    else if (a === '--prompts') o.prompts = true
    else if (a.startsWith('-')) return { error: `unknown option: ${a}` }
    else o.rest.push(a)
  }
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { console.error(o.error); usage(); return 2 }
  if (!o.cmd || o.cmd === 'help' || o.cmd === '--help' || o.cmd === '-h') { usage(); return 0 }
  if (o.cmd === 'login') return login()
  if (o.cmd === 'save-key') return saveKey()

  const projectCmds = ['estimate', 'cast', 'voice', 'shots', 'assemble', 'status']
  const needsKey = ['check', 'upload', 'cast', 'voice', 'shots']
  if (![...projectCmds, 'check', 'upload'].includes(o.cmd)) { console.error(`unknown command: ${o.cmd}`); usage(); return 2 }

  const key = await resolveKey()
  if (needsKey.includes(o.cmd) && !key) { console.error(NO_KEY_HINT); return 2 }

  if (o.cmd === 'check') {
    const r = await call(`${API}/balance`, { method: 'GET' }, key)
    if (!r.ok) { console.error(`✗ ${r.message}${r.hint ? `\n  ${r.hint}` : ''}`); return 1 }
    console.log(`✓ key works. Balance: $${r.data?.balance ?? r.data?.credits ?? '?'}`)
    try { await run('ffmpeg', ['-version']); console.log('✓ ffmpeg found') } catch { console.log('! ffmpeg not found — needed for voice and assemble (brew install ffmpeg / apt install ffmpeg)') }
    return 0
  }
  if (o.cmd === 'upload') {
    if (!o.rest[0]) { console.error('usage: upload <file>'); return 2 }
    const r = await upload(resolve(o.rest[0]), key)
    if (!r.ok) { console.error(`✗ ${r.message}`); return 1 }
    console.log(r.url)
    return 0
  }

  const proj = await loadProject(o.rest[0] || 'project.json')
  if (o.cmd === 'estimate') return cmdEstimate(proj, o)
  if (o.cmd === 'status') return cmdStatus(proj, key)
  if (o.cmd === 'assemble') return cmdAssemble(proj, o)
  if (o.cmd === 'cast') return cmdCast(proj, key, o)
  if (o.cmd === 'voice') return cmdVoice(proj, key, o)
  if (o.cmd === 'shots') return cmdShots(proj, key, o)
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
})()
if (invokedDirectly) {
  main().then((code) => process.exit(code ?? 0), (e) => { console.error(`✗ ${e?.message ?? e}`); process.exit(1) })
}
