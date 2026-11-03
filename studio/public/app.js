// AI Short Drama Studio — browser side. No framework, no build step: state lives in
// one object, every change re-renders the main panel from it, and polling runs only
// while a generation is in progress (inputs are disabled then, so nothing typed is lost).

const token = document.querySelector('meta[name="studio-token"]').content

const T = {
  zh: {
    brand: 'AI 短剧工作台', newProject: '+ 新建短剧', folder: '项目保存在：', noProjects: '还没有项目',
    connect: '连接 apimodels', connecting: '等待浏览器授权…', connected: '已连接', balance: '余额', keyRejected: 'Key 无效，请重新连接',
    connectHint: '点「连接 apimodels」，在打开的网页里登录并点 Authorize。Key 只保存在这台电脑上，生成费用从你的 apimodels.app 余额扣。',
    steps: ['故事', '角色与场景', '分镜', '成片'],
    storyTitle: '写下或粘贴你的故事', storyPlaceholder: '例：那一年的雪下得特别大。年轻的剑客林风为了寻找失踪的师父，在山里走了三天……',
    style: '画风', customStyle: '自定义画风', aspect: '画幅', vertical: '竖屏 9:16', horizontal: '横屏 16:9',
    mode: '讲述方式', narration: '旁白讲故事（漫剧）', dialogue: '角色说台词', length: '时长', quality: '画质', seconds: '秒',
    plan: 'AI 拆分镜', planCost: '约 $0.01，30 秒左右', planning: 'AI 正在拆分镜，大约 30 秒…', needStory: '先写下故事',
    replan: '用这段故事重新拆一版（另存为新项目）',
    castTitle: '角色与场景', castHint: '每个角色一张设定图，之后每个镜头都用它保持长相一致。不满意就改描述再重画——设定图最便宜，镜头最贵。',
    look: '外貌 / 场景描述', voice: '声音', name: '名字', character: '角色', location: '场景',
    genCast: '生成设定图', redraw: '重画', notYet: '未生成', next: '下一步', back: '上一步',
    shotsTitle: '分镜', shotsHint: '每个镜头 4–15 秒。先生成一个看看效果，满意再生成全部。',
    videoModel: '视频模型', renderAll: '生成全部镜头', renderOne: '生成这个', rerender: '重新生成', retry: '重试',
    prompt: '画面与镜头', narrationText: '旁白', line: '台词', addLine: '+ 台词', offscreen: '画外音', duration: '时长',
    deleteShot: '删除', addShot: '+ 在后面加一个镜头', inShot: '出场角色', noLocation: '无场景',
    state: { todo: '未生成', submitting: '提交中', submitted: '生成中', done: '完成', failed: '失败' },
    stale: '内容已修改，重新生成才会生效', renderTime: '每个镜头通常 2–8 分钟，3 个同时进行。可以先去做别的。',
    finalTitle: '成片', assemble: '合成成片', assembleHint: '在本机用 ffmpeg 拼接、混入旁白并压字幕，免费。',
    download: '下载', withSubs: '带字幕版', subtitles: '字幕 .srt', plain: '无字幕版', missing: '还有镜头没生成：',
    spent: '已花费', toPay: '还要花', running: '进行中', log: '运行记录', failedHint: '失败的任务不扣费。',
    noFfmpeg: '没找到 ffmpeg，合成成片需要它：macOS 运行 brew install ffmpeg，Windows 运行 winget install ffmpeg，Ubuntu 运行 sudo apt install ffmpeg，然后重启工作台。',
    realPerson: '动漫 / 国漫风格选第一组；写实真人风格选「写实」那组。',
    saved: '已保存', error: '出错了：',
    presets: ['国漫风格，2D 动画，水墨质感，电影感光影', '日系动漫，赛璐璐上色，柔和光线', '3D 动画电影风格，柔和的全局光照', '写实电影感，35mm 胶片质感，自然光', '水彩绘本风格，温暖柔和的色调'],
  },
  en: {
    brand: 'AI Short Drama Studio', newProject: '+ New drama', folder: 'Projects are saved in: ', noProjects: 'No projects yet',
    connect: 'Connect apimodels', connecting: 'Waiting for the browser…', connected: 'Connected', balance: 'Balance', keyRejected: 'Key rejected — connect again',
    connectHint: 'Click “Connect apimodels”, log in on the page that opens and click Authorize. The key stays on this computer; generations are billed to your apimodels.app balance.',
    steps: ['Story', 'Cast', 'Shots', 'Episode'],
    storyTitle: 'Write or paste your story', storyPlaceholder: 'e.g. On a rainy night, a courier delivers one last parcel to an old woman who has not received mail in years…',
    style: 'Look', customStyle: 'Custom look', aspect: 'Frame', vertical: 'Vertical 9:16', horizontal: 'Landscape 16:9',
    mode: 'Storytelling', narration: 'A narrator tells it', dialogue: 'Characters speak', length: 'Length', quality: 'Quality', seconds: 's',
    plan: 'Write the shots with AI', planCost: 'about $0.01, ~30 s', planning: 'Writing the shots — about 30 seconds…', needStory: 'Write a story first',
    replan: 'Plan this story again (as a new project)',
    castTitle: 'Characters and places', castHint: 'Every character gets one reference sheet, and every shot uses it to keep the face the same. Fix the description and redraw now — sheets are the cheap step, shots the expensive one.',
    look: 'Look / description', voice: 'Voice', name: 'Name', character: 'Character', location: 'Location',
    genCast: 'Draw reference images', redraw: 'Redraw', notYet: 'Not drawn yet', next: 'Next', back: 'Back',
    shotsTitle: 'Shots', shotsHint: 'Each shot is 4–15 s. Render one first to check the look, then the rest.',
    videoModel: 'Video model', renderAll: 'Render all shots', renderOne: 'Render this', rerender: 'Re-render', retry: 'Retry',
    prompt: 'What we see', narrationText: 'Narration', line: 'Line', addLine: '+ line', offscreen: 'Off-screen', duration: 'Length',
    deleteShot: 'Delete', addShot: '+ Add a shot after', inShot: 'In this shot', noLocation: 'No location',
    state: { todo: 'Not rendered', submitting: 'Submitting', submitted: 'Rendering', done: 'Done', failed: 'Failed' },
    stale: 'Edited since it was rendered — re-render to apply', renderTime: 'A shot usually takes 2–8 minutes; 3 run at once. Feel free to do something else.',
    finalTitle: 'Episode', assemble: 'Cut the episode', assembleHint: 'Joins the shots, mixes the narration and burns in subtitles with ffmpeg on this computer. Free.',
    download: 'Download', withSubs: 'With subtitles', subtitles: 'Subtitles .srt', plain: 'Without subtitles', missing: 'Not rendered yet: ',
    spent: 'Spent', toPay: 'Still to pay', running: 'Running', log: 'Log', failedHint: 'Failed tasks are not charged.',
    noFfmpeg: 'ffmpeg was not found; cutting the episode needs it. macOS: brew install ffmpeg · Windows: winget install ffmpeg · Ubuntu: sudo apt install ffmpeg — then restart the studio.',
    realPerson: 'Pick from the first group for anime or comic looks, and from the “photoreal” group for realistic people.',
    saved: 'Saved', error: 'Something went wrong: ',
    presets: ['2D anime, soft cel shading, cinematic lighting', 'Chinese ink-wash animation, cool palette, cinematic lighting', '3D animated film, soft global illumination', 'Photoreal cinematic, 35mm film look, natural light', 'Watercolour picture book, warm soft colours'],
  },
}

const MODELS = [
  { id: 'dreamina-seedance-2-0-mini', label: 'Seedance 2.0 Mini', group: 'stylised', res: ['480p', '720p'] },
  { id: 'dreamina-seedance-2-0-fast', label: 'Seedance 2.0 Fast', group: 'stylised', res: ['480p', '720p'] },
  { id: 'dreamina-seedance-2-0', label: 'Seedance 2.0', group: 'stylised', res: ['480p', '720p', '1080p'] },
  { id: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini', group: 'photoreal', res: ['480p', '720p'] },
  { id: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', group: 'photoreal', res: ['480p', '720p'] },
  { id: 'seedance-2.0', label: 'Seedance 2.0', group: 'photoreal', res: ['480p', '720p', '1080p'] },
]

let lang = (() => { try { return localStorage.getItem('studioLang') } catch { return null } })() || (navigator.language.startsWith('zh') ? 'zh' : 'en')
const state = { status: null, projects: [], current: null, step: 0, busy: '', error: '', login: false, form: null }
let pollTimer = null
let saveTimer = null

const t = () => T[lang]
const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const usd = (n) => (n == null ? '?' : `$${Number(n).toFixed(n < 10 ? 3 : 2)}`)
const fileUrl = (path, v = '') => `/files/${encodeURIComponent(state.current.id)}/${path.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(token)}&v=${encodeURIComponent(String(v).slice(-16))}`

async function api(path, opts = {}) {
  const r = await fetch(`/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}

function fail(e) { state.error = e?.message || String(e); render() }

// ─── data ────────────────────────────────────────────────────────────────────

async function refreshStatus() {
  try { state.status = await api('/status') } catch (e) { state.status = null; state.error = e.message }
  // The story form's button and banners depend on the account, not only the top bar.
  if (state.current) renderTop(); else render()
}

async function refreshList() {
  try { state.projects = (await api('/projects')).projects } catch (e) { state.error = e.message }
  renderSide()
}

function defaultStep(v) {
  const p = v.project
  const cast = [...p.characters, ...p.locations]
  if (cast.some((x) => !x.sheet_url)) return 1
  if (p.output?.file && p.shots.every((s) => s.state === 'done')) return 3
  return 2
}

async function open(id, step) {
  try {
    const v = await api(`/projects/${encodeURIComponent(id)}`)
    state.current = v
    state.step = step ?? defaultStep(v)
    state.error = ''
    render()
    watchJob()
  } catch (e) { fail(e) }
}

function watchJob() {
  clearTimeout(pollTimer)
  if (!state.current?.job?.running) return
  pollTimer = setTimeout(async () => {
    try {
      const v = await api(`/projects/${encodeURIComponent(state.current.id)}`)
      if (state.current?.id !== v.id) return
      const finished = !v.job?.running
      state.current = v
      render()
      if (finished) { refreshStatus(); refreshList() } else watchJob()
    } catch (e) { fail(e) }
  }, 2500)
}

async function run(step, extra = {}) {
  try {
    state.error = ''
    state.current = await api(`/projects/${encodeURIComponent(state.current.id)}/run`, { method: 'POST', body: JSON.stringify({ step, ...extra }) })
    render()
    refreshList()
    watchJob()
  } catch (e) { fail(e) }
}

/** Edits go straight into the project and are saved after a short pause. */
function edit(mutate) {
  mutate(state.current.project)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}

async function save() {
  clearTimeout(saveTimer)
  try {
    const v = await api(`/projects/${encodeURIComponent(state.current.id)}`, { method: 'PUT', body: JSON.stringify({ project: state.current.project }) })
    // Keep whatever the user typed meanwhile; take the server's numbers.
    state.current.estimate = v.estimate
    state.current.spent = v.spent
    state.current.problems = v.problems
    state.current.stale = v.stale
    renderCosts()
    // Flag edited shots in place; a full re-render here could swallow the click
    // that caused this save (blur → save → DOM replaced before the click lands).
    for (const el of document.querySelectorAll('[data-stale]')) el.hidden = !v.stale.includes(el.dataset.stale)
  } catch (e) { fail(e) }
}

// ─── rendering ───────────────────────────────────────────────────────────────

function renderTop() {
  const s = state.status
  const L = t()
  document.documentElement.lang = lang
  document.title = L.brand
  $('#brandName').textContent = L.brand
  $('#langToggle').textContent = lang === 'zh' ? 'English' : '中文'
  $('#newProject').textContent = L.newProject
  $('#folderNote').textContent = s?.dir ? L.folder + s.dir : ''
  $('#account').innerHTML = !s ? ''
    : s.key ? `<span class="chip ok">${L.connected} · ${L.balance} ${usd(s.balance)}</span>`
    : `<span class="chip warn">${s.keyRejected ? L.keyRejected : ''}</span><button class="primary small" data-action="connect" type="button">${state.login ? L.connecting : L.connect}</button>`
}

function renderSide() {
  const L = t()
  $('#projectList').innerHTML = state.projects.length ? state.projects.map((p) => `
    <button class="projectItem ${state.current?.id === p.id ? 'active' : ''}" data-action="open" data-id="${esc(p.id)}" type="button">
      <span class="projectTitle">${p.running ? '<span class="dot"></span>' : ''}${esc(p.title || p.id)}</span>
      <span class="muted tiny">${p.done}/${p.shots} · ${esc(p.mode === 'dialogue' ? L.dialogue : L.narration)}</span>
    </button>`).join('') : `<p class="muted tiny">${L.noProjects}</p>`
}

function render() {
  renderTop()
  renderSide()
  const L = t()
  const main = $('#main')
  if (!state.current) { main.innerHTML = errorBox() + storyForm(); return }
  const steps = L.steps.map((name, i) => `<button class="step ${i === state.step ? 'active' : ''}" data-action="step" data-step="${i}" type="button"><span>${i + 1}</span>${name}</button>`).join('')
  const body = [storyView, castView, shotsView, finalView][state.step]()
  main.innerHTML = `<nav class="steps">${steps}</nav>${errorBox()}<div id="costs">${costsBar()}</div>${body}${logBox()}`
}

const errorBox = () => (state.error ? `<div class="banner error">${esc(t().error + state.error)}</div>` : '')

function costsBar() {
  const v = state.current
  if (!v) return ''
  const L = t()
  const running = v.job?.running ? `<span class="chip run"><span class="dot"></span>${L.running}</span>` : ''
  return `<div class="costs">${running}<span>${L.spent} <b>${usd(v.spent)}</b></span>${v.estimate.total ? `<span>${L.toPay} ≈ <b>${usd(v.estimate.total)}</b></span>` : ''}</div>`
}

function renderCosts() { const el = $('#costs'); if (el) el.innerHTML = costsBar() }

function logBox() {
  const job = state.current?.job
  if (!job?.log?.length) return ''
  return `<details class="log" ${job.running || job.code ? 'open' : ''}><summary>${t().log}</summary><pre>${esc(job.log.slice(-30).join('\n'))}</pre></details>`
}

const disabled = () => (state.current?.job?.running ? 'disabled' : '')
const stageCost = (stage) => state.current.estimate.rows.filter((r) => stage.includes(r.stage)).reduce((n, r) => n + (r.cost ?? 0), 0)

function storyForm() {
  const L = t()
  const f = state.form ?? (state.form = { story: '', style: L.presets[0], custom: '', aspect: '9:16', mode: 'narration', seconds: 60, resolution: '480p' })
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`
  const presets = L.presets.map((p) => opt(p, p, f.style)).join('') + opt('custom', L.customStyle, f.style)
  return `
  <section class="panel">
    <h1>${L.storyTitle}</h1>
    ${state.status && !state.status.key ? `<div class="banner">${L.connectHint}</div>` : ''}
    <textarea id="story" class="story" rows="12" placeholder="${esc(L.storyPlaceholder)}" data-form="story">${esc(f.story)}</textarea>
    <div class="grid">
      <label>${L.style}<select data-form="style">${presets}</select></label>
      ${f.style === 'custom' ? `<label>${L.customStyle}<input data-form="custom" value="${esc(f.custom)}"></label>` : ''}
      <label>${L.aspect}<select data-form="aspect">${opt('9:16', L.vertical, f.aspect)}${opt('16:9', L.horizontal, f.aspect)}</select></label>
      <label>${L.mode}<select data-form="mode">${opt('narration', L.narration, f.mode)}${opt('dialogue', L.dialogue, f.mode)}</select></label>
      <label>${L.length}<select data-form="seconds">${[30, 60, 90, 120].map((s) => opt(s, `${s} ${L.seconds}`, f.seconds)).join('')}</select></label>
      <label>${L.quality}<select data-form="resolution">${opt('480p', '480p', f.resolution)}${opt('720p', '720p', f.resolution)}</select></label>
    </div>
    <div class="actions">
      ${state.busy === 'plan' ? `<span class="spinner"></span><span>${L.planning}</span>`
        : `<button class="primary" data-action="plan" type="button" ${state.status?.key ? '' : 'disabled'}>${L.plan}</button><span class="muted">${L.planCost}</span>`}
    </div>
  </section>`
}

function storyView() {
  const L = t()
  const p = state.current.project
  return `
  <section class="panel">
    <h1><input class="titleInput" data-path="title" value="${esc(p.title)}" ${disabled()}></h1>
    <p class="muted">${esc(p.style)} · ${esc(p.aspect)} · ${esc(p.mode === 'dialogue' ? L.dialogue : L.narration)} · ${esc(p.resolution)}</p>
    ${p.story ? `<pre class="storyText">${esc(p.story)}</pre>` : ''}
    <div class="actions">
      <button class="primary" data-action="step" data-step="1" type="button">${L.next} →</button>
      ${p.story ? `<button class="ghost" data-action="replan" type="button" ${disabled()}>${L.replan}</button>` : ''}
      ${state.busy === 'plan' ? `<span class="spinner"></span><span>${L.planning}</span>` : ''}
    </div>
  </section>`
}

function castCard(kind, item, i) {
  const L = t()
  const list = kind === 'character' ? 'characters' : 'locations'
  const img = item.sheet_path ? `<img src="${fileUrl(item.sheet_path, item.sheet_url)}" alt="${esc(item.name || item.id)}">` : `<div class="placeholder">${item.sheet_task_id ? '<span class="spinner"></span>' : L.notYet}</div>`
  return `
  <div class="card">
    <div class="sheet ${kind}">${img}</div>
    <div class="cardBody">
      <div class="row"><span class="tag">${kind === 'character' ? L.character : L.location}</span>
        <input data-path="${list}.${i}.name" value="${esc(item.name)}" ${disabled()}></div>
      <label>${L.look}<textarea rows="4" data-path="${list}.${i}.look" ${disabled()}>${esc(item.look)}</textarea></label>
      ${kind === 'character' && state.current.project.mode === 'dialogue' ? `<label>${L.voice}<input data-path="${list}.${i}.voice" value="${esc(item.voice)}" ${disabled()}></label>` : ''}
      ${item.sheet_url ? `<button class="ghost small" data-action="redraw" data-id="${esc(item.id)}" type="button" ${disabled()}>${L.redraw} · ${usd(0.022)}</button>` : ''}
    </div>
  </div>`
}

function castView() {
  const L = t()
  const p = state.current.project
  const missing = [...p.characters, ...p.locations].filter((x) => !x.sheet_url).length
  const cost = stageCost(['cast'])
  return `
  <section class="panel">
    <h1>${L.castTitle}</h1>
    <p class="muted">${L.castHint}</p>
    <div class="actions">
      ${missing ? `<button class="primary" data-action="cast" type="button" ${disabled()}>${L.genCast} (${missing}) · ${usd(cost)}</button>` : ''}
      <button class="${missing ? 'ghost' : 'primary'}" data-action="step" data-step="2" type="button" ${missing ? 'disabled' : ''}>${L.next} →</button>
    </div>
    <div class="cards">${p.characters.map((c, i) => castCard('character', c, i)).join('')}${p.locations.map((l, i) => castCard('location', l, i)).join('')}</div>
  </section>`
}

function shotRow(s, i) {
  const L = t()
  const p = state.current.project
  const dis = disabled()
  const st = s.state || 'todo'
  const stale = state.current.stale?.includes(s.id)
  const preview = s.file ? `<video src="${fileUrl(s.file, s.task_id)}" controls preload="metadata" playsinline></video>`
    : `<div class="placeholder ${p.aspect === '16:9' ? 'wide' : ''}">${st === 'submitted' || st === 'submitting' ? '<span class="spinner"></span>' : L.state[st] || st}</div>`
  const chars = p.characters.map((c) => `<label class="pill"><input type="checkbox" data-action="toggleChar" data-shot="${i}" data-id="${esc(c.id)}" ${(s.characters || []).includes(c.id) ? 'checked' : ''} ${dis}>${esc(c.name || c.id)}</label>`).join('')
  const locs = `<select data-path="shots.${i}.location" ${dis}><option value="">${L.noLocation}</option>${p.locations.map((l) => `<option value="${esc(l.id)}" ${s.location === l.id ? 'selected' : ''}>${esc(l.name || l.id)}</option>`).join('')}</select>`
  const words = p.mode === 'narration'
    ? `<label>${L.narrationText}<textarea rows="2" data-path="shots.${i}.narration" ${dis}>${esc(s.narration)}</textarea></label>`
    : `<div class="lines">${(s.dialogue || []).map((l, j) => `<div class="row">
        <select data-path="shots.${i}.dialogue.${j}.who" ${dis}><option value="">${L.offscreen}</option>${p.characters.map((c) => `<option value="${esc(c.id)}" ${l.who === c.id ? 'selected' : ''}>${esc(c.name || c.id)}</option>`).join('')}</select>
        <input data-path="shots.${i}.dialogue.${j}.line" value="${esc(l.line)}" ${dis}>
        <button class="ghost small" data-action="delLine" data-shot="${i}" data-line="${j}" type="button" ${dis}>×</button></div>`).join('')}
        <button class="ghost small" data-action="addLine" data-shot="${i}" type="button" ${dis}>${L.addLine}</button></div>`
  const dur = p.mode === 'dialogue'
    ? `<select data-path="shots.${i}.duration" data-number ${dis}>${Array.from({ length: 12 }, (_, k) => k + 4).map((d) => `<option ${Number(s.duration ?? 5) === d ? 'selected' : ''}>${d}</option>`).join('')}</select> ${L.seconds}`
    : `${s.voice?.seconds ? Math.min(15, Math.max(4, Math.ceil(s.voice.seconds + 0.6))) : '≈'} ${L.seconds}`
  const action = st === 'done' ? `<button class="ghost small" data-action="renderOne" data-id="${esc(s.id)}" data-redo="1" type="button" ${dis}>${L.rerender}</button>`
    : st === 'failed' ? `<button class="primary small" data-action="renderOne" data-id="${esc(s.id)}" data-retry="1" type="button" ${dis}>${L.retry}</button>`
    : st === 'todo' ? `<button class="ghost small" data-action="renderOne" data-id="${esc(s.id)}" type="button" ${dis}>${L.renderOne}</button>` : ''
  return `
  <div class="shot">
    <div class="shotMedia ${p.aspect === '16:9' ? 'wide' : ''}">${preview}</div>
    <div class="shotBody">
      <div class="row between"><b>#${i + 1}</b><span class="badge ${st}">${L.state[st] || st}</span></div>
      ${s.error && st === 'failed' ? `<p class="errorText">${esc(s.error)} ${L.failedHint}</p>` : ''}
      <p class="warnText" data-stale="${esc(s.id)}" ${stale ? '' : 'hidden'}>${L.stale}</p>
      <div class="row wrap"><span class="muted tiny">${L.inShot}</span>${chars}${locs}<span class="muted tiny">${L.duration}</span>${dur}</div>
      <label>${L.prompt}<textarea rows="3" data-path="shots.${i}.prompt" ${dis}>${esc(s.prompt)}</textarea></label>
      ${words}
      <div class="row between">${action}<span class="row">
        <button class="ghost small" data-action="addShot" data-shot="${i}" type="button" ${dis}>${L.addShot}</button>
        <button class="ghost small danger" data-action="delShot" data-shot="${i}" type="button" ${dis || (p.shots.length < 2 ? 'disabled' : '')}>${L.deleteShot}</button></span></div>
    </div>
  </div>`
}

function shotsView() {
  const L = t()
  const p = state.current.project
  const model = MODELS.find((m) => m.id === p.video_model) ?? MODELS[0]
  const group = (g, label) => `<optgroup label="${label}">${MODELS.filter((m) => m.group === g).map((m) => `<option value="${m.id}" ${m.id === p.video_model ? 'selected' : ''}>${m.label}</option>`).join('')}</optgroup>`
  const todo = p.shots.filter((s) => s.state !== 'done').length
  const cost = stageCost(['voice', 'shots'])
  return `
  <section class="panel">
    <h1>${L.shotsTitle}</h1>
    <p class="muted">${L.shotsHint}</p>
    <div class="row wrap">
      <label class="inline">${L.videoModel}<select data-path="video_model" ${disabled()}>${group('stylised', lang === 'zh' ? '动漫 / 国漫 / 插画' : 'Anime, comic, illustration')}${group('photoreal', lang === 'zh' ? '写实真人' : 'Photoreal people')}</select></label>
      <label class="inline">${L.quality}<select data-path="resolution" ${disabled()}>${model.res.map((r) => `<option ${r === p.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    </div>
    <p class="muted tiny">${L.realPerson}</p>
    <div class="actions">
      ${todo ? `<button class="primary" data-action="renderAll" type="button" ${disabled()}>${L.renderAll} (${todo}) · ${usd(cost)}</button>` : ''}
      <button class="${todo ? 'ghost' : 'primary'}" data-action="step" data-step="3" type="button">${L.next} →</button>
    </div>
    ${state.current.job?.running && state.current.job.step === 'render' ? `<div class="banner">${L.renderTime}</div>` : ''}
    <div class="shots">${p.shots.map(shotRow).join('')}</div>
  </section>`
}

function finalView() {
  const L = t()
  const p = state.current.project
  const out = p.output
  const missing = p.shots.filter((s) => s.state !== 'done').map((s, i) => `#${p.shots.indexOf(s) + 1}`)
  const v = out?.file ? (p.shots.map((s) => s.task_id).join('').slice(-12) + (out.seconds || '')) : ''
  return `
  <section class="panel">
    <h1>${L.finalTitle}</h1>
    ${state.status && !state.status.ffmpeg ? `<div class="banner error">${L.noFfmpeg}</div>` : ''}
    ${missing.length ? `<div class="banner">${L.missing}${missing.join(' ')}</div>` : ''}
    <p class="muted">${L.assembleHint}</p>
    <div class="actions"><button class="primary" data-action="assemble" type="button" ${disabled()} ${missing.length === p.shots.length ? 'disabled' : ''}>${L.assemble}</button></div>
    ${out?.file ? `
      <div class="final ${p.aspect === '16:9' ? 'wide' : ''}"><video src="${fileUrl(out.subtitled || out.file, v)}" controls playsinline></video></div>
      <div class="row wrap">
        ${out.subtitled ? `<a class="button primary" href="${fileUrl(out.subtitled, v)}" download>${L.download} · ${L.withSubs}</a>` : ''}
        <a class="button ghost" href="${fileUrl(out.file, v)}" download>${L.download} · ${L.plain}</a>
        ${out.subtitles ? `<a class="button ghost" href="${fileUrl(out.subtitles, v)}" download>${L.subtitles}</a>` : ''}
        <span class="muted">${out.seconds} ${L.seconds} · ${L.spent} ${usd(state.current.spent)}</span>
      </div>` : ''}
  </section>`
}

// ─── events ──────────────────────────────────────────────────────────────────

function setPath(obj, path, value) {
  const keys = path.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k]
  o[keys.at(-1)] = value
}

document.addEventListener('input', (e) => {
  const el = e.target
  if (el.dataset.form) {
    state.form[el.dataset.form] = el.dataset.form === 'seconds' ? Number(el.value) : el.value
    if (el.dataset.form === 'style') render()
    return
  }
  if (el.dataset.path && state.current) {
    const value = 'number' in el.dataset ? Number(el.value) : el.value
    edit((p) => setPath(p, el.dataset.path, el.dataset.path.endsWith('.location') && !value ? undefined : value))
    if (['video_model', 'resolution'].includes(el.dataset.path) || el.tagName === 'SELECT') {
      if (el.dataset.path === 'video_model') {
        const m = MODELS.find((x) => x.id === value)
        if (m && !m.res.includes(state.current.project.resolution)) state.current.project.resolution = m.res[0]
      }
      save().then(render)
    }
  }
})

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]')
  if (!el || el.disabled) return
  const a = el.dataset.action
  const p = state.current?.project
  if (a === 'connect') {
    try {
      const { url } = await api('/login', { method: 'POST' })
      window.open(url, '_blank', 'noopener')
      state.login = true
      renderTop()
      const until = Date.now() + 10 * 60e3
      const tick = async () => {
        await refreshStatus()
        if (state.status?.key || Date.now() > until) { state.login = false; render() } else setTimeout(tick, 2000)
      }
      setTimeout(tick, 2000)
    } catch (err) { fail(err) }
  } else if (a === 'open') open(el.dataset.id)
  else if (a === 'step') { if (saveTimer) await save(); state.step = Number(el.dataset.step); render() }
  else if (a === 'plan' || a === 'replan') {
    const f = a === 'plan' ? state.form : { story: p.story, style: p.style, aspect: p.aspect, mode: p.mode, seconds: 60, resolution: p.resolution }
    if (!String(f.story || '').trim()) return fail(new Error(t().needStory))
    state.busy = 'plan'
    state.error = ''
    render()
    try {
      const v = await api('/projects', { method: 'POST', body: JSON.stringify({ ...f, style: f.style === 'custom' ? f.custom : f.style }) })
      state.form = null
      state.busy = ''
      await refreshList()
      state.current = v
      state.step = 1
      render()
    } catch (err) { state.busy = ''; fail(err) }
  } else if (a === 'cast') run('cast')
  else if (a === 'redraw') run('cast', { redo: [el.dataset.id] })
  else if (a === 'renderAll') run('render', { retryFailed: true })
  else if (a === 'renderOne') run('render', { only: [el.dataset.id], ...(el.dataset.redo ? { redo: [el.dataset.id] } : {}), ...(el.dataset.retry ? { retryFailed: true } : {}) })
  else if (a === 'assemble') run('assemble')
  else if (a === 'toggleChar') {
    const s = p.shots[Number(el.dataset.shot)]
    const set = new Set(s.characters || [])
    el.checked ? set.add(el.dataset.id) : set.delete(el.dataset.id)
    edit(() => { s.characters = p.characters.map((c) => c.id).filter((id) => set.has(id)) })
  } else if (a === 'addLine') { edit(() => { const s = p.shots[Number(el.dataset.shot)]; (s.dialogue ||= []).push({ who: s.characters?.[0] || '', line: '' }) }); render() }
  else if (a === 'delLine') { edit(() => p.shots[Number(el.dataset.shot)].dialogue.splice(Number(el.dataset.line), 1)); render() }
  else if (a === 'addShot') {
    edit(() => {
      const i = Number(el.dataset.shot)
      const prev = p.shots[i]
      const used = new Set(p.shots.map((s) => s.id))
      let n = p.shots.length + 1
      while (used.has(`s${n}`)) n++
      p.shots.splice(i + 1, 0, { id: `s${n}`, characters: [...(prev.characters || [])], location: prev.location, prompt: '', ...(p.mode === 'dialogue' ? { duration: 5, dialogue: [] } : { narration: '' }) })
    })
    render()
  } else if (a === 'delShot') { edit(() => p.shots.splice(Number(el.dataset.shot), 1)); render() }
})

$('#newProject').addEventListener('click', () => { clearTimeout(pollTimer); state.current = null; state.error = ''; render() })
$('#langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  try { localStorage.setItem('studioLang', lang) } catch { /* private mode */ }
  state.form = null
  render()
})

render()
refreshStatus()
refreshList()
