// Offline tests: no API key, no network, no spend. `node --test test/`
// The assemble test builds fake clips with ffmpeg and is skipped without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  withDefaults, validate, buildShotPrompt, shotRefUrls, shotDuration, estimate,
  buildSrt, splitSentences, slugify, defaultVideoModel, estimateSpeechSeconds, sheetPrompt,
} from '../scripts/drama.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'drama.mjs')
const example = (name) => withDefaults(JSON.parse(readFileSync(join(ROOT, 'examples', name, 'project.json'), 'utf8')))

const base = (over = {}) => withDefaults({
  title: 'T',
  style: 'anime',
  characters: [{ id: 'a', name: 'Ann', look: 'x', sheet_url: 'https://r/a.png' }, { id: 'b', name: 'Bo', look: 'y', sheet_url: 'https://r/b.png' }],
  locations: [{ id: 'room', name: 'Room', look: 'z', sheet_url: 'https://r/room.png' }],
  shots: [{ id: 's1', prompt: 'p', characters: ['a', 'b'], location: 'room', duration: 5 }],
  ...over,
})

test('both examples validate cleanly', () => {
  for (const name of ['last-delivery', 'snow-night-zh']) {
    const { errors } = validate(example(name))
    assert.deepEqual(errors, [], name)
  }
})

test('stylised projects default to the dreamina line, everything else to seedance-2.0-mini', () => {
  assert.equal(defaultVideoModel('2D anime, cel shading'), 'dreamina-seedance-2-0-mini')
  assert.equal(defaultVideoModel('国漫风格，水墨'), 'dreamina-seedance-2-0-mini')
  assert.equal(defaultVideoModel('photorealistic, 35mm film'), 'seedance-2.0-mini')
  assert.equal(defaultVideoModel(undefined), 'seedance-2.0-mini')
  assert.equal(base({ video_model: 'seedance-2.0' }).video_model, 'seedance-2.0')
})

test('narrator defaults only appear in narration mode', () => {
  assert.equal(base().narrator, undefined)
  assert.equal(base({ mode: 'narration', language: 'zh' }).narrator.voice_id, 'male-qn-qingse')
  assert.equal(base({ mode: 'narration' }).narrator.voice_id, 'English_Trustworthy_Man')
})

test('validate: duration must be a whole number from 4 to 15', () => {
  for (const d of [3, 16, 4.5]) {
    const { errors } = validate(base({ shots: [{ id: 's1', prompt: 'p', duration: d }] }))
    assert.ok(errors.some((e) => /duration/.test(e)), `duration ${d} should be rejected`)
  }
  for (const d of [4, 15]) assert.deepEqual(validate(base({ shots: [{ id: 's1', prompt: 'p', duration: d }] })).errors, [])
})

test('validate: unknown ids, duplicates and missing prompt', () => {
  const { errors } = validate(base({ shots: [
    { id: 's1', prompt: 'p', characters: ['ghost'], location: 'nowhere' },
    { id: 's1' },
  ] }))
  assert.ok(errors.some((e) => /unknown character "ghost"/.test(e)))
  assert.ok(errors.some((e) => /unknown location "nowhere"/.test(e)))
  assert.ok(errors.some((e) => /duplicate shot id "s1"/.test(e)))
  assert.ok(errors.some((e) => /"prompt" is required/.test(e)))
})

test('validate: at most 9 reference images per shot', () => {
  const characters = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, look: 'x' }))
  const ok = base({ characters, locations: [], shots: [{ id: 's1', prompt: 'p', characters: characters.map((c) => c.id) }] })
  assert.deepEqual(validate(ok).errors, [])
  const over = base({ characters, shots: [{ id: 's1', prompt: 'p', characters: characters.map((c) => c.id), location: 'room' }] })
  assert.ok(validate(over).errors.some((e) => /at most 9/.test(e)))
})

test('validate: resolution must exist for the chosen model', () => {
  assert.ok(validate(base({ resolution: '1080p' })).errors.some((e) => /does not render 1080p/.test(e)))
  assert.deepEqual(validate(base({ video_model: 'seedance-2.0', resolution: '1080p' })).errors, [])
})

test('validate: a character needs a look or an image', () => {
  const { errors } = validate(base({ characters: [{ id: 'a' }], shots: [{ id: 's1', prompt: 'p', characters: ['a'] }] }))
  assert.ok(errors.some((e) => /character "a"/.test(e)))
})

test('validate: narration longer than one shot can hold is an error', () => {
  const long = 'word '.repeat(60)
  const { errors } = validate(base({ mode: 'narration', shots: [{ id: 's1', prompt: 'p', narration: long }] }))
  assert.ok(errors.some((e) => /split it across two shots/.test(e)))
})

test('prompt: references are cited by position, characters first, then the location', () => {
  const p = base()
  const prompt = buildShotPrompt(p, p.shots[0])
  assert.match(prompt, /@image1 is the character sheet for Ann/)
  assert.match(prompt, /@image2 is the character sheet for Bo/)
  assert.match(prompt, /@image3 is the location "Room"/)
  assert.deepEqual(shotRefUrls(p, p.shots[0]), ['https://r/a.png', 'https://r/b.png', 'https://r/room.png'])
  assert.match(prompt, /No subtitles/)
})

test('prompt: Chinese projects cite 图片N and quote dialogue in Chinese', () => {
  const p = base({ language: 'zh', shots: [{ id: 's1', prompt: '中景', characters: ['a'], dialogue: [{ who: 'a', line: '你好' }] }] })
  const prompt = buildShotPrompt(p, p.shots[0])
  assert.match(prompt, /图片1是「Ann」的角色设定图/)
  assert.match(prompt, /Ann说："你好"/)
  assert.doesNotMatch(prompt, /@image/)
})

test('prompt: dialogue carries the speaker name and voice; silence is stated when nobody talks', () => {
  const p = base({ characters: [{ id: 'a', name: 'Ann', look: 'x', voice: 'low and calm' }], locations: [],
    shots: [{ id: 's1', prompt: 'p', characters: ['a'], dialogue: [{ who: 'a', line: 'Hi.' }, { line: 'Who is there?' }] }, { id: 's2', prompt: 'p' }] })
  assert.match(buildShotPrompt(p, p.shots[0]), /Ann \(low and calm\) says: "Hi\."/)
  assert.match(buildShotPrompt(p, p.shots[0]), /A voice off-screen says: "Who is there\?"/)
  assert.match(buildShotPrompt(p, p.shots[1]), /Nobody speaks/)
})

test('prompt: narration mode ignores dialogue and keeps the shot silent', () => {
  const p = base({ mode: 'narration', shots: [{ id: 's1', prompt: 'p', dialogue: [{ who: 'a', line: 'Hi.' }], narration: 'n' }] })
  const prompt = buildShotPrompt(p, p.shots[0])
  assert.doesNotMatch(prompt, /says:/)
  assert.match(prompt, /Nobody speaks/)
})

test('duration: narration shots stretch to fit the voice-over, within 4–15 s', () => {
  const p = base({ mode: 'narration' })
  assert.equal(shotDuration(p, { narration: 'x', voice: { seconds: 7.2 } }), 8)
  assert.equal(shotDuration(p, { narration: 'x', voice: { seconds: 1.5 } }), 4)
  assert.equal(shotDuration(p, { narration: 'x', voice: { seconds: 2 }, duration: 10 }), 10)
  assert.equal(shotDuration(p, { narration: 'x', voice: { seconds: 20 } }), 15)
  assert.equal(shotDuration(p, {}), 4)
  assert.equal(shotDuration(base(), {}), 5)
})

test('speech estimate counts CJK characters and latin words', () => {
  assert.ok(Math.abs(estimateSpeechSeconds('一二三四五六七八九') - 2) < 0.01)
  assert.ok(Math.abs(estimateSpeechSeconds('one two three four five six seven eight nine ten eleven twelve thirteen') - 5) < 0.01)
})

test('estimate: only work still to do is priced; finished and in-flight tasks are not paid again', () => {
  const p = base({ shots: [
    { id: 's1', prompt: 'p', duration: 5, state: 'done' },
    { id: 's2', prompt: 'p', duration: 6, state: 'submitted', task_id: 't2' },
    { id: 's3', prompt: 'p', duration: 4, state: 'failed' },
    { id: 's4', prompt: 'p', duration: 8 },
  ] })
  const est = estimate(p)
  const shots = est.rows.find((r) => r.stage === 'shots')
  assert.equal(est.rows.find((r) => r.stage === 'cast'), undefined) // every sheet already exists
  assert.match(shots.what, /2 shot\(s\), 12 s/)
  assert.ok(Math.abs(shots.cost - 12 * 0.0225) < 1e-9)
})

test('estimate: unknown model prices are reported as unknown, not as zero', () => {
  const est = estimate(base({ video_model: 'some-future-model' }))
  assert.equal(est.complete, false)
  assert.equal(est.rows.find((r) => r.stage === 'shots').cost, null)
})

test('estimate: a short narration clip is priced at the observed per-clip minimum', () => {
  const p = base({ mode: 'narration', shots: [{ id: 's1', prompt: 'p', narration: '雪下得很大。他终于看见了灯火。' }] })
  const voice = estimate(p).rows.find((r) => r.stage === 'voice')
  assert.ok(Math.abs(voice.cost - 0.004) < 1e-9, `got ${voice.cost}`)
})

test('sheet prompt: a character sheet takes the rendering style but keeps a plain grey backdrop', () => {
  const p = base({ style: '国漫风格，冷色调雪夜' })
  const prompt = sheetPrompt(p, p.characters[0], 'character')
  assert.match(prompt, /drawing style only, not any setting/)
  assert.match(prompt, /flat plain neutral grey/)
  assert.match(sheetPrompt(p, p.locations[0], 'location'), /No people/)
})

test('subtitles: dialogue lines split each shot evenly; narration splits by sentence', () => {
  const d = base({ shots: [{ id: 's1', prompt: 'p', dialogue: [{ who: 'a', line: 'One.' }, { who: 'b', line: 'Two.' }] }] })
  const srt = buildSrt(d, [{ shot: d.shots[0], start: 10, duration: 6 }])
  assert.match(srt, /^1\n00:00:10,200 --> 00:00:12,900\nOne\.\n/)
  assert.match(srt, /2\n00:00:13,200 --> 00:00:15,900\nTwo\.\n/)

  const n = base({ mode: 'narration', shots: [{ id: 's1', prompt: 'p', narration: '第一句。第二句话！', voice: { seconds: 4 } }] })
  const srt2 = buildSrt(n, [{ shot: n.shots[0], start: 0, duration: 5 }])
  assert.match(srt2, /00:00:00,300 --> .*\n第一句。/)
  assert.match(srt2, /2\n.* --> 00:00:04,300\n第二句话！/)
})

test('helpers: sentence split and slug', () => {
  assert.deepEqual(splitSentences('Hi there. How are you? Fine!'), ['Hi there.', 'How are you?', 'Fine!'])
  assert.deepEqual(splitSentences('雪很大。他走了三天，终于看见灯火！'), ['雪很大。', '他走了三天，终于看见灯火！'])
  assert.equal(slugify('The Last Delivery'), 'the-last-delivery')
  assert.equal(slugify('雪夜来客'), 'episode')
})

test('key: a login made with the apimodels MCP server (credentials.json) is picked up', async () => {
  const home = mkdtempSync(join(tmpdir(), 'drama-home-'))
  execFileSync('mkdir', ['-p', join(home, '.apimodels')])
  writeFileSync(join(home, '.apimodels', 'credentials.json'), JSON.stringify({ api_key: 'sk_frommcplogin00000000' }))
  let seen = null
  const server = createServer((req, res) => {
    seen = req.headers.authorization
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 200, data: { balance: 1 } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const env = { ...process.env, HOME: home, APIMODELS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }
  delete env.APIMODELS_API_KEY
  try {
    const child = spawn('node', [SCRIPT, 'check'], { env, stdio: 'ignore' })
    const code = await new Promise((r) => child.on('exit', r))
    assert.equal(code, 0)
    assert.equal(seen, 'Bearer sk_frommcplogin00000000')
  } finally {
    server.close()
  }
})

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

test('assemble: normalizes mixed clips, mixes narration, joins and writes subtitles', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'drama-test-'))
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a])
  // s1: video with sound at the target size; s2: silent and a different size, as a
  // real mix of model outputs can be. Narration is a plain tone.
  ff('-f', 'lavfi', '-i', 'testsrc=size=480x854:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', join(dir, 's1.mp4'))
  ff('-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=5', '-c:v', 'libx264', join(dir, 's2.mp4'))
  ff('-f', 'lavfi', '-i', 'sine=frequency=800:duration=2', join(dir, 'n1.mp3'))
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    title: 'Test Cut', mode: 'narration', style: 'anime',
    shots: [
      { id: 's1', prompt: 'p', narration: 'First line. Second line.', voice: { file: 'n1.mp3', seconds: 2, text_hash: 'x' }, state: 'done', file: 's1.mp4' },
      { id: 's2', prompt: 'p', state: 'done', file: 's2.mp4' },
    ],
  }))
  execFileSync('node', [SCRIPT, 'assemble', join(dir, 'project.json'), '--burn-subs'], { stdio: 'pipe' })
  const out = join(dir, 'test-cut.mp4')
  assert.ok(existsSync(out))
  assert.ok(existsSync(join(dir, 'test-cut.subtitled.mp4')))
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', out]))
  assert.ok(Math.abs(Number(info.format.duration) - 9) < 0.3, `duration ${info.format.duration}`)
  const v = info.streams.find((s) => s.codec_type === 'video')
  assert.deepEqual([v.width, v.height], [480, 854])
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'))
  const srt = readFileSync(join(dir, 'test-cut.srt'), 'utf8')
  assert.match(srt, /First line\./)
  assert.equal(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).output.file, 'test-cut.mp4')
})

test('shots: the task id is saved before waiting, so a killed run resumes instead of paying again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drama-resume-'))
  let complete = false
  let onPost = null
  const posts = []
  const polls = []
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'POST' && u.pathname === '/v1/video/generations') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { posts.push(JSON.parse(body)); json({ code: 200, data: { taskId: 't-new' } }); onPost?.() })
      return
    }
    if (req.method === 'GET' && u.pathname === '/v1/video/generations') {
      const id = u.searchParams.get('task_id')
      polls.push(id)
      if (!complete) return json({ code: 200, data: { state: 'pending' } })
      return json({ code: 200, data: { state: 'completed', resultUrls: [`http://127.0.0.1:${server.address().port}/files/${id}.mp4`] } })
    }
    if (u.pathname.startsWith('/v1/records/')) return json({ code: 200, data: { settled: true, credits: 0.09 } })
    if (u.pathname.startsWith('/files/')) { res.writeHead(200); res.end(Buffer.from('fake-mp4')); return }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const project = join(dir, 'project.json')
  writeFileSync(project, JSON.stringify({ title: 'R', style: 'anime', shots: [
    { id: 's1', prompt: 'p', state: 'done', file: 'shots/s1.mp4', task_id: 't1' },
    { id: 's2', prompt: 'p', state: 'submitted', task_id: 't-old' },
    { id: 's3', prompt: 'p', state: 'failed', error: 'busy' },
    { id: 's4', prompt: 'p' },
  ] }))
  const env = { ...process.env, APIMODELS_API_KEY: 'sk_offlinetest000000000', APIMODELS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }
  const runShots = () => spawn('node', [SCRIPT, 'shots', project, '--concurrency', '4'], { env, stdio: 'ignore' })
  const exited = (child) => new Promise((r) => child.on('exit', (code) => r(code)))

  try {
    // Run 1 is killed right after the API accepted s4 — a crash or a closed laptop.
    const first = runShots()
    await new Promise((r) => { onPost = r })
    await new Promise((r) => setTimeout(r, 300))
    first.kill('SIGKILL')
    await exited(first)
    let saved = JSON.parse(readFileSync(project, 'utf8'))
    const s4 = saved.shots.find((s) => s.id === 's4')
    assert.equal(s4.task_id, 't-new')
    assert.equal(s4.state, 'submitted')

    // Run 2: the renders finish. Nothing is created a second time.
    complete = true
    onPost = null
    const code = await exited(runShots())
    assert.equal(posts.length, 1, 'only s4 was ever submitted')
    assert.ok(!polls.includes('t1'), 'a finished shot is not touched')
    saved = JSON.parse(readFileSync(project, 'utf8'))
    const by = Object.fromEntries(saved.shots.map((s) => [s.id, s]))
    assert.equal(by.s2.state, 'done')
    assert.equal(by.s2.cost, 0.09)
    assert.equal(by.s3.state, 'failed', 'failed shots wait for --retry-failed')
    assert.equal(by.s4.state, 'done')
    assert.ok(existsSync(join(dir, by.s4.file)))
    assert.equal(code, 0)
  } finally {
    server.close()
  }
})
