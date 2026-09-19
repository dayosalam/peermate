import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocType, Resource } from '../src/models/index.js'

vi.mock('../src/repositories/index.js', () => ({
  userRepository: { forCourse: vi.fn(async () => []) },
  resourceRepository: { recent: vi.fn(async () => []) },
}))
vi.mock('../src/services/delivery.service.js', () => ({
  deliveryService: { send: vi.fn(async () => true) },
}))

let videoEnabled = true
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      render: {
        ...actual.config.render,
        get enabled() {
          return videoEnabled
        },
      },
    },
  }
})

const { ResourceAlertService } = await import('../src/services/resource-alert.service.js')
const service = new ResourceAlertService()

const format = (courseKey: string, resources: Resource[]): string =>
  (Reflect.get(service, 'format') as (key: string, batch: Record<string, unknown>) => string).call(
    service,
    courseKey,
    {
      courseKey,
      chatJid: 'g1@g.us',
      resources,
      senders: new Set(['Dr Bello']),
    },
  )

function file(over: Partial<Resource> = {}): Resource {
  return {
    fileName: 'CVE575_wk4.pdf',
    mediaKey: 'doc/wk4',
    mimeType: 'application/pdf',
    docType: 'slides' as DocType,
    courseKey: 'CVE575',
    chatJid: 'g1@g.us',
    ...over,
  } as Resource
}

describe('offering a walkthrough of new material', () => {
  beforeEach(() => {
    videoEnabled = true
  })

  /** The tool is filtered out when video is off, so an offer would promise nothing. */
  it('says nothing at all while the video path is switched off', () => {
    videoEnabled = false
    expect(format('CVE575', [file()])).not.toContain('short video')
  })

  /** Nobody asks a WhatsApp bot for a video unprompted; this is how it is discovered. */
  it('offers one when the lecturer posts slides', () => {
    expect(format('CVE575', [file()])).toContain('short video')
  })

  it('offers nothing for a photographed notice', () => {
    const photo = file({ fileName: 'notice.jpg', mimeType: 'image/jpeg', docType: 'other' })
    expect(format('CVE575', [photo])).not.toContain('short video')
  })

  /** A PDF that is an assignment is work to hand in, not material to be taught from. */
  it('offers nothing for an assignment brief', () => {
    expect(format('CVE575', [file({ docType: 'assignment' })])).not.toContain('short video')
  })

  it('still offers when only some of the batch is worth explaining', () => {
    const mixed = [file({ docType: 'assignment' }), file({ fileName: 'wk5.pdf' })]
    expect(format('CVE575', mixed)).toContain('short video')
  })
})
