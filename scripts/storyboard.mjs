/**
 * Story → project.json, with one LLM call on apimodels.app.
 *
 * The agent skill does not need this (the agent writes project.json itself); the
 * studio does, because a person pasting a story has nobody to write the shots.
 * The model gets the same rules as references/shot-writing.md, condensed, and
 * its answer is checked with the engine's own validate(). An invalid answer goes
 * back once with the errors; a second failure is reported, not papered over.
 */

import { API, withDefaults, validate, isZh } from './drama.mjs'

export const STORYBOARD_MODEL = 'claude-haiku-5-5'

const RULES = `You turn a story into a production plan for a short drama made with an AI video model.
Return ONLY one JSON object, no prose, no code fence:

{
  "title": "short title",
  "characters": [{ "id": "mika", "name": "Mika", "look": "…", "voice": "…" }],
  "locations": [{ "id": "street", "name": "Rainy street", "look": "…" }],
  "shots": [{
    "id": "s1", "characters": ["mika"], "location": "street",
    "prompt": "…", "duration": 5,
    "narration": "…",                                  // narration mode only
    "dialogue": [{ "who": "mika", "line": "…" }]      // dialogue mode only
  }]
}

Rules:
- ids: lowercase ascii letters and digits, unique. Shots are s1, s2, …
- "look": everything visual about a character in one place — age, build, face, hair, every item of clothing with colours, props they always carry. For a location: place, time of day, weather, light. Never mention real or famous people.
- "voice" (characters): how they sound, e.g. "young woman, quick and friendly".
- "prompt": shot size and ONE camera move first, then who does what, then mood and light. Do NOT repeat a character's look or the visual style — reference images carry those. Write the acting: expression, gaze, one small physical action.
- 1–2 characters per shot; list only characters visible in that shot. Each shot has at most one location.
- One story beat per shot. The first shot is a hook (conflict or the strangest image). The last shot ends on a turn or an open question.
- Alternate wide, medium and close-up shots. Keep screen direction and state changes consistent between shots.
- Nothing readable on screen: no signs, captions, letters, phone screens.
- "duration": whole seconds, 4–15.`

const MODE_RULES = {
  narration: `Mode: narration. One narrator tells the story; nobody speaks on screen. Every shot gets "narration": one or two short sentences written for the ear that add what the picture does not show. At most 55 Chinese characters or 32 English words per shot. Omit "dialogue".`,
  dialogue: `Mode: dialogue. Characters speak on screen. A shot holds at most two short lines (English ≈ 2.5 words per second, Chinese ≈ 4.5 characters per second); put reactions in their own shot. The speaker must be in that shot's "characters". Omit "narration".`,
}

const extractJson = (text) => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('the model did not return JSON')
  return JSON.parse(text.slice(a, b + 1))
}

const slugId = (s, fallback) => {
  const v = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')
  return /^[a-z]/.test(v) ? v.slice(0, 24) : fallback
}

/**
 * Make ids safe for file names and URLs (the model sometimes uses the character's
 * Chinese name as the id) and re-point every reference to the renamed ids.
 */
export function normalizePlan(plan) {
  const rename = (list, prefix) => {
    const map = new Map()
    const used = new Set()
    for (const [i, item] of (list || []).entries()) {
      let id = slugId(item.id, `${prefix}${i + 1}`)
      while (used.has(id)) id = `${id}${i + 1}`
      used.add(id)
      map.set(item.id, id)
      item.id = id
    }
    return map
  }
  const chars = rename(plan.characters, 'c')
  const locs = rename(plan.locations, 'loc')
  ;(plan.shots || []).forEach((s, i) => {
    s.id = `s${i + 1}`
    s.characters = (s.characters || []).map((id) => chars.get(id) ?? id)
    if (s.location != null) s.location = locs.get(s.location) ?? s.location
    for (const l of s.dialogue || []) if (l.who != null) l.who = chars.get(l.who) ?? l.who
    if (s.duration != null) s.duration = Math.min(15, Math.max(4, Math.round(Number(s.duration) || 5)))
  })
  return plan
}

async function chat(model, messages, key) {
  let res
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 8000, temperature: 0.7 }),
      signal: AbortSignal.timeout(180000),
    })
  } catch (e) {
    throw new Error(`network error talking to apimodels.app: ${e.message}`)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 401 || body?.code === 401) throw new Error('API key rejected (401)')
  if (res.status === 402 || body?.code === 402) throw new Error('Not enough balance (402) — top up at https://apimodels.app/console/credits')
  const text = body?.choices?.[0]?.message?.content
  if (!res.ok || typeof text !== 'string') throw new Error(body?.error?.message || body?.msg || `storyboard request failed (HTTP ${res.status})`)
  const cost = Number(res.headers.get('x-apimodels-cost'))
  return { text, cost: Number.isFinite(cost) ? cost : null }
}

/**
 * opts: { story, style, aspect, mode, language, seconds, resolution, model }
 * Returns a complete project (defaults filled in) ready for `estimate` / `cast`.
 */
export async function storyboard(opts, key) {
  const mode = opts.mode === 'dialogue' ? 'dialogue' : 'narration'
  const language = opts.language || (/[㐀-鿿]/.test(opts.story) ? 'zh' : 'en')
  const seconds = Math.min(180, Math.max(20, Number(opts.seconds) || 60))
  const shots = Math.min(24, Math.max(3, Math.round(seconds / 5)))
  const model = opts.model || STORYBOARD_MODEL
  const brief = [
    MODE_RULES[mode],
    `Target length: about ${seconds} seconds, so about ${shots} shots.`,
    `Write "name", "prompt", "narration" and "dialogue" in ${isZh(language) ? 'Simplified Chinese' : 'the language of the story'}; "look" and "voice" may be in the same language.`,
    opts.style ? `Visual style (the video model gets it separately; do not repeat it in prompts): ${opts.style}` : '',
    `Story:\n${String(opts.story || '').slice(0, 20000)}`,
  ].filter(Boolean).join('\n\n')

  const messages = [{ role: 'system', content: RULES }, { role: 'user', content: brief }]
  let cost = 0
  let problems = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(model, messages, key)
    cost += r.cost ?? 0
    let plan
    try { plan = normalizePlan(extractJson(r.text)) } catch (e) {
      problems = [e.message]
      messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: 'That was not valid JSON. Return the corrected JSON object only.' })
      continue
    }
    const project = withDefaults({
      title: plan.title || 'Untitled',
      language,
      style: opts.style || '',
      aspect: opts.aspect || '9:16',
      resolution: opts.resolution || '480p',
      mode,
      characters: plan.characters || [],
      locations: plan.locations || [],
      shots: (plan.shots || []).map((s) => (mode === 'narration' ? { ...s, dialogue: undefined } : { ...s, narration: undefined })),
      story: opts.story,
      storyboard: { model, cost },
    })
    problems = validate(project).errors
    if (!problems.length) return project
    messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: `Fix these problems and return the whole corrected JSON object only:\n- ${problems.join('\n- ')}` })
  }
  throw new Error(`the storyboard did not come out valid: ${problems.slice(0, 5).join('; ')}`)
}
