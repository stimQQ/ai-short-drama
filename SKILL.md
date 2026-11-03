---
name: ai-short-drama
description: Turn a story idea, script or novel chapter into a finished short drama episode — recurring characters that stay consistent across shots, spoken dialogue or a voice-over narrator, subtitles, one MP4 at the end. Uses apimodels.app (Seedance 2.0 video, Nano Banana image, MiniMax voice) with one API key. Use when the user wants a short drama, mini-series episode, AI comic drama (漫剧 / 短剧 / AI 动态漫), a vertical story video with the same characters in every shot, or wants to adapt a script into video. Also use when they ask what such an episode costs.
homepage: https://apimodels.app
metadata:
  emoji: "🎬"
  requires:
    bins: ["node", "ffmpeg"]
  primaryEnv: "APIMODELS_API_KEY"
---

# AI short drama

Story in, episode out. You write the story into a `project.json` (characters,
locations, shots). `scripts/drama.mjs` takes care of everything that costs money
or is easy to get wrong:

```
project.json ─ estimate ─ cast ─ (voice) ─ shots ─ assemble ─▶ episode.mp4 + .srt
               free       a reference    narration  Seedance   ffmpeg: normalize,
               validates  image per      mode only  renders    mix the voice-over,
               + prices   character                 each shot  join, subtitles
                          and location
```

How the characters stay the same: every character gets one reference sheet
(portrait + front/side/back views). Each shot passes the sheets of the characters
in it to Seedance 2.0 as reference images, and the prompt says which image is who.

## Rules

1. **Always run `scripts/drama.mjs`.** Do not call the API with curl or fetch.
   The script stores every task id the moment it exists, so a crash or a timeout
   resumes the same task instead of paying for it again. Hand-rolled calls lose
   that.
2. **Read `references/project-schema.md` and `references/shot-writing.md`
   before writing `project.json`.** The shot-writing guide decides whether the
   episode looks like one film or like twelve unrelated clips.
3. **Run `estimate` first and show the user the result**: shot list, total
   length, models and the price table. Wait for a yes before `cast` / `shots`.
   The script refuses any step over $1 without `--yes`. Only pass `--yes` after
   the user has agreed to that amount.
4. **Show the user the character sheets before rendering shots.** Sheets cost
   about $0.02 each; shots cost 10–100× more. If a face, an outfit or the style
   is wrong, fix the `look` and run `cast --redo <id>` now. Every shot inherits it.
5. **For a new project, render one shot first** (`shots --only s1`). Look at
   it with the user, then render the rest. Skip this only for very short
   projects (three shots or fewer) or when the user says so.
6. **Never invent a model name.** Use only the models in the table below. If
   the user asks for another one, say this skill does not support it.
7. **Failed tasks are never charged.** Say so plainly when one fails, explain
   why (the script prints the reason and the next step), and offer the retry.
8. **Do not mention upstream providers or routing.** Talk about the model
   names in this file and nothing behind them.
9. **No real, identifiable people without their consent**, and nothing sexual,
   hateful or defamatory about anyone real. Decline those requests.

## Workflow

```bash
S=/absolute/path/to/this/skill/scripts/drama.mjs     # you know your base directory; use it
node $S check                                         # key, balance, ffmpeg
mkdir -p dramas/my-episode                            # one folder per episode, in the user's workspace
# write dramas/my-episode/project.json               (see references/project-schema.md)
node $S estimate dramas/my-episode/project.json --prompts
node $S cast     dramas/my-episode/project.json      # then SHOW the images in cast/
node $S voice    dramas/my-episode/project.json      # narration mode only
node $S shots    dramas/my-episode/project.json --only s1   # check one, then:
node $S shots    dramas/my-episode/project.json
node $S assemble dramas/my-episode/project.json --burn-subs
node $S status   dramas/my-episode/project.json      # any time: progress, spend, what is left
```

- **Renders are slow.** One shot usually takes 2–8 minutes, and shots run 3
  at a time. Before `shots`, tell the user roughly how long it will take. Do
  not leave them looking at a silent terminal.
- **Any command can be re-run safely.** Finished work is skipped. In-flight
  tasks are picked up where they left off. Failed shots are retried only with
  `--retry-failed`.
- **Editing a shot after it was rendered does not re-render it.** `status` marks
  it "inputs changed". Re-render it on purpose with `shots --redo <id>`; that is
  paid again.
- **Show the result:** the final MP4 path, its length, and the `.srt`. Then say
  what was spent: `status` prints the exact amount billed, read back from the
  API.
- Everything is downloaded into the project folder. The API's result URLs
  expire after 30 days, so the folder is the copy that lasts.

## The Studio (for people who would rather click than chat)

If the user wants to work visually, or to make episodes later without an
agent, start the Studio for them:

```bash
node /absolute/path/to/this/skill/studio/server.mjs
```

It opens a local four-step page: story, cast, shots, episode. The page writes
the shots with AI, shows every price before spending, and saves projects in
`~/AI-Short-Drama`. It uses the same key and engine as the commands above. Tell
the user the address it prints, and that Ctrl-C in that terminal stops it.

## Dialogue or narration

Choose before writing the shots:

| | `"mode": "dialogue"` | `"mode": "narration"` |
|---|---|---|
| Who speaks | Characters on screen, lip-synced. Seedance generates the voices with the video. | One narrator voice-over (text to speech), mixed over each shot's ambient sound. |
| Good for | Scenes driven by conversation; live-action-style mini dramas. | 漫剧 / AI comic dramas, novel adaptations, recap and storytelling videos. |
| Voice consistency | A character's voice can vary a little from shot to shot. | One identical voice for the whole episode. |
| Shot length | You set `duration` (4–15 s). Keep each line short enough to fit. | Set automatically to fit each narration line, up to 15 s. |
| Limits | About 1–2 short lines per 5 s shot. No exact control over who speaks when. | Characters do not talk on screen. |

If the user does not say, use **narration** for anything described as 漫剧, a
comic, a novel or a story recap. Use **dialogue** for scenes built on
conversation.

## Models and cost

The script picks a default `video_model` from the style. Stylised looks (anime,
comic, 国漫, cartoon, watercolour) get `dreamina-seedance-2-0-mini`. Everything
else gets `seedance-2.0-mini`. Override it in `project.json` when the user wants
something else.

| The user wants | `video_model` | Resolutions | Per second of video |
|---|---|---|---|
| Stylised episode (anime, comic, 国漫); drafts | `dreamina-seedance-2-0-mini` | 480p / 720p | $0.0225 / $0.048 |
| Stylised, a step up from mini | `dreamina-seedance-2-0-fast` | 480p / 720p | $0.0644 / $0.1372 |
| Stylised, final quality up to 1080p | `dreamina-seedance-2-0` | 480p / 720p / 1080p | $0.10 / $0.22 / $0.55 |
| Photoreal people | `seedance-2.0-mini` | 480p / 720p | $0.044 / $0.095 |
| Photoreal, a step up from mini | `seedance-2.0-fast` | 480p / 720p | $0.071 / $0.153 |
| Photoreal, final quality up to 1080p | `seedance-2.0` | 480p / 720p / 1080p | $0.092 / $0.197 / $0.492 |

Other costs:
- Character and location sheets: `nano-banana-2-1`, $0.022 each at 1K.
- Narration: `minimax-speech-2.8-turbo`, $0.04 per 1,000 characters. A short clip is billed at least $0.004.

A one-minute episode (12 shots × 5 s, 5 sheets) costs about:
- $1.46 at `dreamina-seedance-2-0-mini` 480p
- $2.99 at `dreamina-seedance-2-0-mini` 720p
- $2.75 at `seedance-2.0-mini` 480p
- $29.63 at `seedance-2.0` 1080p

Suggest 480p for the first pass. A second pass at 720p only re-renders the shots
(`"resolution": "720p"`, then `shots --redo <ids>`). The sheets stay.

Why the photoreal rows exist: the `dreamina-*` models refuse reference images
that look like a real person, and a photoreal character sheet can trigger that.
The script recognises this refusal and tells you to switch to
`seedance-2.0-mini`. The refused task is not charged.

Prices are list prices, checked 2026-09-30. `status` shows what was actually
billed.

## The API key

Run `node $S check` first. The key comes from `APIMODELS_API_KEY`, or from
`~/.apimodels/credentials`, or from `~/.apimodels/credentials.json`. The last one
is written by `npx apimodels-mcp login`, so a user who has logged in to any
apimodels tool is already set up.

If there is no key, **run `node $S login` yourself and give the user the link it
prints.** They log in to apimodels.app and click **Authorize**. A new key is
written to `~/.apimodels/credentials` and never appears in this conversation.
Then re-run `check` and carry on.

If `login` cannot work (no browser on the machine), do not ask for the key in
the chat. Give the user one command to paste into a **new terminal window**,
with the absolute script path filled in:

```
read -s KEY && printf %s "$KEY" | node /ABSOLUTE/PATH/scripts/drama.mjs save-key && unset KEY
```

Keys are created at https://apimodels.app/console/api-keys.

Handling the key:
- Never echo it back.
- Never pass it as a command argument.
- Never write it into the project folder.
- If a key ever appears in the conversation, tell the user to rotate it.

## Errors

The script prints the reason and the next step. In plain words:

| You see | Meaning | Do |
|---|---|---|
| `401` | Bad or missing key | Run `login` again |
| `402` | Not enough balance | Top up at https://apimodels.app/console/credits. Finished shots are kept. |
| "looks like a real person" | `dreamina-*` refused a reference image | Switch `video_model` to `seedance-2.0-mini`, then `shots --retry-failed` |
| Content review refusal | The prompt or a line was refused | Reword that shot. Retrying the same text will not help. |
| Busy / timeout | Upstream load | Run `shots --retry-failed` a little later |
| "still running" | Over 25 minutes | Run `shots` again later; it picks the task up, unpaid |
| exit code 3 | Step costs over $1 | Confirm the amount with the user, then add `--yes` |

Success is not 100%: an occasional shot fails, and a retry usually works.

## What this skill does not do

Say so directly rather than improvising:
- **It does not guarantee perfect consistency.** Faces can drift in wide
  shots, and with three or more characters in one frame. Keep 1–2 characters
  per shot (see shot-writing).
- **No shot is longer than 15 s.** Longer moments are cut into several shots.
- **It does not lip-sync to a voice track the user recorded.**
- **It does not control a shot's exact first frame.** Shots are driven by
  reference images and the prompt.
- **Subtitle timings are approximate.** They are spread evenly inside each
  shot. Edit the `.srt` if exact timing matters.
- **It does not publish anywhere.** The output is a local MP4 plus an SRT.
