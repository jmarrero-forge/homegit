// Offline tests of bin/bot-heartbeat's usage snapshot: what statusline
// keeps of Claude Code's status line input, and the token sums over the
// synthetic transcripts in tests/fixtures/bot-heartbeat, and over an
// opencode database built by tests/opencode-db.js where the coordinator
// runs on several backends. Run with tests/bot-heartbeat-usage.sh, or
// node --test on this file.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TOOL = path.join(__dirname, "..", "bin", "bot-heartbeat");
const PROJECTS = path.join(__dirname, "fixtures", "bot-heartbeat", "projects");
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bot-heartbeat-usage-test-"));
const RATE_LIMITS = path.join(CACHE, "bot-heartbeat", "rate-limits.json");
const NOW = "2026-09-28T20:00:00Z";
const NOW_MS = Date.parse(NOW);
// bot-coordinator-loop's state and config, written only by the backends test.
const BACKEND_STATE = path.join(CACHE, "backend.json");
const BACKENDS_TOML = path.join(CACHE, "backends.toml");
const ENV = {
  ...process.env, XDG_CACHE_HOME: CACHE, BOT_HEARTBEAT_PROJECTS: PROJECTS, BOT_HEARTBEAT_NOW: NOW,
  XDG_DATA_HOME: path.join(CACHE, "data"), XDG_STATE_HOME: path.join(CACHE, "state"),
  BOT_BACKEND_STATE: BACKEND_STATE, BOT_BACKENDS_TOML: BACKENDS_TOML,
};

// The module reads its environment once, at load.
Object.assign(process.env, ENV);
const hb = require(TOOL);
const { makeOpencodeDb, tokens: ocTokens } = require(path.join(__dirname, "opencode-db.js"));
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

const run = (args, input) => execFileSync(TOOL, args, { env: ENV, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const tokens = (input, output, cache_read, cache_write) => ({ input, output, cache_read, cache_write });
const epoch = (s) => Date.parse(s) / 1000;
const statusline = (fiveHour, sevenDay) => ({
  session_id: "s-1", transcript_path: "/home/u/.claude/projects/p/s-1.jsonl", cwd: "/home/u/secret-project",
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  rate_limits: { five_hour: fiveHour, seven_day: sevenDay },
});
const saveRateLimits = (fiveHour, sevenDay) => run(["statusline"], JSON.stringify(statusline(fiveHour, sevenDay)));

test("rateLimitsOf keeps the two windows' percent and reset, and nothing else", () => {
  const cases = [
    ["both", { five_hour: { used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, seven_day: { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") } },
      { observed_at: NOW, five_hour: { used_percent: 23.5, resets_at: "2026-09-28T21:30:00Z" }, seven_day: { used_percent: 41, resets_at: "2026-10-03T13:00:00Z" } }],
    ["one", { seven_day: { used_percentage: 0, resets_at: epoch("2026-10-03T13:00:00Z") } }, { observed_at: NOW, seven_day: { used_percent: 0, resets_at: "2026-10-03T13:00:00Z" } }],
    ["malformed windows are dropped", { five_hour: { used_percentage: "23", resets_at: 1 }, seven_day: { used_percentage: 5, resets_at: -1 } }, null],
    ["an absurd percent", { five_hour: { used_percentage: 1e6, resets_at: epoch("2026-09-28T21:30:00Z") } }, null],
    ["no rate limits (an API key session)", undefined, null],
  ];
  for (const [what, rl, want] of cases) assert.deepEqual(hb.rateLimitsOf({ cwd: "/x", rate_limits: rl }, NOW_MS), want, what);
  assert.equal(hb.rateLimitsOf(null, NOW_MS), null);
});

test("statusline saves only the rate limits and prints a short line", () => {
  const out = saveRateLimits({ used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  // 23.46 is kept as 23.5, and printed rounded.
  assert.equal(out, "Opus · 5h 24% · 7d 41%\n");
  const saved = fs.readFileSync(RATE_LIMITS, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ["five_hour", "observed_at", "seven_day"]);
  assert.doesNotMatch(saved, /secret-project|transcript|s-1/);
  // Garbage in: no failure, just the line it can make.
  for (const input of ["not json", "", JSON.stringify({ model: { display_name: "Opus" } })]) {
    assert.match(run(["statusline"], input), /^(Opus)?\n$/);
  }
});

test("usage without a status line reading: the last 5 hours and 7 days", () => {
  fs.rmSync(RATE_LIMITS, { force: true });
  const { usage, workerTokens } = hb.collectUsage(NOW_MS);
  assert.deepEqual(usage, {
    windows: [
      // c1 (logged twice, counted once), w1, w2, r1, x1 and o1; not the synthetic message.
      { kind: "five_hour", since: "2026-09-28T15:00:00Z", requests: 6, tokens: tokens(123, 1652, 3502, 152) },
      // ...and c2, but not c3, which is older.
      { kind: "seven_day", since: "2026-09-21T20:00:00Z", requests: 7, tokens: tokens(124, 1662, 3502, 152) },
    ],
  });
  assert.equal(workerTokens.size, 0);
});

test("usage with a status line reading: its windows, and per-agent tokens", () => {
  saveRateLimits({ used_percentage: 23.46, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const agents = new Map([["w", ["aw1", "ar1"]], ["gone", ["nope"]]]);
  const { usage, workerTokens } = hb.collectUsage(NOW_MS, "s-1", agents);
  assert.deepEqual(usage, {
    observed_at: NOW,
    windows: [
      // From 16:30, its reset less 5 hours: o1 (16:00) is left out.
      { kind: "five_hour", since: "2026-09-28T16:30:00Z", used_percent: 23.5, resets_at: "2026-09-28T21:30:00Z", requests: 5, tokens: tokens(23, 652, 3502, 152) },
      // From 09-26 13:00: c2 (12:00) is left out.
      { kind: "seven_day", since: "2026-09-26T13:00:00Z", used_percent: 41, resets_at: "2026-10-03T13:00:00Z", requests: 6, tokens: tokens(123, 1652, 3502, 152) },
    ],
    // The coordinator's session in the 5-hour window: c1 only.
    coordinator_tokens: tokens(10, 100, 1000, 50),
  });
  assert.deepEqual([...workerTokens], [["w", tokens(11, 550, 2500, 100)]]);
  // Another session's agents aren't anyone's here.
  assert.equal(hb.collectUsage(NOW_MS, "other-session", agents).workerTokens.size, 0);
});

test("a window that has reset is not reported, and the cache is reused", () => {
  saveRateLimits({ used_percentage: 99, resets_at: epoch("2026-09-28T19:00:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const first = JSON.parse(run(["usage"]));
  assert.deepEqual(first.windows.map((w) => [w.kind, w.used_percent, w.since]), [["five_hour", undefined, "2026-09-28T15:00:00Z"], ["seven_day", 41, "2026-09-26T13:00:00Z"]]);
  // The second run reads the cached sums: the same answer.
  const cache = path.join(CACHE, "bot-heartbeat", "transcripts.json");
  assert.ok(fs.existsSync(cache));
  assert.deepEqual(JSON.parse(run(["usage"])), first);
  // A corrupt cache is rebuilt, not fatal.
  fs.writeFileSync(cache, "{oops");
  assert.deepEqual(JSON.parse(run(["usage"])), first);
});

test("a reading more than an hour old is not published", () => {
  saveRateLimits({ used_percentage: 10, resets_at: epoch("2026-09-28T21:30:00Z") }, { used_percentage: 41, resets_at: epoch("2026-10-03T13:00:00Z") });
  const later = Date.parse("2026-09-28T21:01:00Z");
  assert.equal(hb.collectUsage(later).usage.observed_at, undefined);
  assert.equal(hb.collectUsage(NOW_MS + 3600 * 1000).usage.observed_at, NOW);
});

test("publish goes on without usage when the transcripts can't be read", () => {
  const input = JSON.stringify({ coordinator: { session: "s-1", loop_state: "sleeping" }, workers: [] });
  const env = { ...ENV, BOT_HEARTBEAT_PROJECTS: path.join(CACHE, "broken") };
  fs.mkdirSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), { recursive: true });
  fs.chmodSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), 0o000);
  try {
    const out = execFileSync(TOOL, ["publish", "--dry-run"], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    assert.match(out, /"schema": "bot-heartbeat\/v1"/);
    assert.doesNotMatch(out, /bot-usage/);
  } finally {
    fs.chmodSync(path.join(env.BOT_HEARTBEAT_PROJECTS, "proj"), 0o755);
  }
});

test("usageSnapshot: what goes to the private repository", () => {
  fs.rmSync(RATE_LIMITS, { force: true });
  const heartbeat = { updated_at: "2026-09-28T19:59:00Z", coordinator: { session: "s-1", loop_state: "sleeping" }, workers: [] };
  const snap = hb.usageSnapshot(heartbeat, new Map([["w", ["aw1"]]]), NOW_MS);
  assert.deepEqual(Object.keys(snap), ["schema", "updated_at", "session", "windows", "coordinator_tokens", "workers"]);
  assert.equal(snap.schema, "bot-usage/v1");
  assert.deepEqual(snap.workers, [{ name: "w", tokens: tokens(10, 500, 2000, 100) }]);
  assert.match(hb.renderUsage(snap), /^<!-- bot-usage v1 -->\nUsage, 5-hour window: /);
});

test("validate keeps agent_ids out of the heartbeat", () => {
  const input = {
    updated_at: "2026-09-28T19:59:00Z",
    coordinator: { session: "s-1", loop_state: "sleeping" },
    workers: [{ name: "w", item_url: "https://github.com/o/r/pull/3", started_at: "2026-09-28T19:40:00Z", status: "testing", agent_ids: ["aw1", "ar1"] }],
  };
  const { hb: out, agentIds } = hb.validate(input, NOW_MS);
  assert.deepEqual(out.workers[0], { name: "w", item_url: "https://github.com/o/r/pull/3", started_at: "2026-09-28T19:40:00Z", status: "testing" });
  assert.deepEqual([...agentIds], [["w", ["aw1", "ar1"]]]);
  // opencode's task_ids.
  const oc = hb.validate({ ...input, workers: [{ ...input.workers[0], agent_ids: ["ses_eb96d7f15ffeR5Wp3JYW0Ds5ch"] }] }, NOW_MS);
  assert.deepEqual([...oc.agentIds], [["w", ["ses_eb96d7f15ffeR5Wp3JYW0Ds5ch"]]]);
  for (const bad of [["../x"], ["ses_"], ["ses_a-b"], "aw1", Array.from({ length: 9 }, (_, i) => `a${i}`)]) {
    assert.throws(() => hb.validate({ ...input, workers: [{ ...input.workers[0], agent_ids: bad }] }, NOW_MS), /agent_ids/);
  }
});

// writeBackends(): bot-coordinator-loop's config and state with opencode
// active, Claude used up.
function writeBackends() {
  fs.writeFileSync(BACKENDS_TOML, [
    "[[backend]]", 'name = "claude"', 'command = ["claude"]', 'probe = { type = "file", path = "x", window = "seven_day" }',
    "[[backend]]", 'name = "opencode"', 'command = ["opencode"]', 'probe = { type = "copilot", auth_env = "X" }', "",
  ].join("\n"));
  fs.writeFileSync(BACKEND_STATE, JSON.stringify({ active: "opencode", phase: "running", view: {
    claude: { available: false, why: "at its threshold", probe_error: null, used_percent: 96, observed_at: "2026-09-28T19:59:00Z", resets_at: "2026-10-03T13:00:00Z" },
    opencode: { available: true, why: null, probe_error: null, used_percent: 61.54, observed_at: "2026-09-28T19:55:00Z", resets_at: "2026-10-01T00:00:00Z" },
  } }));
}
const msg = (id, ts, t) => ({ id, ts, model: "github-copilot/gpt-9", tokens: t });
const removeBackends = () => {
  for (const f of [BACKEND_STATE, BACKENDS_TOML, ENV.XDG_DATA_HOME, ENV.XDG_STATE_HOME]) fs.rmSync(f, { recursive: true, force: true });
};

test("on several backends: opencode's month window, each backend, and opencode tasks' tokens", () => {
  fs.rmSync(RATE_LIMITS, { force: true });
  writeBackends();
  makeOpencodeDb(path.join(ENV.XDG_DATA_HOME, "opencode", "opencode.db"), [
    // The coordinator, a worker it started, and the worker's reviewer.
    { id: "ses_coord", messages: [msg("m1", "2026-09-28T19:00:00Z", ocTokens(1, 2, 0, 3, 0)), msg("m2", "2026-09-02T10:00:00Z", ocTokens(10, 0, 0, 0, 0))] },
    { id: "ses_work", parent_id: "ses_coord", messages: [msg("m3", "2026-09-28T18:00:00Z", ocTokens(100, 10, 5, 1000, 50))] },
    { id: "ses_rev", parent_id: "ses_work", messages: [msg("m4", "2026-09-28T19:30:00Z", ocTokens(7, 3, 0, 0, 0))] },
    // Last month's.
    { id: "ses_prev", messages: [msg("m5", "2026-08-30T10:00:00Z", ocTokens(1e6, 0, 0, 0, 0))] },
  ]);
  // An earlier opencode session's database, which bot-coordinator-loop archived.
  makeOpencodeDb(path.join(ENV.XDG_STATE_HOME, "bot-coordinator", "archive", "opencode", "20260910T000000Z-opencode", "opencode.db"), [
    { id: "ses_old", messages: [msg("m6", "2026-09-10T10:00:00Z", ocTokens(1000, 0, 0, 0, 0))] },
  ]);
  try {
    const { usage, workerTokens } = hb.collectUsage(NOW_MS, "ses_coord", new Map([["w", ["ses_work", "ses_rev"]], ["c", ["aw1"]]]));
    // Claude's windows are as before: its transcripts only.
    assert.deepEqual(usage.windows.slice(0, 2).map((w) => [w.kind, w.requests]), [["five_hour", 6], ["seven_day", 7]]);
    // The month of Copilot premium requests: every opencode session in it,
    // reasoning counted as output.
    assert.deepEqual(usage.windows[2], { kind: "opencode", since: "2026-09-01T00:00:00Z", used_percent: 61.5, resets_at: "2026-10-01T00:00:00Z",
      requests: 5, tokens: tokens(1118, 20, 1003, 50) });
    assert.deepEqual(usage.backends, [
      { name: "claude", active: false, available: false, used_percent: 96 },
      { name: "opencode", active: true, available: true, used_percent: 61.54 },
    ]);
    // The coordinator's 5-hour tokens; the worker with its reviewer, once,
    // and no Claude agent of another session.
    assert.deepEqual(usage.coordinator_tokens, tokens(1, 2, 3, 0));
    assert.deepEqual([...workerTokens], [["w", tokens(107, 18, 1000, 50)]]);
    assert.match(hb.renderUsage(hb.usageSnapshot({ updated_at: NOW, coordinator: { session: "ses_coord", loop_state: "sleeping" }, workers: [] }, new Map(), NOW_MS)),
      /; opencode window: 61\.5% used, resets 2026-10-01T00:00:00Z, 2k tokens \(20 output\) in 5 requests since 2026-09-01T00:00:00Z\./);
    // A failed probe with no reading: the window, without a percent.
    const state = JSON.parse(fs.readFileSync(BACKEND_STATE, "utf8"));
    state.view.opencode = { available: true, probe_error: "unexpected response", used_percent: null };
    fs.writeFileSync(BACKEND_STATE, JSON.stringify(state));
    const again = hb.collectUsage(NOW_MS).usage;
    assert.deepEqual([again.windows[2].since, again.windows[2].used_percent], ["2026-09-01T00:00:00Z", undefined]);
    assert.deepEqual(again.backends[1], { name: "opencode", active: true, available: true, used_percent: null, probe_error: "unexpected response" });
  } finally {
    removeBackends();
  }
});

test("a session in the live database and an archived copy counts once, all of its messages", () => {
  writeBackends();
  const live = path.join(ENV.XDG_DATA_HOME, "opencode", "opencode.db");
  const archive = (stamp) => path.join(ENV.XDG_STATE_HOME, "bot-coordinator", "archive", "opencode", `${stamp}-opencode`, "opencode.db");
  const work = (messages) => [{ id: "ses_coord", messages: [msg("c1", "2026-09-28T19:00:00Z", ocTokens(1, 0, 0, 0, 0))] },
    { id: "ses_work", parent_id: "ses_coord", messages }];
  const m1 = msg("w1", "2026-09-28T18:00:00Z", ocTokens(100, 20, 0, 0, 0));
  const m2 = msg("w2", "2026-09-28T19:00:00Z", ocTokens(5, 1, 0, 0, 0));
  const workers = new Map([["w", ["ses_work"]]]);
  const cases = [
    // An identical copy, as a move across filesystems could leave.
    ["an identical copy", [m1], [m1], tokens(100, 20, 0, 0)],
    // A copy taken before the session's last message.
    ["a partial copy", [m1, m2], [m1], tokens(105, 21, 0, 0)],
    ["the copy has the later message", [m1], [m1, m2], tokens(105, 21, 0, 0)],
  ];
  try {
    for (const [what, liveMsgs, archivedMsgs, want] of cases) {
      makeOpencodeDb(live, work(liveMsgs));
      makeOpencodeDb(archive("20260928T000000Z"), work(archivedMsgs));
      const { usage, workerTokens } = hb.collectUsage(NOW_MS, "ses_coord", workers);
      assert.deepEqual(workerTokens.get("w"), want, what);
      assert.deepEqual(usage.windows[2].tokens, tokens(want.input + 1, want.output, 0, 0), what);
    }
  } finally {
    removeBackends();
  }
});

test("publish keeps backends and usage out of the public heartbeat", () => {
  writeBackends();
  makeOpencodeDb(path.join(ENV.XDG_DATA_HOME, "opencode", "opencode.db"),
    [{ id: "ses_coord", messages: [msg("c1", "2026-09-28T19:00:00Z", ocTokens(1234, 0, 0, 0, 0))] }]);
  try {
    const input = JSON.stringify({ coordinator: { session: "ses_coord", loop_state: "sleeping" }, workers: [] });
    const out = run(["publish", "--dry-run"], input);
    const [heartbeat, usage] = out.split(hb.USAGE_MARKER);
    assert.match(usage, /"backends"/);
    assert.match(usage, /"kind": "opencode"/);
    assert.doesNotMatch(heartbeat, /backend|opencode|claude|used_percent|tokens|1234|probe/i);
  } finally {
    removeBackends();
  }
});
