import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/models/index.js'
import { calendarWindow } from '../src/utils/dates.js'

vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))

const { extractionService } = await import('../src/services/extraction.service.js')

/**
 * Nigerian class groups do not speak one language.
 *
 * Pidgin is English-lexified and the date rules read it correctly — verified against
 * real audio. Yoruba is a different matter: it transcribes cleanly and then produces
 * a confidently wrong date, because the weekday rules only recognise words they were
 * built for. These tests are about not asserting what cannot be checked.
 */

function spoken(transcript: string): Message {
  return {
    waMessageId: 'm1',
    chatJid: '111@g.us',
    senderName: 'Chidi',
    fromGroup: true,
    timestamp: new Date('2026-09-14T09:00:00Z'),
    type: 'audio',
    text: null,
    caption: null,
    transcript,
    transcriptConfidence: 0.95,
  } as Message
}

const announced = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'announcement' as const,
    announcements: [
      {
        course: 'CVE 575',
        scope: 'course' as const,
        eventType: 'test' as const,
        title: 'test',
        originalDateText: 'Thursday',
        date: '2026-09-17',
        time: '16:00',
        venue: 'NLNG Lecture Theatre',
        confidence: 1,
        ...over,
      },
    ],
  }) as never

describe('Pidgin is read as the English it is built on', () => {
  it('keeps a date said in Pidgin at full confidence', () => {
    const [row] = extractionService.toRows(
      spoken('The CVE 575 test wey dem schedule for Monday don shift to next week Thursday 4pm'),
      announced({ originalDateText: 'next week Thursday' }),
      'CVE 575',
    )

    expect(row!.date).toBe('2026-09-17')
    expect(row!.confidence).toBeCloseTo(0.95, 2)
  })
})

describe('a language the date rules cannot check', () => {
  /**
   * Measured, not hypothetical: "ọjọ́bọ̀" — Thursday — came back as Tuesday, then
   * Wednesday, at confidence 1.0 each time.
   */
  it('caps confidence when nothing can check the date', () => {
    const [row] = extractionService.toRows(
      spoken('Ẹ kú àárọ̀ ìdánwò CVE 575 tí wọ́n ti ṣètò fún ọ̀la tí yí padà.'),
      announced({ originalDateText: 'ọ̀la' }),
      'CVE 575',
    )

    expect(row!.confidence).toBeLessThanOrEqual(0.3)
  })

  /**
   * The ordinary case, and the reason the cap is not simply "is this Yoruba".
   * Weekdays are said in English even inside a Yoruba sentence, and when one is
   * named the date has already been checked against it deterministically — there is
   * nothing left to be unsure about, and capping it would send a real announcement
   * to triage for being *phrased* in Yoruba.
   */
  it('trusts a Yoruba sentence whose weekday is in English', () => {
    const [row] = extractionService.toRows(
      spoken('Ẹ kú àárọ̀ ìdánwò CVE 575 tí wọ́n ti ṣètò, ó di Thursday 4pm.'),
      announced({ originalDateText: 'Thursday' }),
      'CVE 575',
    )

    expect(row!.date).toBe('2026-09-17')
    expect(row!.confidence).toBeCloseTo(0.95, 2)
  })

  it('still rejects a wrong date even when the weekday is in English', () => {
    const now = new Date('2026-09-14T09:00:00Z')
    const checked = extractionService.rejectInventedDates(
      announced({ originalDateText: 'Thursday', date: '2026-09-15' }),
      calendarWindow(now, 'Africa/Lagos'),
      'm1',
      now,
    )

    // 15 September is a Tuesday. Said in English inside a Yoruba sentence or not,
    // a Thursday has to be a Thursday.
    expect(checked.announcements[0]!.date).toBeNull()
  })

  it('keeps the right weekday, whatever the sentence around it', () => {
    const now = new Date('2026-09-14T09:00:00Z')
    const checked = extractionService.rejectInventedDates(
      announced({ originalDateText: 'Thursday', date: '2026-09-17' }),
      calendarWindow(now, 'Africa/Lagos'),
      'm1',
      now,
    )

    expect(checked.announcements[0]!.date).toBe('2026-09-17')
  })

  it('still keeps the venue and time, which are not in doubt', () => {
    const [row] = extractionService.toRows(
      spoken('Ẹ kú àárọ̀ ìdánwò CVE 575 ní ọjọ́bọ̀ ní àago mẹ́rin ìrọ̀lẹ́.'),
      announced(),
      'CVE 575',
    )

    expect(row!.venue).toBe('NLNG Lecture Theatre')
    expect(row!.time).toBe('16:00')
  })

  /** A stray character is a name or a typo, not another language. */
  it('does not mistake one accented word for a whole language', () => {
    const [row] = extractionService.toRows(
      spoken('The CVE 575 test is on Thursday, ask Ṣola if you miss it'),
      announced(),
      'CVE 575',
    )

    expect(row!.confidence).toBeCloseTo(0.95, 2)
  })

  it('leaves a typed English message alone entirely', () => {
    const typed = { ...spoken('x'), type: 'text', transcript: null, transcriptConfidence: null }
    const [row] = extractionService.toRows(typed as Message, announced(), 'CVE 575')

    expect(row!.confidence).toBe(1)
  })
})
