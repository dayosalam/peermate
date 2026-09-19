import { describe, expect, it } from 'vitest'
import { closestNamed, similarity, CLOSE_ENOUGH } from '../src/utils/similarity.js'

describe('putting a name to a group a student half-remembers', () => {
  it('matches a name typed the way people actually type it', () => {
    expect(similarity('Engineering 400 Level', 'Engineeering 400Leve')).toBeGreaterThan(
      CLOSE_ENOUGH,
    )
    expect(similarity('cve 575 class', 'CVE575 Class')).toBeGreaterThan(CLOSE_ENOUGH)
  })

  /** The name is read back to them, so a loose match would name a group they are not in. */
  it('refuses a vague guess', () => {
    expect(similarity('group', 'Engineering 400 Level')).toBeLessThan(CLOSE_ENOUGH)
    expect(similarity('the group', 'CVE 575 Class Group')).toBeLessThan(CLOSE_ENOUGH)
  })

  it('does not confuse two cohorts of the same department', () => {
    const groups = [{ name: 'Engineering 300 Level' }, { name: 'Engineering 400 Level' }]
    expect(closestNamed('engineering 400 level', groups)?.name).toBe('Engineering 400 Level')
  })

  it('answers nothing rather than the least bad option', () => {
    expect(closestNamed('physics tutorial', [{ name: 'Engineering 400 Level' }])).toBeNull()
  })

  it('ignores a group whose name was never recorded', () => {
    expect(closestNamed('anything', [{ name: null }])).toBeNull()
  })
})
