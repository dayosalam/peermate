# Peermate

Peermate is a personal AI agent that lives in university course group chats and privately helps students keep up with what matters. It listens silently across multiple WhatsApp groups, understands text messages, voice notes, photographed timetables, PDFs and Word documents, and extracts important information such as tests, deadlines, venue changes and class schedules.

Students receive timely alerts and personalized daily digests with citations showing who shared each announcement and when. They can ask follow-up questions, retrieve course files, manage their courses and notification preferences, upload personal timetables, receive reminders, and generate revision guides or quizzes from materials shared in their groups. Peermate also uses Exa to find clearly labelled external reading and additional study materials without mixing web content with official group-chat information.

By turning noisy, fragmented group conversations into one reliable private assistant, Peermate helps students avoid missed announcements, find buried resources and prepare more effectively without constantly scrolling through every class group. Tunes

## Running it

Everything in containers:

```bash
cp .env.example .env      # OPENAI_API_KEY and ADMIN_PHONE are the two that matter
docker compose up --build
```

The first boot has to be paired. Set `WHATSAPP_PAIRING_NUMBER` to the bot's number
(digits only, country code, no `+`) and read the code out of the logs:

```bash
docker compose logs -f app      # INFO: pairing code: ABCD-EFGH
```

Then on the bot's phone: **WhatsApp → Linked devices → Link with phone number**, and
type the code. It pairs once and stays paired.

To develop against the host instead, run the stores in Docker and the app outside it,
which puts the pairing code — or the QR — in your own terminal:

```bash
docker compose up mongo minio chroma
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

Chroma has to be run, not borrowed. The JS client speaks HTTP only — there is no
embedded mode as in Python — so a server is required.

### Two things that break it

**The session lives in a volume, not the image.** `auth_state/` is a live WhatsApp
credential: it is gitignored, excluded from the build context, and mounted at
`/app/auth_state`. Lose the volume and you re-pair by hand from the phone — there is
no token that substitutes for a linked device.

**One process, always.** Two running against one session desynchronise the Signal
ratchet, and every student sees *"Waiting for this message"* with no way back. That
rules out rolling deploys: use `stop-first` (Compose), `Recreate` (Kubernetes) or
`--strategy immediate` (Fly), and never scale past one replica.



## Operating it

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
``` It reports what it could not resolve
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
