import { config } from './config.js'
import { logger } from './core/logger.js'
import { connectChroma } from './db/chroma.js'
import { connectMinio } from './db/minio.js'
import { closeMongo, connectMongo } from './db/mongo.js'
import { shardRepository } from './repositories/index.js'
import { startServer } from './http/server.js'
import { startScheduler } from './scheduler/index.js'
import { deliveryService } from './services/delivery.service.js'
import { resourceAlertService } from './services/resource-alert.service.js'
import { groupService } from './services/group.service.js'
import { PROGRESS_TICK_MS, renderProgressService } from './services/render-progress.service.js'
import { connectWhatsApp, onGroupJoin, onGroupLeave, onMessage } from './whatsapp/socket.js'
import { backfillPrivateMemory, ingestQueue, recoverUnfinished } from './workers/ingest.worker.js'
import { backfillTenancy } from './scripts/backfill-tenancy.js'
import { deletionService } from './services/deletion.service.js'

/** Shorter than the orchestrator's own SIGKILL timer, so the flushes below still run. */
const SHUTDOWN_GRACE_MS = 10_000

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

  // Before anything can be answered, not as a step somebody has to remember.
  //
  // Every read is scoped by `groupJids`, and an empty one returns nothing rather than
  // everything — so an account that predates tenancy hears silence, with clean logs,
  // until this has run. Idempotent: it skips anyone already scoped, so on every boot
  // after the first it reads two collections and writes nothing.
  //
  // Fails soft. A backfill that cannot complete is a subset of students hearing less
  // than they should; a boot that dies on it is all of them hearing nothing.
  try {
    const scoped = await backfillTenancy()
    if (scoped.usersScoped > 0 || scoped.resourcesScoped > 0) {
      logger.info(
        { users: scoped.usersScoped, resources: scoped.resourcesScoped },
        'tenancy backfilled',
      )
    }
    if (scoped.usersStranded.length > 0 || scoped.ambiguous.length > 0) {
      logger.warn(
        { stranded: scoped.usersStranded, ambiguous: scoped.ambiguous },
        'students left unscoped — they hear nothing until their group is set by hand',
      )
    }
  } catch (error) {
    logger.error({ err: error }, 'tenancy backfill failed — pre-tenancy accounts stay silent')
  }

  // Do this before the socket and scheduler can send anything. A user whose deletion
  // was interrupted must not receive one last queued alert during recovery.
  try {
    const deleted = await deletionService.recover()
    if (deleted > 0) logger.info({ count: deleted }, 'private deletions recovered')
  } catch (error) {
    logger.error({ err: error }, 'private deletion recovery failed')
  }

  // The socket handler does nothing but enqueue, so a slow transcription can never
  // stall WhatsApp ingestion.
  onMessage((message) => ingestQueue.push(message))
  onGroupJoin((chatJid, subject) => {
    void groupService
      .register(chatJid, subject)
      .catch((error) => logger.error({ err: error, chatJid }, 'group registration failed'))
  })
  onGroupLeave((chatJid, { participants, botRemoved }) => {
    const handle = botRemoved
      ? groupService.revoke(chatJid)
      : groupService.removeMembers(chatJid, participants)
    void handle.catch((error) => logger.error({ err: error, chatJid }, 'group departure failed'))
  })
  const sock = await connectWhatsApp()
  void groupService
    .retryDisclosures()
    .catch((error) => logger.error({ err: error }, 'group disclosure recovery failed'))
  // Recorded after the socket is up, because the number is only known once WhatsApp
  // says who it logged in as. An operator reading this collection needs to see which
  // number is holding which session before they can safely restart anything.
  await shardRepository.announce({
    shardId: config.whatsapp.shardId,
    phoneNumber: sock.user?.id?.split(':')[0] ?? null,
    status: 'active',
    authDir: config.whatsapp.authDir,
    lastSeenAt: new Date(),
    startedAt: new Date(),
  })

  startScheduler()
  startServer()

  // The renderer runs in another process and holds no socket, so telling students how
  // their video is going has to happen here. Only when the video path is switched on —
  // otherwise this is a query every fifteen seconds for jobs nothing creates.
  const progress = setInterval(() => {
    if (!config.render.enabled) return
    void renderProgressService
      .tick()
      .catch((error) => logger.error({ err: error }, 'render progress tick failed'))
  }, PROGRESS_TICK_MS)
  progress.unref()

  // Anything a crash left owed. Before the recovery sweep, which may add to it.
  void deliveryService
    .drainOutbox()
    .catch((error) => logger.error({ err: error }, 'outbox drain failed'))

  // After the socket is up, so recovered announcements can still be delivered.
  void recoverUnfinished().catch((error) => logger.error({ err: error }, 'recovery sweep failed'))
  void backfillPrivateMemory()
    .then((count) => count && logger.info({ count }, 'private memory backfilled'))
    .catch((error) => logger.error({ err: error }, 'private memory backfill failed'))
  logger.info({ shard: config.whatsapp.shardId }, 'peermate up')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      logger.info({ signal }, 'shutting down')

      // Bounded. A wedged handler used to hold the drain open until the orchestrator
      // ran out of patience and sent SIGKILL — which skips the flushes below, so the
      // held alerts this is here to save were lost anyway.
      await Promise.race([
        (async () => {
          await ingestQueue.drain()
          await resourceAlertService.flushAll()
          await deliveryService.flushAll()
        })(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ])

      await closeMongo()
      process.exit(0)
    })()
  })
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start')
  process.exit(1)
})
