# Writing shots that cut together

Each shot is rendered on its own, by a model that has never seen the shot
before it. Continuity is your job, and it lives in how you write `prompt`.

## Shape of an episode

- **Hook in the first shot.** On a vertical feed the viewer decides in about
  3 seconds. Open on the conflict or the strangest image, not on scenery.
- **One beat per shot.** A one-minute episode is roughly 10–15 shots of 4–6
  seconds. If a shot needs "and then", it is two shots.
- **End on a turn.** A reveal, a threat, an unanswered question. Mini-series
  live on the next episode.
- **Alternate distance.** Wide to set the place, then medium, then close-up for
  the emotion. Three close-ups in a row feel airless. Three wide shots in a row
  lose the characters.

## One shot = one action + one camera move

Write the prompt in this order: **shot size and camera → who does what → mood
and light details.** Do not describe a character's look. Their sheet carries
it, and repeating it in words fights the reference.

| Shot size | Use for |
|---|---|
| Wide / establishing | Where we are. Faces are small here, so the likeness is weakest. |
| Medium | Body language, two people talking. |
| Two-shot | A relationship in one frame. Say who is on the left. |
| Close-up | Emotion, a reaction, the line that matters. The likeness is strongest here. |
| Extreme close-up / insert | An object: a letter, a ring, a hand on a sword. |
| Over-the-shoulder | A conversation from one side. |

Camera moves: static, slow push-in, pull-back, tracking alongside, pan, tilt
up/down, handheld, slow orbit. Pick **one**. Stacked moves ("orbit while
zooming while tracking") come out as mush.

Bad:
```
Mika, a girl with a black bob and yellow raincoat, is riding her scooter in the
rain at night in the city and then she stops and looks at the package and then
she looks up at the building and walks in.
```

Good:
```
Wide tracking shot. Mika rides a small electric scooter through the rain,
brakes hard and checks the address on a soaked parcel.
```
Her look comes from the sheet. Walking into the building is the next shot.

## Characters

- **One or two per shot.** Consistency drops with each extra face in the
  frame. For a group scene, open with a wide shot, then cut to singles and
  two-shots.
- **List only who is visible** in `characters`. Someone who is off screen
  should not be sent as a reference.
- **Name characters in the prompt exactly** as their `name`. The script maps
  each name to its reference image.
- **Write the acting:** expression, gaze direction and a small physical action.
  "Her jaw tightens; she looks away" renders better than "she is upset".

## Continuity between shots

- **Screen direction.** If Mika is on the left facing right in shot 2, keep her
  left in shot 3. Say it: "Mika on the left, Mrs. Hana on the right."
- **State changes carry over.** If she got soaked in shot 1, write "dripping
  wet" in shot 2. If a door opened, it stays open.
- **The location fixes time and weather.** Keep night as night and rain as rain
  unless the story moves on. When it does, add a new location.
- **Never edit `style` mid-episode.** It is the one line every shot shares.

## Dialogue mode

- **Short lines.** English is about 2.5 words a second; Chinese about 4.5
  characters a second. A 5-second shot holds one or two short lines. The script
  warns when a shot is overfull.
- **Put the reaction in its own shot** instead of a third line.
- **Give every speaking character a `voice`** ("young woman, quick and
  friendly"). It is the best lever for keeping a voice steady across shots.

## Narration mode

- **Write for the ear.** Short sentences. One or two per shot.
- **Do not narrate what the picture already shows.** The image shows the
  lantern; the narration says why the lantern matters.
- **Mind the length.** Each shot stretches to fit its narration, up to 15
  seconds (about 60 Chinese characters or 35 English words). Split anything
  longer across two shots.

## What tends to go wrong

| Problem | Write instead |
|---|---|
| Readable text: signs, letters, phone screens | Keep text out of frame or blurred. The script already asks for no text, but a prompt about "reading a sign" invites it. |
| Hands handling small, complex objects | Show the result ("the envelope is open in her hands"), not the fiddly process. |
| Fast fights, crowds, sports | Slow it down: one strike, one reaction. Imply the crowd with sound and a wide shot. |
| A character drifts off-model | Tighter shot size, fewer characters in frame, re-render that shot only (`--redo s4`). |
| The sheet's grey background or three-view layout leaks into the shot | The script's reference wording prevents most of it. If it happens, give the shot a `location`. A real background reference wins over the sheet's grey. |

When a shot comes out wrong, change **one** thing and re-render it. If you
change everything at once, you will not know what fixed it.

## Chinese projects

Set `"language": "zh"` and write the prompt, dialogue and narration in Chinese.
The script then cites references as 图片1, 图片2 … and writes its own wording in
Chinese too. Shot sizes in Chinese: 远景, 全景, 中景, 近景, 特写, 过肩镜头. Camera
moves: 固定镜头, 缓慢推进, 拉远, 跟拍, 横摇, 环绕.
