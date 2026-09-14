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

| | |
|---|---|
| Working copy | `/Users/salami/Desktop/Startup/ai-agenty` |
| Repo with the GitHub remote | `/Users/salami/Desktop/peermate` (`dayosalam/peermate`) |
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
`.*` swallowed *"What course do I have on Tuesday?"* — a timetable question answered
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
connected because *somebody else's* group carried the code — and `listening()` printed
every group on the deployment **by name** to any student who asked. Same class as the
original cross-institution bug, on the coverage side rather than the content side.

All seven now use `groupRepository.forStudent(user.groupJids)`.
[tests/guidance.test.ts](tests/guidance.test.ts) asserts a student is never shown a
group they are not in.

### There is no operator

The largest change, and the user's explicit decision, made in stages:

1. Whoever adds Peermate to a group approves it, not the operator.
2. Nobody is notified about anyone else's group — *"we are 2 different users, peermate
   deals with me separately, and deals with chidi separately."*
3. The operator role was removed entirely.

**Authority over a group is being in it**, proved by `membershipService.mayAdminister`
— the same proof retrieval already uses. Deleted: `admin.service.ts`, `operator.ts`,
`ADMIN_PHONE` from config and both env templates, the operator branch in
`dm.service.ts`, and every "the operator has to approve this" answer in guidance.

Replaced by four tools, each resolving the group from the student's own groups and
re-checking membership *inside the tool*: `set_group_course`, `trust_sender`,
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

Visuals are the lecturer's **real slide pages**, cropped to the ink on them. There is no
generated-image path, and that is a decision rather than an omission: a model asked to
draw a shear force diagram puts the arrows the wrong way round, and a student revising
from it cannot tell.

## Open threads

**The Livepeer key is blocked.** `sk_` keys are retired network-wide. From the live API:

> *"Daydream `sk_` API keys are retired and can no longer pay for inference on this
> network. Use a pymthouse composite key instead — `Authorization: Bearer
> app_<appId>_pmth_<token>`."*

The docs page still says to get an `sk_` key; it is stale, and the API is authoritative.
`render/src/livepeer.ts` is written against the real endpoint
(`POST https://sdk.daydream.monster/inference`, body `{capability, input}`) and
`narrate.ts` prints which provider ran, falling back to OpenAI. The moment a valid key
lands in `render/.env`, that line reads `livepeer`. Ask in the Daydream Discord.

**The render runner does not exist.** It is the one piece joining the explainer to
`render/`: take a `render_jobs` row, fetch its PDFs from MinIO, write a storyboard,
invoke `render/` **as a subprocess** (not an import — that is what keeps the wall real),
and deliver the result. `render_jobs` is durable, keyed so asking twice renders once,
with `take()` using `findOneAndUpdate` and a `recoverUnfinished()` sweep. Nothing
consumes it yet.

**Not built:** no transcript correction tool; audio over 25MB is not chunked; no rate
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
- **`gpt-4o-transcribe` beats whisper-1 decisively** on real code-switched Yoruba, where
  whisper produced gibberish. Measured on the user's own recordings. Do not swap it for a
  Livepeer-hosted whisper without re-benchmarking.
- **The model calculates no dates.** `calendarWindow()` offers real days and the
  extractor picks one. Asked what "this Friday" meant, it once returned a Tuesday — at
  confidence 1.0.
- **Verify by looking, not by reading the numbers.** A rendered video reported the right
  duration, size and codec while every slide in it was blank. Extract a frame.
