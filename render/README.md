# peermate-render

Turns a grounded storyboard into a narrated slide video.

Deliberately a separate package. It is never imported by `src/` — the bot produces a
storyboard and consumes a file path, and nothing else crosses the line. Its
dependencies are the reason: a PDF rasteriser, a native canvas and ffmpeg have no
business in the image the WhatsApp socket runs in, where a wedged render could block
shutdown and a native build failure would take the bot down with it. `render/` is in
`.dockerignore` and excluded from both tsconfigs so that stays true rather than
merely intended.

## Running it

```bash
npm install
OPENAI_API_KEY=... npm run render -- fixtures/csc301.json out/csc301.mp4
npm test        # the caption timing, which is the only real logic here
```

Needs `ffmpeg` and `ffprobe` on the PATH.

The fixture points at a PDF under `.local/fixtures/`, which is gitignored — point
`pdfPath` at any PDF you have.

## The storyboard

The contract, and the only thing the bot has to produce:

```json
{
  "title": "Normalisation, from the ground up",
  "course": "CSC 301",
  "scenes": [
    {
      "narration": "First normal form asks one thing: every cell holds a single value.",
      "visual": { "kind": "slide", "pdfPath": "…/CSC301_wk3.pdf", "page": 1 },
      "source": "CSC301_wk3.pdf, p.1"
    }
  ]
}
```

It is `ExplainerService`'s output plus a `visual` — the same `scenes` shape, which is
why that name was chosen there.

`visual.kind` is `slide` or `title`. There is no generated-image kind, and that is a
decision rather than an omission: a model asked to draw a shear force diagram will put
the arrows the wrong way round, and a student revising from it has no way to find that
out. The lecturer's own page is never wrong about what was taught.

## What it does

Per scene: speak the narration, rasterise the page and crop it to the ink on it, then
draw one frame per caption — the slide, the source line, and the words being said over
it. Each caption becomes a segment taking its slice of the same narration track. Then
concatenate by stream copy.

Captions are drawn on the canvas rather than burned by ffmpeg. The `subtitles` filter
needs libass, and `drawtext` needs freetype; the ffmpeg this was built against has
neither, and depending on how a particular build was configured is not something to
discover in deployment.

The crop is what makes it readable. A4 lecture notes put their content in the top
third of the page; fitted whole into a 16:9 frame that is mostly blank paper with text
too small to read on a phone.

The result carries `fitsInChat`, measured against WhatsApp's media ceiling (15MB, the
same figure as the bot's `research.maxFileBytes`). Under it the file is sent into the
chat and kept; over it, it is uploaded and sent as a playback link. Oversize is not an
error and is not thrown on — this package cannot reach WhatsApp, so the decision is
the caller's.

## Measured

A 4-scene, 47-second captioned explainer: **0.6MB**, rendered in 26 seconds, most of
it TTS.

Static slides encode almost for free, so the size ceiling is rarely the constraint it
looked like from the outside — roughly 3MB for a five-minute explainer against a 15MB
limit. Render *time* is the real constraint, and it is why this cannot be a tool call:
the agent's budget is 45 seconds and a twelve-scene explainer will not make it.

## Known gaps

- **No upload path.** `fitsInChat` says when one is needed; nothing implements it yet.
  That is where Livepeer comes in — an explainer over the ceiling is hosted and sent
  as a playback link instead of a file.
- **Nothing is durable.** A crash mid-render loses the TTS already paid for. A job
  store belongs here before this is wired to anything that costs money at scale.
