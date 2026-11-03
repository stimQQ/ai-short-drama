# project.json

One file per episode. You write the **story fields**. The script adds the
**generated fields** as it works, so do not write those yourself. The script
also fills in every default it uses and saves it back, so the file always shows
what will actually be sent.

Complete examples:
- `examples/last-delivery/project.json` (English, dialogue)
- `examples/snow-night-zh/project.json` (Chinese, narration)

## Top level

| Field | Default | Notes |
|---|---|---|
| `title` | — | Also names the output file (`the-last-delivery.mp4`). Non-Latin titles become `episode.mp4`. |
| `language` | `en` | `zh` / `zh-CN` makes the prompts Chinese (references cited as 图片1, 图片2 …) and picks a Chinese narrator voice. Write dialogue and narration in this language. |
| `style` | — | One line repeated at the top of every shot and sheet. This keeps the episode looking like one film. Be concrete: medium, rendering, palette, lighting. Leave places, weather and time of day out; those belong in `locations`. |
| `aspect` | `9:16` | `9:16` `16:9` `1:1` `4:3` `3:4` `21:9` `adaptive`. Vertical for TikTok, Reels, Shorts, Douyin. |
| `resolution` | `480p` | `480p` / `720p`; `1080p` only on `seedance-2.0` and `dreamina-seedance-2-0`. |
| `mode` | `dialogue` | `dialogue` or `narration`. See SKILL.md. |
| `video_model` | from `style` | `dreamina-seedance-2-0-mini` for stylised looks, otherwise `seedance-2.0-mini`. Full list in SKILL.md. |
| `image_model` | `nano-banana-2-1` | Model for the reference sheets. |
| `image_resolution` | `1K` | `1K` is enough for a reference; `2K` costs $0.036. |
| `native_audio` | `true` | Seedance's own sound (voices in dialogue mode, ambience in both). Set `false` for silent clips. |
| `narrator` | narration mode only | `{ "model": "minimax-speech-2.8-turbo", "voice_id": "…", "speed": 1.0 }`. The default voice is `male-qn-qingse` (Chinese) or `English_Trustworthy_Man`. Browse voices at https://apimodels.app/voices, or with `GET https://api.apimodels.app/v1/voices/catalog?provider=minimax&language=zh` (no key needed). |

## `characters[]` and `locations[]`

Both have the same shape. A **character** gets a sheet: a portrait plus
front/side/back views on grey. A **location** gets an establishing shot with
no people.

| Field | | Notes |
|---|---|---|
| `id` | required | Short, used in shots: `mika`, `inn`. |
| `name` | | The name used in prompts and dialogue. Defaults to `id`. |
| `look` | required unless an image is given | **Everything visual, in one place**: age, build, face, hair, every item of clothing with colours, props they always carry. The video prompt never repeats this; the sheet carries it. |
| `voice` | characters, dialogue mode | How they sound: "elderly woman, soft and slow". Added to every line they speak, which steadies the voice across shots. |
| `sheet_file` | optional | Path (relative to project.json) to the user's own image of this character or place. It is uploaded instead of generated. |
| `sheet_url` | optional | An existing public `https://` image to use as is. |

Generated fields:

| Field | Meaning |
|---|---|
| `sheet_url` | The reference image actually sent with shots. |
| `sheet_path` | Local copy under `cast/`. |
| `sheet_task_id` | The image task; lets an interrupted `cast` resume. |
| `sheet_cost` | USD actually billed. |

## `shots[]`

Shots play in array order.

| Field | | Notes |
|---|---|---|
| `id` | required | `s1`, `s2` … Used by `--only` / `--redo`. |
| `prompt` | required | What we see and how the camera moves. Read shot-writing.md. Do not restate the characters' looks or the style. |
| `characters` | | Character ids **in this shot**. Their sheets go in as references, in this order. Keep it to 1–2. |
| `location` | | One location id. Its image goes in after the characters. |
| `duration` | 5 (dialogue) | Whole seconds, 4–15. In narration mode it is a minimum: the shot grows to fit the voice-over. |
| `dialogue` | dialogue mode | `[{ "who": "mika", "line": "Last one tonight." }]`. Omit `who` for an off-screen voice. The speaker should be in `characters`. |
| `narration` | narration mode | The voice-over for this shot. Up to about 14 s of speech: roughly 60 Chinese characters, or 35 English words. Longer text is an error; split it across two shots. |

Generated fields:

| Field | Meaning |
|---|---|
| `state` | `submitted` (rendering), `done` or `failed`. |
| `task_id` | The video task. Saved before waiting, which is what makes re-runs safe. |
| `prompt_sent` | The full prompt that went to the model, including the reference mapping. |
| `hash` | Fingerprint of the inputs. `status` uses it to flag shots edited after rendering. |
| `file`, `url` | Local copy under `shots/`, and the source URL (expires in 30 days). |
| `cost` | USD actually billed. |
| `error` | Why the last attempt failed. |
| `voice` | Narration mode: `{ task_id, file, seconds, cost, text_hash }`. |

Top-level `output` (after `assemble`): `{ file, seconds, subtitles, subtitled }`.

## Folder after a full run

```
my-episode/
  project.json
  cast/       mika.png  hana.png  street.png  door.png
  audio/      s1.mp3 …                (narration mode)
  shots/      s1.mp4 …
  build/      normalized clips, concat list
  the-last-delivery.mp4
  the-last-delivery.srt
  the-last-delivery.subtitled.mp4     (--burn-subs)
```
