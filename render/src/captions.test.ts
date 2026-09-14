import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cues } from './captions.js'

const LONG =
  'Normalisation is how you organise a table so that the same fact is not written down twice, which matters when the data changes.'

describe('splitting narration into captions', () => {
  it('gives each sentence its own cue', () => {
    const result = cues('Shear force acts parallel. It is the derivative.', 10)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.lines.join(' '), 'Shear force acts parallel.')
  })

  it('spends the whole scene and no more', () => {
    const result = cues('One sentence here. A second one. And a third.', 12)
    const total = result.reduce((sum, cue) => sum + cue.seconds, 0)
    assert.ok(Math.abs(total - 12) < 0.001, `got ${total}`)
  })

  /** A long sentence takes longer to say, so it holds the screen longer. */
  it('gives the longer line the longer slice', () => {
    const [short, long] = cues('Short one. A considerably longer sentence than that one.', 10)
    assert.ok(long!.seconds > short!.seconds)
  })

  it('breaks a long sentence into several cues', () => {
    const result = cues(LONG, 10)
    assert.ok(result.length > 1)
  })

  /**
   * The regression this exists for: wrapping truncated a chunk to two lines, so the
   * overflow was dropped while the narration still said it. A caption that silently
   * differs from the audio is worse than no caption.
   */
  it('shows every word that is spoken', () => {
    const shown = cues(LONG, 10).flatMap((cue) => cue.lines.join(' ').split(/\s+/))
    assert.deepEqual(shown, LONG.split(/\s+/))
  })

  /** A single word alone on screen for half a second reads as a flicker. */
  it('does not leave an orphan word in a cue of its own', () => {
    for (const cue of cues(LONG, 10)) {
      assert.ok(cue.lines.join(' ').split(/\s+/).length > 2, cue.lines.join(' '))
    }
  })

  /** Two lines is what fits at a readable size; a third would be a paragraph. */
  it('never returns more than two lines in one cue', () => {
    for (const cue of cues('A sentence long enough to need wrapping across several lines.', 10)) {
      assert.ok(cue.lines.length <= 2)
    }
  })

  it('returns nothing for nothing, rather than dividing by zero', () => {
    assert.deepEqual(cues('   ', 10), [])
  })
})
