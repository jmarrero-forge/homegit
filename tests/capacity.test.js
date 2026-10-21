// Offline tests of lib/capacity.js (buckets, attribution, projection math),
// lib/backends.js (backend windows and readings) and of bin/bot-actuals
// and bin/bot-capacity against fake bot-cost and bot-board commands, and
// a fake bot-coordinator-loop state. Run with tests/capacity.sh, or node
// --test tests/capacity.test.js.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const BIN = path.join(__dirname, "..", "bin");
const FIXTURES = path.join(__dirname, "fixtures", "bot-cost");
const cap = require(path.join(__dirname, "..", "lib", "capacity.js"));
const backends = require(path.join(__dirname, "..", "lib", "backends.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY = cap.DAY_MS;
const NOW = Date.parse("2026-09-24T00:00:00Z");

test("bucket parsing: option names, bare keys, junk", () => {
  const cases = [
    ["XS (<200k tok)", "XS"], ["S (<1M tok)", "S"], ["M (<5M tok)", "M"], ["L (<20M tok)", "L"],
    ["XL (>20M tok)", "XL"], ["xl", "XL"], [" s ", "S"], ["Small", null], ["", null], [undefined, null], ["XXL", null],
  ];
  for (const [s, want] of cases) assert.equal(cap.bucketOf(s)?.key ?? null, want, String(s));
  for (const b of cap.BUCKETS) assert.equal(cap.bucketOf(b.option), b, b.option);
});

test("buckets by token count are half-open at the upper bound", () => {
  const cases = [[0, "XS"], [199999, "XS"], [200e3, "S"], [999999, "S"], [1e6, "M"], [5e6, "L"], [19999999, "L"], [20e6, "XL"], [1e9, "XL"]];
  for (const [n, want] of cases) assert.equal(cap.bucketForTokens(n).key, want, String(n));
});

test("item markers: Item: line, URL forms, PVTI fallback", () => {
  const url = "https://github.com/o/r/issues/5";
  const cases = [
    [`Read the preamble.\nItem: ${url}\nGo.`, url],
    [`Item: ${url}#issuecomment-1.`, url],
    ["- Item: https://github.com/O/R/pull/7/files", "https://github.com/o/r/pull/7"],
    ["  Item: PVTI_abc-1_x", "PVTI_abc-1_x"],
    ["Board item PVTI_item1: claim it.", "PVTI_item1"],
    ["Item: not-an-item, but see PVTI_zz", "PVTI_zz"],
    ["See https://github.com/o/r/issues/5 for the Item: idea", null],
    ["no marker", null],
  ];
  for (const [prompt, want] of cases) assert.equal(cap.itemMarker(prompt), want, prompt);
});

const ITEMS = [
  { id: "PVTI_a", status: "Done", priority: "P0", content: { url: "https://github.com/o/r/issues/1" }, branch: "https://github.com/f/r/pull/9 https://github.com/f/r/pull/10", title: "A" },
  { id: "PVTI_b", status: "Done", priority: "P1", content: { url: "https://github.com/o/r/issues/2" }, title: "B", "actual tokens": 5 },
  { id: "PVTI_c", status: "Todo", priority: "P0", content: { url: "https://github.com/o/r/issues/3" }, title: "C" },
];

test("attribution: by id, issue URL or Branch PR URL; unmatched tasks dropped", () => {
  const tasks = [
    { item: "PVTI_a", fresh_tokens: 100 },
    { item: "https://github.com/o/r/issues/1", fresh_tokens: 20 },
    { item: "https://github.com/f/r/pull/10", fresh_tokens: 3 },
    { item: "https://github.com/o/r/issues/2", fresh_tokens: 7 },
    { item: "https://github.com/o/r/issues/99", fresh_tokens: 1000 },
    { item: null, fresh_tokens: 1000 },
  ];
  assert.deepEqual(cap.attribute(tasks, ITEMS), { PVTI_a: 123, PVTI_b: 7 });
});

test("projection: burn rate and percent at reset", () => {
  // Halfway through the week at 30%: 60/7 per day, 60% at the reset.
  let p = cap.weekProjection({ usedPercent: 30, resetsAt: NOW + 3.5 * DAY, now: NOW });
  assert.ok(Math.abs(p.burn_per_day - 30 / 3.5) < 1e-9);
  assert.ok(Math.abs(p.projected - 60) < 1e-9);
  assert.ok(Math.abs(p.elapsed_days - 3.5) < 1e-9);
  // Too early in the week to extrapolate.
  p = cap.weekProjection({ usedPercent: 10, resetsAt: NOW + 6.8 * DAY, now: NOW });
  assert.equal(p.projected, null);
  // A reset time more than a week out (clock skew) clamps elapsed to 0.
  p = cap.weekProjection({ usedPercent: 10, resetsAt: NOW + 8 * DAY, now: NOW });
  assert.equal(p.projected, null);
  assert.equal(p.burn_per_day, 0);
  // Past 100% already.
  p = cap.weekProjection({ usedPercent: 100, resetsAt: NOW + 1 * DAY, now: NOW });
  assert.ok(Math.abs(p.projected - 100 * 7 / 6) < 1e-9);
});

test("projection over a window of any length: Copilot's month, a 5-hour window", () => {
  // 20% by day 10 of a 30-day month: 2 per day, 60% at the reset.
  const p = cap.windowProjection({ usedPercent: 20, start: NOW - 10 * DAY, end: NOW + 20 * DAY, now: NOW });
  assert.ok(Math.abs(p.burn_per_day - 2) < 1e-9);
  assert.ok(Math.abs(p.projected - 60) < 1e-9);
  // A month still waits 12 hours; 5 hours wait a 14th of theirs.
  const HOUR = 3600e3;
  const cases = [[DAY * 30, 11.9 * HOUR, false], [DAY * 30, 12 * HOUR, true], [5 * HOUR, 20 * 60e3, false], [5 * HOUR, 22 * 60e3, true]];
  for (const [length, elapsed, want] of cases) {
    const q = cap.windowProjection({ usedPercent: 10, start: NOW - elapsed, end: NOW - elapsed + length, now: NOW });
    assert.equal(q.projected !== null, want, `${elapsed / HOUR}h of ${length / HOUR}h`);
  }
});

test("backend windows: Claude's 7-day file probe, Copilot's calendar month", () => {
  const t = (s) => Date.parse(s);
  const now = t("2026-10-21T03:00:00Z");
  const cases = [
    ["7-day", { type: "file", window: "seven_day" }, t("2026-10-24T22:00:00Z"), [t("2026-10-17T22:00:00Z"), t("2026-10-24T22:00:00Z")]],
    ["unknown file window", { type: "file", window: "fortnight" }, t("2026-10-24T22:00:00Z"), null],
    ["file without a reset", { type: "file", window: "seven_day" }, null, null],
    ["Copilot", { type: "copilot" }, t("2026-11-01T00:00:00Z"), [t("2026-10-01T00:00:00Z"), t("2026-11-01T00:00:00Z")]],
    ["Copilot, no reading", { type: "copilot" }, null, [t("2026-10-01T00:00:00Z"), t("2026-11-01T00:00:00Z")]],
    ["a shorter month before", { type: "copilot" }, t("2026-03-31T00:00:00Z"), [t("2026-02-28T00:00:00Z"), t("2026-03-31T00:00:00Z")]],
    ["no probe", { type: "none" }, t("2026-11-01T00:00:00Z"), null],
    ["a command's", { type: "command" }, t("2026-11-01T00:00:00Z"), null],
  ];
  for (const [what, probe, resets, want] of cases) {
    const w = backends.windowOf(probe, resets, now);
    assert.deepEqual(w && [w.start, w.end], want, what);
  }
});

test("backend readings: fresh ones only, and why not", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const fresh = { used_percent: 12, observed_at: iso(NOW - 60e3), resets_at: iso(NOW + DAY) };
  const cases = [
    ["fresh", fresh, 12, null],
    ["a failed probe keeps a fresh reading", { ...fresh, probe_error: "timed out" }, 12, null],
    ["no reading, a failed probe", { probe_error: "unexpected response", used_percent: null }, null, "probe: unexpected response"],
    ["not probed yet", {}, null, "no reading yet"],
    ["stale", { ...fresh, observed_at: iso(NOW - 2 * 3600e3) }, null, /^stale \(observed /],
    ["stale, and the probe failing", { ...fresh, observed_at: iso(NOW - 2 * 3600e3), probe_error: "HTTP 500" }, null, /; probe: HTTP 500\)$/],
    ["its window reset", { ...fresh, resets_at: iso(NOW - 1) }, null, /^its window reset at /],
    ["no reset time", { ...fresh, resets_at: null }, 12, null],
  ];
  for (const [what, v, used, why] of cases) {
    const r = backends.readingOf(v, NOW);
    assert.equal(r.reading ? r.reading.used_percent : null, used, what);
    if (why instanceof RegExp) assert.match(r.why, why, what);
    else assert.equal(r.why, why, what);
  }
});

test("calibration needs enough tokens", () => {
  assert.equal(cap.percentPerToken({ usedPercent: 10, tokens: 1e5 }), null);
  assert.equal(cap.percentPerToken({ usedPercent: 0, tokens: 1e7 }), null);
  assert.equal(cap.percentPerToken({ usedPercent: 10, tokens: 1e7 }), 1e-6);
});

test("dispatch advice: all below 80%, P0 only from 80%, none at 100%", () => {
  const cases = [[0, "all"], [79.9, "all"], [80, "p0"], [99.9, "p0"], [100, "none"], [250, "none"]];
  for (const [proj, want] of cases) assert.equal(cap.dispatchAdvice(proj).scope, want, String(proj));
  const a = cap.dispatchAdvice(70);
  assert.equal(a.headroom, 30);
  assert.ok(a.fits(30) && !a.fits(30.1));
  // Used up at a backend's threshold instead, with "P0 only" no later.
  const limited = [[79.9, 95, "all"], [80, 95, "p0"], [95, 95, "none"], [69.9, 70, "all"], [70, 70, "none"]];
  for (const [proj, limit, want] of limited) assert.equal(cap.dispatchAdvice(proj, limit).scope, want, `${proj} of ${limit}`);
  assert.equal(cap.dispatchAdvice(80, 95).headroom, 15);
});

test("report on a backend: handoff headroom while a next one is up, the threshold on the last", () => {
  const items = [{ id: "x", status: "Todo", priority: "P0", "est. cost": "M (<5M tok)" }];
  const claude = { name: "claude", leave_at: 95, available: true, why: null };
  // 40% by day 3.5 of the week on 40M tokens: 80% projected, 2.5% for an M.
  const rate = { usedPercent: 40, resetsAt: NOW + 3.5 * DAY };
  const cases = [
    ["next up: no P0-only step, room before the handoff", { ...claude, next: "opencode" }, rate, "all", 55, /until the handoff to opencode at 95%/],
    ["next up, past the threshold", { ...claude, next: "opencode" }, { ...rate, usedPercent: 96 }, "none", -1, /handoff/],
    ["next up, no reading", { ...claude, next: "opencode" }, null, "unknown", null, /opencode takes over at claude's 95%/],
    ["the last one: P0 only from 80%", { ...claude, next: null }, rate, "p0", 15, /claude is the last available backend, used up at 95%/],
    ["the last one: nothing at its threshold", { ...claude, next: null }, { ...rate, usedPercent: 48 }, "none", 95 - 96, /last available/],
    ["at its threshold, handing off", { ...claude, available: false, why: "at its threshold", next: "opencode" }, rate, "none", null,
      /claude is at its threshold; the session hands off to opencode/],
    ["at its threshold, the last", { ...claude, available: false, why: "at its threshold", next: null }, rate, "none", null,
      /no other backend is available/],
  ];
  for (const [what, backend, r, scope, headroom, reason] of cases) {
    const rep = cap.capacityReport({ rate: r, weekTokens: 40e6, budget: null, items, now: NOW, backend });
    assert.equal(rep.dispatch.scope, scope, what);
    if (headroom === null) assert.equal(rep.dispatch.headroom, null, what);
    else assert.ok(Math.abs(rep.dispatch.headroom - headroom) < 1e-9, `${what}: headroom ${rep.dispatch.headroom}`);
    assert.match(rep.dispatch.reason, reason, what);
    assert.equal(rep.backend.name, "claude", what);
  }
  // A month's window: 20% by day 10 of 30, 60% projected.
  const month = cap.capacityReport({ rate: { usedPercent: 20, startsAt: NOW - 10 * DAY, resetsAt: NOW + 20 * DAY }, weekTokens: 1e7,
    budget: null, items, now: NOW, backend: { name: "opencode", leave_at: 95, available: true, next: null } });
  assert.equal(month.source, "backend");
  assert.ok(Math.abs(month.projected - 60) < 1e-9);
  assert.equal(month.dispatch.scope, "all");
  // A 5-hour window, the last backend: 80% after 4 hours projects to 100%,
  // past its 95%.
  const HOUR = 3600e3;
  const short = cap.capacityReport({ rate: { usedPercent: 80, startsAt: NOW - 4 * HOUR, resetsAt: NOW + HOUR }, weekTokens: 1e7,
    budget: null, items, now: NOW, backend: { name: "claude", leave_at: 95, available: true, next: null } });
  assert.ok(Math.abs(short.projected - 100) < 1e-9);
  assert.equal(short.dispatch.scope, "none");
});

test("report: statusline reading, estimates summed by bucket", () => {
  const items = [
    ...["XS (<200k tok)", "S (<1M tok)", "S (<1M tok)", "L (<20M tok)", undefined].map((e, i) => ({ id: `p0${i}`, status: "Todo", priority: "P0", "est. cost": e })),
    { id: "p1", status: "In Progress", priority: "P1", "est. cost": "M (<5M tok)" },
    { id: "p2", status: "Todo", priority: "P2", "est. cost": "XL (>20M tok)" },
    { id: "d", status: "Done", priority: "P0", "est. cost": "XL (>20M tok)" },
    { id: "dr", status: "Draft", priority: "P1", "est. cost": "XL (>20M tok)" },
  ];
  // 40% used by day 3.5 on 40M tokens: 1e-6 percent per token, 80% projected.
  const r = cap.capacityReport({ rate: { usedPercent: 40, resetsAt: NOW + 3.5 * DAY }, weekTokens: 40e6, budget: null, items, now: NOW });
  assert.equal(r.source, "statusline");
  assert.ok(Math.abs(r.projected - 80) < 1e-9);
  assert.equal(r.dispatch.scope, "p0");
  const p0 = r.estimates.P0;
  assert.deepEqual([p0.XS.count, p0.S.count, p0.L.count, p0.unestimated], [1, 2, 1, 1]);
  assert.equal(p0.tokens, 100e3 + 2 * 500e3 + 10e6);
  assert.ok(Math.abs(p0.percent - 11.1) < 1e-9);
  assert.equal(r.estimates.P1.M.count, 1);
  assert.equal(r.estimates.P1.XL.count, 0);
  // 20% headroom: P0's 11.1% fits, then P1's 2.5% does too.
  assert.deepEqual([p0.fits, r.estimates.P1.fits], [true, true]);
  assert.ok(Math.abs(r.dispatch.headroom - 20) < 1e-9);
});

test("report: estimates that exceed the headroom do not fit; budget and token-only fallbacks", () => {
  const items = [{ id: "x", status: "Todo", priority: "P0", "est. cost": "XL (>20M tok)" }];
  let r = cap.capacityReport({ rate: { usedPercent: 50, resetsAt: NOW + 3.5 * DAY }, weekTokens: 50e6, budget: null, items, now: NOW });
  assert.ok(Math.abs(r.projected - 100) < 1e-9);
  assert.equal(r.dispatch.scope, "none");
  assert.equal(r.estimates.P0.fits, false);
  // A rolling week against a budget: 60M of 100M, 30M of XL is 30%.
  r = cap.capacityReport({ rate: null, weekTokens: 60e6, budget: 100e6, items, now: NOW });
  assert.equal(r.source, "budget");
  assert.ok(Math.abs(r.projected - 60) < 1e-9);
  assert.ok(Math.abs(r.estimates.P0.percent - 30) < 1e-9);
  assert.equal(r.estimates.P0.fits, true);
  // No rate, no budget: only tokens.
  r = cap.capacityReport({ rate: null, weekTokens: 7e6, budget: null, items, now: NOW });
  assert.equal(r.dispatch.scope, "unknown");
  assert.equal(r.burn_tokens_per_day, 1e6);
  assert.equal(r.estimates.P0.percent, null);
  assert.equal(r.estimates.P0.tokens, 30e6);
});

// --- the tools, against fakes ---------------------------------------------------

function fake(name, body) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return f;
}

const COST_JSON = JSON.stringify({
  totals: { fresh_tokens: 40e6 },
  tasks: [{ item: "PVTI_a", fresh_tokens: 1234 }, { item: "https://github.com/o/r/issues/2", fresh_tokens: 5 }, { item: "PVTI_c", fresh_tokens: 9 }],
});
const BOARD_LOG = path.join(TMP, "board.log");
const fakeCost = fake("cost", `echo "$@" >>${TMP}/cost.log; cat <<'EOF'\n${COST_JSON}\nEOF`);
const fakeBoard = fake("board", `if test "$1" = list; then cat <<'EOF'\n${JSON.stringify(ITEMS)}\nEOF\nelse echo "$@" >>${BOARD_LOG}; fi`);

test("bot-actuals sets Actual tokens on Done items without one; --dry-run only prints", () => {
  const env = { ...process.env, BOT_ACTUALS_COST: fakeCost, BOT_ACTUALS_BOARD: fakeBoard };
  const run = (args) => execFileSync(path.join(BIN, "bot-actuals"), args, { env, encoding: "utf8" });
  assert.match(run(["--dry-run"]), /would set Actual tokens = 1234 on PVTI_a \(A\)/);
  assert.ok(!fs.existsSync(BOARD_LOG));
  const out = run([]);
  assert.match(out, /^set Actual tokens = 1234 on PVTI_a/m);
  // PVTI_b already has a value and PVTI_c is not Done.
  assert.doesNotMatch(out, /PVTI_[bc]/);
  assert.equal(fs.readFileSync(BOARD_LOG, "utf8"), "set PVTI_a --field Actual tokens 1234\n");
  assert.match(run(["--dry-run", "--all"]), /Actual tokens = 5 on PVTI_b/);
});

test("bot-capacity reads the statusline file and reports the projection", () => {
  const rate = path.join(TMP, "rate-limits.json");
  const base = { ...process.env, BOT_CAPACITY_COST: fakeCost, BOT_CAPACITY_BOARD: fakeBoard, BOT_CAPACITY_RATE_FILE: rate, BOT_CAPACITY_NOW: new Date(NOW).toISOString(),
    BOT_BACKEND_STATE: path.join(TMP, "no-backends.json") };
  const run = (args = [], env = {}) => execFileSync(path.join(BIN, "bot-capacity"), args, { env: { ...base, ...env }, encoding: "utf8" });
  fs.writeFileSync(rate, JSON.stringify({ observed_at: new Date(NOW - 60e3).toISOString(), seven_day: { used_percent: 40, resets_at: new Date(NOW + 3.5 * DAY).toISOString() } }));
  const r = JSON.parse(run(["--json"]));
  assert.equal(r.source, "statusline");
  assert.ok(Math.abs(r.projected - 80) < 1e-9);
  assert.match(fs.readFileSync(path.join(TMP, "cost.log"), "utf8"), /--since 2026-09-20T12:00:00.000Z /);
  assert.match(run(), /Dispatch: P0 only/);
  // A stale reading is ignored: with a budget the week is the trailing 7 days.
  fs.writeFileSync(rate, JSON.stringify({ observed_at: new Date(NOW - 2 * 3600e3).toISOString(), seven_day: { used_percent: 99, resets_at: new Date(NOW + DAY).toISOString() } }));
  assert.equal(JSON.parse(run(["--json", "--budget", "100000000"])).source, "budget");
  assert.equal(JSON.parse(run(["--json"])).source, "tokens");
});

test("bot-cost attributes a transcript to its Item: marker, with fresh tokens", () => {
  const dir = path.join(TMP, "proj");
  fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
  const t = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), "");
  fs.writeFileSync(path.join(dir, "s1", "subagents", "agent-x1.jsonl"), [
    t({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "Read the preamble.\nItem: https://github.com/o/r/issues/2\nScratch: /tmp/c/scratchpad/zz/" } }),
    t({ type: "assistant", timestamp: "2026-09-20T10:01:00Z", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 } } }),
  ].join("\n") + "\n");
  const env = { ...process.env, XDG_CACHE_HOME: TMP, BOT_COST_NOW: "2026-09-22T00:00:00Z", BOT_COST_MODELS_JSON: path.join(FIXTURES, "models.json") };
  const out = JSON.parse(execFileSync(path.join(BIN, "bot-cost"), ["--since", "2026-09-20", "--projects", dir, "--no-compute", "--json"], { env, encoding: "utf8" }));
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].item, "https://github.com/o/r/issues/2");
  assert.equal(out.tasks[0].tokens, 1060);
  assert.equal(out.tasks[0].fresh_tokens, 60);
  assert.equal(out.totals.fresh_tokens, 60);
  assert.deepEqual(cap.attribute(out.tasks, ITEMS), { PVTI_b: 60 });
});

test("bot-capacity measures the coordinator's active backend", () => {
  const state = path.join(TMP, "backend.json");
  const toml = path.join(TMP, "backends.toml");
  fs.writeFileSync(toml, [
    "[[backend]]", 'name = "claude"', 'command = ["claude"]', "leave_at = 95",
    'probe = { type = "file", path = "~/.cache/bot-heartbeat/rate-limits.json", window = "seven_day" }',
    "[[backend]]", 'name = "opencode"', 'command = ["opencode"]', "leave_at = 90", "return_below = 40",
    'probe = { type = "copilot", auth_env = "OPENCODE_AUTH_CONTENT" }', "",
  ].join("\n"));
  const iso = (ms) => new Date(ms).toISOString();
  const view = (claude, opencode) => fs.writeFileSync(state, JSON.stringify({ version: 1, phase: "running", ...claude.state, view: { claude: claude.view, opencode } }));
  const base = { ...process.env, BOT_CAPACITY_COST: fakeCost, BOT_CAPACITY_BOARD: fakeBoard, BOT_CAPACITY_NOW: iso(NOW),
    BOT_BACKEND_STATE: state, BOT_BACKENDS_TOML: toml, BOT_CAPACITY_RATE_FILE: path.join(TMP, "none.json") };
  const run = (args = [], env = {}) => execFileSync(path.join(BIN, "bot-capacity"), args, { env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const costLog = path.join(TMP, "cost.log");

  // opencode coordinates, Claude being used up: 65% of the month by day
  // 23 of 30 projects to 84.8%, P0 only below its 90%.
  view({ state: { active: "opencode" }, view: { available: false, why: "at its threshold", used_percent: 96, observed_at: iso(NOW - 60e3), resets_at: iso(NOW + DAY) } },
    { available: true, used_percent: 65, observed_at: iso(NOW - 60e3), resets_at: "2026-10-01T00:00:00Z" });
  fs.rmSync(costLog, { force: true });
  let r = JSON.parse(run(["--json"]));
  assert.deepEqual([r.source, r.backend.name, r.backend.leave_at, r.backend.next], ["backend", "opencode", 90, null]);
  assert.ok(Math.abs(r.projected - 65 * 30 / 23) < 1e-9);
  assert.equal(r.dispatch.scope, "p0");
  assert.match(fs.readFileSync(costLog, "utf8"), /--since 2026-09-01T00:00:00.000Z .*--source opencode/);
  let out = run();
  assert.match(out, /^Backends: claude \(unavailable: at its threshold\) 96\.0% used, leaves at 95%; opencode \(active\) 65\.0% used, leaves at 90%$/m);
  assert.match(out, /^Window \(opencode's usage reading\): /m);
  assert.match(out, /^Dispatch: P0 only \(projected at or above 80%\); opencode is the last available backend, used up at 90%; headroom after projection /m);

  // Claude coordinates, its probe failing: no percent, unless a budget.
  view({ state: { active: "claude" }, view: { available: true, probe_error: "unexpected response", used_percent: null } },
    { available: true, used_percent: 3, observed_at: iso(NOW - 60e3), resets_at: "2026-10-01T00:00:00Z" });
  fs.rmSync(costLog, { force: true });
  out = run();
  assert.match(out, /^Backends: claude \(active\) no reading \(probe: unexpected response\), leaves at 95%; opencode \(next\) 3\.0% used, leaves at 90%$/m);
  assert.match(out, /^Window \(tokens only; no reading for claude: probe: unexpected response, and no budget\): /m);
  assert.match(out, /^Dispatch: unknown \(no percent for claude: pass --budget\); opencode takes over at claude's 95%$/m);
  assert.match(fs.readFileSync(costLog, "utf8"), /--since 2026-09-17T00:00:00.000Z .*--source claude/);
  // 40M of 100M: 40%, 55% before the handoff.
  r = JSON.parse(run(["--json", "--budget", "100000000"]));
  assert.deepEqual([r.source, r.dispatch.scope], ["budget", "all"]);
  assert.ok(Math.abs(r.dispatch.headroom - 55) < 1e-9);

  // Without the config, the loop's default thresholds.
  out = run([], { BOT_BACKENDS_TOML: path.join(TMP, "missing.toml") });
  assert.match(out, /opencode \(next\) 3\.0% used, leaves at 95%$/m);
  assert.match(out, /^ {2}\(thresholds are bot-coordinator-loop's defaults: no backends config/m);
  // A state file that isn't JSON: measured as without backends, and said so.
  fs.writeFileSync(state, "{oops");
  assert.doesNotThrow(() => run());
  assert.doesNotMatch(run(), /^Backends:/m);
});

test("bot-capacity without backends counts only Claude's tokens, with an opencode database there", () => {
  const { makeOpencodeDb, tokens } = require(path.join(__dirname, "opencode-db.js"));
  const home = path.join(TMP, "home");
  const proj = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: "2026-09-23T10:00:00Z",
    message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 } } })}\n`);
  const data = path.join(TMP, "data");
  makeOpencodeDb(path.join(data, "opencode", "opencode.db"), [{ id: "ses_1", prompt: "Item: PVTI_x",
    messages: [{ id: "msg_1", ts: "2026-09-23T11:00:00Z", model: "github-copilot/gpt-9", tokens: tokens(5000, 100, 0, 0, 0) }] }]);
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(TMP, "cache"), XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(TMP, "state"),
    BOT_CAPACITY_BOARD: fakeBoard, BOT_CAPACITY_NOW: new Date(NOW).toISOString(), BOT_COST_NOW: new Date(NOW).toISOString(),
    BOT_COST_MODELS_JSON: path.join(FIXTURES, "models.json"), BOT_BACKEND_STATE: path.join(TMP, "no-backends.json") };
  delete env.BOT_CAPACITY_COST;
  const r = JSON.parse(execFileSync(path.join(BIN, "bot-capacity"), ["--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(r.source, "tokens");
  // The transcript's 60 fresh tokens, not opencode's 5100.
  assert.equal(r.used_tokens, 60);
});
