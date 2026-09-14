import { describe, expect, it } from 'vitest'
import {
  calendarWindow,
  formatTime12,
  isOfferedDate,
  todayIso,
  weekdayAgrees,
  weekdayNamedIn,
  zonedDay,
} from '../src/utils/dates.js'

const LAGOS = 'Africa/Lagos'

describe('zonedDay', () => {
  it('reads the date in Lagos, not the server timezone', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    const day = zonedDay(new Date('2026-09-11T23:30:00Z'), LAGOS)
    expect(day.iso).toBe('2026-09-12')
    expect(day.weekday).toBe('Sat')
    expect(day.label).toBe('Sat 2026-09-12')
  })

  it('labels weekdays correctly', () => {
    expect(zonedDay(new Date('2026-09-18T12:00:00Z'), LAGOS).weekday).toBe('Fri')
  })
})

describe('calendarWindow', () => {
  const window = calendarWindow(new Date('2026-09-11T12:00:00Z'), LAGOS, 14)

  it('starts a day early so "yesterday" still resolves', () => {
    expect(window[0]?.iso).toBe('2026-09-10')
  })

  it('every label states the real weekday for its date', () => {
    for (const day of window) {
      const actual = new Date(`${day.iso}T12:00:00Z`).toLocaleDateString('en-GB', {
        timeZone: LAGOS,
        weekday: 'short',
      })
      expect(day.weekday).toBe(actual)
    }
  })

  it('the Friday after Fri 11 Sept 2026 is the 18th, not the 15th', () => {
    // The exact failure this exists to prevent: the model previously answered
    // 2026-09-15 for "this Friday", which is a Tuesday.
    const fridays = window.filter((day) => day.weekday === 'Fri').map((day) => day.iso)
    expect(fridays).toContain('2026-09-18')
    expect(fridays).not.toContain('2026-09-15')
  })
})

describe('isOfferedDate', () => {
  const window = calendarWindow(new Date('2026-09-11T12:00:00Z'), LAGOS, 14)

  it('accepts a date the model was actually offered', () => {
    expect(isOfferedDate('2026-09-18', window)).toBe(true)
  })

  it('rejects an invented date outside the window', () => {
    expect(isOfferedDate('2027-01-01', window)).toBe(false)
  })

  it('rejects null rather than treating it as valid', () => {
    expect(isOfferedDate(null, window)).toBe(false)
  })
})

describe('todayIso', () => {
  it('returns a plain ISO date', () => {
    expect(todayIso(LAGOS, new Date('2026-09-12T08:00:00Z'))).toBe('2026-09-12')
  })
})

describe('formatTime12', () => {
  it('converts stored 24-hour times to how people actually say them', () => {
    expect(formatTime12('23:59')).toBe('11:59pm')
    expect(formatTime12('17:00')).toBe('5pm')
    expect(formatTime12('10:00')).toBe('10am')
    expect(formatTime12('09:30')).toBe('9:30am')
  })

  it('handles both midnights correctly', () => {
    expect(formatTime12('00:00')).toBe('12am')
    expect(formatTime12('12:00')).toBe('12pm')
    expect(formatTime12('00:30')).toBe('12:30am')
  })

  it('drops ":00" so a whole hour reads naturally', () => {
    expect(formatTime12('14:00')).toBe('2pm')
    expect(formatTime12('14:05')).toBe('2:05pm')
  })

  it('passes through anything that is not a time rather than mangling it', () => {
    expect(formatTime12(null)).toBeNull()
    expect(formatTime12('')).toBeNull()
    expect(formatTime12('lunchtime')).toBe('lunchtime')
    expect(formatTime12('99:99')).toBe('99:99')
  })
})

/**
 * The failure this codebase keeps hitting.
 *
 * Asked what "this Friday" meant on a Friday, the model returned a Tuesday. Asked
 * for "next two weeks Thursday" from a real recording, it returned Tuesday 29
 * September at confidence 1.0 — and every guard in the path waved it through,
 * because 2026-09-29 is a perfectly valid date inside the year.
 *
 * A weekday is arithmetic-free: either the date lands on the day they named, or the
 * model did the sum and got it wrong.
 */
describe('a date has to fall on the weekday that was said', () => {
  it('rejects a Tuesday offered for a Thursday', () => {
    expect(weekdayAgrees('2026-09-29', 'next two weeks Thursday')).toBe(false)
  })

  it('accepts the Thursday two weeks out', () => {
    expect(weekdayAgrees('2026-10-01', 'next two weeks Thursday')).toBe(true)
  })

  it('accepts anything when no weekday was named', () => {
    expect(weekdayAgrees('2026-09-29', 'the 29th')).toBe(true)
    expect(weekdayAgrees('2026-09-29', null)).toBe(true)
  })

  it('reads the short forms people actually write', () => {
    expect(weekdayAgrees('2026-09-17', 'thurs')).toBe(true)
    expect(weekdayAgrees('2026-09-17', 'Thu 4pm')).toBe(true)
    expect(weekdayAgrees('2026-09-18', 'thurs')).toBe(false)
  })

  /** "sat" inside "satisfied" is not a Saturday. */
  it('only reads a weekday as a whole word', () => {
    expect(weekdayNamedIn('everyone was satisfied')).toBeNull()
    expect(weekdayNamedIn('moving to saturday')).toBe(6)
  })

  it('has no opinion when there is no date to check', () => {
    expect(weekdayAgrees(null, 'Thursday')).toBe(true)
  })
})

/**
 * "Next two weeks Thursday" is ordinary Nigerian academic speech and lands 17 days
 * out. A fortnight-long calendar did not contain the right day, so the model was
 * asked to pick from a list that could not answer, and calculated instead.
 */
describe('the calendar reaches far enough to answer', () => {
  it('covers four weeks, not two', () => {
    const window = calendarWindow(new Date('2026-09-14T09:00:00Z'), 'Africa/Lagos')
    expect(window.length).toBeGreaterThanOrEqual(29)
    expect(window.some((day) => day.iso === '2026-10-01')).toBe(true)
  })

  it('still offers yesterday, for something said late last night', () => {
    const window = calendarWindow(new Date('2026-09-14T09:00:00Z'), 'Africa/Lagos')
    expect(window[0]!.iso).toBe('2026-09-13')
  })
})
