# Peermate whiteboard renderer

Turns grounded study material into a narrated, progressively drawn educational video.
It runs independently from MongoDB and WhatsApp so its teaching quality can be tested
before it is exposed as an agent tool.

The renderer is deliberately a separate package. Native canvas, PDF parsing, FFmpeg
and long-running media work never enter the process holding the WhatsApp socket.

## Test a video locally

Generate and inspect only the teaching plan first:

```bash
npm run video:test -- \
  --file CVE575_ClassNotes_1.pdf \
  --topic "How proof of work reaches consensus" \
  --plan-only
```

Input files live in `zfiles/`. The output uses the PDF's name and is saved in that
same directory. For example, `zfiles/CVE575_ClassNotes_1.pdf` produces
`zfiles/CVE575_ClassNotes_1.mp4`. The plan and preview frames are also saved beside
the PDF. Review their narration, citations, coordinates and timed drawing actions.
Remove `--plan-only` to render the actual video:

```bash
npm run video:test -- \
  --file CVE575_ClassNotes_1.pdf \
  --topic "Shear force and bending moment diagrams"
```

`--out` remains available when a different destination is specifically needed.

`ffmpeg` and `ffprobe` must be on `PATH`. `OPENAI_API_KEY` builds the grounded teaching
plan. Livepeer provides narration by default and performs scene upload, stitching,
delivery encoding and hosting. Set `LIVEPEER_TTS=0` only when deliberately testing the
OpenAI narration fallback.

An existing plan can still be rendered directly:

```bash
npm --prefix render run render -- fixtures/whiteboard-smoke.json out/smoke.mp4
```

## Visual contract

Each scene contains narration, a source and a list of normalized whiteboard actions:

```json
{
  "narration": "A process transforms an input into an output.",
  "visual": {
    "kind": "whiteboard",
    "actions": [
      {
        "type": "box",
        "x": 0.05,
        "y": 0.3,
        "width": 0.2,
        "height": 0.2,
        "label": "Input",
        "at": 0.1,
        "duration": 0.15
      },
      {
        "type": "arrow",
        "fromX": 0.27,
        "fromY": 0.4,
        "toX": 0.6,
        "toY": 0.4,
        "label": "transform",
        "at": 0.4,
        "duration": 0.2
      }
    ]
  },
  "source": "course-notes.pdf, p.4"
}
```

Supported actions are `write`, `box`, `circle`, `line`, `arrow`, `highlight` and
`erase`. Their `at` and `duration` values are fractions of the scene narration. This
makes the diagram evolve with the explanation instead of displaying one picture under
a voice-over.

Legacy `slide`, `title` and generated-background scenes remain renderable for old jobs,
but the standalone planner produces whiteboard scenes only.

## Review checklist

- Every factual statement and load-bearing diagram comes from the supplied material.
- Objects appear before arrows, labels or highlights that refer to them.
- Text remains readable on a phone and visual elements do not overlap.
- The drawing changes throughout the narration rather than completing immediately.
- Every scene retains its filename/page citation.
- The final MP4 has narration, captions, correct duration and a usable hosted URL.

The renderer does not send anything to WhatsApp. Wiring remains a separate product
step after several conceptual, mathematical and diagram-heavy fixtures pass review.
