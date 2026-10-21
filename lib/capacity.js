// Cost buckets and capacity math shared by bot-cost, bot-actuals and
// bot-capacity. Node's standard library only.
//
// "Tokens" here are the fresh ones: input, output and cache writes.
// Cache reads (re-reading a conversation's context every turn) are left
// out: they are 90%+ of the raw count, grow with a session's length rather
// than with the work, and cost a tenth of an input token.
"use strict";

const DAY_MS = 86400e3;
const WEEK_MS = 7 * DAY_MS;

// The Est. cost field's options of the Workstream board, smallest first:
// upper bound in fresh tokens (null: none) and the expected size used when
// summing estimates (about the median of the tasks of that bucket).
const BUCKETS = [
  { key: "XS", option: "XS (<200k tok)", max: 200e3, expected: 100e3 },
  { key: "S", option: "S (<1M tok)", max: 1e6, expected: 500e3 },
  { key: "M", option: "M (<5M tok)", max: 5e6, expected: 2.5e6 },
  { key: "L", option: "L (<20M tok)", max: 20e6, expected: 10e6 },
  { key: "XL", option: "XL (>20M tok)", max: null, expected: 30e6 },
];

// The projected percent of the week's capacity above which only P0 work is
// dispatched.
const P0_ONLY_PERCENT = 80;
// Below this much of the week elapsed, a burn rate extrapolated to the
// reset says little (one busy morning projects to 400%). A shorter window
// (Claude's 5-hour one) needs the same share of its length, a 14th.
const MIN_ELAPSED_MS = 12 * 3600e3;
// A statusline reading is calibrated against the week's tokens only with
// at least this many of them.
const MIN_CALIBRATION_TOKENS = 1e6;

// bucketOf(s): the BUCKETS entry that a board option name ("S (<1M tok)")
// or a bare key ("s") names, or null.
function bucketOf(s) {
  if (typeof s !== "string") return null;
  const m = /^\s*(XS|S|M|L|XL)\b/i.exec(s);
  return m ? BUCKETS.find((b) => b.key === m[1].toUpperCase()) : null;
}

// bucketForTokens(n): the smallest bucket that holds n tokens.
function bucketForTokens(n) {
  return BUCKETS.find((b) => b.max === null || n < b.max);
}

// normalizeItem(s): the identity of a board item as a worker's "Item:"
// marker or the board names it: a PVTI_ id, or a GitHub issue or PR URL
// without fragment, query or trailing slash, lowercased; null otherwise.
function normalizeItem(s) {
  if (typeof s !== "string") return null;
  const t = s.trim().replace(/[)>\].,;]+$/, "");
  if (/^PVTI_[A-Za-z0-9_-]+$/.test(t)) return t;
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/.exec(t);
  return m ? `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`.toLowerCase() : null;
}

// itemMarker(prompt): the item a worker's prompt names on an "Item: X"
// line, normalised, else the first PVTI_ id in it, else null.
function itemMarker(prompt) {
  const m = /^[ \t>*-]*Item:[ \t]*(\S+)/im.exec(prompt);
  const marked = m && normalizeItem(m[1]);
  if (marked) return marked;
  const id = /\bPVTI_[A-Za-z0-9_-]+/.exec(prompt);
  return id ? id[0] : null;
}

// boardKeys(item): the keys under which the tokens of a `bot-board list
// --json` item may have been attributed: its id, its issue or PR URL and
// the PR URLs of its Branch field.
function boardKeys(item) {
  const urls = [item.content && item.content.url, ...String(item.branch || "").split(/\s+/)];
  return [item.id, ...urls.map(normalizeItem)].filter(Boolean);
}

// attribute(tasks, items): {item id: tokens} summing the fresh tokens of
// the tasks (bot-cost --json) whose item marker names a board item.
// Tasks with no marker, or one naming no item on the board, are dropped.
function attribute(tasks, items) {
  const byKey = new Map();
  for (const it of items) for (const k of boardKeys(it)) byKey.set(k, it.id);
  const out = {};
  for (const t of tasks) {
    const key = normalizeItem(t.item);
    const id = key && byKey.get(key);
    if (id) out[id] = (out[id] || 0) + (t.fresh_tokens || 0);
  }
  return out;
}

// windowProjection({usedPercent, start, end, now}): the burn rate in
// percent per day and the percent projected at the end of the usage
// window [start, end) (ms). projected is null while less than
// MIN_ELAPSED_MS of the window has passed (of a window shorter than a
// week, as large a share of it), and never below the usage so far.
function windowProjection({ usedPercent, start, end, now }) {
  const length = end - start;
  const elapsed = Math.min(Math.max(now - start, 0), length);
  const burn = elapsed > 0 ? (usedPercent / elapsed) * DAY_MS : 0;
  const minElapsed = Math.min(MIN_ELAPSED_MS, (length * MIN_ELAPSED_MS) / WEEK_MS);
  const projected = elapsed >= minElapsed ? Math.max(usedPercent, (burn * length) / DAY_MS) : null;
  return { start, elapsed_days: elapsed / DAY_MS, burn_per_day: burn, projected };
}

// weekProjection({usedPercent, resetsAt, now}): windowProjection for the
// 7-day window ending at resetsAt (ms).
function weekProjection({ usedPercent, resetsAt, now }) {
  return windowProjection({ usedPercent, start: resetsAt - WEEK_MS, end: resetsAt, now });
}

// percentPerToken({usedPercent, tokens}): how much of the week one fresh
// token takes, calibrated on this week so far; null without enough
// tokens to say.
function percentPerToken({ usedPercent, tokens }) {
  return tokens >= MIN_CALIBRATION_TOKENS && usedPercent > 0 ? usedPercent / tokens : null;
}

// sumEstimates(items): {bucket key: {count, tokens}} of the items'
// "est. cost" values, plus unestimated: how many had none.
function sumEstimates(items) {
  const out = { unestimated: 0 };
  for (const b of BUCKETS) out[b.key] = { count: 0, tokens: 0 };
  for (const it of items) {
    const b = bucketOf(it["est. cost"]);
    if (!b) out.unestimated++;
    else {
      out[b.key].count++;
      out[b.key].tokens += b.expected;
    }
  }
  return out;
}

// dispatchAdvice(projected, limit): what may be dispatched, with the
// week's capacity used up at LIMIT percent (100; a backend's leave_at,
// where the harness stops using it). `scope` is "all" (P0 and P1), "p0"
// (from P0_ONLY_PERCENT, or LIMIT if lower) or "none"; `headroom` is the
// percent left after the projection, and `fits(percent)` tells whether
// work of that size fits.
function dispatchAdvice(projected, limit = 100) {
  const headroom = limit - projected;
  const scope = projected >= limit ? "none" : projected >= Math.min(P0_ONLY_PERCENT, limit) ? "p0" : "all";
  return { scope, headroom, fits: (percent) => percent <= headroom };
}

// backendDispatch(r, backend): what may be dispatched on the active
// backend of a harness that hands off between several (see
// lib/backends.js), from report R's usage of it. While a next backend is
// available there is no P0-only step, since the next one takes the rest:
// all work fits that ends before the handoff at the backend's leave_at,
// so the headroom is what is left of the usage until then (workers still
// running at the handoff stop with the session). On the last available
// backend, as with one backend, but used up at its leave_at. An
// unavailable active backend (at its threshold) is about to hand off, or
// there is nothing left: nothing new either way.
function backendDispatch(r, backend) {
  const why = backend.why || "unavailable";
  if (!backend.available) {
    return { scope: "none", headroom: null,
      reason: backend.next ? `${backend.name} is ${why}; the session hands off to ${backend.next}` : `${backend.name} is ${why}, and no other backend is available` };
  }
  if (backend.next) {
    if (r.used_percent === null) return { scope: "unknown", headroom: null, reason: `${backend.next} takes over at ${backend.name}'s ${backend.leave_at}%` };
    const headroom = backend.leave_at - r.used_percent;
    return { scope: headroom > 0 ? "all" : "none", headroom, reason: `until the handoff to ${backend.next} at ${backend.leave_at}%` };
  }
  const reason = `${backend.name} is the last available backend, used up at ${backend.leave_at}%`;
  if (r.projected === null) return { scope: "unknown", headroom: null, reason };
  const a = dispatchAdvice(r.projected, backend.leave_at);
  return { scope: a.scope, headroom: a.headroom, reason };
}

// The board statuses whose items are work still to be spent on, and the
// priorities capacity planning covers.
const OPEN_STATUSES = ["Todo", "In Progress"];
const PLANNED_PRIORITIES = ["P0", "P1"];

// capacityReport({rate, weekTokens, budget, items, now, backend}): the
// week's usage, burn rate and projection, the open P0/P1 estimates by
// bucket, and what may be dispatched.
//   rate        {usedPercent, resetsAt (ms), startsAt (ms; default a week
//               before resetsAt)}: the statusline's or the active
//               backend's reading, or null
//   weekTokens  fresh tokens spent in the window (since its start for a
//               rate, else the trailing 7 days)
//   budget      weekly fresh tokens, used when there is no rate; or null
//   items       `bot-board list --json` items
//   backend     with a harness that hands off between backends, the
//               active one: {name, leave_at, available, why, next} (see
//               backendDispatch); or null
// With neither a rate nor a budget there are only token totals and no
// percent, and dispatch.scope is "unknown".
function capacityReport({ rate, weekTokens, budget, items, now, backend = null }) {
  const r = { source: "tokens", used_tokens: weekTokens, used_percent: null, burn_per_day: null, projected: null,
    resets_at: null, percent_per_token: null, burn_tokens_per_day: null };
  if (rate) {
    const p = windowProjection({ usedPercent: rate.usedPercent, start: rate.startsAt ?? rate.resetsAt - WEEK_MS, end: rate.resetsAt, now });
    Object.assign(r, { source: backend ? "backend" : "statusline", used_percent: rate.usedPercent, burn_per_day: p.burn_per_day,
      projected: p.projected, resets_at: new Date(rate.resetsAt).toISOString(), elapsed_days: p.elapsed_days,
      percent_per_token: percentPerToken({ usedPercent: rate.usedPercent, tokens: weekTokens }),
      burn_tokens_per_day: p.elapsed_days > 0 ? weekTokens / p.elapsed_days : null });
  } else if (budget > 0) {
    // A rolling week: its usage already is the steady-state projection.
    const used = (weekTokens / budget) * 100;
    Object.assign(r, { source: "budget", used_percent: used, burn_per_day: used / 7, projected: used,
      percent_per_token: 100 / budget, burn_tokens_per_day: weekTokens / 7 });
  } else {
    r.burn_tokens_per_day = weekTokens / 7;
  }
  const open = items.filter((it) => OPEN_STATUSES.includes(it.status));
  r.estimates = {};
  for (const prio of PLANNED_PRIORITIES) {
    const e = sumEstimates(open.filter((it) => it.priority === prio));
    e.tokens = BUCKETS.reduce((n, b) => n + e[b.key].tokens, 0);
    e.percent = r.percent_per_token ? e.tokens * r.percent_per_token : null;
    e.fits = null;
    r.estimates[prio] = e;
  }
  if (backend) {
    r.backend = { name: backend.name, leave_at: backend.leave_at, available: backend.available, why: backend.why || null, next: backend.next || null };
    r.dispatch = backendDispatch(r, backend);
  } else if (r.projected === null) {
    r.dispatch = { scope: "unknown", headroom: null };
  } else {
    const a = dispatchAdvice(r.projected);
    r.dispatch = { scope: a.scope, headroom: a.headroom };
  }
  let left = r.dispatch.headroom;
  if (left !== null) {
    for (const prio of PLANNED_PRIORITIES) {
      const e = r.estimates[prio];
      e.fits = e.percent === null ? null : e.percent <= left;
      if (e.percent !== null) left -= e.percent;
    }
  }
  return r;
}

module.exports = {
  capacityReport, OPEN_STATUSES, PLANNED_PRIORITIES,
  BUCKETS, DAY_MS, WEEK_MS, P0_ONLY_PERCENT, MIN_ELAPSED_MS, MIN_CALIBRATION_TOKENS,
  bucketOf, bucketForTokens, normalizeItem, itemMarker, boardKeys, attribute,
  windowProjection, weekProjection, percentPerToken, sumEstimates, dispatchAdvice, backendDispatch,
};
