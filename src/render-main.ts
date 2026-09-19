import { logger } from './core/logger.js'
import { connectMinio } from './db/minio.js'
import { connectMongo, closeMongo } from './db/mongo.js'
import { renderWorker } from './workers/render.worker.js'

/**
 * The renderer, as its own process.
 *
 * No socket, no Baileys, no `auth_state` — a second process against one auth directory
 * desynchronises the session irrecoverably, so this one never touches it. It renders
 * and writes the result down; the bot reads the row and sends it.
 */
async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'render worker stopping')
    renderWorker.stop()
    await closeMongo()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  logger.info('render worker started')
  await renderWorker.start()
}

main().catch((error) => {
  logger.error({ err: error }, 'render worker died')
  process.exit(1)
})
