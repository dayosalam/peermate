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
import { connectWhatsApp, onGroupJoin, onGroupLeave, onMessage } from './whatsapp/socket.js'
import { ingestQueue, recoverUnfinished } from './workers/ingest.worker.js'

/** Shorter than the orchestrator's own SIGKILL timer, so the flushes below still run. */
const SHUTDOWN_GRACE_MS = 10_000

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

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

  // Anything a crash left owed. Before the recovery sweep, which may add to it.
  void deliveryService
    .drainOutbox()
    .catch((error) => logger.error({ err: error }, 'outbox drain failed'))

  // After the socket is up, so recovered announcements can still be delivered.
  void recoverUnfinished().catch((error) => logger.error({ err: error }, 'recovery sweep failed'))
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
