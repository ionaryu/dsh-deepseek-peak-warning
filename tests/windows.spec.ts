/**
 * DeepSeek's published peak schedule: Monday through Friday, 01:00-04:00 and
 * 06:00-10:00 UTC.
 *
 * Every instant here is built in UTC and its weekday is read back from the
 * constructed date rather than assumed, so no assertion depends on the
 * machine's zone or on a hand-computed calendar.
 */
import { describe, expect, it } from 'vitest'
import {
  announcementKey,
  classifyPeakState,
  containingWindow,
  nextWindow,
  type PeakSchedule,
} from '../src/windows.ts'

/** The shipped defaults, restated so a default change must update these tests. */
const schedule: PeakSchedule = {
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ],
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** UTC instant. `month` is 1-based, unlike `Date.UTC`. */
function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
}

/** Wednesday 2026-09-16 00:00 UTC — the anchor every other day is measured from. */
const WEDNESDAY = utc(2026, 9, 16)
/** A scheduled weekday inside the same week. */
const MONDAY = WEDNESDAY - 2 * DAY
/** The first unscheduled days after that week: the weekend and the next Monday. */
const FRIDAY = WEDNESDAY + 2 * DAY
const SATURDAY = WEDNESDAY + 3 * DAY
const SUNDAY = WEDNESDAY + 4 * DAY
const NEXT_MONDAY = WEDNESDAY + 5 * DAY
const NEXT_TUESDAY = WEDNESDAY + 6 * DAY

/** A window on one day, as `[start, end)` offsets from that day's UTC midnight. */
function windowOn(dayStartMs: number, startHour: number, endHour: number) {
  return { startMs: dayStartMs + startHour * HOUR, endMs: dayStartMs + endHour * HOUR }
}

/** ISO weekday (1 = Monday … 7 = Sunday) of an instant, read from the date. */
function isoWeekdayOf(atMs: number): number {
  const day = new Date(atMs).getUTCDay()
  return day === 0 ? 7 : day
}

describe('the fixtures name the weekdays they claim', () => {
  it('pins each date to its ISO weekday', () => {
    expect(isoWeekdayOf(MONDAY)).toBe(1)
    expect(isoWeekdayOf(WEDNESDAY)).toBe(3)
    expect(isoWeekdayOf(FRIDAY)).toBe(5)
    expect(isoWeekdayOf(SATURDAY)).toBe(6)
    expect(isoWeekdayOf(SUNDAY)).toBe(7)
    expect(isoWeekdayOf(NEXT_MONDAY)).toBe(1)
    expect(isoWeekdayOf(NEXT_TUESDAY)).toBe(2)
  })
})

describe('containingWindow', () => {
  it('places an instant inside each published window', () => {
    expect(containingWindow(MONDAY + 2 * HOUR, schedule)).toEqual(windowOn(MONDAY, 1, 4))
    expect(containingWindow(MONDAY + 8 * HOUR, schedule)).toEqual(windowOn(MONDAY, 6, 10))
  })

  it('treats a window as half-open: the start is inside, the end is not', () => {
    expect(containingWindow(MONDAY + 1 * HOUR, schedule)).toBeDefined()
    expect(containingWindow(MONDAY + 4 * HOUR - 1, schedule)).toBeDefined()
    expect(containingWindow(MONDAY + 4 * HOUR, schedule)).toBeUndefined()
    expect(containingWindow(MONDAY + 6 * HOUR - 1, schedule)).toBeUndefined()
    expect(containingWindow(MONDAY + 6 * HOUR, schedule)).toBeDefined()
    expect(containingWindow(MONDAY + 10 * HOUR, schedule)).toBeUndefined()
  })

  it('finds no window on a weekend day, whatever the hour', () => {
    for (const hour of [0, 1, 2, 3, 4, 6, 9, 10, 12, 23]) {
      expect(containingWindow(SATURDAY + hour * HOUR, schedule)).toBeUndefined()
      expect(containingWindow(SUNDAY + hour * HOUR, schedule)).toBeUndefined()
    }
  })

  it('finds no window in a gap between the two daily windows', () => {
    for (const minute of [240, 300, 359]) {
      expect(containingWindow(MONDAY + minute * MINUTE, schedule)).toBeUndefined()
    }
  })
})

describe('nextWindow', () => {
  it('returns the window later the same day', () => {
    expect(nextWindow(MONDAY, schedule)).toEqual(windowOn(MONDAY, 1, 4))
    expect(nextWindow(MONDAY + 5 * HOUR, schedule)).toEqual(windowOn(MONDAY, 6, 10))
  })

  it('skips the window containing the instant, so an open window never reports itself', () => {
    expect(nextWindow(MONDAY + 2 * HOUR, schedule)).toEqual(windowOn(MONDAY, 6, 10))
  })

  it('crosses a UTC midnight into the next weekday', () => {
    // Monday 23:00 UTC has no later window that day; Tuesday 01:00 is next.
    expect(nextWindow(MONDAY + 23 * HOUR, schedule)).toEqual(windowOn(MONDAY + DAY, 1, 4))
  })

  it('crosses the weekend, landing on the next Monday window', () => {
    const mondayWindow = windowOn(NEXT_MONDAY, 1, 4)
    // Friday after both windows, then the whole weekend, all point at Monday.
    for (let hours = 11; hours < 24; hours += 1) {
      expect(nextWindow(FRIDAY + hours * HOUR, schedule)).toEqual(mondayWindow)
    }
    expect(nextWindow(SATURDAY, schedule)).toEqual(mondayWindow)
    expect(nextWindow(SUNDAY + 12 * HOUR, schedule)).toEqual(mondayWindow)
    // Monday itself moves on to its own second window, then to Tuesday's first.
    expect(nextWindow(NEXT_MONDAY, schedule)).toEqual(windowOn(NEXT_MONDAY, 1, 4))
    expect(nextWindow(NEXT_MONDAY + 5 * HOUR, schedule)).toEqual(windowOn(NEXT_MONDAY, 6, 10))
    expect(nextWindow(NEXT_MONDAY + 23 * HOUR, schedule)).toEqual(windowOn(NEXT_TUESDAY, 1, 4))
  })

  it('returns undefined for schedules that can never open a window', () => {
    expect(nextWindow(MONDAY, { weekdays: [1, 2, 3, 4, 5], windows: [] })).toBeUndefined()
    expect(nextWindow(MONDAY, { weekdays: [], windows: [{ startMinute: 60, endMinute: 240 }] })).toBeUndefined()
  })
})

describe('classifyPeakState', () => {
  const lead = 30 * MINUTE

  it('reports peak inside a window, with that window\u2019s bounds', () => {
    expect(classifyPeakState(MONDAY + 2 * HOUR, schedule, lead)).toEqual({
      kind: 'peak',
      window: windowOn(MONDAY, 1, 4),
    })
  })

  it('reports approaching from the lead boundary, not before it', () => {
    expect(classifyPeakState(MONDAY + 30 * MINUTE, schedule, lead)).toEqual({
      kind: 'approaching',
      window: windowOn(MONDAY, 1, 4),
      leadMs: 30 * MINUTE,
    })
    expect(classifyPeakState(MONDAY + 30 * MINUTE - 1, schedule, lead)).toEqual({
      kind: 'offPeak',
      window: windowOn(MONDAY, 1, 4),
    })
  })

  it('still reports the next window while off-peak, so a caller can show it', () => {
    expect(classifyPeakState(MONDAY + 12 * HOUR, schedule, lead)).toEqual({
      kind: 'offPeak',
      window: windowOn(MONDAY + DAY, 1, 4),
    })
  })

  it('disables the advance warning when the lead is zero', () => {
    expect(classifyPeakState(MONDAY + 59 * MINUTE, schedule, 0).kind).toBe('offPeak')
    expect(classifyPeakState(MONDAY + 1 * HOUR, schedule, 0).kind).toBe('peak')
  })

  it('treats a weekend as off-peak while still naming the next Monday window', () => {
    expect(classifyPeakState(SUNDAY + 12 * HOUR, schedule, lead)).toEqual({
      kind: 'offPeak',
      window: windowOn(NEXT_MONDAY, 1, 4),
    })
  })
})

describe('announcementKey', () => {
  it('distinguishes the advance warning from the open window that follows it', () => {
    const approaching = classifyPeakState(MONDAY + 45 * MINUTE, schedule, 30 * MINUTE)
    const peak = classifyPeakState(MONDAY + 1 * HOUR, schedule, 30 * MINUTE)
    expect(announcementKey(approaching)).toBe(`approaching|${MONDAY + 1 * HOUR}`)
    expect(announcementKey(peak)).toBe(`peak|${MONDAY + 1 * HOUR}`)
    expect(announcementKey(approaching)).not.toBe(announcementKey(peak))
  })

  it('is stable within one window, so a long session announces it once', () => {
    const early = classifyPeakState(MONDAY + 1 * HOUR, schedule, 30 * MINUTE)
    const late = classifyPeakState(MONDAY + 4 * HOUR - 1, schedule, 30 * MINUTE)
    expect(announcementKey(early)).toBe(announcementKey(late))
  })

  it('changes for the next window on the same day', () => {
    const first = classifyPeakState(MONDAY + 2 * HOUR, schedule, 30 * MINUTE)
    const second = classifyPeakState(MONDAY + 8 * HOUR, schedule, 30 * MINUTE)
    expect(announcementKey(first)).not.toBe(announcementKey(second))
  })

  it('has no key when there is nothing to announce', () => {
    expect(announcementKey(classifyPeakState(MONDAY + 12 * HOUR, schedule, 30 * MINUTE))).toBeUndefined()
    expect(announcementKey(classifyPeakState(MONDAY, { weekdays: [], windows: [] }, 30 * MINUTE))).toBeUndefined()
  })
})

describe('schedule arithmetic across a full week', () => {
  it('opens exactly two windows on each scheduled weekday, at 01:00 and 06:00 UTC', () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const day = WEDNESDAY + offset * DAY
      const opens: number[] = []
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        const at = day + minute * MINUTE
        const window = containingWindow(at, schedule)
        if (window !== undefined && window.startMs === at) opens.push(minute)
      }
      expect(opens).toEqual([60, 360])
    }
  })

  it('opens no window on either weekend day', () => {
    for (const day of [SATURDAY, SUNDAY]) {
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        expect(containingWindow(day + minute * MINUTE, schedule)).toBeUndefined()
      }
    }
  })
})
