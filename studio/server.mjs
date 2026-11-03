#!/usr/bin/env node
/**
 * AI Short Drama Studio — a local four-step web UI over scripts/drama.mjs:
 * story → characters → shots → finished episode.
 *
 *   node studio/server.mjs [--dir ~/AI-Short-Drama] [--port 4317] [--no-open]
 *
 * Zero dependencies. Everything paid or fiddly is the engine's job (resumable
 * tasks, billed amounts read back, downloads into the project folder); this file
 * only serves the page, keeps one background job per project and reports progress.
 *
 * It listens on 127.0.0.1 only, and because any web page can try to reach a
 * localhost port, every request must carry the right Host header (no DNS
 * rebinding) and every API or file request a per-run token that only the page we
 * served knows (no cross-site requests).
 */

import { createServer } from 'node:http'
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve, extname, sep, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  API, call, resolveKey, storeKey, loadProject, withDefaults, validate, estimate, spent, slugify, shotHash,
  cmdCast, cmdVoice, cmdShots, cmdAssemble,
} from '../scripts/drama.mjs'
import { storyboard } from '../scripts/storyboard.mjs'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public')
const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const ROOT = resolve(arg('--dir', process.env.AI_DRAMA_DIR || join(homedir(), 'AI-Short-Drama')))
const token = randomBytes(24).toString('base64url')
const projects = new Map() // id → loaded project (engine object)
const jobs = new Map() // id → { step, running, log, code, error }
let port = Number(arg('--port', process.env.PORT || 4317))
let pendingLogin = null
let ffmpeg = false

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.srt': 'text/plain; charset=utf-8', '.json': 'application/json',
}
const ID = /^[a-z0-9][a-z0-9-]{0,80}$/

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(c)
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}

async function project(id) {
  if (!ID.test(id)) throw Object.assign(new Error('unknown project'), { status: 404 })
  if (!projects.has(id)) {
    const file = join(ROOT, id, 'project.json')
    try { await stat(file) } catch { throw Object.assign(new Error('unknown project'), { status: 404 }) }
    projects.set(id, await loadProject(file))
  }
  return projects.get(id)
}

function view(id, proj) {
  const p = proj.data
  const job = jobs.get(id)
  return {
    id, project: p, estimate: estimate(p), spent: spent(p), problems: validate(p),
    stale: p.shots.filter((s) => s.state === 'done' && s.hash && s.hash !== shotHash(p, s)).map((s) => s.id),
    job: job ? { step: job.step, running: job.running, code: job.code, error: job.error, log: job.log.slice(-60) } : null,
  }
}

async function listProjects() {
  await mkdir(ROOT, { recursive: true })
  const items = []
  for (const name of await readdir(ROOT)) {
    if (!ID.test(name)) continue
    try {
      const file = join(ROOT, name, 'project.json')
      const [info, raw] = await Promise.all([stat(file), readFile(file, 'utf8')])
      const p = JSON.parse(raw)
      const cover = [...(p.characters || []), ...(p.locations || [])].find((x) => x.sheet_path)?.sheet_path
      items.push({ id: name, title: p.title, mode: p.mode, shots: (p.shots || []).length, done: (p.shots || []).filter((s) => s.state === 'done').length,
        output: p.output?.file ?? null, cover: cover ?? null, updatedAt: info.mtimeMs, running: !!jobs.get(name)?.running })
    } catch { /* not a project folder */ }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

function startJob(id, proj, step, req, key) {
  const job = { step, running: true, log: [], code: null, error: null }
  jobs.set(id, job)
  const push = (...a) => { job.log.push(a.join(' ')); if (job.log.length > 400) job.log.splice(0, job.log.length - 400) }
  const opts = {
    out: { log: push, error: push }, yes: true, concurrency: 3, burnSubs: true,
    only: new Set(req.only || []), redo: new Set(req.redo || []), retryFailed: !!req.retryFailed,
  }
  ;(async () => {
    if (step === 'cast') return cmdCast(proj, key, opts)
    if (step === 'assemble') return cmdAssemble(proj, opts)
    // Narration first: shot lengths follow the voice-over. An unchanged line is
    // not voiced again, so re-rendering one shot costs only that shot.
    if (proj.data.mode === 'narration') {
      const v = await cmdVoice(proj, key, { ...opts, redo: new Set() })
      if (v) return v
    }
    return cmdShots(proj, key, opts)
  })().then(
    (code) => { job.code = code ?? 0 },
    (e) => { job.code = e.exitCode ?? 1; job.error = e.message; push(`✗ ${e.message}`) },
  ).finally(() => { job.running = false })
  return job
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0f1115;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><h2>${title}</h2><p style="color:#9aa0aa">${text}</p></div>`

async function loginCallback(u, res) {
  const login = pendingLogin
  if (!login || u.searchParams.get('state') !== login.state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(page('Link expired', 'This authorization link belongs to another attempt. Go back to the studio and click Connect again.'))
  }
  pendingLogin = null
  try {
    const r = await fetch('https://apimodels.app/api/cli-auth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: u.searchParams.get('code') ?? '' }), signal: AbortSignal.timeout(30000),
    })
    const data = await r.json().catch(() => null)
    const key = data?.data?.apiKey
    if (!r.ok || !key) throw new Error(data?.msg || `exchange failed (HTTP ${r.status})`)
    await storeKey(key)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page('✓ Connected', 'You can close this tab and go back to the studio.'))
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page('Authorization failed', `${e.message}. Go back to the studio and try again.`))
  }
}

async function serveFile(req, res, file) {
  let info
  try { info = await stat(file) } catch { return json(res, 404, { error: 'not found' }) }
  if (!info.isFile()) return json(res, 404, { error: 'not found' })
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream'
  // Range requests, so the browser can seek inside videos.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1
    if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end() }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' })
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' })
  createReadStream(file).pipe(res)
}

async function api(req, res, u, parts) {
  const method = req.method
  if (parts[0] === 'status' && method === 'GET') {
    const key = await resolveKey()
    let balance = null
    if (key) {
      const r = await call(`${API}/balance`, { method: 'GET' }, key)
      balance = r.ok ? Number(r.data?.balance ?? r.data?.credits) : null
      if (!r.ok && /401/.test(r.message)) return json(res, 200, { key: false, keyRejected: true, ffmpeg, dir: ROOT })
    }
    return json(res, 200, { key: !!key, balance, ffmpeg, dir: ROOT })
  }
  if (parts[0] === 'login' && method === 'POST') {
    pendingLogin = { state: randomBytes(16).toString('base64url') }
    return json(res, 200, { url: `https://apimodels.app/cli-auth?port=${port}&state=${pendingLogin.state}` })
  }
  if (parts[0] !== 'projects') return json(res, 404, { error: 'not found' })

  if (parts.length === 1 && method === 'GET') return json(res, 200, { projects: await listProjects() })
  if (parts.length === 1 && method === 'POST') {
    const key = await resolveKey()
    if (!key) return json(res, 401, { error: 'connect your apimodels.app account first' })
    const b = await body(req)
    if (!String(b.story || '').trim()) return json(res, 400, { error: 'paste a story first' })
    const p = await storyboard(b, key)
    const id = `${slugify(p.title)}-${randomBytes(3).toString('hex')}`
    await mkdir(join(ROOT, id), { recursive: true })
    await writeFile(join(ROOT, id, 'project.json'), JSON.stringify(p, null, 2) + '\n')
    return json(res, 200, view(id, await project(id)))
  }

  const id = parts[1]
  const proj = await project(id)
  const running = jobs.get(id)?.running
  if (parts.length === 2 && method === 'GET') return json(res, 200, view(id, proj))
  if (parts.length === 2 && method === 'PUT') {
    if (running) return json(res, 409, { error: 'a generation is running — wait for it to finish' })
    const b = await body(req)
    if (!b.project || typeof b.project !== 'object' || Array.isArray(b.project)) return json(res, 400, { error: 'project missing' })
    // Mutate in place: the engine object and any later job share this reference.
    for (const k of Object.keys(proj.data)) delete proj.data[k]
    Object.assign(proj.data, withDefaults(b.project))
    await proj.save()
    return json(res, 200, view(id, proj))
  }
  if (parts.length === 3 && parts[2] === 'run' && method === 'POST') {
    if (running) return json(res, 409, { error: 'a generation is already running for this project' })
    const b = await body(req)
    if (!['cast', 'render', 'assemble'].includes(b.step)) return json(res, 400, { error: 'unknown step' })
    const key = await resolveKey()
    if (b.step !== 'assemble' && !key) return json(res, 401, { error: 'connect your apimodels.app account first' })
    startJob(id, proj, b.step, b, key)
    return json(res, 202, view(id, proj))
  }
  return json(res, 404, { error: 'not found' })
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end('forbidden host') }
    const u = new URL(req.url, `http://${host}`)
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (u.pathname === '/callback') return loginCallback(u, res)
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = (await readFile(join(PUBLIC, 'index.html'), 'utf8')).replace('__STUDIO_TOKEN__', token)
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' })
      return res.end(html)
    }
    if (parts.length === 1 && ['app.js', 'style.css'].includes(parts[0])) return serveFile(req, res, join(PUBLIC, parts[0]))

    if (parts[0] === 'files') {
      if (u.searchParams.get('t') !== token) { res.writeHead(403); return res.end('forbidden') }
      if (!ID.test(parts[1] || '')) return json(res, 404, { error: 'not found' })
      const base = join(ROOT, parts[1])
      const file = resolve(base, ...parts.slice(2))
      if (!file.startsWith(base + sep)) return json(res, 403, { error: 'forbidden' })
      return serveFile(req, res, file)
    }
    if (parts[0] === 'api') {
      if (req.headers['x-studio-token'] !== token) return json(res, 403, { error: 'forbidden' })
      return await api(req, res, u, parts.slice(1))
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || String(e) })
    else res.end()
  }
})

function listen(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) { port += 1; return listen(attempt + 1) }
    console.error(`✗ cannot start the studio: ${e.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    port = server.address().port // --port 0 asks the OS for a free one
    const url = `http://127.0.0.1:${port}/`
    console.log(`AI Short Drama Studio is running → ${url}\nProjects are saved in ${ROOT}\nPress Ctrl-C to stop.`)
    if (!args.includes('--no-open')) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(opener, [url], () => {})
    }
  })
}

execFile('ffmpeg', ['-version'], (err) => { ffmpeg = !err })
listen()
