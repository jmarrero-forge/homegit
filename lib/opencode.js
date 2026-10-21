// opencode's sessions, from its SQLite database: the token usage of each
// model call, and what tells a session's task apart (its first prompt, its
// directory, the commands it ran). Shared by bot-cost and bot-heartbeat.
// Node's standard library only: node:sqlite (Node 22.5 or later).
//
// opencode keeps everything in ${XDG_DATA_HOME:-~/.local/share}/opencode/
// opencode.db: a session row per session (a task subagent's has its
// parent's id in parent_id, and its id is the task_id the task tool
// returns), and a message row per message, whose data JSON holds an
// assistant message's model and tokens. bot-coordinator-loop moves that
// directory aside before each opencode coordinator session, into
// ~/.local/state/bot-coordinator/archive/opencode/STAMP-opencode/ (the
// newest few are kept), so the sessions before the last start are there.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode");
const DB_NAME = "opencode.db";
const ARCHIVE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "bot-coordinator", "archive", "opencode");

// defaultDatabases(): the live database, if any, then the archived ones,
// oldest first.
function defaultDatabases() {
  const out = [];
  let archived = [];
  try {
    archived = fs.readdirSync(ARCHIVE_DIR).sort().map((d) => path.join(ARCHIVE_DIR, d, DB_NAME));
  } catch {
    // no archive: opencode never coordinated here
  }
  for (const f of [path.join(DATA_DIR, DB_NAME), ...archived]) if (fs.existsSync(f)) out.push(f);
  return out;
}

let sqlite;
// loadSqlite(): node:sqlite, or null on a Node without it. Node 22 and 24
// warn that it is experimental on stderr, which would end up in every
// caller's output, so that one warning is dropped.
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning))) return undefined;
    return emit.call(process, warning, ...rest);
  };
  try {
    sqlite = require("node:sqlite");
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

// readSessions(file, {since, from, until, details}): the sessions updated
// since SINCE (ms), each {id, parent_id, root, title, directory, usage},
// where usage is its assistant messages created in [from, until) (FROM
// defaults to SINCE), one record
// {id, ts, model, input, output, reasoning, cache_read, cache_write} per
// message (model is PROVIDER/MODEL, as opencode names it). root is the
// session at the top of its parent_id chain. With details, also prompt
// (the text of its first user message) and commands (its bash tool
// calls' commands). Throws if the file can't be opened or isn't an
// opencode database it knows.
function readSessions(file, { since = 0, from = since, until = Infinity, details = false } = {}) {
  const lib = loadSqlite();
  if (!lib) throw new Error("this Node has no node:sqlite (Node 22.5 or later has it)");
  const db = new lib.DatabaseSync(file, { readOnly: true });
  try {
    const parents = new Map(db.prepare("SELECT id, parent_id FROM session").all().map((r) => [r.id, r.parent_id]));
    const root = (id) => {
      const seen = new Set();
      while (parents.get(id) && !seen.has(id)) {
        seen.add(id);
        id = parents.get(id);
      }
      return id;
    };
    const sessions = db.prepare("SELECT id, parent_id, title, directory FROM session WHERE time_updated >= ? ORDER BY time_created").all(since);
    const messages = db.prepare(`SELECT id, time_created AS ts,
        json_extract(data, '$.providerID') AS provider, json_extract(data, '$.modelID') AS model,
        json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
        json_extract(data, '$.tokens.reasoning') AS reasoning,
        json_extract(data, '$.tokens.cache.read') AS cache_read, json_extract(data, '$.tokens.cache.write') AS cache_write
      FROM message WHERE session_id = ? AND time_created >= ? AND time_created < ?
        AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created, id`);
    const firstUser = db.prepare(`SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
      ORDER BY time_created, id LIMIT 1`);
    const texts = db.prepare(`SELECT json_extract(data, '$.text') AS text FROM part
      WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id`);
    const commands = db.prepare(`SELECT json_extract(data, '$.state.input.command') AS command FROM part
      WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'bash' ORDER BY id`);
    // SQLite takes no Infinity; the largest safe integer is far enough.
    const end = Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
    return sessions.map((s) => {
      const out = {
        id: s.id, parent_id: s.parent_id || null, root: root(s.id), title: s.title || null, directory: s.directory || null,
        usage: messages.all(s.id, from, end).filter((m) => m.model).map((m) => ({
          id: m.id, ts: m.ts, model: m.provider ? `${m.provider}/${m.model}` : m.model,
          input: num(m.input), output: num(m.output), reasoning: num(m.reasoning),
          cache_read: num(m.cache_read), cache_write: num(m.cache_write),
        })),
      };
      if (details) {
        const first = firstUser.get(s.id);
        out.prompt = first ? texts.all(first.id).map((r) => r.text).filter((t) => typeof t === "string").join("\n") : null;
        out.commands = commands.all(s.id).map((r) => r.command).filter((c) => typeof c === "string");
      }
      return out;
    });
  } finally {
    db.close();
  }
}

module.exports = { defaultDatabases, readSessions, loadSqlite, DATA_DIR, ARCHIVE_DIR, DB_NAME };
