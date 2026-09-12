/**
 * DeepSeek API peak-window math. Pure functions of an instant and a schedule:
 * no clock reads, no I/O, no state, so tests pin every boundary directly.
 *
 * Boundaries are UTC. The official schedule is Monday through Friday,
 * 01:00-04:00 and 06:00-10:00 UTC; every other hour is off-peak.
 *
 * @module deepseek-peak-warning/windows
 */

/** One half-open UTC window within a day: `[startMinute, endMinute)`. */
export interface UtcWindow {
  /** Minutes since UTC midnight at which the window opens. */
  readonly startMinute: number
  /** Minutes since UTC midnight at which the window closes. */
  readonly endMinute: number
}

/** The recurring schedule during which DeepSeek bills peak rates. */
export interface PeakSchedule {
  /** ISO weekday numbers (1 = Monday … 7 = Sunday) whose days carry peak windows. */
  readonly weekdays: readonly number[]
  /** UTC windows that apply on each listed weekday. */
  readonly windows: readonly UtcWindow[]
}

/** Bounds of one concrete peak window. */
export interface WindowBounds {
  /** The instant the window opens. */
  readonly startMs: number
  /** The instant the window closes. */
  readonly endMs: number
}

/** Why an instant is classified as it is. */
export type PeakState =
  /** Inside a peak window: peak rates apply now. */
  | { readonly kind: 'peak'; readonly window: WindowBounds }
  /** Outside peak, with the next window opening within the configured lead time. */
  | { readonly kind: 'approaching'; readonly window: WindowBounds; readonly leadMs: number }
  /** Outside peak and no window opens within the lead time. */
  | { readonly kind: 'offPeak'; readonly window: WindowBounds | undefined }

const MS_PER_MINUTE = 60_000

/**
 * ISO weekday number (1 = Monday … 7 = Sunday) of an instant in UTC.
 *
 * `Date.getUTCDay()` numbers Sunday 0 and Monday 1; the schedule is stated in
 * ISO numbers, so Sunday is remapped to 7.
 */
function isoWeekdayUtc(atMs: number): number {
  const day = new Date(atMs).getUTCDay()
  return day === 0 ? 7 : day
}

/** Fractional minutes since UTC midnight, including seconds and milliseconds. */
function utcMinuteOf(atMs: number): number {
  const at = new Date(atMs)
  return at.getUTCHours() * 60
    + at.getUTCMinutes()
    + at.getUTCSeconds() / 60
    + at.getUTCMilliseconds() / MS_PER_MINUTE
}

/** UTC midnight of the day containing an instant. */
function utcDayStart(atMs: number): number {
  const at = new Date(atMs)
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
}

/** Concrete bounds for one scheduled window on the day beginning at `dayStartMs`. */
function boundsOn(dayStartMs: number, window: UtcWindow): WindowBounds {
  return {
    startMs: dayStartMs + window.startMinute * MS_PER_MINUTE,
    endMs: dayStartMs + window.endMinute * MS_PER_MINUTE,
  }
}

/**
 * The peak window containing an instant, if any.
 * @param atMs - the instant, in epoch milliseconds.
 * @param schedule - the recurring schedule to test.
 * @returns the containing window's bounds, or undefined outside every window.
 */
export function containingWindow(atMs: number, schedule: PeakSchedule): WindowBounds | undefined {
  if (!schedule.weekdays.includes(isoWeekdayUtc(atMs))) return undefined
  const dayStartMs = utcDayStart(atMs)
  const minute = utcMinuteOf(atMs)
  for (const window of schedule.windows) {
    if (minute >= window.startMinute && minute < window.endMinute) {
      return boundsOn(dayStartMs, window)
    }
  }
  return undefined
}

/**
 * The first window opening strictly after an instant. Scans a week ahead, which
 * covers every recurrence because weekdays repeat weekly.
 * @param atMs - the instant, in epoch milliseconds.
 * @param schedule - the recurring schedule to search.
 * @returns the next window's bounds, or undefined for a schedule that can never
 *   produce one.
 */
export function nextWindow(atMs: number, schedule: PeakSchedule): WindowBounds | undefined {
  if (schedule.windows.length === 0 || schedule.weekdays.length === 0) return undefined
  const dayStartMs = utcDayStart(atMs)
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDayMs = dayStartMs + offset * 24 * 60 * MS_PER_MINUTE
    if (!schedule.weekdays.includes(isoWeekdayUtc(candidateDayMs))) continue
    for (const window of schedule.windows) {
      const bounds = boundsOn(candidateDayMs, window)
      if (bounds.startMs > atMs) return bounds
    }
  }
  return undefined
}

/**
 * Classify one instant against a schedule.
 * @param atMs - the instant, in epoch milliseconds.
 * @param schedule - the recurring schedule to test.
 * @param leadMs - how long before a window opens `approaching` begins; 0 disables it.
 * @returns the peak state, which the caller uses to decide whether and what to announce.
 */
export function classifyPeakState(
  atMs: number,
  schedule: PeakSchedule,
  leadMs: number,
): PeakState {
  const containing = containingWindow(atMs, schedule)
  if (containing !== undefined) return { kind: 'peak', window: containing }
  const upcoming = nextWindow(atMs, schedule)
  if (upcoming === undefined) return { kind: 'offPeak', window: undefined }
  const remainingMs = upcoming.startMs - atMs
  if (leadMs > 0 && remainingMs <= leadMs) {
    return { kind: 'approaching', window: upcoming, leadMs: remainingMs }
  }
  return { kind: 'offPeak', window: upcoming }
}

/**
 * Stable identity of the window and state a classification refers to.
 * @param state - the classified state.
 * @returns a key that changes when the announced window or state kind changes,
 *   or undefined when there is nothing to announce.
 */
export function announcementKey(state: PeakState): string | undefined {
  if (state.kind === 'offPeak') return undefined
  return `${state.kind}|${state.window.startMs}`
}
