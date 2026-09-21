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
  --pages 13-15 \
  --mode scripted \
  --topic "Explain the final three pages clearly, page by page" \
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
`--pages 13-15` restricts both planning and rendering to that inclusive page range,
which is useful for controlled quality tests. Whiteboard motion renders at 15 FPS with
eased strokes and a hand/marker overlay that follows the active drawing point.

`--mode scripted` enables the denser Python/Pillow renderer. The model emits only a
validated scene DSL; it cannot provide executable Python. Peermate's fixed engine maps
approved primitives (`title`, `write`, `bullets`, `line`, `arrow`, `box`, `circle`,
`highlight`, `road`, and `layers`) to progressive strokes. It distributes drawing
across the narration, rejects more than 0.5 seconds of visual inactivity, checks board
bounds and major collisions, and creates silent scene GIFs in the preview directory.

WhatsApp video requests use scripted mode by default. The agent stores the selected
mode on the durable render job and the worker passes it to this isolated planner.
Structured mode remains available when a user explicitly requests the simpler style.

Install its pinned runtime once and point the renderer at it:

```bash
python3 -m venv render/.scripted-venv
render/.scripted-venv/bin/pip install -r render/python/requirements.txt
export PEERMATE_PYTHON="$PWD/render/.scripted-venv/bin/python"
```

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
