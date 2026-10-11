# Peermate — handover

Written for the next agent. [CLAUDE.md](CLAUDE.md) is the standing brief and
[PRD.md](PRD.md) records why each architectural choice was made; read both. This file
covers what changed in the session of **14 September 2026**, what was decided and why,
and what is still open.

## Hard rules

- **Never push to the remote.** No pushing, no PRs. That is the user's action, always.
- **Never commit unless asked.** Suggest a message; let them run it.
- **Comments explain _why_, never _what_.** Sweep the files you touch.
- `auth_state/` is a live WhatsApp session credential. Never commit it, never bake it
  into an image, and never run two processes against one copy — the Signal ratchet
  desynchronises irrecoverably and every student sees "Waiting for this message".

## Where things are

|                             |                                                                             |
| --------------------------- | --------------------------------------------------------------------------- |
| Working copy                | `/Users/salami/Desktop/Startup/ai-agenty`                                   |
| Repo with the GitHub remote | `/Users/salami/Desktop/peermate` (`dayosalam/peermate`)                     |
| Superseded Python prototype | `/Users/salami/Desktop/Startup/peermate/legacy-python` — nothing imports it |

The two trees were synced at the end of the session and are identical for `src/`,
`tests/` and `render/src/`. The repo additionally has `ops/backup.sh` and
`compose.prod.yml`, which the user's dev wrote around an earlier release — **do not
delete them.** `compose.prod.yml` predates this session's work and should be checked;
in particular it must not set `ADMIN_PHONE`, which the config schema no longer accepts.

## State

**410 tests across 39 files, typecheck clean, prettier clean.** Nothing is committed.
The working tree has both staged and unstaged changes — 126 changed paths. Do not
assume a clean baseline.

Local testing runs against a separate database and a separate WhatsApp session:

```bash
npm run dev:local     # .env.local — peermate_local, auth_state_local, port 3001
npm test
npm run typecheck     # src and tests
```

`.env` points at **production** Atlas. `npm run dev` would write indexes to the live
database. Always use the `:local` scripts.

## What changed, and why

### The agent reads every message

There is no literal command path any more. `student-commands.service.ts` kept its
patterns but is now only the implementation behind the `update_settings` tool; nothing
matches ahead of the model.

The trigger was a real bug: `LIST` was `/^(…|what courses?.*|…)$/`, and the trailing
`.*` swallowed _"What course do I have on Tuesday?"_ — a timetable question answered
with the enrolment list. Matching on shape rather than meaning is what the agent exists
to replace.

Three things still come before the agent, and each is genuinely not a conversation:
onboarding (a form), an answer to a question Peermate itself asked (a "no" to a wipe
must mean no), and an emoji. `soleCourse` and the guidance bypass were removed;
guidance became the `explain_peermate` tool so the model chooses it rather than
inventing how Peermate works.

**Cost accepted:** pausing alerts now needs a working model call. Degraded mode says so.

### Coverage is per student

`groupRepository.approved()` returns every group on the deployment. Seven places built
"which of your courses are covered?" from it, so a student was told a course was
connected because _somebody else's_ group carried the code — and `listening()` printed
every group on the deployment **by name** to any student who asked. Same class as the
original cross-institution bug, on the coverage side rather than the content side.

All seven now use `groupRepository.forStudent(user.groupJids)`.
[tests/guidance.test.ts](tests/guidance.test.ts) asserts a student is never shown a
group they are not in.

### There is no operator

The largest change, and the user's explicit decision, made in stages:

1. Whoever adds Peermate to a group approves it, not the operator.
2. Nobody is notified about anyone else's group — _"we are 2 different users, peermate
   deals with me separately, and deals with chidi separately."_
3. The operator role was removed entirely.

**Authority over a group is being in it**, proved by `membershipService.mayAdminister`
— the same proof retrieval already uses. Deleted: `admin.service.ts`, `operator.ts`,
`ADMIN_PHONE` from config and both env templates, the operator branch in
`dm.service.ts`, and every "the operator has to approve this" answer in guidance.

Replaced by four tools, each resolving the group from the student's own groups and
re-checking membership _inside the tool_: `set_group_course`, `trust_sender`,
`stop_reading_group` (destructive tier), `file_announcement`.

Groups gained `approvedBy` — an address, not a name. `proposedBy` holds a display name,
so looking a person up by it never worked.

A group whose adder never writes stays pending and silent; `membershipService.claimable`
offers it to anyone provably in that room the next time they write.

**Consequences the user accepted, stated plainly:** nobody can repair anything from
outside. A wrongly-filed course nobody corrects stays wrong. Any proved member can stop
a group for everyone in it — that is the backstop that replaced the operator.

### Tenancy backfills on boot

`npm run backfill-tenancy` was a deploy step someone had to remember, and forgetting it
meant every pre-tenancy account went silent with clean logs. It now runs in `index.ts`
after the database connects and before anything is served. Idempotent, fails soft, loud
only when it actually scoped something or left someone stranded. The command still
exists for a manual re-run.

The script exports `backfillTenancy()`; its CLI `main()` is guarded on `process.argv[1]`
so importing it does not run it — without that guard the boot path opened a second Mongo
connection and then closed the shared one.

### Narrated explainers

`explainerService` builds a grounded spoken explanation from the lecturer's own files:
text first, then a voice note — the same trade the digest makes, because a formula in a
voice note cannot be scrolled back to.

Scene citations are **structured and validated**: `fileName` and `page`, both checked
against the material retrieval actually returned. A model asked for a filename will
supply a plausible one, and a plausible filename is what a storyboard later goes looking
for on disk. An unrecognised name drops to null rather than being corrected.

`notCovered` is a required field. If the material does not cover part of what was asked,
it is named and excluded — the alternative is the model filling the gap from general
knowledge, indistinguishable from the lecturer having taught it.

### render/ — the video pipeline, deliberately isolated

Storyboard JSON in, MP4 out. **Not part of the deployment**, and verified so: nothing in
`src/` imports it, it is in `.dockerignore`, and both tsconfigs exclude it. Its
dependencies — a PDF rasteriser, a native canvas, ffmpeg — have no business in the image
the WhatsApp socket runs in.

```bash
cd render && npm install
npm run render -- fixtures/csc301.json out/x.mp4    # reads render/.env
npm test                                            # caption timing
```

Measured: a 4-scene, 47-second captioned explainer is **0.7MB, rendered in 16 seconds**,
almost all of it TTS. Static slides encode nearly for free, so the WhatsApp size ceiling
is rarely the constraint; **render time** is, which is why this can never be a
synchronous tool call — the agent's budget is 45 seconds.

Visuals are the lecturer's **real slide pages**, cropped to the ink on them — which is
all `render/` can do today. Generated imagery has since been allowed, but only where it
cannot carry content; the reasoning and the boundary are in the design record above, and
neither is implemented here yet.

## The explainer video on Livepeer — decided 15 September 2026, not yet built

Decided in discussion with the user, recorded here because none of it is recoverable
from the code: the code does not yet exist, and the first decision below makes the rest
look irrational without it.

**Livepeer is the deliverable, not the implementation.** Livepeer and Daydream host the
hackathon this is entered in. On the numbers it is the worse buy — `chatterbox-tts` is
$0.0262 per 1000 characters against OpenAI's roughly $0.015 a minute, about 1.7× for the
same words — so nobody should "fix" this back to OpenAI on cost. It also means a silent
fallback to OpenAI defeats the point: if the network refuses, that is a failure to
report, not a provider to swap.

**The flow.** Course material → retrieval and a grounded script in `src/` as today →
storyboard → narration, captions, visuals, assembly, transcode and hosting on Livepeer →
the video in the student's DM.

**Nearly everything moves onto the network, because the useful half is free.**
`ffmpeg-concat`, `-mux`, `-burn-subtitles`, `-kenburns`, `-export`, `cdn-vercel-upload`,
`obscura-extract-text` and `hyperframes-caption` are all $0.00 per call. That buys a
genuine claim that the pipeline runs on Livepeer without spending the demo balance on
it, and `ffmpeg-burn-subtitles` happens to solve this machine having no libass. What
stays local is rasterising a PDF page, which is pdf.js and a native canvas — the exact
dependencies that must not be in the image the socket runs in. The subprocess wall
therefore stays.

**Generated visuals are allowed, but never load-bearing.** This reverses the earlier
"there is no generated-image path" and keeps its reasoning: a model asked to draw a
shear force diagram puts the arrows the wrong way round, and a student revising from it
cannot tell. So generated imagery may carry a title card, a section opener or motion
over a real page, and anything a student could revise from — a diagram, a formula, a
labelled figure — is a real page from their own material.

The model chooses which, with the rule in its prompt. That is the user's call, made
knowingly, and it is worth knowing why the alternative was argued for: a prompt
instruction is a request, which is why the agent's execution limits live in code, and
the model will reach for a generated visual precisely when retrieval came back thin —
the moment the real page matters most. The cheap hedge that was taken instead: the
storyboard schema records the choice as a tagged union rather than leaving it implicit
in which field got filled, so a test can assert what the model actually did across a
corpus. If it over-reaches, a validator becomes an addition rather than a refactor.

**The MP4 is the product; the hosted link is the fallback.** A measured explainer is
0.7MB and plays inline in WhatsApp, which is the better experience on a Nigerian data
plan and, more importantly, never becomes a URL. `cdn-vercel-upload` returns a _public_
address, and a lecturer's material on a public CDN is the same leak the tenancy boundary
exists to prevent, arriving through the front door. Hosting is for renders too large to
send, and it stays in the flow because it is real and demonstrable — not because it is
the default path a student's material takes.

**The renderer is a separate process and delivers through the outbox.** A three-minute
render must not share a process with the WhatsApp socket, and a second process must
never hold the credentials — one `auth_state` used twice desynchronises irrecoverably.
So the worker claims a `render_jobs` row, renders, and writes the result to `outbox`;
the bot, which is still the only thing holding a socket, sends it. The one-socket
invariant is untouched and durability comes free from a mechanism that already exists.

**An explainer is answer-shaped:** two to five scenes, under ninety seconds, using only
the pages that bear on what was asked. A student wanting the next part asks again.

**A student asks, and Peermate also offers** when a lecturer posts substantial new
material. The offer costs nothing until it is accepted, and without it nobody discovers
the feature — nobody asks a WhatsApp bot for a video unprompted.

**One message, rewritten in place.** A render takes minutes, so the student gets a
progress message updated roughly every fifteen seconds with a real percentage and the
time elapsed, and that same message becomes the video. Not a progress log: Baileys
supports `edit` against a message key, and an edit does not re-notify, so the phone does
not buzz twelve times. Three things this constrains:

- **WhatsApp only allows editing your own message for about fifteen minutes.** Past
  that, edits fail silently and progress must continue in a fresh message.
- **The percentage comes from stages actually completed**, never from a timer imitating
  progress. A number a student trusts that was invented is the same failure as a
  fabricated citation.
- **A failed render lands in that same message**, as the text explanation and voice note
  that already work today. Every other stage in this pipeline fails soft; this one is
  not the exception that leaves someone staring at 60%.

It is sent whenever it is ready, quiet hours included — the student asked for it, and
watched it being built.

**No spend caps, for now.** The user's call, with no rate limiting anywhere in the
project yet. Every response carries `budget_headroom_usd`, so log it as it falls rather
than discovering zero mid-demo. Caching a render on (group, course, question shape) is
the real long-term answer and is not built.

**The keyless demo balance is a shared pool, and it moves on its own.** Measured on 15
September 2026: it read $51.94, then $39.70 forty minutes later, while this project had
spent three-quarters of a cent. Within a single run the deltas matched our own spend to
the tenth of a cent, so the $12 went to other callers. Nothing here can budget against
that, and a demo that depends on it can die on stage because a stranger rendered a
video. Get an account key — the `signup` tool emails a code, `signup_confirm` redeems
it — and send it as `Authorization: Bearer`, which `render/src/livepeer.ts` already does
whenever `LIVEPEER_API_KEY` is set.

## Open threads

**The Livepeer key is unblocked — and no key is needed.** `sk_` keys are retired
network-wide, and the docs page that still tells you to get one is a bug at the source
which the user is fixing. The way in is the agent MCP, keyless:

```
https://agent.livepeer.org/api/mcp     # streamable http, no auth
```

Verified against the live server, not a doc. An unauthenticated `initialize` answers
`serverInfo.name = "livepeer-agent-raw (demo credits — no key)"`, and `me` reports that
every model and every tool is available keyless — what is limited is _spend_, drawn
from a demo balance at each model's real price. A `chatterbox-tts` run cost $0.0019
against $51.94 of headroom and returned real audio: 4.2s, 24kHz mono, 214KB, probed
after downloading it. Glama's page for this server documents OAuth and dynamic client
registration; it is as stale as the `sk_` page. Configured in [.mcp.json](.mcp.json),
which Claude Code reads at startup.

**This does not by itself feed `render/`.** An MCP connector is the _agent's_
credential, and the render runner is deliberately a subprocess — that wall is what
keeps a 16-second render outside a 45-second tool budget. What does carry over is that
the endpoint is ordinary HTTP: a JSON-RPC `tools/call` of `run_capability`
(`{capability, prompt, async:false}`) posted to `/api/mcp` needs no MCP client library
and no `Authorization` header. So the remaining change in `render/src/livepeer.ts` is
that shape in place of `Bearer` to `sdk.daydream.monster/inference`, and a `provider()`
in `narrate.ts` that no longer gates on `hasLivepeerKey()`, because there is no longer
a key to test.

Two things that will cost an hour if you write it: the audio URL is a **302 to
`fal.media`** — `fetch()` follows it, `curl` does not without `-L`, so a hand-check
looks like an empty file — and the capability returns **WAV, not MP3**. Whether demo
credits should carry a student-facing feature is a decision rather than a detail: $52
of headroom is a demonstration, not a supply.

**The render runner does not exist.** It is the one piece joining the explainer to
`render/`: take a `render_jobs` row, fetch its PDFs from MinIO, write a storyboard,
invoke `render/` **as a subprocess** (not an import — that is what keeps the wall real),
and deliver the result. `render_jobs` is durable, keyed so asking twice renders once,
with `take()` using `findOneAndUpdate` and a `recoverUnfinished()` sweep. Nothing
consumes it yet.

**Not built:** no transcript correction tool; audio over 20MB is not chunked; no rate
limiting or abuse controls; no cost tracking; no backup-restore drill.

## Gotchas found empirically — these will cost you hours

- **`courseKey()` only normalises, it does not validate.** `courseKey("hello")` is
  `"HELLO"`. Use `parseCourseList()` to recognise a real code. This nearly shipped in
  `set_group_course`.
- **pdf.js renders an opaque white page** — every pixel comes back `alpha: 255`. Crop on
  luminance, not alpha. And use `loadImage()`, not `new Image()` with `.src`: the latter
  reports correct dimensions and still draws nothing.
- **ffmpeg's `-shortest` overshoots a looped still** by around seven seconds a scene. Set
  `-t` from the measured audio length instead.
- **This machine's ffmpeg has no libass and no freetype**, so `subtitles` and `drawtext`
  do not exist. Captions are drawn on the canvas, which is more portable anyway.
- **ASR was replaced on 11 October 2026.** The earlier OpenAI comparison below is
  historical: `gpt-4o-transcribe` beat `whisper-1` on the user's code-switched Yoruba
  recordings, but the shipping path now calls the authenticated N-ATLaS Voice API on
  Modal with automatic Yoruba/Hausa/Igbo/English routing. Re-benchmark the new path
  with `npm run hear`; Modal's `language_confidence` is not transcription confidence.
- **The model calculates no dates.** `calendarWindow()` offers real days and the
  extractor picks one. Asked what "this Friday" meant, it once returned a Tuesday — at
  confidence 1.0.
- **Verify by looking, not by reading the numbers.** A rendered video reported the right
  duration, size and codec while every slide in it was blank. Extract a frame.
- **Livepeer's tool capabilities take undocumented parameters, and drop the ones they do
  not recognise without a word.** `describe_capability` returns `example_inputs:
{prompt: "<your prompt>"}` for every ffmpeg tool, which is boilerplate, and
  `openapi.json` on the SDK host has no per-tool schema at all. `ffmpeg-kenburns` wants
  `duration_sec`; `duration` and `seconds` are both accepted, ignored, and answered with
  the 5-second default. The first spike therefore produced a clean 720p h264 video whose
  narration had been cut from 19.9 seconds to 5 — success at every step, three quarters
  of the sentence gone. Probe a parameter by sending it and measuring the output before
  believing it landed.
- **`ffmpeg-burn-subtitles` succeeded on 40% of its last 20 attempts** and the network
  labels it degraded; `ffmpeg-concat` is at 87% of 30. Captions are drawn on the canvas
  locally instead, which was already true for a different reason. Check
  `describe_capability` for a live success rate before putting a tool on the path.
