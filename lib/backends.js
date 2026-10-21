// The coordinator's model backends, where a harness runs it on several
// (atomic-setup's bot-coordinator-loop: Claude Code, then opencode, by
// default): which one is active, the next one it would hand off to, and
// each one's usage reading, thresholds and window. Shared by bot-capacity
// and bot-heartbeat. Node's standard library only, plus python3 for the
// TOML config (its tomllib).
//
// The loop keeps its view in ~/.local/state/bot-coordinator/backend.json:
//   {"active": "claude", "phase": "running", "view": {"claude":
//    {"available": true, "why": null, "probe_error": null,
//     "used_percent": 2.0, "observed_at": "...", "resets_at": "..."}, ...}}
// and the backends, in order of preference with their leave_at and
// return_below thresholds and probes, in ~/.config/bot-harness/
// backends.toml, else the image's /usr/local/share/bot-coordinator/
// backends.toml. Without the state file there is no such harness, and the
// callers measure Claude as they always did.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const STATE_FILE = process.env.BOT_BACKEND_STATE
  || path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "bot-coordinator", "backend.json");
// The loop reads the operator's file if there is one, else the image's;
// it looks under ~/.config whatever XDG_CONFIG_HOME says.
const CONFIG_FILES = process.env.BOT_BACKENDS_TOML
  ? [process.env.BOT_BACKENDS_TOML]
  : [path.join(HOME, ".config", "bot-harness", "backends.toml"), "/usr/local/share/bot-coordinator/backends.toml"];
const PYTHON = process.env.BOT_BACKENDS_PYTHON || "python3";
// bot-coordinator-loop's thresholds for a backend that sets none.
const DEFAULT_LEAVE_AT = 95;
const DEFAULT_RETURN_BELOW = 50;
// A reading older than this is no reading (the loop probes every 1 to 10
// minutes while it runs, so an older one means it stopped).
const MAX_READING_AGE_MS = 3600e3;
const HOUR_MS = 3600e3;
// A file probe's window (bot-heartbeat statusline's keys), by length.
const FILE_WINDOWS = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS };
// Where a backend's tokens are counted, by its name: Claude Code's
// transcripts, or opencode's database (see bot-cost --source).
const TOKEN_SOURCES = ["claude", "opencode"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// readConfig(): {file, backends: [{name, leave_at, return_below, probe:
// {type, window}}]}, in order of preference, or {error} when there is no
// config or it can't be read.
function readConfig() {
  const file = CONFIG_FILES.find((f) => fs.existsSync(f));
  if (!file) return { error: `no backends config (${CONFIG_FILES.join(", ")})` };
  let data;
  try {
    const py = "import json, sys, tomllib\nwith open(sys.argv[1], 'rb') as f: print(json.dumps(tomllib.load(f)))";
    data = JSON.parse(execFileSync(PYTHON, ["-I", "-c", py, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const detail = String(e.stderr || e.message).trim().split("\n").pop();
    return { file, error: `cannot read ${file}: ${detail}` };
  }
  const list = Array.isArray(data.backend) ? data.backend : [];
  const pct = (v, d) => (typeof v === "number" && v >= 0 && v <= 100 ? v : d);
  const backends = list.filter((b) => isObject(b) && typeof b.name === "string").map((b) => ({
    name: b.name,
    leave_at: pct(b.leave_at, DEFAULT_LEAVE_AT),
    return_below: pct(b.return_below, DEFAULT_RETURN_BELOW),
    probe: isObject(b.probe) ? { type: String(b.probe.type || "none"), window: b.probe.window || null } : { type: "none", window: null },
  }));
  return { file, backends };
}

// readState(): the loop's state, or null when there is none (no such
// harness here). Throws on a state file it can't parse.
function readState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read ${STATE_FILE}: ${e.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${STATE_FILE} is not JSON: ${e.message}`);
  }
  return isObject(state) ? state : null;
}

// monthBefore(ms): the same UTC time a calendar month earlier, on the
// month's last day if it is shorter.
function monthBefore(ms) {
  const d = new Date(ms);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

// windowOf(probe, resetsAt, now): {start, end} (ms) of the usage window a
// backend's probe reads, ending at resetsAt (ms) when it is known; null
// for a probe whose window isn't known. Copilot's premium requests reset
// at the start of each UTC month.
function windowOf(probe, resetsAt, now) {
  if (probe.type === "file" && FILE_WINDOWS[probe.window] && resetsAt) {
    return { start: resetsAt - FILE_WINDOWS[probe.window], end: resetsAt };
  }
  if (probe.type === "copilot") {
    if (resetsAt) return { start: monthBefore(resetsAt), end: resetsAt };
    const d = new Date(now);
    return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  }
  return null;
}

// readingOf(v, now): {reading, why}: a view entry's usable reading
// {used_percent, resets_at (ms or null), observed_at (ms)}, or null and
// why there is none. A failed probe that left an earlier reading still
// fresh enough leaves that reading.
function readingOf(v, now) {
  if (typeof v.used_percent !== "number") return { reading: null, why: v.probe_error ? `probe: ${v.probe_error}` : "no reading yet" };
  const observed = Date.parse(v.observed_at);
  const resets = v.resets_at ? Date.parse(v.resets_at) : null;
  if (!(now - observed < MAX_READING_AGE_MS)) {
    return { reading: null, why: `stale (observed ${v.observed_at || "?"}${v.probe_error ? `; probe: ${v.probe_error}` : ""})` };
  }
  if (resets !== null && !(resets > now)) return { reading: null, why: `its window reset at ${v.resets_at}` };
  return { reading: { used_percent: v.used_percent, resets_at: resets, observed_at: observed }, why: null };
}

// backendView(now): the harness's backends as the loop last saw them, or
// null without such a harness (no state file, or no active backend yet):
//   {active, phase, next, config_error, backends: [{name, active,
//    available, why, leave_at, return_below, probe, source, reading,
//    no_reading, window}]}
// in order of preference. next is the first available backend after the
// active one, as `bot-coordinator-loop status` says. Thresholds are the
// loop's defaults when the config can't be read (config_error says why).
function backendView(now) {
  const state = readState();
  if (!state || typeof state.active !== "string") return null;
  const view = isObject(state.view) ? state.view : {};
  const config = readConfig();
  const configured = config.backends || [];
  const names = [...configured.map((b) => b.name), ...Object.keys(view).filter((n) => !configured.some((b) => b.name === n))];
  if (!names.includes(state.active)) names.push(state.active);
  const backends = names.map((name) => {
    const c = configured.find((b) => b.name === name)
      || { leave_at: DEFAULT_LEAVE_AT, return_below: DEFAULT_RETURN_BELOW, probe: { type: "none", window: null } };
    const v = isObject(view[name]) ? view[name] : {};
    const { reading, why } = readingOf(v, now);
    return {
      name, active: name === state.active, available: v.available === true, why: v.why || null,
      leave_at: c.leave_at, return_below: c.return_below, probe: c.probe,
      source: TOKEN_SOURCES.includes(name) ? name : null,
      reading, no_reading: why, probe_error: v.probe_error || null,
      window: windowOf(c.probe, reading && reading.resets_at, now),
    };
  });
  const i = backends.findIndex((b) => b.active);
  const next = backends.slice(i + 1).find((b) => b.available);
  return { active: state.active, phase: state.phase || null, next: next ? next.name : null, config_error: config.error || null, backends };
}

module.exports = { backendView, windowOf, readingOf, readConfig, monthBefore, STATE_FILE, TOKEN_SOURCES, DEFAULT_LEAVE_AT, MAX_READING_AGE_MS };
