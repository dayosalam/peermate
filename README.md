# Peermate

Peermate is a personal AI agent that lives in university course group chats and privately helps students keep up with what matters. It listens silently across multiple WhatsApp groups, understands text messages, voice notes and photographed timetables, stores shared files, and extracts important information such as tests, deadlines, venue changes and class schedules. PDF contents are processed only when a student explicitly asks to use a file.

Students receive timely alerts and personalized daily digests with citations showing who shared each announcement and when. They can ask follow-up questions, retrieve course files, manage their courses and notification preferences, upload personal timetables, receive reminders, and generate revision guides or quizzes from materials shared in their groups. Peermate also uses Exa to find clearly labelled external reading and additional study materials without mixing web content with official group-chat information.

By turning noisy, fragmented group conversations into one reliable private assistant, Peermate helps students avoid missed announcements, find buried resources and prepare more effectively without constantly scrolling through every class group.

Private messages are part of each student's own searchable memory. Group history is available only after membership has been verified, remains available when that student leaves, and can be explicitly forgotten. Students can keep every update from a group, limit it to deadlines, pause proactive messages while retaining search, or delete their account and private data. Named collections let them organize useful source messages without copying or detaching them from their provenance.

## Running it

Everything in containers:

```bash
cp .env.example .env      # set the required API, storage, and WhatsApp values
docker compose up --build
```

The first boot has to be paired. Set `WHATSAPP_PAIRING_NUMBER` to the bot's number
(digits only, country code, no `+`) and read the code out of the logs:

```bash
docker compose logs -f app      # INFO: pairing code: ABCD-EFGH
```

Then on the bot's phone: **WhatsApp → Linked devices → Link with phone number**, and
type the code. It pairs once and stays paired.

To develop against the host instead, start MongoDB, MinIO and Chroma locally,
then run the app outside them. This puts the pairing code — or the QR — in your
own terminal:

```bash
npm run dev
```

## Deploying it

[docker-compose.deploy.yml](docker-compose.deploy.yml) runs the app with MinIO and
Chroma beside it and expects Mongo to be hosted — set `MONGODB_URL` to your cluster and
keep `MONGODB_DATABASE=peermate`, which stays a separate database even on a cluster
shared with something else.

```bash
scp .env you@server:/srv/peermate/.env
docker compose -f docker-compose.deploy.yml up -d --build
docker compose -f docker-compose.deploy.yml logs -f app
```

Read the pairing code out of those logs and link it from the bot's phone. Only port
3000 is published — MinIO and Chroma are reachable only from inside the compose
network, which is where they belong: neither needs to be on the public internet, and an
object store that is costs more than it gives.

## Delivery pipeline

The GitHub Actions workflow in `.github/workflows/pipeline.yml` runs on every pull
request and push to `main`. It installs from both lockfiles, runs the app and renderer
test/type gates, builds the app, validates `compose.prod.yml`, and builds both
production images.

Production deployment is intentionally manual. In GitHub Actions, run **PeerMate
pipeline**, enable **Deploy**, and approve the `production` environment if it has a
review rule. The deploy job refuses a dirty server checkout, confirms that the exact
commit it verified is still `origin/main`, performs a fast-forward-only update, and
runs `ops/deploy.sh`. That script preserves all named volumes and waits for `/ready`.

Configure these GitHub production secrets:

- `DEPLOY_HOST`: the server hostname or IP address
- `DEPLOY_USER`: the unprivileged SSH user that owns the checkout and can run Docker
- `SSH_PRIVATE_KEY`: its deployment key
- `DEPLOY_KNOWN_HOSTS`: the pinned `known_hosts` line for the server

`DEPLOY_PATH` is an optional production environment variable and defaults to
`/home/dayo/peermate`. The server keeps its existing `.env` and WhatsApp auth volume;
neither is copied through GitHub Actions.

Run the same gates locally with:

```bash
npm ci
npm run verify
npm --prefix render ci
npm run verify:render
npm run verify:compose
```

Chroma has to be run, not borrowed. The JS client speaks HTTP only — there is no
embedded mode as in Python — so a server is required.

### Two things that break it

**The session lives in a volume, not the image.** `auth_state/` is a live WhatsApp
credential: it is gitignored, excluded from the build context, and mounted at
`/app/auth_state`. Lose the volume and you re-pair by hand from the phone — there is
no token that substitutes for a linked device.

**One process, always.** Two running against one session desynchronise the Signal
ratchet, and every student sees _"Waiting for this message"_ with no way back. That
rules out rolling deploys: use `stop-first` (Compose), `Recreate` (Kubernetes) or
`--strategy immediate` (Fly), and never scale past one replica.

## Operating it

### Privacy and retention

Peermate announces itself once when it joins a group and begins retaining new content
only after that point. Removing the bot stops new ingestion. A student's private DMs,
private media, vectors, schedules, collections and preferences remain until they send
`forget me`; that cleanup is checkpointed and resumes after a restart if a dependency
was unavailable. Shared group sources are not deleted by one student's account deletion
because other verified members may rely on them. A student can instead ask Peermate to
forget one group, which removes only that student's access to its archive.

Conversation transcripts and shared sources do not expire automatically. They remain
until an authorised forget/delete request or deliberate data-version retirement.

### Product acceptance check

Before releasing a change, validate one staged group and two test students end to end:

1. Add Peermate and verify it remains silent in the room and sends one private confirmation to a known user.
2. Send text, voice, image, PDF and DOCX sources; retrieve each naturally and request
   the original.
3. Confirm neither student can retrieve the other's private DM.
4. Leave and rejoin the group; confirm prior authorized history remains available.
5. Exercise all, deadlines-only, paused and forget modes.
6. Restart during an account deletion and verify cleanup resumes without a later DM.
7. Run `npm run eval` and require zero cross-group leaks and followed injections.

### Tenancy backfill — automatic, on every boot

Retrieval is scoped by the groups a student belongs to, and an empty boundary returns
nothing rather than everything. Every account created before that change has no groups
recorded, so it hears nothing until it is scoped. That used to be a deploy step
somebody had to remember; it now runs itself in `index.ts`, after the database
connects and before anything is served.

It is idempotent — it skips anyone already scoped — so the cost of every boot after
the first is two reads and no writes. To re-run it by hand, after resolving a group it
could not place:

```bash
npm run backfill-tenancy
```

It reports what it could not resolve
rather than guessing — a course carried by two groups is exactly the cross-institution
collision the boundary exists to stop, and picking one would be guessing which
university somebody attends.

### Adding a second bot number

Capacity comes from more numbers, never more replicas: Baileys holds one socket per
number, and two processes against one auth state corrupt the session irrecoverably.

Give each shard its own `SHARD_ID` and its **own** auth volume, and it will read only
the groups that number is in and message only the students who wrote to it. See the
worked example in [docker-compose.deploy.yml](docker-compose.deploy.yml).

A student can only subscribe to groups their own shard is in. That is a real
constraint rather than an oversight: a DM belongs to a number, so a shard they have
never written to cannot message them without breaking the rule that Peermate never
writes first.

### Moving search to Atlas

```bash
npm run migrate-to-atlas -- --indexes     # create the search indexes
npm run migrate-to-atlas -- --backfill    # copy every chunk across
SEARCH_BACKEND=dual                       # write both, still read Chroma
npm run migrate-to-atlas -- --compare <group-jid> <COURSEKEY>
SEARCH_BACKEND=atlas                      # read Atlas; Chroma can go
```

Each step is reversible until the last, and the last is one environment variable.

### Measuring it

```bash
npm run export-fixtures   # freeze the real group, anonymised
npm run eval              # retrieval recall and answer quality
```

Run it **before** changing anything. A number with nothing to compare against is not a
measurement. Cross-group leaks and followed injections are reported separately and
must be zero — they are correctness failures, not scores to average.
