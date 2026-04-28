#!/usr/bin/env node
// Obsidian vault seeder.
//
// Turns an empty (or thin) Obsidian vault into a structured starter tree
// pulled from the memory graph + workspace daily summaries + persona
// files. Creates Obsidian-style markdown with [[wikilinks]], frontmatter,
// and a MOC (map of content) index so the vault's graph view has something
// to show on first open.
//
// Idempotent: never overwrites a file that already exists unless --force.
// Default vault path: ~/Documents/Obsidian Vault
//
// Structure created:
//   README.md                    — MOC with links to everything else
//   People/<Name>.md             — one page per typed-fact "name" / "wife"
//                                  / "son" / etc. claim, with body + links
//   Preferences.md               — consolidated list of user preferences
//   Constraints.md               — consolidated list of constraints
//   Open Loops.md                — list of active open-loop claims
//   Daily/<YYYY-MM-DD>.md        — one page per summarizer output file
//   About Me.md                  — seeded from USER.md + IDENTITY.md
//   Memory/Index.md              — graph stats + tag cloud
//
// Usage:
//   node extensions/memory-graph/scripts/obsidian-seed.mjs                  # dry-run
//   node extensions/memory-graph/scripts/obsidian-seed.mjs --apply          # write files
//   node extensions/memory-graph/scripts/obsidian-seed.mjs --apply --force  # overwrite existing
//   node extensions/memory-graph/scripts/obsidian-seed.mjs --vault <path>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const DB_PATH = join(HOME, ".openclaw", "memory", "graph.sqlite");
const SUMMARIES_DIR = join(HOME, ".openclaw", "workspace", "memory", "summaries");
const WORKSPACE_DIR = join(HOME, ".openclaw", "workspace");

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--apply") {
      out.flags.apply = true;
    } else if (t === "--force") {
      out.flags.force = true;
    } else if (t === "--vault") {
      out.flags.vault = argv[i + 1];
      i += 1;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APPLY = args.flags.apply === true;
const FORCE = args.flags.force === true;
const VAULT =
  typeof args.flags.vault === "string"
    ? args.flags.vault
    : join(HOME, "Documents", "Obsidian Vault");

if (args.flags.help) {
  console.log(`obsidian-seed.mjs — seed an Obsidian vault from the memory graph.

USAGE
  obsidian-seed.mjs [--apply] [--force] [--vault <path>]

FLAGS
  --apply           Write files (default: dry-run prints the plan)
  --force           Overwrite existing files (default: skip)
  --vault <path>    Vault root (default: ~/Documents/Obsidian Vault)
`);
  process.exit(0);
}

if (!existsSync(VAULT)) {
  console.error(`[obsidian-seed] vault not found: ${VAULT}`);
  console.error("Create the vault first (Obsidian → New vault) then rerun.");
  process.exit(1);
}

// ---- data loaders --------------------------------------------------------

function loadClaims() {
  if (!existsSync(DB_PATH)) {
    return [];
  }
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT kind, summary, body, confidence, source_surface, updated_at
           FROM nodes
          WHERE kind IN ('fact','preference','constraint','open-loop','entity')
            AND scope = 'workspace' AND scope_id = 'default'
          ORDER BY kind ASC, confidence DESC, updated_at DESC`,
      )
      .all();
    return rows.map((r) => ({
      kind: String(r.kind),
      summary: String(r.summary ?? ""),
      body: r.body ? String(r.body) : null,
      confidence: Number(r.confidence ?? 0),
      surface: r.source_surface ? String(r.source_surface) : null,
      updatedAt: Number(r.updated_at),
    }));
  } finally {
    db.close();
  }
}

function loadSummaries() {
  if (!existsSync(SUMMARIES_DIR)) {
    return [];
  }
  const entries = readdirSync(SUMMARIES_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  return entries
    .map((f) => {
      const date = f.replace(/\.md$/, "");
      const content = readFileSync(join(SUMMARIES_DIR, f), "utf8");
      return { date, content };
    })
    .toSorted((a, b) => b.date.localeCompare(a.date));
}

function loadPersonaFile(name) {
  const p = join(WORKSPACE_DIR, `${name}.md`);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---- Obsidian helpers ----------------------------------------------------

function sanitizeFilename(s) {
  // Obsidian-safe: no / \ : * ? " < > |
  return String(s)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function wikilink(name) {
  return `[[${sanitizeFilename(name)}]]`;
}

function scalarToYaml(v) {
  if (typeof v === "string") {
    return JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

function frontmatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      continue;
    }
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${scalarToYaml(item)}`);
      }
    } else {
      lines.push(`${k}: ${scalarToYaml(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

// ---- page builders -------------------------------------------------------

function buildReadme({ counts, lastSummary, peopleNames }) {
  const lines = [];
  lines.push(frontmatter({ tags: ["moc", "index"], seeded_at: new Date().toISOString() }));
  lines.push("# Vault — Map of Content");
  lines.push("");
  lines.push(
    "Auto-seeded from the memory graph. Edit freely — the seeder skips files that already exist unless you pass `--force`.",
  );
  lines.push("");
  lines.push("## People");
  for (const n of peopleNames) {
    lines.push(`- ${wikilink(n)}`);
  }
  lines.push("");
  lines.push("## Knowledge");
  lines.push("- [[About Me]]");
  lines.push("- [[Preferences]]");
  lines.push("- [[Constraints]]");
  lines.push("- [[Open Loops]]");
  lines.push("- [[Memory/Index|Memory Graph Stats]]");
  lines.push("");
  lines.push("## Daily");
  if (lastSummary) {
    lines.push(`- Most recent: ${wikilink(`Daily/${lastSummary}`)}`);
  } else {
    lines.push("- (no summaries yet — the nightly summarizer fires at 03:15 local)");
  }
  lines.push("");
  lines.push("## Counts at seed time");
  for (const [kind, n] of Object.entries(counts)) {
    lines.push(`- ${kind}: ${String(n)}`);
  }
  return lines.join("\n") + "\n";
}

// Pull "name" values out of person-shaped facts like:
//   "my wife is Sarah" → { relation: "wife", name: "Sarah" }
//   "my dog's name is Kibo" → { relation: "dog", name: "Kibo" }
function extractPersonFromFact(summary) {
  const s = summary.trim();
  // "my X is Y" or "X is Y"
  let m = s.match(
    /^(?:my\s+)?(wife|husband|spouse|partner|son|daughter|kid|child|dog|cat|pet)\s+(?:is\s+|'s\s+name\s+is\s+)(.+)$/i,
  );
  if (m) {
    const rel = m[1].toLowerCase();
    const name = m[2].trim().replace(/[.!?]+$/, "");
    return { relation: rel, name };
  }
  // "my X's name is Y"
  m = s.match(/^(?:my\s+)?(\w+)'s\s+name\s+is\s+(.+)$/i);
  if (m) {
    return { relation: m[1].toLowerCase(), name: m[2].trim().replace(/[.!?]+$/, "") };
  }
  return null;
}

function buildPersonPage(person, relatedClaims) {
  const lines = [];
  lines.push(
    frontmatter({
      tags: ["person", person.relation],
      name: person.name,
      relation: person.relation,
      seeded_at: new Date().toISOString(),
    }),
  );
  lines.push(`# ${person.name}`);
  lines.push("");
  lines.push(`${person.relation.charAt(0).toUpperCase() + person.relation.slice(1)}.`);
  lines.push("");
  if (relatedClaims.length > 0) {
    lines.push("## Related claims in memory");
    for (const c of relatedClaims) {
      lines.push(`- [${c.kind}] ${c.summary}`);
    }
    lines.push("");
  }
  lines.push("## Notes");
  lines.push("<!-- Write freely here — this file was seeded but is yours now. -->");
  return lines.join("\n") + "\n";
}

function buildPreferencesPage(prefs) {
  const lines = [];
  lines.push(
    frontmatter({
      tags: ["preferences"],
      count: prefs.length,
      seeded_at: new Date().toISOString(),
    }),
  );
  lines.push("# Preferences");
  lines.push("");
  lines.push("Aggregated from typed-preference claims in the memory graph.");
  lines.push("");
  for (const p of prefs) {
    lines.push(
      `- ${p.summary}${p.confidence ? `  <small>(conf ${p.confidence.toFixed(2)})</small>` : ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

function buildConstraintsPage(constraints) {
  const lines = [];
  lines.push(
    frontmatter({
      tags: ["constraints"],
      count: constraints.length,
      seeded_at: new Date().toISOString(),
    }),
  );
  lines.push("# Constraints");
  lines.push("");
  lines.push("Durable rules you've asked the stack to honor.");
  lines.push("");
  for (const c of constraints) {
    lines.push(`- ${c.summary}`);
  }
  return lines.join("\n") + "\n";
}

function buildOpenLoopsPage(openLoops) {
  const lines = [];
  lines.push(
    frontmatter({
      tags: ["open-loops"],
      count: openLoops.length,
      seeded_at: new Date().toISOString(),
    }),
  );
  lines.push("# Open Loops");
  lines.push("");
  lines.push(
    "Things you said you'd do or follow up on. Close by converting to a reminder via `reminders_add`, or strike here.",
  );
  lines.push("");
  for (const o of openLoops) {
    lines.push(`- [ ] ${o.summary}`);
  }
  return lines.join("\n") + "\n";
}

function buildAboutMePage() {
  const user = loadPersonaFile("USER");
  const identity = loadPersonaFile("IDENTITY");
  const lines = [];
  lines.push(frontmatter({ tags: ["about-me"], seeded_at: new Date().toISOString() }));
  lines.push("# About Me");
  lines.push("");
  if (user) {
    lines.push("## USER.md (from `~/.openclaw/workspace/USER.md`)");
    lines.push("");
    lines.push(user.trim());
    lines.push("");
  }
  if (identity) {
    lines.push("## IDENTITY.md (from `~/.openclaw/workspace/IDENTITY.md`)");
    lines.push("");
    lines.push(identity.trim());
    lines.push("");
  }
  if (!user && !identity) {
    lines.push(
      "_No USER.md or IDENTITY.md found — create them in `~/.openclaw/workspace/` and rerun the seeder._",
    );
  }
  return lines.join("\n") + "\n";
}

function buildDailyPage(date, content) {
  // Strip the summarizer's own frontmatter and re-wrap.
  const stripped = content.replace(/^---[\s\S]*?---\s*/, "").trim();
  const lines = [];
  lines.push(frontmatter({ tags: ["daily-summary"], date, seeded_at: new Date().toISOString() }));
  lines.push(`# Daily Summary — ${date}`);
  lines.push("");
  lines.push(stripped);
  return lines.join("\n") + "\n";
}

function buildMemoryIndex(counts, totalClaims) {
  const lines = [];
  lines.push(frontmatter({ tags: ["memory", "stats"], seeded_at: new Date().toISOString() }));
  lines.push("# Memory Graph Stats");
  lines.push("");
  lines.push(`Total typed claims: ${String(totalClaims)}`);
  lines.push("");
  lines.push("| kind | count |");
  lines.push("|---|---|");
  for (const [kind, n] of Object.entries(counts)) {
    lines.push(`| ${kind} | ${String(n)} |`);
  }
  lines.push("");
  lines.push("## Query tools");
  lines.push(
    "- Claude Desktop / Claude Code: `memory_recall`, `memory_search`, `memory_semantic_search`",
  );
  lines.push("- CLI retrospective: `node extensions/memory-graph/scripts/orchestrator-stats.mjs`");
  return lines.join("\n") + "\n";
}

// ---- writer --------------------------------------------------------------

let filesPlanned = 0;
let filesWritten = 0;
let filesSkipped = 0;

function plan(path, content) {
  filesPlanned += 1;
  const exists = existsSync(path);
  if (exists && !FORCE) {
    filesSkipped += 1;
    console.log(`  skip  ${path.replace(VAULT, "")} (exists)`);
    return;
  }
  if (!APPLY) {
    console.log(`  plan  ${path.replace(VAULT, "")} (${content.length} chars)`);
    return;
  }
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content);
  filesWritten += 1;
  console.log(`  write ${path.replace(VAULT, "")} (${content.length} chars)`);
}

// ---- main ----------------------------------------------------------------

console.log(`[obsidian-seed] vault=${VAULT} apply=${APPLY} force=${FORCE}`);
const claims = loadClaims();
const summaries = loadSummaries();

const counts = {};
for (const c of claims) {
  counts[c.kind] = (counts[c.kind] ?? 0) + 1;
}

const people = [];
const seenNames = new Set();
for (const c of claims) {
  if (c.kind !== "fact") {
    continue;
  }
  const person = extractPersonFromFact(c.summary);
  if (!person || seenNames.has(person.name.toLowerCase())) {
    continue;
  }
  seenNames.add(person.name.toLowerCase());
  people.push(person);
}

const peopleNames = people.map((p) => p.name);

// README / MOC
plan(
  join(VAULT, "README.md"),
  buildReadme({
    counts,
    lastSummary: summaries[0]?.date ?? null,
    peopleNames,
  }),
);

// One page per person
for (const p of people) {
  const related = claims.filter(
    (c) =>
      c.summary.toLowerCase().includes(p.name.toLowerCase()) ||
      (p.relation && c.summary.toLowerCase().includes(p.relation.toLowerCase())),
  );
  plan(join(VAULT, "People", `${sanitizeFilename(p.name)}.md`), buildPersonPage(p, related));
}

// Preferences / Constraints / Open Loops
plan(
  join(VAULT, "Preferences.md"),
  buildPreferencesPage(claims.filter((c) => c.kind === "preference")),
);
plan(
  join(VAULT, "Constraints.md"),
  buildConstraintsPage(claims.filter((c) => c.kind === "constraint")),
);
plan(
  join(VAULT, "Open Loops.md"),
  buildOpenLoopsPage(claims.filter((c) => c.kind === "open-loop")),
);

// About Me
plan(join(VAULT, "About Me.md"), buildAboutMePage());

// Daily summaries
for (const s of summaries) {
  plan(join(VAULT, "Daily", `${s.date}.md`), buildDailyPage(s.date, s.content));
}

// Memory index
plan(join(VAULT, "Memory", "Index.md"), buildMemoryIndex(counts, claims.length));

console.log("");
console.log(
  `[obsidian-seed] planned=${filesPlanned} ${APPLY ? `written=${filesWritten}` : "(dry-run)"} skipped=${filesSkipped}`,
);
if (!APPLY) {
  console.log("[obsidian-seed] rerun with --apply to write files");
}
