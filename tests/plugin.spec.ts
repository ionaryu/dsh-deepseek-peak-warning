/**
 * The plugin's observable contract: which models warn, when a window is
 * announced, that one window is announced once per window and state kind, and
 * that an unusable schedule fails at load instead of staying silent forever.
 *
 * The wall clock is pinned with fake timers, so every case names an exact UTC
 * instant, and the day fixtures are read back as weekdays rather than assumed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, Config, name, type Config as PluginConfig } from '../src/index.ts'

const SIGNAL = new AbortController().signal

/** The plugin as the loader mounts it: named exports, schema included. */
const plugin = { name, apply, Config }

/** UTC instant. `month` is 1-based, unlike `Date.UTC`. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Wednesday 2026-09-16 00:00 UTC, with its neighbours, all read back below. */
const WEDNESDAY = utc(2026, 9, 16)
const MONDAY = WEDNESDAY - 2 * DAY
const FRIDAY = WEDNESDAY + 2 * DAY
const SATURDAY = WEDNESDAY + 3 * DAY
const SUNDAY = WEDNESDAY + 4 * DAY
const NEXT_MONDAY = WEDNESDAY + 5 * DAY

/** Pin the wall clock so the schedule decides, not the test machine. */
function at(instantMs: number): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(instantMs))
}

afterEach(() => {
  vi.useRealTimers()
})

/** ISO weekday of an instant, read from the date rather than assumed. */
function isoWeekdayOf(atMs: number): number {
  const day = new Date(atMs).getUTCDay()
  return day === 0 ? 7 : day
}

it('pins the fixture days the cases below name', () => {
  expect(isoWeekdayOf(MONDAY)).toBe(1)
  expect(isoWeekdayOf(FRIDAY)).toBe(5)
  expect(isoWeekdayOf(SATURDAY)).toBe(6)
  expect(isoWeekdayOf(SUNDAY)).toBe(7)
  expect(isoWeekdayOf(NEXT_MONDAY)).toBe(1)
})

/** One agent recording what the plugin injects, since that is its only output. */
interface Probe {
  readonly agent: Agent
  /** Every message this agent was handed through `inject`. */
  readonly injected: UserMessage[]
}

function createProbe(): Probe {
  const injected: UserMessage[] = []
  const agent = { inject: (message: UserMessage) => { injected.push(message) } } as unknown as Agent
  return { agent, injected }
}

/** Mount the plugin the way the loader does, so schema defaults and validation both apply. */
async function mount(overrides: PluginConfig = {}): Promise<{ ctx: Context; probe: Probe }> {
  const ctx = new Context()
  await ctx.plugin(plugin, overrides as never)
  return { ctx, probe: createProbe() }
}

/**
 * Dispatch one request, the way the loop does, and return only the notices that
 * dispatch injected — not the agent's accumulated ones.
 */
async function request(ctx: Context, probe: Probe, config: LlmCallConfig): Promise<UserMessage[]> {
  const before = probe.injected.length
  await agentEvents(ctx, probe.agent).waterfall(
    'agent/request',
    { turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve(config),
  )
  return probe.injected
    .slice(before)
    .filter(message => message.source.kind === 'plugin' && message.source.plugin === name)
}

/** The model text of one notice. */
function textOf(message: UserMessage | undefined): string {
  return (message?.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('model gate', () => {
  it('warns a DeepSeek model during a peak window', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    const notices = await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0])).toContain('inside a DeepSeek peak-pricing window')
    await ctx.fiber.dispose()
  })

  it('warns the same model through a gateway route, because the model decides', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    // The gateway serves other vendors' models too; only the DeepSeek ones
    // carry DeepSeek's peak pricing, and the model id is what distinguishes them.
    const notices = await request(ctx, probe, { provider: 'opencode-go', model: 'deepseek-flash' })
    expect(notices).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('stays silent on a non-DeepSeek model, even in peak and on a DeepSeek route', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    expect(await request(ctx, probe, { provider: 'opencode-go', model: 'minimax-m3' })).toHaveLength(0)
    const second = await mount()
    expect(await request(second.ctx, second.probe, { provider: 'deepseek-official', model: 'claude-sonnet' })).toHaveLength(0)
    await ctx.fiber.dispose()
    await second.ctx.fiber.dispose()
  })

  it('warns every model when the prefix list is empty', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount({ modelPrefixes: [] })
    expect(await request(ctx, probe, { provider: 'opencode-go', model: 'minimax-m3' })).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('honors a configured replacement model prefix', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount({ modelPrefixes: ['ds-'] })
    expect(await request(ctx, probe, { provider: 'corp-gw', model: 'ds-flash' })).toHaveLength(1)
    // The replaced list no longer matches the shipped default's models.
    const other = await mount({ modelPrefixes: ['ds-'] })
    expect(await request(other.ctx, other.probe, { provider: 'corp-gw', model: 'deepseek-flash' })).toHaveLength(0)
    await ctx.fiber.dispose()
    await other.ctx.fiber.dispose()
  })
})

describe('when a warning is emitted', () => {
  it('warns during peak and names the window that closes it', async () => {
    at(MONDAY + 6.5 * HOUR)
    const { ctx, probe } = await mount()
    const notices = await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(textOf(notices[0])).toContain('06:00 UTC to 10:00 UTC')
    expect(textOf(notices[0])).toContain('2x the off-peak price')
    await ctx.fiber.dispose()
  })

  it('warns a half hour before a window opens', async () => {
    at(MONDAY + 30 * MINUTE)
    const { ctx, probe } = await mount()
    const notices = await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0])).toContain('opens in about 30 minutes')
    expect((notices[0]?.source as { summary?: string }).summary).toContain('starts in ~30 min')
    await ctx.fiber.dispose()
  })

  it('stays silent one minute before the advance warning begins', async () => {
    at(MONDAY + 29 * MINUTE)
    const { ctx, probe } = await mount()
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('stays silent in off-peak hours far from any window', async () => {
    at(MONDAY + 12 * HOUR)
    const { ctx, probe } = await mount()
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('carries the advance warning across the weekend, to the next Monday window', async () => {
    // Monday's first window is the next one from Friday evening through Sunday,
    // so the weekend is off-peak until that window comes within the lead time.
    at(NEXT_MONDAY + 45 * MINUTE) // 00:45 UTC, 15 minutes before the 01:00 window
    const { ctx, probe } = await mount()
    const notices = await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(notices).toHaveLength(1)
    expect(textOf(notices[0])).toContain('opens in about 15 minutes')
    await ctx.fiber.dispose()
  })

  it('stays silent across the weekend until that window enters the lead time', async () => {
    // Sunday 23:45 UTC is 75 minutes before the next Monday 01:00 UTC window,
    // outside the default 30-minute lead.
    at(SUNDAY + 23 * HOUR + 45 * MINUTE)
    const { ctx, probe } = await mount()
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('stays silent on a weekend whose peak clock time falls on non-peak days', async () => {
    // Saturday 02:00 UTC sits inside a weekday window's clock time; the schedule
    // lists weekdays only, so no window is open.
    at(SATURDAY + 2 * HOUR)
    const { ctx, probe } = await mount({ leadMinutes: 0 })
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('announces an open window only when peak has begun, if the advance warning is disabled', async () => {
    at(MONDAY + 30 * MINUTE)
    const { ctx, probe } = await mount({ leadMinutes: 0 })
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(0)
    at(MONDAY + 61 * MINUTE)
    expect(await request(ctx, probe, { provider: 'deepseek-official', model: 'deepseek-flash' })).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

describe('announcement frequency', () => {
  it('announces one window once, however many requests run inside it', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    const config = { provider: 'deepseek-official', model: 'deepseek-flash' }
    expect(await request(ctx, probe, config)).toHaveLength(1)
    expect(await request(ctx, probe, config)).toHaveLength(0)
    at(MONDAY + 3.5 * HOUR)
    expect(await request(ctx, probe, config)).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('announces the advance warning and then the window it precedes', async () => {
    const { ctx, probe } = await mount()
    const config = { provider: 'deepseek-official', model: 'deepseek-flash' }
    at(MONDAY + 45 * MINUTE)
    expect(await request(ctx, probe, config)).toHaveLength(1)
    at(MONDAY + 2 * HOUR)
    expect(await request(ctx, probe, config)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('announces the second window of the same day separately', async () => {
    const { ctx, probe } = await mount()
    const config = { provider: 'deepseek-official', model: 'deepseek-flash' }
    at(MONDAY + 2 * HOUR)
    expect(await request(ctx, probe, config)).toHaveLength(1)
    at(MONDAY + 8 * HOUR)
    expect(await request(ctx, probe, config)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('keeps one agent\u2019s announcement from silencing another', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    const second = createProbe()
    const config = { provider: 'deepseek-official', model: 'deepseek-flash' }
    expect(await request(ctx, probe, config)).toHaveLength(1)
    await agentEvents(ctx, second.agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve(config),
    )
    const secondNotices = second.injected.filter(message => message.source.kind === 'plugin')
    expect(secondNotices).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

describe('interaction with the loop', () => {
  it('leaves the resolved call configuration untouched', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    const config = { provider: 'opencode-go', model: 'deepseek-flash', temperature: 0.3 }
    const resolved = await agentEvents(ctx, probe.agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve(config),
    )
    expect(resolved).toBe(config)
    await ctx.fiber.dispose()
  })

  it('injects at most one message per resolution, even across several requests', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    const config = { provider: 'deepseek-official', model: 'deepseek-flash' }
    await request(ctx, probe, config)
    await request(ctx, probe, config)
    await request(ctx, probe, config)
    expect(probe.injected).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('stops warning as soon as the agent routes to a non-matching model', async () => {
    at(MONDAY + 2 * HOUR)
    const { ctx, probe } = await mount()
    expect(await request(ctx, probe, { provider: 'opencode-go', model: 'deepseek-flash' })).toHaveLength(1)
    at(MONDAY + 8 * HOUR)
    expect(await request(ctx, probe, { provider: 'opencode-go', model: 'minimax-m3' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

describe('configuration failures', () => {
  it('rejects an empty schedule, an inverted window, an out-of-day bound, and a bad lead', async () => {
    await expect(mount({ peakWindows: [] })).rejects.toThrow('peakWindows must list at least one window')
    await expect(mount({ peakWindows: [[240, 60]] })).rejects.toThrow('must end after it starts')
    await expect(mount({ peakWindows: [[60, 2000]] })).rejects.toThrow('minutes within one UTC day')
    await expect(mount({ peakWindows: [[60]] })).rejects.toThrow('is a [startMinute, endMinute] pair')
    await expect(mount({ peakWeekdays: [0] })).rejects.toThrow('ISO weekday numbers 1-7')
    await expect(mount({ peakWeekdays: [] })).rejects.toThrow('at least one ISO weekday')
    await expect(mount({ leadMinutes: -1 })).rejects.toThrow('leadMinutes must be a finite value >= 0')
    await expect(mount({ peakMultiplier: 0.5 })).rejects.toThrow('peakMultiplier must be a finite value >= 1')
  })

  it('accepts the shipped defaults unchanged', async () => {
    const { ctx } = await mount()
    await ctx.fiber.dispose()
  })
})

describe('plugin identity', () => {
  it('is a function plugin: named exports only, no default export', async () => {
    const module = await import('../src/index.ts')
    expect('default' in module).toBe(false)
    expect(module.name).toBe('deepseek-peak-warning')
    expect(typeof module.apply).toBe('function')
    expect(typeof module.Config).toBe('function')
  })

  it('defaults the model gate to DeepSeek ids', () => {
    expect(Config({}).modelPrefixes).toEqual(['deepseek-'])
    expect(Config({}).leadMinutes).toBe(30)
    expect(Config({}).peakWindows).toEqual([[60, 240], [360, 600]])
  })
})
