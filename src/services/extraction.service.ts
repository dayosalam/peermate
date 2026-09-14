import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { ExtractionFailed } from '../core/errors.js'
import { logger } from '../core/logger.js'
import type { Authority, Extraction, Message } from '../models/index.js'
import { EventType } from '../models/index.js'
import {
  calendarWindow,
  isOfferedDate,
  isoFromAnswer,
  isPlausibleAbsoluteDate,
  weekdayAgrees,
  weekdayNamedIn,
  type CalendarDay,
} from '../utils/dates.js'
import { courseKey } from '../utils/courses.js'
import { getOpenAI } from './openai.client.js'

/**
 * The LLM-facing schema. Structured outputs run in strict mode, where every property
 * must be present — so absence is expressed as null, never as an omitted or optional
 * field. Same shape as models/extraction.ts, minus the defaults.
 */
const LlmAnnouncement = z.object({
  course: z.string().nullable(),
  scope: z.enum(['course', 'department']),
  eventType: EventType,
  title: z.string().nullable(),
  originalDateText: z.string().nullable(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  venue: z.string().nullable(),
  confidence: z.number(),
})

const LlmExtraction = z.object({
  kind: z.enum(['announcement', 'question', 'noise']),
  announcements: z.array(LlmAnnouncement),
})

type LlmExtraction = z.infer<typeof LlmExtraction>

/**
 * What the extractor is allowed to see besides the message itself. Captions and
 * quoted messages travel with the source; the preceding window is only used to tag
 * documents whose filename says nothing.
 */
export interface ExtractionContext {
  defaultCourse: string | null
  quotedText?: string | null
  precedingTexts?: string[]
}

function systemPrompt(window: CalendarDay[], context: ExtractionContext): string {
  const today = window[1] ?? window[0]!
  const calendar = window.map((day) => `  ${day.label}`).join('\n')

  return `You read messages from Nigerian university course group chats and decide whether each one is an announcement students need to know about.

Decide "kind" FIRST, before considering any event details:
- "announcement": states a test, assignment, lecture, meeting, venue change or deadline that students must act on.
- "question": someone asking about one.
- "noise": greetings, banter, thanks, reactions, or anything with no actionable event. Most messages are noise.

If kind is not "announcement", return an empty announcements array.

One message can contain SEVERAL announcements — a photographed timetable or a long voice note often carries a week of them. Return one entry per distinct event.

DATES. Today is ${today.label} in ${config.digest.timezone}. These are the only dates you may use:
${calendar}

For anything said in RELATIVE terms — "Friday", "tomorrow", "next week Tuesday" — pick the matching line from that list and return ONLY its YYYY-MM-DD part, not the weekday in front of it. Never calculate a weekday yourself.

If instead the message states a date OUTRIGHT — "15 October", "20/11/2026", "the 3rd of March" — write that date as YYYY-MM-DD even though it is not in the list above, using the current year unless the message says otherwise.

If you cannot tell which day is meant, return null for "date". Always keep the speaker's own wording in "originalDateText".

Other rules:
- "time" is 24-hour HH:MM.
- Use "cancelled" when a message says something is NOT happening — "no lecture today", "the test has been called off", "class is cancelled". Fill in the course, date and time of the thing being cancelled, not of the message. Never file a cancellation as a lecture or a test: that records the opposite of what was said.
- "title" is what the thing is called, in the speaker's own words and at most a few words — "bridge design report", "week 3 quiz", "site visit". It is how two assignments for one course are told apart, so take it from the message rather than inventing a label. Return null when the message names no such thing.
- ${context.defaultCourse ? `This group is for ${context.defaultCourse}; use that as the course unless the message clearly names a different one.` : 'This group has no default course, so the message must name the course itself. If it does not, return null for "course".'}
- "scope" is "course" for anything about one course, even when you cannot tell which. Use "department" ONLY when the announcement applies to every student regardless of what they study — "no lectures on Friday", "resumption is Monday", "the fees deadline is the 15th", "the department meeting is at 10". A department-wide announcement has no course, so return null for "course".
- Null over guessing. If a venue, date or time is not stated, it is null. Never invent one.
- A filename is not an announcement. Never infer an event from what a file might contain, or from its name.
- Everything you report must be traceable to words actually present. If you cannot point at the phrase that states it, it is not there.
- "confidence" is 0..1 for how certain you are this is a real, current announcement.

The messages mix English, Nigerian Pidgin and sometimes Yoruba, Hausa or Igbo, and often code-switch mid-sentence. Read for meaning, not grammar. Weekdays are usually said in English even inside a sentence in another language — when one is, copy it into "originalDateText" exactly as they said it, because that is what the date is checked against. Yoruba weekdays, when they do appear: ọjọ́ Àìkú Sunday, ọjọ́ Ajé Monday, ọjọ́ Ìṣẹ́gun Tuesday, ọjọ́rú Wednesday, ọjọ́bọ̀ Thursday, ọjọ́ Ẹtì Friday, Àbámẹ́ta Saturday.`
}

export class ExtractionService {
  /** One call per message. Returns the raw verdict; the caller decides what to store. */
  async classify(message: Message, context: ExtractionContext): Promise<LlmExtraction> {
    const content = this.readableContent(message, context)
    if (!content) return { kind: 'noise', announcements: [] }

    const window = calendarWindow(message.timestamp, config.digest.timezone)

    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.extractionModel,
        messages: [
          { role: 'system', content: systemPrompt(window, context) },
          { role: 'user', content },
        ],
        response_format: zodResponseFormat(LlmExtraction, 'extraction'),
      })
      const parsed = completion.choices[0]?.message.parsed
      if (!parsed) throw new Error('model returned no parsed content')

      const checked = this.rejectInventedDates(
        parsed,
        window,
        message.waMessageId,
        message.timestamp,
      )
      logger.debug(
        {
          waMessageId: message.waMessageId,
          kind: checked.kind,
          count: checked.announcements.length,
        },
        'extracted',
      )
      return checked
    } catch (error) {
      throw new ExtractionFailed(`extraction failed for ${message.waMessageId}`, error)
    }
  }

  /**
   * Each announcement becomes its own row sharing the source message's provenance.
   * They are never merged into one summary record — see PRD §8.
   */
  toRows(
    message: Message,
    result: LlmExtraction,
    fallbackCourse: string | null,
    authority: Authority = 'student',
  ): Extraction[] {
    if (result.kind !== 'announcement') return []
    return result.announcements.map((raw, index) => {
      const announcement = this.blankToNull(raw)
      return {
        ...announcement,
        // `||`, not `??`: the model returns "" as often as null for an absent course,
        // and `"" ?? fallback` is "" — which silently defeats the group default.
        // A department-wide notice has no course by definition, so the group default
        // must not be stamped onto it — that would narrow it to one course's students.
        course: announcement.scope === 'department' ? null : announcement.course || fallbackCourse,
        courseKey:
          announcement.scope === 'department'
            ? null
            : courseKey(announcement.course || fallbackCourse),
        // A claim is only ever as good as the hearing it rests on. A confidently
        // extracted date taken from a badly heard recording reads as certain to the
        // student and is not, so the doubt travels with it rather than being lost at
        // the boundary between the two models.
        confidence: heardConfidence(
          announcement.confidence,
          message,
          announcement.originalDateText,
        ),
        eventId: `${message.waMessageId}:${index}`,
        authority,
        corroboratedBy: [],
        supersededBy: null,
        sourceMessageId: message.waMessageId,
        chatJid: message.chatJid,
        extractedAt: new Date(),
      }
    })
  }

  /**
   * "Null over guessing" only holds if absence is actually null.
   *
   * Structured outputs make every field required, so a model with nothing to say
   * fills it with a placeholder — "/", "-", "N/A", "TBD" — which then reaches a
   * student as a venue. Treat those as the nulls they are.
   */
  private blankToNull<T extends Record<string, unknown>>(row: T): T {
    const PLACEHOLDER = /^(|[-/.]|n\/?a|tbd|tba|none|null|unknown|not specified)$/i
    const cleaned: Record<string, unknown> = { ...row }
    for (const field of ['course', 'venue', 'time', 'originalDateText', 'date']) {
      const value = cleaned[field]
      if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) cleaned[field] = null
    }
    return cleaned as T
  }

  /**
   * A date the model wrote rather than chose is dropped; the wording survives for the
   * citation.
   *
   * Public because it is the guard that stops a wrong test date reaching a whole
   * class, and a guard nothing can test directly is a guard nobody trusts.
   */
  rejectInventedDates(
    result: LlmExtraction,
    window: CalendarDay[],
    waMessageId: string,
    now: Date,
  ): LlmExtraction {
    return {
      ...result,
      announcements: result.announcements.map((announcement) => {
        if (announcement.date === null) return announcement

        // The calendar is offered as labels, so "Tue 2026-09-22" is a correct answer
        // to "copy the date from that list" — but only the ISO part may be stored.
        const date = isoFromAnswer(announcement.date)

        // A weekday is deterministic and needs no calendar: if they said Thursday,
        // the date has to be a Thursday. This is the guard that was missing — the
        // model answered "next two weeks Thursday" with a Tuesday, at confidence 1.0,
        // and every other check waved it through because the date itself was valid.
        if (!weekdayAgrees(date, announcement.originalDateText)) {
          logger.warn(
            { waMessageId, date, said: announcement.originalDateText },
            'model returned a date on the wrong weekday, dropping it',
          )
          return { ...announcement, date: null }
        }

        // Either it chose from the calendar, or it read an explicit date off the
        // message. Anything else is arithmetic the model is not trusted to do.
        //
        // The absolute-date allowance is only for a date somebody actually stated —
        // "15 October". Applied to a relative phrase it defeats the whole guard,
        // because any well-formed date inside a year passes it.
        if (
          isOfferedDate(date, window) ||
          (statesADate(announcement.originalDateText) && isPlausibleAbsoluteDate(date, now))
        ) {
          return { ...announcement, date }
        }

        logger.warn(
          { waMessageId, date: announcement.date, said: announcement.originalDateText },
          'model invented a date outside the offered calendar, dropping it',
        )
        return { ...announcement, date: null }
      }),
    }
  }

  /**
   * What the extractor is allowed to read.
   *
   * Context — a quoted message, the messages before a file — only ever *supports* a
   * body. It is never the body itself, and a message with none returns null and is
   * treated as noise.
   *
   * This is not a technicality. Given only "Attached document: CVE575_ClassNotes.pdf"
   * and a group whose course is CVE 575, the model confabulated "CVE 575 test,
   * tomorrow 4pm" at 0.9 confidence, and once gave the venue as "/dev/null". A
   * filename is a name; a model asked to find an event in one will invent it.
   */
  private readableContent(message: Message, context: ExtractionContext): string | null {
    const body = [message.text, message.caption, message.transcript]
      .filter(Boolean)
      .join('\n\n')
      .trim()

    // Nobody said anything. The file is still filed and still read by
    // DocumentReader — there is simply no announcement in it to find.
    if (!body) return null

    const preamble: string[] = []
    if (context.precedingTexts?.length) {
      preamble.push(
        `Earlier in this group:\n${context.precedingTexts.map((t) => `- ${t}`).join('\n')}`,
      )
    }
    if (context.quotedText) {
      // For "No, it is LG8" the quoted message is the only thing that carries the subject.
      preamble.push(`This message replies to:\n"${context.quotedText}"`)
    }
    if (message.fileName) {
      preamble.push(`This was sent with a file attached, named: ${message.fileName}`)
    }

    return [...preamble, body].filter(Boolean).join('\n\n').trim() || null
  }
}

export const extractionService = new ExtractionService()

/**
 * The extractor's certainty, discounted by how well the words were heard.
 *
 * Only for audio: text and captions arrive exactly as written, so there is nothing to
 * discount. A null transcript confidence means the API did not report one, which is
 * not evidence of a bad hearing and must not be treated as such.
 */
function heardConfidence(stated: number, message: Message, said: string | null): number {
  const heard =
    message.type !== 'audio' || message.transcriptConfidence === null
      ? stated
      : stated * message.transcriptConfidence

  // A date read out of a language Peermate cannot check is not a date it should
  // assert.
  //
  // The weekday guard is deterministic only for words it recognises, and a Yoruba
  // weekday transcribes three different ways — ọjọ́bọ̀, ojúbọ̀, ọjọ́ bọ̀ — so a word
  // list catches some spellings and waves the rest through *silently*, which is
  // worse than not checking at all. Measured on the real thing: "ọjọ́bọ̀" (Thursday)
  // came back as Tuesday, then Wednesday, at confidence 1.0 each time.
  //
  // So the confidence is capped rather than the date guessed at. It still reaches a
  // student, still carries the venue and time — but as something to check, and a
  // dated one goes to the operator instead of to forty people.
  // If they named a weekday, the date has already been checked against it — and
  // weekdays are said in English even inside a Yoruba sentence, which is the ordinary
  // case rather than the exception. Capping those would send real announcements to
  // triage for being *phrased* in Yoruba while their date was fully verifiable.
  if (weekdayNamedIn(said) !== null) return heard

  // Nothing left to check it with. A relative term in a language the date rules were
  // not built for — ọ̀la, ọ̀túnla — resolves by the model's own reckoning, which is
  // the arithmetic the calendar exists to prevent.
  return looksYoruba(message.transcript) ? Math.min(heard, 0.3) : heard
}

/**
 * Characters that only appear in Yoruba orthography, not in English or Pidgin.
 *
 * Deliberately a script test rather than a language classifier: it asks "is this
 * written in something the date rules were built for", which is the question that
 * matters, and it cannot be wrong about English.
 */
const YORUBA_LETTERS = /[ọẹṣ]/iu

function looksYoruba(transcript: string | null): boolean {
  if (!transcript) return false
  const marked = [...transcript].filter((letter) => YORUBA_LETTERS.test(letter)).length
  // A stray character is a typo or a name; a sentence of them is another language.
  return marked >= 3
}

/**
 * Did the speaker state a date outright, rather than point at one?
 *
 * "15 October", "20/11/2026", "the 3rd of March" are dates. "Friday", "tomorrow",
 * "next two weeks Thursday" are directions to a date, and resolving those is exactly
 * the arithmetic the calendar exists to prevent the model from doing.
 */
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i
const NUMERIC_DATE = /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/

function statesADate(said: string | null | undefined): boolean {
  if (!said) return false
  return MONTHS.test(said) || NUMERIC_DATE.test(said)
}
