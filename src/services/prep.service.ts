import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Quiz, QuizQuestion, User } from '../models/index.js'
import { attemptRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { getOpenAI } from './openai.client.js'
import { researchService, type Reading } from './research.service.js'
import { retrievalService, type Candidate } from './retrieval.service.js'
import { format, sample } from './material.js'

const PrepSchema = z.object({
  /** What the material actually covers, in the student's own syllabus terms. */
  topics: z.array(z.string()),
  questions: z.array(
    z.object({
      question: z.string(),
      /** Short enough to read on a phone — two or three lines. */
      answer: z.string(),
      /**
       * One of the topics above, verbatim.
       *
       * This is what makes a wrong answer mean something later: without it a score
       * says only that a session went badly, never which part of the syllabus to go
       * back to.
       */
      topic: z.string(),
      /** "CVE575-lecture3.pdf, p.4". Null when it came from across several places. */
      source: z.string().nullable(),
    }),
  ),
})

const MarkSchema = z.object({
  verdict: z.enum(['right', 'close', 'wrong']),
  /** One or two lines: what was missing, or what they got right. */
  comment: z.string(),
})

const SYSTEM = `You prepare a Nigerian university student for a test, using ONLY the course material provided.

Rules:
- Every question and every answer must be answerable from the provided material. Never test them on something that is not in it.
- Prefer what looks like a past question paper: those are what the real test looks like. Otherwise build questions from the headings, definitions and worked examples in the notes.
- Write questions the way a lecturer in this course would write them — "Define...", "State two...", "Derive...", "With a diagram, explain..." — not multiple choice unless the material itself is multiple choice.
- Keep each answer to two or three lines. This is revision on a phone, not a textbook.
- Cite the file and page an answer came from, exactly as given in the excerpt header.
- If the material is thin, return fewer questions rather than inventing more. Six good questions beat twelve guesses.
- Topics are what the material covers, in the student's own words — "shear force diagrams", "soil classification" — never "Chapter 3".`

const MARK_SYSTEM = `You mark one short answer from a university student, generously but honestly.

- "right" means they have the substance, even if the wording is loose or the spelling is wrong.
- "close" means they have part of it or the right idea with a real gap.
- "wrong" means they have not got it, or they said they do not know.
- The comment is one or two lines, spoken to them directly. Say what was missing. Never be sarcastic and never pad it with praise they did not earn.`

/**
 * Revision built from the files people actually shared.
 *
 * Peermate already holds the slides and past papers — they are read, chunked and
 * indexed for answering questions. The same material answers a bigger one: "am I
 * ready?". Nothing here invents content; a course with no files gets told so.
 */
export class PrepService {
  /**
   * A study brief: what the material covers, and questions likely to be asked.
   *
   * Returns null when there is nothing to build it from, so the caller can say what
   * is missing rather than produce a confident-looking page of invented questions.
   */
  async brief(user: User, courseKey: string): Promise<{ text: string; quiz: Quiz } | null> {
    const material = await retrievalService.material(courseKey, user.groupJids)
    const readable = material.filter((chunk) => chunk.readVia !== 'none')
    if (readable.length === 0) return null

    const prep = await this.build(readable, courseKey)
    if (!prep || prep.questions.length === 0) return null

    const course = courseDisplay(courseKey) ?? courseKey
    // Only the topics the files themselves raised are ever searched. The web widens
    // the explanation of what is on the syllabus; it must not widen the syllabus.
    const reading = await researchService.readingFor(prep.topics, course)
    const files = new Set(readable.map((chunk) => chunk.fileName).filter(Boolean))
    const unreadable = material.filter((chunk) => chunk.readVia === 'none')

    const lines = [
      `📚 *Prep for ${course}*`,
      `_From ${files.size} file${files.size === 1 ? '' : 's'} shared in your group._`,
      '',
      '*What the material covers*',
      ...prep.topics.slice(0, 8).map((topic) => `• ${topic}`),
      '',
      '*Likely questions*',
      ...prep.questions.map((item, index) => `${index + 1}. ${item.question}`),
    ]

    if (reading.length > 0) {
      lines.push('', '*Going deeper* _(from the web, not from your files)_', ...describe(reading))
    }

    if (unreadable.length > 0) {
      const names = [...new Set(unreadable.map((chunk) => chunk.fileName).filter(Boolean))]
      lines.push(
        '',
        `_I'm also holding ${names.length} file${names.length === 1 ? '' : 's'} I couldn't read (${names.join(', ')}) — ask and I'll send ${names.length === 1 ? 'it' : 'them'} over._`,
      )
    }

    lines.push('', `Send *quiz me* and I'll ask them one at a time and mark your answers.`)

    return {
      text: lines.join('\n'),
      quiz: { courseKey, questions: prep.questions, index: 0, right: 0 },
    }
  }

  /** The first question, once they have said they want to be asked. */
  ask(quiz: Quiz): string {
    const current = quiz.questions[quiz.index]
    if (!current) return this.score(quiz)

    const course = courseDisplay(quiz.courseKey) ?? quiz.courseKey
    return `*${course} — question ${quiz.index + 1} of ${quiz.questions.length}*

${current.question}

_Type your answer, or *skip*. Send *stop* to end._`
  }

  /**
   * Marks an answer and moves on.
   *
   * The right answer is shown either way. Being told only "wrong" is the one outcome
   * that teaches nothing, and a student revising alone has nowhere else to look.
   */
  async mark(quiz: Quiz, said: string, phone?: string): Promise<{ reply: string; next: Quiz }> {
    const current = quiz.questions[quiz.index]
    if (!current) return { reply: this.score(quiz), next: quiz }

    const skipped = /^(skip|next|pass|i don'?t know|idk|dunno)\b/i.test(said.trim())
    const verdict = skipped ? null : await this.judge(current, said)
    // judge() returns null when the call failed, which is not the same as a wrong
    // answer and must not be shown as one — a student revising alone has no way to
    // tell the two apart, and being wrongly marked wrong is worse than being told
    // the marking broke.
    const unmarked = !skipped && !verdict

    const next: Quiz = {
      ...quiz,
      index: quiz.index + 1,
      // A close answer is most of the way there, and scoring it zero tells them they
      // know less than they do.
      right:
        quiz.right + (verdict?.verdict === 'right' ? 1 : verdict?.verdict === 'close' ? 0.5 : 0),
    }

    // Recorded before the reply is built: the quiz object expires with the
    // conversation, so an answer not written down now is gone for good.
    if (phone && !unmarked) {
      await attemptRepository
        .record([
          {
            phone,
            courseKey: quiz.courseKey,
            topic: current.topic || 'general',
            question: current.question,
            verdict: skipped ? 'skipped' : (verdict?.verdict ?? 'wrong'),
            at: new Date(),
          },
        ])
        .catch((error) => logger.warn({ err: error }, 'could not record a quiz attempt'))
    }

    const head = skipped
      ? '⏭️ *Skipped*'
      : unmarked
        ? '⚠️ *I could not mark that one*'
        : verdict?.verdict === 'right'
          ? '✅ *Right*'
          : verdict?.verdict === 'close'
            ? '🟡 *Close*'
            : '❌ *Not quite*'

    const body = [
      head,
      verdict?.comment ?? '',
      '',
      `*Answer:* ${current.answer}`,
      current.source ? `_${current.source}_` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const more =
      next.index < next.questions.length
        ? `\n\n———\n\n${this.ask(next)}`
        : `\n\n${this.score(next)}`
    return { reply: `${body}${more}`, next }
  }

  /** How it went, said plainly. A score nobody asked for is still the point of a quiz. */
  score(quiz: Quiz): string {
    const asked = Math.min(quiz.index, quiz.questions.length)
    const course = courseDisplay(quiz.courseKey) ?? quiz.courseKey
    if (asked === 0)
      return `Stopped. Send *prep me for ${course}* whenever you want to pick it up again.`

    // A half comes from a "close" answer, so print 3.5 rather than rounding away the
    // difference between four right and three-and-a-near-miss.
    const scored = Number.isInteger(quiz.right) ? String(quiz.right) : quiz.right.toFixed(1)
    return `*Done — ${scored} of ${asked} right.*

${quiz.right === asked ? "That's the lot. You're ready." : "Go back over the ones you missed — ask me for the files and I'll send them."}`
  }

  /**
   * Where to start, ranked worst first.
   *
   * Deliberately not a study plan with dates. A schedule Peermate invents is a
   * schedule nobody keeps, and the moment one session is missed the whole thing is
   * wrong and has to be apologised for. A ranked list of what they are actually weak
   * at is smaller, always true, and is the part a student would have worked out for
   * themselves anyway.
   *
   * Topics decay as they improve: a subject answered right three times running stops
   * being the thing shown first, without ever being declared finished.
   */
  async weakTopics(
    phone: string,
    courseKey: string,
    limit = 5,
  ): Promise<Array<{ topic: string; asked: number; right: number }>> {
    const attempts = await attemptRepository.forCourse(phone, courseKey)
    if (attempts.length === 0) return []

    const tally = new Map<string, { asked: number; right: number }>()
    for (const attempt of attempts) {
      const seen = tally.get(attempt.topic) ?? { asked: 0, right: 0 }
      seen.asked += 1
      if (attempt.verdict === 'right') seen.right += 1
      else if (attempt.verdict === 'close') seen.right += 0.5
      tally.set(attempt.topic, seen)
    }

    return [...tally.entries()]
      .map(([topic, seen]) => ({ topic, ...seen }))
      .sort((a, b) => a.right / a.asked - b.right / b.asked || b.asked - a.asked)
      .slice(0, limit)
  }

  /** How they are doing in one course, in a line they can read. */
  async progress(phone: string, courseKey: string): Promise<string | null> {
    const attempts = await attemptRepository.forCourse(phone, courseKey)
    if (attempts.length === 0) return null

    const course = courseDisplay(courseKey) ?? courseKey
    const right = attempts.filter((item) => item.verdict === 'right').length
    const weak = await this.weakTopics(phone, courseKey, 3)

    const lines = [
      `*${course}* — ${right} of ${attempts.length} right across ${attempts.length} question${attempts.length === 1 ? '' : 's'}.`,
    ]
    if (weak.length > 0 && weak[0]!.right / weak[0]!.asked < 1) {
      lines.push('', '*Worth going back over:*')
      for (const topic of weak) {
        if (topic.right / topic.asked >= 1) continue
        lines.push(`• ${topic.topic} — ${topic.right} of ${topic.asked}`)
      }
    }
    return lines.join('\n')
  }

  private async build(
    material: Candidate[],
    courseKey: string,
  ): Promise<z.infer<typeof PrepSchema> | null> {
    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.answerModel,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `Course: ${courseDisplay(courseKey) ?? courseKey}

Build 6 to 8 questions. Give each one a "topic" copied exactly from the topics list you return, so a wrong answer names the part of the syllabus to go back to.

Material:
${format(sample(material))}`,
          },
        ],
        response_format: zodResponseFormat(PrepSchema, 'prep'),
      })
      return completion.choices[0]?.message.parsed ?? null
    } catch (error) {
      logger.error({ err: error, courseKey }, 'could not build prep')
      return null
    }
  }

  private async judge(
    question: QuizQuestion,
    said: string,
  ): Promise<z.infer<typeof MarkSchema> | null> {
    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.answerModel,
        messages: [
          { role: 'system', content: MARK_SYSTEM },
          {
            role: 'user',
            content: `Question: ${question.question}\nCorrect answer: ${question.answer}\nWhat they said: ${said}`,
          },
        ],
        response_format: zodResponseFormat(MarkSchema, 'mark'),
      })
      return completion.choices[0]?.message.parsed ?? null
    } catch (error) {
      logger.error({ err: error }, 'could not mark answer')
      return null
    }
  }
}

/**
 * The reading list, grouped by the topic that prompted it.
 *
 * Marked as web material throughout. A student revising has to know which lines came
 * from their lecturer's notes and which came from a stranger's blog, because only one
 * of those is what they will be tested on.
 */
function describe(reading: Reading[]): string[] {
  const byTopic = new Map<string, Reading[]>()
  for (const item of reading) byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item])

  return [...byTopic].flatMap(([topic, items]) => [
    `_${topic}_`,
    ...items.map((item) => `• ${item.title}\n  ${item.url}`),
  ])
}

export const prepService = new PrepService()
