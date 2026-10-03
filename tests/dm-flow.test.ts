import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Course, Extraction, Group, Message, User } from '../src/models/index.js'

const PHONE = '2348100000000'
const JID = `${PHONE}@s.whatsapp.net`

let user: User
let conversation: Conversation | null = null
let pendingGroups: Group[] = []
let knownCourses: Course[] = []
const outbox: string[] = []
const sentFiles: string[] = []
const proposed: Array<{ chatJid: string; course: string }> = []
const learned: Array<{ courseKey: string; title: string | null }> = []

const extraction: Extraction = {
  eventId: 'evt-1',
  sourceMessageId: 'src-1',
  chatJid: '1@g.us',
  course: 'CSC 301',
  courseKey: 'CSC301',
  scope: 'course' as const,
  eventType: 'test',
  title: null,
  originalDateText: 'Friday',
  date: '2026-09-18',
  time: '10:00',
  venue: 'LG7',
  confidence: 0.9,
  authority: 'lecturer',
  corroboratedBy: [],
  supersededBy: null,
  extractedAt: new Date(),
}

const sourceMessage = {
  waMessageId: 'src-1',
  chatJid: '1@g.us',
  senderName: 'Dr Bello',
  type: 'audio',
  transcript: 'The CSC 301 test holds Friday 10am in LG7.',
  transcriptConfidence: null,
  text: null,
  caption: null,
  mediaKey: 'audio/src-1',
  mimeType: 'audio/ogg',
  timestamp: new Date('2026-09-12T08:43:00+01:00'),
} as unknown as Message

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    findByPhone: vi.fn(async () => user),
    upsert: vi.fn(async (next: User) => {
      user = next
    }),
  },
  groupRepository: {
    approved: vi.fn(async () => []),
    forStudent: vi.fn(async () => []),
    pending: vi.fn(async () => pendingGroups),
    findByJid: vi.fn(async (jid: string) => pendingGroups.find((g) => g.chatJid === jid) ?? null),
  },
  messageRepository: { findById: vi.fn(async () => sourceMessage) },
  extractionRepository: {
    findByEventId: vi.fn(async () => extraction),
    currentFor: vi.fn(async () => extraction),
    dueOn: vi.fn(async () => []),
    forCourses: vi.fn(async () => []),
  },
  conversationRepository: {
    find: vi.fn(async () => conversation),
    save: vi.fn(async (next: Conversation) => {
      conversation = next
    }),
    clear: vi.fn(async () => {
      conversation = null
    }),
  },
  courseRepository: {
    forKeys: vi.fn(async () => knownCourses),
    find: vi.fn(async () => knownCourses[0] ?? null),
    enrich: vi.fn(async (courseKey: string, patch: { title?: string | null }) => {
      learned.push({ courseKey, title: patch.title ?? null })
    }),
  },
  scheduleRepository: {
    forStudent: vi.fn(async () => []),
    forCourse: vi.fn(async () => []),
    insertMany: vi.fn(),
    replaceKinds: vi.fn(async () => 0),
  },
  resourceRepository: {
    forCourse: vi.fn(async (key: string) =>
      key === 'CSC301'
        ? [
            {
              fileName: 'CSC301_week4.pdf',
              mediaKey: 'doc/1',
              mimeType: 'application/pdf',
              courseKey: 'CSC301',
              docType: 'slides',
              postedBy: 'Dr Bello',
              postedAt: new Date(),
            },
          ]
        : [],
    ),
  },
}))

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    sendText: vi.fn(async (_jid: string, text: string) => {
      outbox.push(text)
      return `sent-${outbox.length}`
    }),
    sendDocument: vi.fn(async (_jid: string, _bytes: Buffer, fileName: string) => {
      sentFiles.push(fileName)
    }),
    sendFile: vi.fn(async (_jid: string, _key: string, fileName: string) => {
      sentFiles.push(fileName)
    }),
    sendVoiceNote: vi.fn(async () => {
      sentFiles.push('voice-note')
    }),
    sendImage: vi.fn(async () => {
      sentFiles.push('image')
    }),
    withTyping: vi.fn(async (_jid: string, work: () => Promise<unknown>) => work()),
  },
}))

vi.mock('../src/services/group.service.js', () => ({
  groupService: {
    propose: vi.fn(async (chatJid: string, course: string) => {
      proposed.push({ chatJid, course })
      return { group: null, approved: false }
    }),
    claimableBy: vi.fn(async () => []),
    claim: vi.fn(async () => false),
  },
}))

vi.mock('../src/db/minio.js', () => ({ getMedia: vi.fn(async () => Buffer.from('bytes')) }))

let timetableRead: unknown = null
vi.mock('../src/services/timetable.service.js', () => ({
  timetableService: {
    looksLikeTimetable: vi.fn(() => timetableRead !== null),
    read: vi.fn(async () => timetableRead),
  },
}))

let webFinds: Array<{ title: string; url: string }> = []
let downloadable = true
vi.mock('../src/services/research.service.js', () => ({
  researchService: {
    documentsFor: vi.fn(async () =>
      webFinds.map((find) => ({ ...find, topic: 'x', extract: null })),
    ),
    download: vi.fn(async () =>
      downloadable ? { bytes: Buffer.from('%PDF-1.4'), fileName: 'notes.pdf' } : null,
    ),
  },
}))
vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))

const answer = vi.fn(async (..._args: unknown[]) => 'The CSC 301 test is Friday 10am in LG7.')
vi.mock('../src/services/qa.service.js', () => ({ qaService: { answer } }))

/**
 * The agent is mocked wholesale.
 *
 * What is left in DmService is the part that is deliberately *not* a conversation:
 * onboarding, the operator console, a pending question Peermate itself asked, an
 * emoji, a photographed timetable. Those are what these tests cover. What the agent
 * decides to do with an ordinary question is measured by the evals, not asserted
 * here — pinning it to a fixed intent is what the router did, and why an unusual
 * phrasing used to fail.
 */
let agentReply = 'answered'
let agentCalls: string[] = []
vi.mock('../src/services/agent/agent.service.js', () => ({
  agentService: {
    answer: async (text: string) => {
      agentCalls.push(text)
      return agentReply
    },
  },
  AgentFailed: class extends Error {},
}))

// researchService itself is mocked; this only flips the "can I search?" check that
// gates the offer, which reads the key rather than the service.
process.env['EXA_API_KEY'] ||= 'test-key'

const { dmService } = await import('../src/services/dm.service.js')
const { conversationService } = await import('../src/services/conversation.service.js')

function dm(text: string): Message {
  return {
    waMessageId: `m-${Math.random()}`,
    chatJid: JID,
    senderJid: JID,
    senderPhone: PHONE,
    senderName: 'Amina',
    fromGroup: false,
    timestamp: new Date(),
    type: 'text',
    text,
    caption: null,
    transcript: null,
    transcriptConfidence: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    quotedMessageId: null,
    processingStatus: 'done',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
  } as Message
}

beforeEach(() => {
  agentCalls = []
  agentReply = 'answered'
  timetableRead = null
  webFinds = []
  downloadable = true
  outbox.length = 0
  sentFiles.length = 0
  proposed.length = 0
  learned.length = 0
  pendingGroups = []
  knownCourses = []
  conversation = null
  answer.mockClear()
  user = {
    phone: PHONE,
    jid: JID,
    name: 'Amina',
    displayName: 'Amina',
    courseKeys: ['CSC301', 'STA202'],
    groupJids: ['g1@g.us'],
    shardId: 'default',
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: null,
    quietTo: null,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
  }
})

/**
 * The exchange the product is actually for: an alert arrives, and the student's next
 * three messages are all about it without ever naming it again.
 */
describe('messages that are not questions', () => {
  it('says nothing to a thumbs-up', async () => {
    await dmService.handle(dm('👍'))
    expect(outbox).toHaveLength(0)
  })

  it('offers help to a puzzled face', async () => {
    await dmService.handle(dm('🤔'))
    expect(outbox.at(-1)).toMatch(/send \*help\*/i)
  })

  /**
   * There are no operator commands any longer, so "approve CVE 575" is just language
   * and the agent reads it like anything else.
   */
  it('treats a setup-sounding message as language, not a refusal', async () => {
    await dmService.handle(dm('approve CVE 575'))
    expect(agentCalls.at(-1)).toBe('approve CVE 575')
  })

  it('does not run ordinary registered-user text through timetable parsing', async () => {
    const { timetableService } = await import('../src/services/timetable.service.js')
    vi.mocked(timetableService.read).mockClear()
    timetableRead = {
      kind: 'other',
      unreadable: false,
      entries: [],
      courseKeys: [],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(dm('How many groups are you in?'))
    expect(agentCalls.at(-1)).toBe('How many groups are you in?')
    expect(timetableService.read).not.toHaveBeenCalled()
  })
})

/**
 * One intent can be acted on, so the reply has to name the half it did not do.
 * Silence about the second request reads as not having understood it.
 */
/**
 * People ask for two things at once. Answering one and telling them to ask again for
 * the other is honest, but it still leaves them to ask again — so the second half is
 * routed and acted on in its own right.
 */
describe('replying to a specific alert', () => {
  it('answers about the alert they quoted, not the last thing discussed', async () => {
    conversation = {
      phone: PHONE,
      alerts: [{ waMessageId: 'alert-7', eventId: 'evt-1' }],
      turns: [],
      files: [],
      findings: [],
      updatedAt: new Date(),
    } as unknown as Conversation
    await dmService.handle({ ...dm('is it still holding?'), quotedMessageId: 'alert-7' })

    // The quoted alert becomes the conversation's referent, so the agent's own
    // search resolves "it" against that event rather than the last one discussed.
    expect(conversation!.eventId).toBe('evt-1')
  })

  it('ignores a quote of something that was never an alert', async () => {
    await dmService.handle({ ...dm('what about this?'), quotedMessageId: 'not-an-alert' })
    expect(conversation?.eventId ?? null).toBeNull()
  })
})

describe('reading a photographed timetable', () => {
  const row = (courseKey: string, weekday: number, time: string) => ({
    courseKey,
    course: courseKey,
    kind: 'lecture',
    date: null,
    weekday,
    time,
    venue: null,
    sourceMessageId: 'img-1',
    createdAt: new Date(),
  })

  const photo = (): Message => ({ ...dm(''), type: 'image', transcript: 'Monday CVE 575 8am' })

  it('keeps the schedule even when the model calls it a course list', async () => {
    timetableRead = {
      kind: 'course_list',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00')],
      courseKeys: ['CSC301'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(photo())
    expect(outbox.at(-1)).toMatch(/Is that right\?/)
    expect(conversation?.pendingAction).toBe('confirm_timetable')
  })

  /**
   * The one moment a student is most likely to send a timetable is while registering,
   * and onboarding reads the codes off it and stops — so the grid was thrown away
   * exactly then, and "when is my next class?" answered that it had never seen one.
   */
  it('keeps the schedule from a timetable sent during registration', async () => {
    user = { ...user, onboardingState: 'awaiting_timetable', courseKeys: [] }
    timetableRead = {
      kind: 'class_timetable',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00')],
      courseKeys: ['CSC301'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle({ ...photo(), transcript: 'Monday CSC 301 8am' })
    expect(outbox.at(-1)).toMatch(/Is that right\?/)
    expect(user.onboardingState).toBe('awaiting_timetable_confirmation')
    expect(conversation?.pendingAction).toBe('confirm_timetable')
  })

  it('accepts a timetable typed as text during registration', async () => {
    user = { ...user, onboardingState: 'awaiting_timetable', courseKeys: [] }
    timetableRead = {
      kind: 'class_timetable',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00')],
      courseKeys: ['CSC301'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(dm('CSC 301 — Monday 8am'))
    expect(outbox.at(-1)).toMatch(/Is that right\?/)
    expect(user.onboardingState).toBe('awaiting_timetable_confirmation')
  })

  it('saves a confirmed onboarding timetable and advances to reminder setup', async () => {
    user = { ...user, onboardingState: 'awaiting_timetable', courseKeys: [] }
    timetableRead = {
      kind: 'class_timetable',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00')],
      courseKeys: ['CSC301'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(photo())
    await dmService.handle(dm('yes'))

    expect(user.onboardingState).toBe('awaiting_reminder')
    expect(outbox.at(-1)).toMatch(/Saved 1 timetable item/)
    expect(outbox.at(-1)).toMatch(/When should I remind you/i)
  })

  it('still reads a genuine course list as one', async () => {
    timetableRead = {
      kind: 'course_list',
      unreadable: false,
      entries: [],
      courseKeys: ['MTH101'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(photo())
    expect(outbox.at(-1)).toMatch(/Read that as a course list/)
  })

  /**
   * apply() keeps only rows for courses the student watches, so a first timetable was
   * read correctly, previewed in full, and then stored nothing at all.
   */
  it('starts watching the courses on it', async () => {
    timetableRead = {
      kind: 'class_timetable',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00'), row('PHY102', 2, '10:00')],
      courseKeys: ['CSC301', 'PHY102'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(photo())
    expect(user.courseKeys).toContain('PHY102')
    expect(outbox.at(-1)).toMatch(/added PHY 102 to your courses/i)
  })

  it('says nothing about courses it was already watching', async () => {
    timetableRead = {
      kind: 'class_timetable',
      unreadable: false,
      entries: [row('CSC301', 1, '08:00')],
      courseKeys: ['CSC301'],
      courses: [],
      mismatches: [],
      undated: [],
    }

    await dmService.handle(photo())
    expect(outbox.at(-1)).not.toMatch(/added/i)
  })
})

function pendingGroup(over: Partial<Group> = {}): Group {
  return {
    chatJid: '120363430457309406@g.us',
    name: 'Peermate',
    defaultCourse: null,
    defaultCourseKey: null,
    status: 'pending',
    shardId: 'default',
    addedBy: null,
    addedByName: null,
    participantCount: 2,
    proposedCourse: null,
    proposedBy: null,
    approvedBy: null,
    trustedSenders: [],
    joinedAt: new Date(),
    approvedAt: null,
    ...over,
  }
}

/**
 * What gets agreed here decides where every announcement from that group is filed for
 * the rest of the semester, and the student cannot see what their typed — or
 * photographed — course code became. Reading it back is cheaper than finding out in
 * week six that the alerts went somewhere else.
 */
describe('saying which course a group is for', () => {
  it('reads the pairing back instead of acting on it', async () => {
    pendingGroups = [pendingGroup()]
    const reply = await dmService.proposeGroupCourse(user, 'the group is for Cve 575')

    expect(reply).toMatch(/Peermate.*is the group for \*CVE 575\*/s)
    expect(proposed).toHaveLength(0)
    expect(conversation!.pendingAction).toBe('confirm_group_course')
  })

  it('relays it only once they agree', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for Cve 575')

    await dmService.handle(dm('yes'))

    expect(proposed).toEqual([{ chatJid: '120363430457309406@g.us', course: 'CVE 575' }])
    expect(outbox.at(-1)).toMatch(/not reading it yet/i)
    expect(conversation!.pendingAction).toBeNull()
  })

  it('takes a different code as a correction rather than a refusal', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for Cve 575')

    await dmService.handle(dm('CVE 577'))
    expect(proposed).toHaveLength(0)
    expect(outbox.at(-1)).toMatch(/CVE 577/)

    await dmService.handle(dm('yes'))
    expect(proposed).toEqual([{ chatJid: '120363430457309406@g.us', course: 'CVE 577' }])
  })

  /**
   * The follow-up question has to be recorded too. Clearing the pending action here
   * sent the next message back to the start, so the student was asked a third time
   * instead of being answered.
   */
  it('asks again on a no, and remembers that it asked', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for Cve 575')

    await dmService.handle(dm('no'))
    expect(proposed).toHaveLength(0)
    expect(outbox.at(-1)).toMatch(/which course/i)
    expect(conversation!.pendingAction).toBe('awaiting_group_course')
    expect(conversation!.proposal?.course).toBeNull()
  })

  it('takes the code sent after that no, instead of asking a third time', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for Cve 575')
    await dmService.handle(dm('no'))

    await dmService.handle(dm('CVE 563'))
    expect(outbox.at(-1)).not.toMatch(/which course is/i)
  })

  /** A departmental group carries every course; being asked for one code loops forever. */
  it('accepts a group that is not for any one course', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for Cve 575')
    await dmService.handle(dm('no'))

    await dmService.handle(dm('the group is a general group not for a particular course'))
    expect(proposed.at(-1)?.course).toBeNull()
  })

  /**
   * The question rides alongside the answer. Returning here discarded what the student
   * said, so every message got the group question and nothing else — including
   * "wipe everything about me".
   */
  it('still answers the message it asked the group question on', async () => {
    pendingGroups = [pendingGroup({ addedBy: JID })]
    await dmService.handle(dm('wipe everything about me'))

    expect(outbox.some((line) => /you added me to/i.test(line))).toBe(false)
    expect(agentCalls).toContain('wipe everything about me')
  })

  it('says which group it picked when several are waiting', async () => {
    pendingGroups = [pendingGroup(), pendingGroup({ chatJid: '2@g.us', name: 'Dept Notices' })]
    outbox.push(await dmService.proposeGroupCourse(user, 'the group is for CVE 575'))
    expect(outbox.at(-1)).toMatch(/out of 2 waiting/i)
  })

  it('lets them change the subject instead of answering', async () => {
    pendingGroups = [pendingGroup()]
    await dmService.proposeGroupCourse(user, 'the group is for CVE 575')

    await dmService.handle(dm('when is the test?'))
    expect(agentCalls).toContain('when is the test?')
    expect(proposed).toHaveLength(0)
  })
})

function voiceNote(transcript: string): Message {
  return {
    ...dm(''),
    type: 'audio',
    text: null,
    transcript,
    mediaKey: 'audio/incoming',
    mimeType: 'audio/ogg',
  } as Message
}

/**
 * A DM's content can live entirely in its transcript. This broke once: media was read
 * only on the group branch, so a student's recorded question reached the router as an
 * empty string and was answered as though they had sent nothing.
 */
describe('talking to it with a voice note', () => {
  it('asks a question from the transcript alone', async () => {
    await dmService.handle(voiceNote('When is the CSC 301 test?'))

    // The transcript *is* the message. This broke once: media was read only on the
    // group branch, so a recorded question arrived as an empty string.
    expect(agentCalls).toEqual(['When is the CSC 301 test?'])
  })

  // A spoken instruction used to be claimed by the literal matcher. It is the agent's
  // to read now — it carries it out through update_settings — because matching on
  // shape answered "What course do I have on Tuesday?" with the enrolment list.
  it('hands a command spoken aloud to the agent', async () => {
    await dmService.handle(voiceNote('Pause until Monday.'))
    expect(agentCalls.at(-1)).toMatch(/pause until monday/i)
    expect(user.pausedUntil).toBeNull()
  })

  it('says it could not hear rather than answering an empty question', async () => {
    await dmService.handle({ ...dm(''), type: 'audio', text: null } as Message)
    expect(outbox.at(-1)).toMatch(/couldn't make anything out of that/i)
    expect(answer).not.toHaveBeenCalled()
  })
})

/**
 * A voice note the student cannot see transcribed is a black box. "I'm not sure what
 * you're after" leaves them unable to tell a misunderstood request from a misheard
 * word — and a two-second recording is far more often the latter.
 */
