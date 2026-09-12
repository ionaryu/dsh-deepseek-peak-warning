# dsh-deepseek-peak-warning

## Summary

DeepSeek bills API usage at peak and off-peak rates that differ by a factor of two, on a schedule published in UTC, and resellers of DeepSeek models pass that schedule through. This plugin puts the fact where the work happens: when the model a session actually routes to is a DeepSeek model and a peak window is open or about to open, it injects one advisory notice naming the window and the multiplier. Non-DeepSeek models never see it, and each window is announced once, so a long session does not accumulate warnings.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Install it from the repository into a profile, then restart the harness:

```sh
dsh plugin --profile web add github:ionaryu/dsh-deepseek-peak-warning
dsh --profile web --dump-config   # shows a "# == dsh-deepseek-peak-warning" layer
```

A git install fetches sources, so pnpm runs this package's `prepare` script to produce `lib/index.js`. pnpm 10 and later refuse a dependency's lifecycle scripts until the profile allows them, so the first `add` may stop with the package key pnpm printed; copy that key into `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-deepseek-peak-warning: true
```

Re-run the `add`, then restart. Pin a commit (`github:ionaryu/dsh-deepseek-peak-warning#<sha>`) when the install must stay fixed, and run the same command with a newer commit to update. To install from a local checkout instead — the path used during development — replace the reference with `file:/absolute/path/to/deepseek-peak-warning`.

A host row is applied once at boot, so the notice starts with the next launch.

### When to choose it

Choose it when the session runs DeepSeek models at peak/off-peak pricing — directly or through a provider that passes DeepSeek's schedule on, such as a subscription gateway that meters DeepSeek models in dollars. On a plan whose limits are dollar amounts, peak hours consume the limit at twice the rate, so the notice tells you when a long run starts costing more.

Do not install it where DeepSeek models bill at a flat rate: the notice would describe a price you are not paying.

### How the warning fires

The plugin warns when all of these hold:

- The model the request resolved to starts with a `modelPrefixes` entry (default `['deepseek-']`).
- The current instant is inside a peak window, or within `leadMinutes` of the next one opening.
- That window and state have not already been announced for this agent.

It fires from `agent/request`, on the resolution that reveals the model. The model a session uses is only known from a resolved call, and a turn's first `agent/pre-step` runs before that — so emitting at request time is what lets a warning reach the very first turn rather than the second. The notice is delivered with `agent.inject`, which lands it in the next admitted request.

### The published schedule

Peak hours are **01:00-04:00 and 06:00-10:00 UTC, Monday through Friday**; every other hour, including the whole weekend, is off-peak, and off-peak costs half the peak rate. In UTC+9 that is 10:00-13:00 and 15:00-19:00 on weekdays.

The windows are stated in UTC and do not follow any zone's daylight saving, so a local-time reading of them shifts with your offset. The notice prints the local and the UTC time for that reason.

### Configuration

```yaml
- insert:
    - id: deepseek-peak-warning
      name: dsh-deepseek-peak-warning
      config:
        modelPrefixes: ["deepseek-"]
        peakWeekdays: [1, 2, 3, 4, 5]
        peakWindows: [[60, 240], [360, 600]]
        leadMinutes: 30
        peakMultiplier: 2
```

| Field | Default | Meaning |
|---|---|---|
| `modelPrefixes` | `["deepseek-"]` | Model ids the warning applies to; empty matches every model |
| `peakWeekdays` | `[1,2,3,4,5]` | ISO weekdays (1 = Monday … 7 = Sunday) that carry peak windows |
| `peakWindows` | `[[60,240],[360,600]]` | `[startMinute, endMinute)` pairs, as minutes since UTC midnight |
| `leadMinutes` | `30` | How long before a window opens the advance warning starts; `0` disables it |
| `peakMultiplier` | `2` | Peak price factor quoted in the notice |

Invalid configuration throws at plugin load rather than degrading to silence: an empty weekday or window list, a weekday outside 1-7, a window bound outside one UTC day, a window that ends before it starts, a negative lead, or a multiplier below 1. A window never crosses UTC midnight; a schedule that needs to is written as two windows.

To follow a different model family, replace `modelPrefixes` — for example `["deepseek-", "ds-"]`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design commitments

- **The resolved model decides.** The gate reads `model` from the call configuration the request actually resolved to — not the session's configured model, and not the provider name. One provider can serve several vendors' models at different prices, and the same DeepSeek model is served by the native adapter and by gateways alike.
- **Emit where the model becomes known.** `agent/request` is the first point at which the model exists. The notice rides `agent.inject`, which the loop claims at the nearest later step boundary, so a single-turn session is warned within its turn instead of never.
- **One announcement per window per state.** `announcementKey` is `<state kind>|<window start>`, held in a `WeakMap` keyed by agent. Inside one window the key is stable however long the window lasts, while the advance warning and the window it precedes are distinct keys, so a session spanning the boundary sees both.
- **Advisory only.** The listener never replaces the resolved call configuration and never blocks a step; its only effect is the injected message.
- **Fail loud at load.** The schedule is validated in `apply` and throws; a schedule that could never match would otherwise leave the plugin permanently silent with no diagnostic.

### Where the notice goes

The notice is a `createUserMessage` with source `{ kind: 'plugin', plugin: 'deepseek-peak-warning', form: 'notice', summary }`. It becomes a durable `user/message` in the session log, attributed to this plugin, rendered by the existing Chat body for `notice`-form context, and reconstructed from the log on replay with no new session event. The `summary` is bounded by `boundContextSummary` to the 120-character collapsed-row limit.

### Source map

| File | Role |
|---|---|
| [`src/windows.ts`](src/windows.ts) | Pure UTC window math: containment, next window, classification, announcement key |
| [`src/index.ts`](src/index.ts) | Config schema, fail-loud validation, model gate, notice construction and injection |
| [`build.mjs`](build.mjs) | esbuild entry-point build; `@deepseek-ai/*` imports stay external |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Advance notice

#### What the model sees

Between `leadMinutes` and zero minutes before a window opens, the routed agent receives one user-role message:

```markdown
Pricing notice: a DeepSeek peak-pricing window opens in about 30 minutes.
- opens: <local time> (<HH:MM> UTC)
- closes: <local time> (<HH:MM> UTC)
- rate: 2x the off-peak price
Requests started after it opens cost more. Finish or defer long work now if the difference matters.
```

#### Token effect

One retained message per window. Nothing is added while off-peak and no window is within the lead time.

#### KV Cache effect

Append-only, at the history tail; it does not invalidate a reusable prefix.

### Peak notice

#### What the model sees

Inside an unannounced window:

```markdown
Pricing notice: this session is inside a DeepSeek peak-pricing window.
- rate: 2x the off-peak price
- window: <local time> to <local time> (<HH:MM> UTC to <HH:MM> UTC)
Off-peak rates resume when the window closes. Continue if the work matters more than the difference.
```

#### Token effect

One retained message per window per session.

#### KV Cache effect

Append-only, at the history tail.

### Non-DeepSeek models

Nothing: no message, no tool schema, no prompt text.

## Known Limitations and Deferred Work

- **The schedule is a configured constant, not a fetched fact.** DeepSeek changed both the window boundaries and the multiplier during 2026, and a reseller's copy of the schedule can drift from either. Nothing verifies the configuration against a published page, so a stale schedule is confidently wrong; re-check `peakWindows`, `peakWeekdays`, and `peakMultiplier` when pricing changes.
- **Only the first resolution of a turn can warn that turn.** The warning cannot pre-empt work already running, so a single long turn begun before the lead time runs into peak unpriced.
- **A resumed session re-announces its current window.** The announcement record is process-local, so a session resumed inside a peak window gets one more notice. This is deliberate: the alternative is a durable record for a notice that is cheap to repeat.
- **The gate is a model-id prefix.** A deployment that renames DeepSeek models beyond the configured prefixes is never warned.
- **The clock is the host's.** A machine with a wrong clock classifies the window wrongly; the notice prints both local and UTC time so a wrong local reading is visible.
