#!/usr/bin/env node
// memory-purge-by-label.mjs
//
// List or delete nodes tagged with a given origin_label. Complements the
// v5 schema field — smoke-test runners set OPENCLAW_MEMORY_ORIGIN_LABEL
// when they drive the classifier, this script lets you clean up afterward
// without hand-picking ids.
//
// Usage:
//   node scripts/memory-purge-by-label.mjs --label smoke --list
//   node scripts/memory-purge-by-label.mjs --label smoke --delete
//   node scripts/memory-purge-by-label.mjs --list-labels      # show all cohorts
//
// Exit codes: 0 ok, 1 misuse, 2 db missing.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const DEFAULT_DB = join(HOME, ".openclaw", "memory", "graph.sqlite");

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--label") {
      out.flags.label = argv[i + 1];
      i += 1;
    } else if (t === "--list") {
      out.flags.list = true;
    } else if (t === "--delete") {
      out.flags.delete = true;
    } else if (t === "--list-labels") {
      out.flags.listLabels = true;
    } else if (t === "--db") {
      out.flags.db = argv[i + 1];
      i += 1;
    } else if (t === "--yes") {
      out.flags.yes = true;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.help) {
  console.log(`memory-purge-by-label.mjs — manage origin_label cohorts.

USAGE
  --list-labels           Show every distinct origin_label + node count
  --label <name> --list   Preview nodes tagged <name>
  --label <name> --delete Delete nodes tagged <name> (prompts unless --yes)

FLAGS
  --db <path>   Override ~/.openclaw/memory/graph.sqlite
  --yes         Skip the "proceed?" prompt on --delete
`);
  process.exit(0);
}

const DB_PATH = typeof args.flags.db === "string" ? args.flags.db : DEFAULT_DB;
if (!existsSync(DB_PATH)) {
  console.error(`[memory-purge] db not found: ${DB_PATH}`);
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH);

function listLabels() {
  const rows = db
    .prepare(
      `SELECT origin_label AS label, COUNT(*) AS n
         FROM nodes
        WHERE origin_label IS NOT NULL
        GROUP BY origin_label
        ORDER BY n DESC`,
    )
    .all();
  if (rows.length === 0) {
    console.log("(no labeled nodes)");
    return;
  }
  console.log("label\tcount");
  for (const r of rows) {
    console.log(`${String(r.label)}\t${String(r.n)}`);
  }
}

function listByLabel(label) {
  const rows = db
    .prepare(
      `SELECT id, kind, substr(summary, 1, 80) AS summary, confidence, updated_at
         FROM nodes
        WHERE origin_label = ?
        ORDER BY updated_at DESC`,
    )
    .all(label);
  if (rows.length === 0) {
    console.log(`(no nodes tagged "${label}")`);
    return 0;
  }
  console.log(`${rows.length} node(s) tagged "${label}":`);
  for (const r of rows) {
    const when = new Date(Number(r.updated_at)).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `  ${String(r.id).padEnd(28)} ${String(r.kind).padEnd(16)} ${when}  ${String(r.summary)}`,
    );
  }
  return rows.length;
}

async function confirm(prompt) {
  process.stdout.write(`${prompt} [y/N] `);
  return await new Promise((resolve) => {
    process.stdin.once("data", (buf) => {
      const ans = buf.toString().trim().toLowerCase();
      resolve(ans === "y" || ans === "yes");
    });
  });
}

async function deleteByLabel(label, skipPrompt) {
  const n = listByLabel(label);
  if (n === 0) {
    return;
  }
  const ok = skipPrompt ? true : await confirm(`Delete all ${String(n)} nodes tagged "${label}"?`);
  if (!ok) {
    console.log("aborted.");
    return;
  }
  const info = db.prepare("DELETE FROM nodes WHERE origin_label = ?").run(label);
  console.log(`deleted ${String(info.changes)} node(s).`);
}

try {
  if (args.flags.listLabels) {
    listLabels();
  } else if (typeof args.flags.label === "string" && args.flags.list) {
    listByLabel(args.flags.label);
  } else if (typeof args.flags.label === "string" && args.flags.delete) {
    await deleteByLabel(args.flags.label, args.flags.yes === true);
  } else {
    console.error("usage: --list-labels | --label <name> --list | --label <name> --delete");
    process.exit(1);
  }
} finally {
  db.close();
}
