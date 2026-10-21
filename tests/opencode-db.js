// Builds a small opencode database for the tests of bot-cost and
// bot-heartbeat: the tables and columns lib/opencode.js reads, as opencode
// 1.19 has them, filled from plain objects (built at test time, so no
// binary fixture is checked in).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadSqlite } = require(path.join(__dirname, "..", "lib", "opencode.js"));

const SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL);
`;

// makeOpencodeDb(file, sessions): writes FILE with SESSIONS, each
//   {id, parent_id, title, directory, prompt, commands: [...],
//    messages: [{id, ts (ISO), model, tokens: {input, output, reasoning,
//                cache: {read, write}}}]}
// prompt becomes the first user message's text part, and each command a
// bash tool part.
function makeOpencodeDb(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  db.exec(SCHEMA);
  const addSession = db.prepare("INSERT INTO session VALUES (?, 'p', ?, ?, ?, ?, '1.19.0', ?, ?)");
  const addMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const addPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  let n = 0;
  const id = (prefix) => `${prefix}_${String(++n).padStart(6, "0")}`;
  for (const s of sessions) {
    const times = s.messages.map((m) => Date.parse(m.ts));
    const created = Math.min(...times) - 1000;
    addSession.run(s.id, s.parent_id || null, s.id, s.directory || "/work", s.title || "", created, Math.max(...times));
    if (s.prompt !== undefined) {
      const user = id("msg");
      addMessage.run(user, s.id, created, created, JSON.stringify({ role: "user", time: { created } }));
      addPart.run(id("prt"), user, s.id, created, created, JSON.stringify({ type: "text", text: s.prompt }));
    }
    for (const m of s.messages) {
      const ts = Date.parse(m.ts);
      const [providerID, modelID] = m.model.split("/");
      const data = { role: "assistant", providerID, modelID, tokens: m.tokens, time: { created: ts } };
      addMessage.run(m.id, s.id, ts, ts, JSON.stringify(data));
    }
    for (const command of s.commands || []) {
      const ts = Date.parse(s.messages[0].ts);
      addPart.run(id("prt"), s.messages[0].id, s.id, ts, ts, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command } } }));
    }
  }
  db.close();
}

// tokens(input, output, reasoning, read, write): a message's tokens, as
// opencode records them.
const tokens = (input, output, reasoning, read, write) => ({ total: input + output + reasoning + read + write, input, output, reasoning, cache: { read, write } });

module.exports = { makeOpencodeDb, tokens };
