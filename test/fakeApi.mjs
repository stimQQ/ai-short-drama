// A stand-in for api.apimodels.app: storyboard, images, voice, video, billing records
// and balance, with real media files made by ffmpeg. Used by the studio test, and
// runnable by hand to click through the studio without spending anything:
//
//   node test/fakeApi.mjs            → prints the APIMODELS_BASE_URL to use
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plan = {
  title: 'Snow Lantern',
  characters: [{ id: 'linfeng', name: '林风', look: '青年剑客，黑色马尾，白袍灰斗篷' }],
  locations: [{ id: 'inn', name: '客栈', look: '雪夜山间客栈，屋檐挂红灯笼' }],
  shots: [
    { id: 's1', characters: ['linfeng'], location: 'inn', prompt: '远景，缓慢推进。林风顶着风雪走向客栈。', narration: '雪下得很大。' },
    { id: 's2', characters: ['linfeng'], location: 'inn', prompt: '近景，固定镜头。林风抬头看见灯火。', narration: '他终于看见了灯火。' },
  ],
}

export function startFakeApi() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-api-'))
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a])
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', join(dir, 'sheet.png'))
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', join(dir, 'voice.mp3'))
  ff('-f', 'lavfi', '-i', 'testsrc=size=480x854:rate=24:duration=4', '-f', 'lavfi', '-i', 'anoisesrc=d=4:a=0.05', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'clip.mp4'))
  const media = { images: 'sheet.png', audio: 'voice.mp3', video: 'clip.mp4' }
  const calls = []
  let n = 0

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const send = (o, headers = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(o)) }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      calls.push(`${req.method} ${u.pathname}`)
      // Result files are public URLs on the real API, so they need no key here either.
      if (u.pathname.startsWith('/media/')) { res.writeHead(200); return res.end(readFileSync(join(dir, u.pathname.slice(7)))) }
      if (req.headers.authorization !== 'Bearer sk_fakeapitestkey000000') return send({ code: 401, msg: 'invalid key' })
      const kind = u.pathname.match(/^\/v1\/(images|audio|video)\/generations$/)?.[1]
      if (u.pathname === '/v1/chat/completions') return send({ choices: [{ message: { content: JSON.stringify(plan) } }] }, { 'x-apimodels-cost': '0.002' })
      if (kind && req.method === 'POST') return send({ code: 200, data: { taskId: `${kind}-${++n}` } })
      if (kind) return send({ code: 200, data: { state: 'completed', resultUrls: [`http://127.0.0.1:${server.address().port}/media/${media[kind]}`] } })
      if (u.pathname.startsWith('/v1/records/')) return send({ code: 200, data: { settled: true, credits: 0.01 } })
      if (u.pathname === '/v1/balance') return send({ code: 200, data: { balance: 12.34 } })
      res.writeHead(404)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`, key: 'sk_fakeapitestkey000000', calls, close: () => server.close(),
  })))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = await startFakeApi()
  console.log(`Fake API running. In another terminal:\n  APIMODELS_BASE_URL=${api.url} APIMODELS_API_KEY=${api.key} node studio/server.mjs --dir /tmp/drama-studio-demo`)
}
