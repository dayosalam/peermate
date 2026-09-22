import 'dotenv/config'
import { z } from 'zod'
import defaults from './data/defaults.json' with { type: 'json' }

/**
 * z.coerce.boolean() is the wrong tool for env vars: it is Boolean(string), so the
 * string "false" coerces to true and MINIO_USE_SSL=false would silently enable TLS.
 */
const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().default(defaults.server.port),

  MONGODB_URL: z.string().default('mongodb://localhost:27017'),
  MONGODB_DATABASE: z.string().default(defaults.database.mongodbDatabase),

  CHROMA_URL: z.string().default(defaults.database.chromaUrl),

  /**
   * Which store answers a search.
   *
   * The cutover is staged rather than switched: `dual` writes both and still reads
   * Chroma, so Atlas can be backfilled and compared under real traffic before
   * anything depends on it. `atlas` reads Atlas and stops writing Chroma, which is
   * the end state — at which point the container can go.
   */
  SEARCH_BACKEND: z.enum(['chroma', 'dual', 'atlas']).default('chroma'),

  MINIO_ENDPOINT: z.string().default('localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('peermate-local'),
  MINIO_SECRET_KEY: z.string().default('peermate-local-dev'),
  MINIO_USE_SSL: booleanFromEnv.default('false'),

  /**
   * Which bot number this process is.
   *
   * Baileys holds one socket per number and two processes against one auth state
   * corrupt the Signal ratchet irrecoverably, so scaling means more numbers rather
   * than more replicas. Each shard owns its own auth directory, its own groups and
   * its own students.
   *
   * The default keeps a single-number deployment working exactly as before.
   */
  SHARD_ID: z.string().min(1).default('default'),

  // Per shard, and never shared: give each container its own directory. Two shards
  // pointed at one auth state is the same fatal mistake as two processes.
  WHATSAPP_AUTH_DIR: z.string().default(defaults.whatsapp.authDir),
  // Set to pair with an 8-character code instead of scanning a QR.
  WHATSAPP_PAIRING_NUMBER: z.string().default(''),

  OPENAI_API_KEY: z.string().default(''),

  // Optional observability. Off by default because traces contain student messages
  // and retrieved course material; enabling it is an explicit data-sharing choice.
  LANGSMITH_TRACING: booleanFromEnv.default('false'),
  LANGSMITH_API_KEY: z.string().default(''),
  LANGSMITH_PROJECT: z.string().default('peermate'),

  // Exa. Optional: with no key, prep is built from the shared files alone and the
  // further-reading section is simply absent.
  EXA_API_KEY: z.string().default(''),

  INGEST_CONCURRENCY: z.coerce.number().default(defaults.ingest.concurrency),

  // How the render worker starts `render/`. A subprocess, never an import: its PDF
  // rasteriser and native canvas have no business in the image the socket runs in.
  // Off by default: the video path is built and tested, but not yet connected to the
  // agent. Turning it on exposes render_explainer and offers walkthroughs — neither of
  // which works unless a render worker is actually running.
  RENDER_VIDEO_ENABLED: booleanFromEnv.default('false'),
  RENDER_CWD: z.string().default('render'),
  RENDER_COMMAND: z.string().default('npx'),
  // The child inherits this process's environment. Do not require render/.env: it is
  // useful for standalone local tests but deliberately absent from production images.
  RENDER_ARGS: z.string().default('tsx,src/cli.ts'),

  // Off during a live demo: an alert held for a minute looks like an alert that
  // never came, when the whole point on screen is that it arrives instantly.
  DEFER_ALERTS: booleanFromEnv.default('true'),

  // Meta Cloud API — unused today, kept wired for the split-directions move in PRD §8.
  ACCESS_TOKEN: z.string().default(''),
  APP_SECRET: z.string().default(''),
  VERIFY_TOKEN: z.string().default(''),
  CLOUD_API_PHONE_NUMBER_ID: z.string().default(''),

  // Baileys logs a failed optional init query at error level on most connects. It
  // is noise — our own connection.update logging covers what actually matters.
  BAILEYS_LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('silent'),

  // Landing-page lead capture. Google signup is intentionally disabled for now.
  LANDING_WHATSAPP_NUMBER: z.string().regex(/^\d+$/).default('15076046411'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USERNAME: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_USE_TLS: booleanFromEnv.default('true'),
  SMTP_USE_SSL: booleanFromEnv.default('false'),
  MAIL_FROM: z.string().default(''),
  ADMIN_WAITLIST_EMAIL: z.string().default(''),
})

const env = envSchema.parse(process.env)

/**
 * Every variable above has a default, so `parse` never throws — which is right for a
 * laptop and wrong for a server. A production deploy that forgot `MONGODB_URL` used
 * to come up cleanly, connect to a localhost Mongo that is not there, and report
 * itself healthy while storing nothing.
 *
 * Checked here rather than at each use, so it fails at boot with the name of what is
 * missing instead of hours later with a timeout.
 */
const REQUIRED_IN_PRODUCTION = [
  'MONGODB_URL',
  'MINIO_ENDPOINT',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'OPENAI_API_KEY',
  'ADMIN_PHONE',
  'SMTP_HOST',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
  'MAIL_FROM',
  'ADMIN_WAITLIST_EMAIL',
] as const

if (env.ENVIRONMENT === 'production') {
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => {
    const value = process.env[name]
    return !value || value.trim() === ''
  })

  if (missing.length > 0) {
    throw new Error(
      `ENVIRONMENT=production but these are unset: ${missing.join(', ')}. ` +
        'Each has a development default that would silently point at the wrong place.',
    )
  }
}

/**
 * A hosted MinIO is written as a bare hostname and served on the standard port; a
 * local one carries its port. Defaulting a missing port to 9000 makes a TLS
 * connection to a port nothing is listening on, which surfaces as a timeout rather
 * than as anything that names the cause.
 */
const [minioHost, minioPort] = env.MINIO_ENDPOINT.split(':')

export const config = {
  env: env.ENVIRONMENT,
  logLevel: env.LOG_LEVEL,
  isProduction: env.ENVIRONMENT === 'production',

  app: defaults.app,
  server: { host: defaults.server.host, port: env.PORT },

  mongo: { url: env.MONGODB_URL, database: env.MONGODB_DATABASE },
  chroma: { url: env.CHROMA_URL, collection: defaults.database.chromaCollection },
  minio: {
    endPoint: minioHost!,
    port: minioPort ? Number(minioPort) : env.MINIO_USE_SSL ? 443 : 9000,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: defaults.minio.bucketMedia,
  },
  whatsapp: {
    shardId: env.SHARD_ID,
    authDir: env.WHATSAPP_AUTH_DIR,
    pairingNumber: env.WHATSAPP_PAIRING_NUMBER,
  },
  openai: { apiKey: env.OPENAI_API_KEY, ...defaults.llm },
  langsmith: {
    enabled: env.LANGSMITH_TRACING && env.LANGSMITH_API_KEY !== '',
    project: env.LANGSMITH_PROJECT,
  },
  research: { apiKey: env.EXA_API_KEY, enabled: env.EXA_API_KEY !== '', ...defaults.research },
  embeddings: defaults.embeddings,
  searchBackend: env.SEARCH_BACKEND,
  retrieval: defaults.retrieval,
  /** How long a group must fall quiet before new files are announced as one batch. */
  resourceAlertDelayMs: defaults.resources.alertDelaySeconds * 1000,
  digest: defaults.digest,
  delivery: {
    enabled: env.DEFER_ALERTS,
    conversationActiveMs: defaults.delivery.conversationActiveSeconds * 1000,
    deferMs: defaults.delivery.deferSeconds * 1000,
    maxDeferMs: defaults.delivery.maxDeferSeconds * 1000,
  },
  ingest: { concurrency: env.INGEST_CONCURRENCY },
  render: {
    enabled: env.RENDER_VIDEO_ENABLED,
    cwd: env.RENDER_CWD,
    command: env.RENDER_COMMAND,
    args: env.RENDER_ARGS.split(',').filter(Boolean),
  },
  baileysLogLevel: env.BAILEYS_LOG_LEVEL,
  landing: {
    whatsappNumber: env.LANDING_WHATSAPP_NUMBER,
    whatsappUrl: `https://wa.me/${env.LANDING_WHATSAPP_NUMBER}`,
  },
  email: {
    enabled:
      env.SMTP_HOST !== '' &&
      env.MAIL_FROM !== '' &&
      env.ADMIN_WAITLIST_EMAIL !== '',
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD,
    secure: env.SMTP_USE_SSL,
    requireTls: env.SMTP_USE_TLS,
    from: env.MAIL_FROM,
    adminWaitlistEmail: env.ADMIN_WAITLIST_EMAIL,
  },
  cloudApi: {
    accessToken: env.ACCESS_TOKEN,
    appSecret: env.APP_SECRET,
    verifyToken: env.VERIFY_TOKEN,
    phoneNumberId: env.CLOUD_API_PHONE_NUMBER_ID,
  },
} as const

export type Config = typeof config
