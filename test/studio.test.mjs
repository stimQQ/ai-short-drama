// The studio end to end against the fake API: story → storyboard → sheets →
// voice + shots → cut, plus the localhost protections. No key, no spend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeApi } from './fakeApi.mjs'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'studio', 'server.mjs')
let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

test('studio: story to finished episode, and requests from elsewhere are refused', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const api = await startFakeApi()
  const home = mkdtempSync(join(tmpdir(), 'studio-home-'))
  writeFileSync(join(home, 'secret.txt'), 'outside every project')
  const env = { ...process.env, HOME: home, APIMODELS_BASE_URL: api.url, APIMODELS_API_KEY: api.key }
  const child = spawn('node', [SERVER, '--dir', join(home, 'dramas'), '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const base = await new Promise((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (c) => { out += c; const m = out.match(/running → (http:\/\/127\.0\.0\.1:\d+)\//); if (m) resolve(m[1]) })
      child.on('exit', (code) => reject(new Error(`studio exited (${code})`)))
    })
    const html = await (await fetch(`${base}/`)).text()
    const token = html.match(/name="studio-token" content="([^"]+)"/)[1]
    const call = async (path, init = {}) => {
      const r = await fetch(`${base}/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token } })
      return { status: r.status, body: await r.json() }
    }
    const waitJob = async (id) => {
      for (let i = 0; i < 60; i++) {
        const { body } = await call(`/projects/${id}`)
        if (!body.job?.running) return body
        await new Promise((r) => setTimeout(r, 1000))
      }
      throw new Error('job did not finish')
    }

    // Localhost protections.
    assert.equal((await fetch(`${base}/api/status`)).status, 403, 'no token')
    const port = new URL(base).port
    const rebind = await new Promise((resolve) => {
      import('node:http').then(({ request }) => request({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}` } }, (r) => resolve(r.statusCode)).end())
    })
    assert.equal(rebind, 403, 'foreign Host header')

    const status = (await call('/status')).body
    assert.equal(status.key, true)
    assert.equal(status.balance, 12.34)

    const created = await call('/projects', { method: 'POST', body: JSON.stringify({ story: '雪夜，剑客林风找到客栈。', mode: 'narration', seconds: 30, style: '国漫风格' }) })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.id
    assert.equal(created.body.project.shots.length, 2)
    assert.equal(created.body.spent, 0.002, 'storyboard cost is counted')

    // An edit is saved and comes back.
    const p = created.body.project
    p.shots[1].prompt = '近景，固定镜头。林风抬头，远处亮起灯火。'
    const saved = await call(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ project: p }) })
    assert.equal(saved.body.project.shots[1].prompt, p.shots[1].prompt)

    assert.equal((await call(`/projects/${id}/run`, { method: 'POST', body: JSON.stringify({ step: 'cast' }) })).status, 202)
    assert.equal((await call(`/projects/${id}/run`, { method: 'POST', body: JSON.stringify({ step: 'cast' }) })).status, 409, 'one job at a time')
    let v = await waitJob(id)
    assert.equal(v.job.code, 0, v.job.log.join('\n'))
    assert.ok(v.project.characters[0].sheet_path && v.project.locations[0].sheet_path)

    await call(`/projects/${id}/run`, { method: 'POST', body: JSON.stringify({ step: 'render' }) })
    v = await waitJob(id)
    assert.equal(v.job.code, 0, v.job.log.join('\n'))
    assert.ok(v.project.shots.every((s) => s.state === 'done' && s.voice?.file))
    assert.deepEqual(v.stale, [])

    await call(`/projects/${id}/run`, { method: 'POST', body: JSON.stringify({ step: 'assemble' }) })
    v = await waitJob(id)
    assert.equal(v.job.code, 0, v.job.log.join('\n'))
    assert.ok(v.project.output.subtitled)

    const file = `${base}/files/${id}/${v.project.output.file}`
    assert.equal((await fetch(file)).status, 403, 'files need the token too')
    const full = await fetch(`${file}?t=${token}`)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    const part = await fetch(`${file}?t=${token}`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(part.status, 206)
    assert.equal((await part.arrayBuffer()).byteLength, 100)
    const escape = await fetch(`${base}/files/${id}/..%2F..%2Fsecret.txt?t=${token}`)
    assert.equal(escape.status, 403, 'no escaping the project folder')

    // Editing a rendered shot flags it for re-rendering.
    v.project.shots[0].prompt += ' 风更大了。'
    const edited = await call(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ project: v.project }) })
    assert.deepEqual(edited.body.stale, ['s1'])

    const list = (await call('/projects')).body.projects
    assert.equal(list[0].id, id)
    assert.equal(list[0].done, 2)
  } finally {
    child.kill()
    api.close()
  }
})
