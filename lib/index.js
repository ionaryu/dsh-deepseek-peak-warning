// src/index.ts
import z from "@deepseek-ai/schemastery";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

// src/windows.ts
var MS_PER_MINUTE = 6e4;
function isoWeekdayUtc(atMs) {
  const day = new Date(atMs).getUTCDay();
  return day === 0 ? 7 : day;
}
function utcMinuteOf(atMs) {
  const at = new Date(atMs);
  return at.getUTCHours() * 60 + at.getUTCMinutes() + at.getUTCSeconds() / 60 + at.getUTCMilliseconds() / MS_PER_MINUTE;
}
function utcDayStart(atMs) {
  const at = new Date(atMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}
function boundsOn(dayStartMs, window) {
  return {
    startMs: dayStartMs + window.startMinute * MS_PER_MINUTE,
    endMs: dayStartMs + window.endMinute * MS_PER_MINUTE
  };
}
function containingWindow(atMs, schedule) {
  if (!schedule.weekdays.includes(isoWeekdayUtc(atMs))) return void 0;
  const dayStartMs = utcDayStart(atMs);
  const minute = utcMinuteOf(atMs);
  for (const window of schedule.windows) {
    if (minute >= window.startMinute && minute < window.endMinute) {
      return boundsOn(dayStartMs, window);
    }
  }
  return void 0;
}
function nextWindow(atMs, schedule) {
  if (schedule.windows.length === 0 || schedule.weekdays.length === 0) return void 0;
  const dayStartMs = utcDayStart(atMs);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDayMs = dayStartMs + offset * 24 * 60 * MS_PER_MINUTE;
    if (!schedule.weekdays.includes(isoWeekdayUtc(candidateDayMs))) continue;
    for (const window of schedule.windows) {
      const bounds = boundsOn(candidateDayMs, window);
      if (bounds.startMs > atMs) return bounds;
    }
  }
  return void 0;
}
function classifyPeakState(atMs, schedule, leadMs) {
  const containing = containingWindow(atMs, schedule);
  if (containing !== void 0) return { kind: "peak", window: containing };
  const upcoming = nextWindow(atMs, schedule);
  if (upcoming === void 0) return { kind: "offPeak", window: void 0 };
  const remainingMs = upcoming.startMs - atMs;
  if (leadMs > 0 && remainingMs <= leadMs) {
    return { kind: "approaching", window: upcoming, leadMs: remainingMs };
  }
  return { kind: "offPeak", window: upcoming };
}
function announcementKey(state) {
  if (state.kind === "offPeak") return void 0;
  return `${state.kind}|${state.window.startMs}`;
}

// src/index.ts
var name = "deepseek-peak-warning";
var MS_PER_MINUTE2 = 6e4;
var MINUTES_PER_DAY = 24 * 60;
var Config = z.object({
  modelPrefixes: z.array(z.string()).default(["deepseek-"]),
  peakWeekdays: z.array(z.number()).default([1, 2, 3, 4, 5]),
  peakWindows: z.array(z.array(z.number())).default([[60, 240], [360, 600]]),
  leadMinutes: z.number().default(30),
  peakMultiplier: z.number().default(2)
});
function resolveSchedule(config) {
  const weekdays = config.peakWeekdays;
  if (weekdays.length === 0) {
    throw new Error("deepseek-peak-warning: peakWeekdays must list at least one ISO weekday");
  }
  for (const weekday of weekdays) {
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new Error(`deepseek-peak-warning: peakWeekdays entries must be ISO weekday numbers 1-7, got ${weekday}`);
    }
  }
  const rawWindows = config.peakWindows;
  if (rawWindows.length === 0) {
    throw new Error("deepseek-peak-warning: peakWindows must list at least one window");
  }
  const windows = rawWindows.map((pair) => {
    if (pair.length !== 2) {
      throw new Error(`deepseek-peak-warning: every peakWindows entry is a [startMinute, endMinute] pair, got ${JSON.stringify(pair)}`);
    }
    const [start, end] = pair;
    for (const bound of [start, end]) {
      if (!Number.isFinite(bound) || bound < 0 || bound > MINUTES_PER_DAY) {
        throw new Error(`deepseek-peak-warning: peakWindows bounds are minutes within one UTC day (0-${MINUTES_PER_DAY}), got ${bound}`);
      }
    }
    if (start >= end) {
      throw new Error(`deepseek-peak-warning: peak window [${start}, ${end}) must end after it starts; a window never crosses UTC midnight, so split it into two`);
    }
    return { startMinute: start, endMinute: end };
  });
  const leadMinutes = config.leadMinutes;
  if (!Number.isFinite(leadMinutes) || leadMinutes < 0) {
    throw new Error(`deepseek-peak-warning: leadMinutes must be a finite value >= 0, got ${leadMinutes}`);
  }
  const multiplier = config.peakMultiplier;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error(`deepseek-peak-warning: peakMultiplier must be a finite value >= 1, got ${multiplier}`);
  }
  return {
    schedule: { weekdays: [...new Set(weekdays)].sort((a, b) => a - b), windows },
    leadMs: leadMinutes * MS_PER_MINUTE2
  };
}
function localTime(atMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).formatToParts(new Date(atMs));
  const field = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const stamp = `${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
  const zone = field("timeZoneName");
  return zone.length > 0 ? `${stamp} ${zone}` : stamp;
}
function utcTime(atMs) {
  const at = new Date(atMs);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
}
function minutesUntil(leadMs) {
  return Math.max(1, Math.round(leadMs / MS_PER_MINUTE2));
}
function peakNotice(state, multiplier) {
  const { startMs, endMs } = state.window;
  return `Pricing notice: this session is inside a DeepSeek peak-pricing window.
- rate: ${multiplier}x the off-peak price
- window: ${localTime(startMs)} to ${localTime(endMs)} (${utcTime(startMs)} to ${utcTime(endMs)})
Off-peak rates resume when the window closes. Continue if the work matters more than the difference.`;
}
function approachingNotice(state, multiplier) {
  const { startMs, endMs } = state.window;
  const minutes = minutesUntil(state.leadMs);
  return `Pricing notice: a DeepSeek peak-pricing window opens in about ${minutes} minute${minutes === 1 ? "" : "s"}.
- opens: ${localTime(startMs)} (${utcTime(startMs)})
- closes: ${localTime(endMs)} (${utcTime(endMs)})
- rate: ${multiplier}x the off-peak price
Requests started after it opens cost more. Finish or defer long work now if the difference matters.`;
}
function buildNotice(state, multiplier) {
  if (state.kind === "peak") {
    return createUserMessage({
      content: [{ type: "text", text: peakNotice(state, multiplier) }],
      source: {
        kind: "plugin",
        plugin: name,
        form: "notice",
        summary: boundContextSummary(`DeepSeek peak pricing active until ${localTime(state.window.endMs)}`)
      }
    });
  }
  if (state.kind === "approaching") {
    return createUserMessage({
      content: [{ type: "text", text: approachingNotice(state, multiplier) }],
      source: {
        kind: "plugin",
        plugin: name,
        form: "notice",
        summary: boundContextSummary(`DeepSeek peak pricing starts in ~${minutesUntil(state.leadMs)} min`)
      }
    });
  }
  return void 0;
}
function apply(ctx, config) {
  const { schedule, leadMs } = resolveSchedule(config);
  const prefixes = config.modelPrefixes.filter((prefix) => prefix.length > 0);
  const multiplier = config.peakMultiplier;
  const tracked = (model) => prefixes.length === 0 || prefixes.some((prefix) => model.startsWith(prefix));
  const announcedByAgent = /* @__PURE__ */ new WeakMap();
  ctx.on("agent/request", async ({ agent }, next) => {
    const resolved = await next();
    if (!tracked(resolved.model)) return resolved;
    const state = classifyPeakState(Date.now(), schedule, leadMs);
    const key = announcementKey(state);
    if (key === void 0 || announcedByAgent.get(agent) === key) return resolved;
    const notice = buildNotice(state, multiplier);
    if (notice === void 0) return resolved;
    announcedByAgent.set(agent, key);
    agent.inject(notice);
    return resolved;
  });
}
export {
  Config,
  apply,
  name
};
