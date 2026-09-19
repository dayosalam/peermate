# Peermate

## Project Overview

An agent that reads university WhatsApp class group chats and DMs registered students
what they missed, with citations. One shared bot number serves a whole class. It posts
nothing in any group and speaks only in 1:1 DMs.

[PRD.md](PRD.md) is the specification and records why each architectural choice was
made. Read it before proposing a different one.

## Related Projects

| Project | Role | Path |
|---------|------|------|
| unimart-api | `formatPhoneAsChatID` — the phone normalisation this ports, in Go | `/Users/salami/Desktop/Startup/unimart-api` |
| uniwrite-api | Pattern source for the layering (Python, not a stack reference) | `/Users/salami/Desktop/Startup/uniwrite-api` |

## Tech Stack

- **Runtime:** Node 20+, TypeScript, ESM (`"type": "module"` — relative imports need `.js`)
- **WhatsApp:** Baileys (`@whiskeysockets/baileys`) — in-process socket, no webhook
- **HTTP:** Express — health and operator routes only
- **Database:** MongoDB (official `mongodb` driver)
- **Search:** MongoDB Atlas `$vectorSearch` + `$search`, merged by reciprocal rank
  fusion. Chroma is still wired for the staged cutover — see `SEARCH_BACKEND`
- **Storage:** MinIO (voice notes, images, course documents)
- **AI:** OpenAI — Whisper for voice notes, structured outputs for extraction
- **Embeddings:** `text-embedding-3-small`, **512-dim** (shortened deliberately — a
  third of the storage, and these now live in Atlas beside everything else)
- **Testing:** vitest
- **Config:** zod-validated env over `src/data/defaults.json`

## Commands

```bash
npm run dev          # tsx watch — prints the pairing QR on first run
npm run build        # tsc -> dist/
npm test             # vitest
npm run typecheck    # tsc over src *and* tests
npm run infra:up     # docker compose (mongo, minio, chroma)

npm run backfill-tenancy    # runs itself at boot; this is the manual re-run
npm run migrate-to-atlas    # --indexes | --backfill | --compare
npm run export-fixtures     # freeze the real group, anonymised, for evals
npm run eval                # retrieval recall and answer quality
```

**Tenancy backfills itself on boot.** Retrieval is scoped by `user.groupJids`, and an
empty boundary returns nothing rather than everything, so an account that predates
tenancy hears silence — with clean logs — until it has groups. That made it a deploy
step somebody had to remember, which is the kind of step that gets forgotten exactly
once. `index.ts` runs it after the database connects and before anything is served.
It is idempotent: it skips anyone already scoped, so every boot after the first reads
two collections and writes nothing. It fails soft, because a backfill that cannot
finish leaves some students hearing less than they should, while a boot that dies on
it leaves all of them hearing nothing. The command still exists for a manual re-run
after an operator resolves an ambiguous group.

No Docker on this machine — see [README.md](README.md) for the direct-daemon fallback.

## Project Structure

```
src/
├── index.ts             # Boots db -> socket -> queue -> http; handles SIGINT
├── config.ts            # zod-validated env over data/defaults.json
├── core/                # logger.ts (pino), errors.ts
├── db/                  # mongo.ts (owns indexes), chroma.ts, minio.ts
├── models/              # zod schemas — message.ts is the contract
├── repositories/        # One per collection, all extending base.repository.ts
├── services/            # notifier.service.ts is the only module that sends;
│   └── agent/           # agent.service.ts is the loop; tools.ts is everything it
│                        # can do; evidence.ts fences untrusted retrieved content
├── scheduler/           # node-cron — digest + deadline warnings at 07:00 Lagos
├── scripts/             # smoke.ts — full pipeline against real OpenAI, no WhatsApp
├── whatsapp/            # socket.ts (Baileys), normalizer.ts, jid.ts
├── workers/             # queue.ts (bounded concurrency), ingest.worker.ts
├── http/                # server.ts — health + admin only
└── utils/               # courses.ts (canonical keys), dates.ts (calendar window)
```

The superseded Python prototype is out of this repo entirely, at
`/Users/salami/Desktop/Startup/peermate/legacy-python`. Nothing here imports it.

## Invariants

These are decisions, not defaults. Changing one changes the product.

- **`messages` and `extractions` are append-only.** A correction is a new row. Never
  update an existing extraction, and never resolve conflicts at write time.
- **Peermate never posts in a group.** Every send goes through
  [NotifierService](src/services/notifier.service.ts), which throws `GroupSendForbidden`
  on a `@g.us` JID. Do not add a second send path that bypasses it.
- **Peermate never messages someone who has not messaged it first.** Baileys can list
  group participants; that list must not become users.
- **Dedupe before any paid work.** `insertIfNew` returns false for an already-ingested
  message and the worker stops there. WhatsApp re-delivers on reconnect, so without
  this a reconnect re-transcribes and re-notifies everything.
- **Nothing may throw into the socket handler.** An unhandled rejection takes WhatsApp
  ingestion down with it. The queue catches per item; keep it that way.
- **Extraction always decides `kind` first.** The tagged union in
  [src/models/extraction.ts](src/models/extraction.ts) is what stops noise becoming a
  phantom announcement. Do not flatten it into nullable fields.
- **One message can yield several announcements.** A timetable photo carries a week of
  them. Extraction returns a list and each entry becomes its own row sharing the source
  message's provenance — never merge them into one summary record.
- **The model never calculates a date.** `calendarWindow()` computes the real days and
  the extractor picks one; anything outside that list is dropped to null. Asked what
  "this Friday" meant on a Friday, the model returned a Tuesday. See
  [src/utils/dates.ts](src/utils/dates.ts).
- **Course matching is always on `courseKey`.** `courseKey('csc 301') === 'CSC301'`.
  Matching on the display string returns nothing and raises nothing, so a student
  silently stops hearing from Peermate. See [src/utils/courses.ts](src/utils/courses.ts).
- **The group is the tenancy boundary, and a course code is never a scope.**
  `courseKey` is the same string at every university that issues the code, so matching
  on it alone put one school's announcements, files and citations in another school's
  DMs. Every read — retrieval, the shelf, announcements, digests, reminders — is
  filtered by `chatJid ∈ user.groupJids` *before* the course narrows it, and
  `groupJids` is passed explicitly rather than defaulted so the compiler finds a new
  read path that forgot it. An empty boundary returns nothing rather than everything:
  fail closed, or every pre-tenancy account sees the world. See
  [tests/tenancy.test.ts](tests/tenancy.test.ts), which proves exclusion by running
  the real queries rather than by inspecting them.
- **Belonging to a group is proved, never claimed.** Course codes are self-reported.
  A student reaches a group only by having added Peermate to it, or by appearing in
  its participant list. A check that cannot complete leaves the group *unverified* —
  a dropped socket must not be what grants access. See
  [MembershipService](src/services/membership.service.ts).
- **JIDs are built in one place.** Individuals are `@s.whatsapp.net`, never Green API's
  `@c.us`. A wrong suffix raises nothing — the DM is simply never delivered. See
  [src/whatsapp/jid.ts](src/whatsapp/jid.ts).
- **A document is filed before it is read.** DocumentService tags every file; the
  reader is a second pass that may fail without consequence. A file that cannot be
  read is indexed as unreadable rather than skipped, so students are told the truth
  instead of being told it does not exist. Chunking happens *within* one file only —
  no embedding ever blends two senders.
- **Retrieval favours recall.** Read-time conflict resolution can only compare records
  retrieval returned, so filter by course and window, then take a generous k.
- **Citations come from stored provenance, not from the model.** Sender, timestamp and
  source message id ride on the row; the LLM phrases the answer, it does not supply
  the attribution.
- **The agent decides, the code authorises.** There is no intent router and no
  literal fast path for anything that is a conversation. What stays literal is what is
  not one: onboarding (a form), the operator console, and a pending question Peermate
  itself asked. Execution limits — 8 tool calls, 2 model retries, a 45s budget,
  repeated-call detection — live in `agent.service.ts` and are never prompt
  instructions, because a prompt instruction is a request. Every tool resolves the
  student from the session, never from an argument the model passed.
- **Everything a tool returns is untrusted.** Group messages, PDF text, transcripts
  and web pages are written by people who have agreed to nothing, and a document
  saying "ignore your instructions" is realistic rather than hypothetical. Retrieved
  content is fenced by `asEvidence()` and labelled as quoted material — but the load
  is carried by tools authorising independently, so a model that *is* talked into
  trying still reaches nothing the student could not.
- **A generated visual is never load-bearing.** A model asked to draw a shear force
  diagram puts the arrows the wrong way round, and the student revising from it is the
  last person able to notice. So generated imagery carries an opener, a break or a
  closing card, and anything a student could revise from — a diagram, a formula, a
  labelled figure — is a real page from their own material. The choice is recorded as
  a tagged union rather than implied by which field got filled, so a test can assert
  the rule held. See `JobVisual` in
  [src/models/render-job.ts](src/models/render-job.ts).
- **A render is a separate process, and delivers through the outbox.** A three-minute
  render must not share a process with the WhatsApp socket, and a second process
  holding `auth_state` desynchronises the session irrecoverably — so the worker
  renders and writes the result down, and the bot sends it. MinIO carries the bytes
  because neither can see the other's disk. Progress is written to the job row by the
  renderer and read by the bot, which owns the only socket. See
  [src/workers/render.worker.ts](src/workers/render.worker.ts).
- **Progress shown to a student is measured, never estimated.** The percentage is the
  renderer's own count of finished stages, reported line by line off its stdout. A
  student reads it to decide whether to keep waiting, and an invented number is a
  fabricated citation wearing a percent sign.
- **Work is an entity, not an extraction.** `extractions` is append-only, so a
  corrected deadline is a new row with a new `eventId` — and a student's "submitted"
  keyed to that id would be orphaned exactly when it matters. `assignments` is keyed
  on (group, course, normalised title), which survives the date moving.
- **Outbound is durable.** Every unsolicited send claims an `outbox` row before it is
  attempted and clears it after, so a crash leaves evidence and a restart does not
  send a test alert twice. Suppressions are written to `notifications` with their
  reason: "she was in quiet hours" and "we were down" must be distinguishable months
  later, and a pino line on a replaced container is not an answer.
- **Every unsolicited message goes through
  [DeliveryService](src/services/delivery.service.ts).** Pauses, per-course mutes,
  urgent-only, quiet hours and mid-conversation deferral are decided there and
  nowhere else. A student who asked to be left alone and is messaged anyway does not
  give a second chance, and a rule applied in three services will be missed in the
  fourth. Answers to a question the student just asked are not unsolicited and do not
  pass through it.
- **Nothing a delivery rule holds is ever discarded.** The digest covers everything
  since it last ran, and `lastDigestAt` is not advanced when a digest is held — so a
  pause defers and never deletes. Reversal of PRD §8's original "no toggles"; see §8.
- **A group is silent until approved.** Being added to a chat is not consent from the
  people in it. `pending` groups are ingested from not at all — see
  [GroupService](src/services/group.service.ts).
- **A repeat is corroboration, not news.** `findSimilar` matches only on stated
  values; nulls stay open so a fuller telling enriches the first row rather than
  creating a second. Only a more authoritative speaker turns a repeat into a DM.
- **The extractor reads only what somebody said** — text, caption or transcript. A
  filename is not an announcement. See `readableContent` and
  [tests/extraction-content.test.ts](tests/extraction-content.test.ts).
- **`auth_state/` is a live WhatsApp session credential.** Gitignored. Never commit it,
  never bake it into an image, never run two processes against it.
- **One shard, one number, one socket, one auth directory.** Capacity comes from more
  bot numbers, never from more replicas — `deploy.replicas` stays 1 for ever. Every
  query that iterates students is scoped by `shardId`, or each student receives one
  digest per number running. A student's `shardId` is the number they wrote to, and
  outbound for them always leaves through it: a DM belongs to a number, so a shard
  they have never written to cannot message them without breaking the rule above.
  This is why a student may only subscribe to groups their own shard is in, and why
  `uncovered` exists on [MembershipService](src/services/membership.service.ts).

## Conventions

- Comments explain *why*, never *what*. If the code says it, don't restate it.
- Repositories own all Mongo access; services never touch a collection directly.
- Every pipeline stage fails soft — a message that cannot be transcribed is still a
  stored message, and the digest still goes out.
- Env booleans go through `booleanFromEnv` in [src/config.ts](src/config.ts).
  `z.coerce.boolean()` is `Boolean(string)`, so `"false"` would coerce to `true`.
