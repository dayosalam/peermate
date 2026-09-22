import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { snapshot } from '../core/metrics.js'
import { getMinio } from '../db/minio.js'
import { getDb } from '../db/mongo.js'
import { groupRepository } from '../repositories/index.js'
import { landingSignupService, SignupInputError } from '../services/landing-signup.service.js'
import { signupEmailService } from '../services/signup-email.service.js'
import { isSocketOpen } from '../whatsapp/socket.js'
import { ingestQueue } from '../workers/ingest.worker.js'

const SIGNUP_WINDOW_MS = 10 * 60 * 1000
const SIGNUP_LIMIT = 10
const signupAttempts = new Map<string, { count: number; resetAt: number }>()

function limitPublicSignups(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now()
  const key = req.ip || req.socket.remoteAddress || 'unknown'
  const current = signupAttempts.get(key)

  if (!current || current.resetAt <= now) {
    signupAttempts.set(key, { count: 1, resetAt: now + SIGNUP_WINDOW_MS })
    next()
    return
  }

  if (current.count >= SIGNUP_LIMIT) {
    res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)))
    res.status(429).json({ error: 'Too many signup attempts. Please try again shortly.' })
    return
  }

  current.count += 1
  next()
}

function sendSignupError(error: unknown, res: Response): void {
  if (error instanceof SignupInputError) {
    res.status(400).json({ error: error.message })
    return
  }

  logger.error({ error }, 'landing signup failed')
  res.status(500).json({ error: 'Signup could not be saved. Please try again.' })
}

/**
 * Deliberately small. With Baileys in-process there is no inbound webhook, so this
 * exists only for health checks and operator tasks — never for student-facing flows,
 * which all happen in WhatsApp DMs.
 */
export function createServer(): Express {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '16kb' }))

  app.get('/api/signup/config', (_req, res) => {
    res.json({
      whatsappUrl: config.landing.whatsappUrl,
    })
  })

  app.post('/api/signup/email', limitPublicSignups, async (req, res) => {
    try {
      const signup = await landingSignupService.email(req.body)
      let emailSent = true

      try {
        await signupEmailService.sendSignupEmails(signup)
      } catch (error) {
        emailSent = false
        logger.error({ err: error }, 'signup saved but signup emails could not be delivered')
      }

      res.status(201).json({
        signedUp: true,
        emailSent,
        whatsappUrl: config.landing.whatsappUrl,
      })
    } catch (error) {
      sendSignupError(error, res)
    }
  })

  // Liveness: the process is up. Deliberately cheap and always 200 — an orchestrator
  // restarting the container because Atlas blipped would take WhatsApp down with it,
  // and the session is the expensive thing to lose.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
      shard: config.whatsapp.shardId,
    })
  })

  /**
   * Readiness: can this shard actually do its job?
   *
   * Reports each dependency separately rather than one boolean, because "not ready"
   * with no reason is the same as no answer at all when somebody is looking at it at
   * 2am. The socket matters most: Mongo and MinIO have retries, a dead WhatsApp
   * session has a human.
   */
  app.get('/ready', async (_req, res) => {
    const checks: Record<string, string> = {}

    try {
      await getDb().command({ ping: 1 })
      checks['mongo'] = 'ok'
    } catch (error) {
      checks['mongo'] = String(error)
    }

    try {
      await getMinio().bucketExists(config.minio.bucket)
      checks['minio'] = 'ok'
    } catch (error) {
      checks['minio'] = String(error)
    }

    checks['whatsapp'] = isSocketOpen() ? 'ok' : 'disconnected'

    const ready = Object.values(checks).every((value) => value === 'ok')
    res.status(ready ? 200 : 503).json({ ready, shard: config.whatsapp.shardId, checks })
  })

  app.get('/admin/metrics', (_req, res) => {
    res.json(snapshot())
  })

  app.get('/admin/queue', (_req, res) => {
    res.json({ depth: ingestQueue.depth })
  })

  app.get('/admin/groups', async (_req, res) => {
    res.json(await groupRepository.all())
  })

  return app
}

export function startServer(): void {
  createServer().listen(config.server.port, config.server.host, () => {
    logger.info({ port: config.server.port }, 'http listening')
  })
}
