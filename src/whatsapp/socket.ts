import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { isBroadcastJid, isGroupJid } from './jid.js'

export type MessageHandler = (message: WAMessage) => void
export interface GroupJoinInfo {
  subject: string | null
  addedBy?: string | null
  addedByName?: string | null
  participantCount?: number | null
}
export type GroupJoinHandler = (chatJid: string, info: GroupJoinInfo) => void

export interface GroupLeaveInfo {
  /** The JIDs that left or were removed. */
  participants: string[]
  /** True when one of them was Peermate itself, which ends the group entirely. */
  botRemoved: boolean
}
export type GroupLeaveHandler = (chatJid: string, info: GroupLeaveInfo) => void

let sock: WASocket | null = null
let reconnecting = false
let attempts = 0
let open = false

/** Resolved the moment the socket comes back, so a caller need not poll for it. */
const waitingForOpen: Array<() => void> = []

const handlers: MessageHandler[] = []
const leaveHandlers: GroupLeaveHandler[] = []
const groupHandlers: GroupJoinHandler[] = []

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler)
}

/** Whether this shard currently holds a live WhatsApp session. */
export function isSocketOpen(): boolean {
  return open
}

export function onGroupLeave(handler: GroupLeaveHandler): void {
  leaveHandlers.push(handler)
}

export function onGroupJoin(handler: GroupJoinHandler): void {
  groupHandlers.push(handler)
}

/**
 * Waits for the socket to be usable, for a caller holding something to send.
 *
 * A reconnect takes a few seconds. Retrying a send on a fixed timer inside that window
 * fails a second time and the message is dropped — the student asked something and got
 * silence. Resolves false if it does not come back within the timeout, which is the
 * caller's cue to give up rather than to hold the message for ever.
 */
export async function whenOpen(timeoutMs: number): Promise<boolean> {
  if (open) return true

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waitingForOpen.indexOf(wake)
      if (index >= 0) waitingForOpen.splice(index, 1)
      resolve(false)
    }, timeoutMs)

    const wake = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    waitingForOpen.push(wake)
  })
}

export function getSocket(): WASocket {
  if (!sock)
    throw new Error('WhatsApp socket not connected — call connectWhatsApp() during startup')
  return sock
}

/** Current WhatsApp state, not the database's remembered group list. */
export async function participatingGroups(): Promise<
  Array<{
    chatJid: string
    subject: string | null
    participantCount: number
    participants: unknown[]
  }>
> {
  const groups = await getSocket().groupFetchAllParticipating()
  return Object.values(groups).map((group) => ({
    chatJid: group.id,
    subject: group.subject ?? null,
    participantCount: group.participants.length,
    participants: group.participants,
  }))
}

/**
 * Tears the old socket down before a new one replaces it.
 *
 * Without this the previous socket keeps its listeners and its keep-alive running.
 * Two live sockets on one session is the state that leaves Baileys reporting
 * "connected" while its init queries time out and no message is ever delivered —
 * the process looks healthy and silently ingests nothing.
 */
function dispose(previous: WASocket | null): void {
  if (!previous) return
  try {
    previous.ev.removeAllListeners('connection.update')
    previous.ev.removeAllListeners('messages.upsert')
    previous.ev.removeAllListeners('groups.upsert')
    previous.ev.removeAllListeners('group-participants.update')
    previous.ev.removeAllListeners('groups.update')
    previous.ev.removeAllListeners('creds.update')
    previous.end(undefined)
  } catch (error) {
    logger.debug({ err: error }, 'error disposing previous socket')
  }
}

export async function connectWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir)
  const { version } = await fetchLatestBaileysVersion()

  dispose(sock)

  // Baileys logs every protocol frame at debug, and reports a failed optional init
  // query at error level on most connects — alarming, and harmless. Our own
  // connection handling covers the failures that matter.
  const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel })

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    // Peermate is a reader. Announcing presence would make a silent number look active.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  const current = sock

  current.ev.on('creds.update', saveCreds)

  current.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      logger.info('scan this QR with the bot number: WhatsApp > Linked devices')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      attempts = 0
      reconnecting = false
      open = true
      logger.info({ jid: current.user?.id }, 'whatsapp connected')
      for (const wake of waitingForOpen.splice(0)) wake()
    }

    if (connection === 'close') {
      open = false
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode

      // These session states cannot be repaired by redialling the same credentials.
      // Stop rather than producing an endless reconnect loop; the auth directory is
      // kept intact so the operator can move it aside and re-pair recoverably.
      const terminalSession = [
        DisconnectReason.loggedOut,
        DisconnectReason.forbidden,
        DisconnectReason.badSession,
        DisconnectReason.multideviceMismatch,
      ].includes(statusCode as DisconnectReason)
      if (terminalSession) {
        logger.error(
          { authDir: config.whatsapp.authDir, statusCode },
          'WhatsApp session is no longer accepted — move the auth dir aside and re-pair; not reconnecting',
        )
        return
      }

      // Only the socket that is currently live may trigger a reconnect; a disposed
      // one firing late would spawn a second connection.
      if (current !== sock || reconnecting) return
      reconnecting = true
      attempts += 1
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
      logger.warn({ statusCode, attempts, delay }, 'connection closed, reconnecting')
      setTimeout(() => {
        void connectWhatsApp().catch((error) => {
          reconnecting = false
          logger.error({ err: error }, 'reconnect failed')
        })
      }, delay)
    }
  })

  // Fires when the bot is added to a group. This is how a group registers itself —
  // there is no other moment at which we learn the subject.
  current.ev.on('groups.upsert', (groups) => {
    for (const group of groups) {
      for (const handler of groupHandlers) {
        // `group.owner` is the group's *creator*, which is a different person from
        // whoever added Peermate — often somebody who left the group a year ago.
        // The adder arrives on group-participants.update instead, and until it does
        // there is nobody to name.
        handler(group.id, {
          subject: group.subject ?? null,
          participantCount: group.participants?.length ?? null,
        })
      }
    }
  })

  // A rename after the fact still tells us the course, so treat it as a join.
  current.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (!update.id || !update.subject) continue
      for (const handler of groupHandlers) handler(update.id, { subject: update.subject })
    }
  })

  // Who performed the add. The operator is deciding whose request to trust, so the
  // name matters more than the group's own metadata.
  current.ev.on('group-participants.update', (update) => {
    const selfJids = new Set(
      [current.user?.id, current.user?.phoneNumber, current.user?.lid]
        .map(jidNormalizedUser)
        .filter(Boolean),
    )
    const involvesBot = update.participants.some((participant) =>
      [participant.id, participant.phoneNumber, participant.lid]
        .map(jidNormalizedUser)
        .some((jid) => selfJids.has(jid)),
    )
    // Preserve every address Baileys supplies. Existing accounts may be keyed by
    // their phone JID or LID, and removeMembers deliberately matches both.
    const participantJids = [
      ...new Set(
        update.participants.flatMap((participant) =>
          [participant.id, participant.phoneNumber, participant.lid].filter((jid): jid is string =>
            Boolean(jid),
          ),
        ),
      ),
    ]

    if (update.action === 'add') {
      if (!involvesBot) return
      for (const handler of groupHandlers) {
        handler(update.id, { subject: null, addedBy: update.author ?? null })
      }
      return
    }

    // A voluntary leave and a removal arrive the same way; the difference does not
    // matter here, because either way that person is no longer in the room and must
    // stop hearing what is said in it.
    if (update.action === 'remove') {
      for (const handler of leaveHandlers) {
        handler(update.id, { participants: participantJids, botRemoved: involvesBot })
      }
    }
  })

  current.ev.on('messages.upsert', ({ messages, type }) => {
    // Visibility: without this, "nothing happened" is indistinguishable from
    // "nothing arrived", which is the hardest failure here to diagnose.
    logger.info(
      { type, count: messages.length, kinds: messages.map((m) => Object.keys(m.message ?? {})[0]) },
      'messages.upsert',
    )

    // 'append' carries messages the linked phone itself sent, which is how a lecturer
    // testing from their own handset appears. Ignoring it loses real announcements;
    // the unique index makes accepting both types harmless.
    if (type !== 'notify' && type !== 'append') return

    for (const message of messages) {
      const jid = message.key.remoteJid

      // Status posts arrive looking exactly like messages. Treated as a DM they
      // create a "student" called status and get replied to — which publishes a
      // Status update to the account's contacts.
      if (isBroadcastJid(jid)) {
        logger.debug({ jid }, 'ignoring broadcast/status')
        continue
      }

      // Our own DMs are the notifications we just sent — ingesting them would loop.
      // In a group, though, a message from this account is a real participant
      // talking, and skipping it is why testing from the linked phone looked broken.
      if (message.key.fromMe && !isGroupJid(jid)) {
        logger.debug({ id: message.key.id }, 'skipping own dm')
        continue
      }

      for (const handler of handlers) handler(message)
    }
  })

  // Pairing code instead of a QR scan: WhatsApp > Linked devices > Link with phone
  // number. The phone is still required once — a linked device is a credential the
  // account issues, so there is no token that substitutes for it.
  if (!current.authState.creds.registered && config.whatsapp.pairingNumber) {
    const number = config.whatsapp.pairingNumber.replace(/\D/g, '')
    // The socket must finish opening before it can ask for a code.
    setTimeout(() => {
      void current
        .requestPairingCode(number)
        .then((code) => logger.info({ number }, `pairing code: ${code}`))
        .catch((error) => logger.error({ err: error }, 'could not request pairing code'))
    }, 3000)
  }

  return current
}
