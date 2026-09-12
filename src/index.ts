/**
 * DeepSeek peak-window warning. Injects one plugin-attributed notice into the
 * conversation when an agent routed to a DeepSeek provider is about to enter,
 * or is inside, a peak pricing window.
 *
 * The notice rides `agent/pre-step`'s decision messages, so it is model-visible
 * and reconstructable from the session log with no new session event. Each
 * window is announced once per state kind per agent, so a long session does not
 * accumulate repeated warnings.
 *
 * @module deepseek-peak-warning
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  announcementKey,
  classifyPeakState,
  type PeakSchedule,
  type PeakState,
} from './windows.ts'

export const name = 'deepseek-peak-warning'

const MS_PER_MINUTE = 60_000
const MINUTES_PER_DAY = 24 * 60

/**
 * Plugin configuration. The schedule and route ids vary by deployment, so each
 * is a validated config field; the defaults are DeepSeek's published schedule.
 * Misconfiguration fails loud at load rather than silently never firing.
 */
export interface Config {
  /**
   * Model id prefixes the warning applies to (default `['deepseek-']`). The
   * resolved model decides, so the same model warns whether it is served by the
   * native DeepSeek adapter or by a gateway. An empty list matches every model.
   */
  modelPrefixes?: string[]
  /** ISO weekday numbers (1 = Monday … 7 = Sunday) that carry peak windows. */
  peakWeekdays?: number[]
  /**
   * Peak windows as `[startMinute, endMinute)` pairs of minutes since UTC
   * midnight. Defaults to DeepSeek's two daily windows. A pair is required:
   * `resolveSchedule` rejects any other length at load.
   */
  peakWindows?: number[][]
  /**
   * Minutes before a peak window opens at which the advance warning starts
   * (default 30). `0` disables it and announces only an already-open window.
   */
  leadMinutes?: number
  /** Price factor during peak hours, quoted in the notice (default 2). */
  peakMultiplier?: number
}

export const Config: z<Config> = z.object({
  modelPrefixes: z.array(z.string()).default(['deepseek-']),
  peakWeekdays: z.array(z.number()).default([1, 2, 3, 4, 5]),
  peakWindows: z.array(z.array(z.number())).default([[60, 240], [360, 600]]),
  leadMinutes: z.number().default(30),
  peakMultiplier: z.number().default(2),
})

/**
 * Validate the configured schedule and convert it to the window math's units.
 * A nonsensical window would never match and the warning would silently never
 * fire, so every bound is re-checked here.
 * @param config - validated {@link Config}.
 * @returns the schedule the classifier consumes and the resolved lead time.
 * @throws when a weekday, window bound, lead, or multiplier is out of range.
 */
function resolveSchedule(config: Config): { schedule: PeakSchedule; leadMs: number } {
  const weekdays = config.peakWeekdays as number[]
  if (weekdays.length === 0) {
    throw new Error('deepseek-peak-warning: peakWeekdays must list at least one ISO weekday')
  }
  for (const weekday of weekdays) {
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new Error(`deepseek-peak-warning: peakWeekdays entries must be ISO weekday numbers 1-7, got ${weekday}`)
    }
  }
  const rawWindows = config.peakWindows as number[][]
  if (rawWindows.length === 0) {
    throw new Error('deepseek-peak-warning: peakWindows must list at least one window')
  }
  const windows = rawWindows.map((pair) => {
    if (pair.length !== 2) {
      throw new Error(`deepseek-peak-warning: every peakWindows entry is a [startMinute, endMinute] pair, got ${JSON.stringify(pair)}`)
    }
    const [start, end] = pair as [number, number]
    for (const bound of [start, end]) {
      if (!Number.isFinite(bound) || bound < 0 || bound > MINUTES_PER_DAY) {
        throw new Error(`deepseek-peak-warning: peakWindows bounds are minutes within one UTC day (0-${MINUTES_PER_DAY}), got ${bound}`)
      }
    }
    if (start >= end) {
      throw new Error(`deepseek-peak-warning: peak window [${start}, ${end}) must end after it starts; a window never crosses UTC midnight, so split it into two`)
    }
    return { startMinute: start, endMinute: end }
  })
  const leadMinutes = config.leadMinutes as number
  if (!Number.isFinite(leadMinutes) || leadMinutes < 0) {
    throw new Error(`deepseek-peak-warning: leadMinutes must be a finite value >= 0, got ${leadMinutes}`)
  }
  const multiplier = config.peakMultiplier as number
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error(`deepseek-peak-warning: peakMultiplier must be a finite value >= 1, got ${multiplier}`)
  }
  return {
    schedule: { weekdays: [...new Set(weekdays)].sort((a, b) => a - b), windows },
    leadMs: leadMinutes * MS_PER_MINUTE,
  }
}

/**
 * Format an instant in the host's local zone, labelled with that zone so a
 * reader elsewhere is never misled about which clock a time belongs to.
 * @param atMs - the instant, in epoch milliseconds.
 * @returns local wall-clock time such as `2026-09-14 10:00 GMT+9`.
 */
function localTime(atMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(new Date(atMs))
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? ''
  const stamp = `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`
  const zone = field('timeZoneName')
  return zone.length > 0 ? `${stamp} ${zone}` : stamp
}

/**
 * Wall-clock time of an instant in UTC, the zone the published schedule uses.
 * @param atMs - the instant, in epoch milliseconds.
 * @returns `HH:MM UTC`.
 */
function utcTime(atMs: number): string {
  const at = new Date(atMs)
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** Minutes an instant sits after its window opened, floored at one. */
function minutesUntil(leadMs: number): number {
  return Math.max(1, Math.round(leadMs / MS_PER_MINUTE))
}

/** The notice body announcing a window that is already open. */
function peakNotice(state: Extract<PeakState, { kind: 'peak' }>, multiplier: number): string {
  const { startMs, endMs } = state.window
  return 'Pricing notice: this session is inside a DeepSeek peak-pricing window.\n'
    + `- rate: ${multiplier}x the off-peak price\n`
    + `- window: ${localTime(startMs)} to ${localTime(endMs)} (${utcTime(startMs)} to ${utcTime(endMs)})\n`
    + 'Off-peak rates resume when the window closes. Continue if the work matters more than the difference.'
}

/** The notice body announcing a window that is about to open. */
function approachingNotice(
  state: Extract<PeakState, { kind: 'approaching' }>,
  multiplier: number,
): string {
  const { startMs, endMs } = state.window
  const minutes = minutesUntil(state.leadMs)
  return `Pricing notice: a DeepSeek peak-pricing window opens in about ${minutes} minute${minutes === 1 ? '' : 's'}.\n`
    + `- opens: ${localTime(startMs)} (${utcTime(startMs)})\n`
    + `- closes: ${localTime(endMs)} (${utcTime(endMs)})\n`
    + `- rate: ${multiplier}x the off-peak price\n`
    + 'Requests started after it opens cost more. Finish or defer long work now if the difference matters.'
}

/**
 * Build the notice for one classified state.
 * @param state - the current classification, which selects the wording.
 * @param multiplier - peak price factor.
 * @returns the message to inject, or undefined when there is nothing to warn about.
 */
function buildNotice(state: PeakState, multiplier: number): UserMessage | undefined {
  if (state.kind === 'peak') {
    return createUserMessage({
      content: [{ type: 'text', text: peakNotice(state, multiplier) }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(`DeepSeek peak pricing active until ${localTime(state.window.endMs)}`),
      },
    })
  }
  if (state.kind === 'approaching') {
    return createUserMessage({
      content: [{ type: 'text', text: approachingNotice(state, multiplier) }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(`DeepSeek peak pricing starts in ~${minutesUntil(state.leadMs)} min`),
      },
    })
  }
  return undefined
}

/**
 * Install the warning.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; the schedule is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const { schedule, leadMs } = resolveSchedule(config)
  const prefixes = (config.modelPrefixes as string[]).filter(prefix => prefix.length > 0)
  const multiplier = config.peakMultiplier as number

  /** Whether a resolved model id is one this plugin warns about. */
  const tracked = (model: string): boolean =>
    prefixes.length === 0 || prefixes.some(prefix => model.startsWith(prefix))

  /**
   * The announcement each agent has already received, keyed by window and
   * state kind. This is the only per-agent state: which model an agent routes
   * to is read from the resolution that is in hand.
   */
  const announcedByAgent = new WeakMap<Agent, string>()

  // The model is known only once a request resolves, and the first pre-step of
  // every turn runs before that. A running session learns it one step later and
  // would still be warned; a single-turn session would never be. So the notice
  // is emitted here, on the resolution that reveals the model, and
  // `agent.inject` lands it in the next admitted request.
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    if (!tracked(resolved.model)) return resolved
    const state = classifyPeakState(Date.now(), schedule, leadMs)
    const key = announcementKey(state)
    if (key === undefined || announcedByAgent.get(agent) === key) return resolved
    const notice = buildNotice(state, multiplier)
    if (notice === undefined) return resolved
    announcedByAgent.set(agent, key)
    agent.inject(notice)
    return resolved
  })
}
