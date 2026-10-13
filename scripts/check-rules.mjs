// Fails if a turn-rule id is in one of docs/turn-rules.md, server/turn.ts and
// test/turn.test.ts but not in all three. See AGENTS.md "Rule ids".
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../docs/turn-rules.md", import.meta.url), "utf8");
const code = readFileSync(new URL("../server/turn.ts", import.meta.url), "utf8");
const tests = readFileSync(new URL("../test/turn.test.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../client/sidebar.tsx", import.meta.url), "utf8");

// Doc ids: the first column of every table whose header starts with "| Rule |".
const docIds = new Set();
let inRuleTable = false;
for (const line of doc.split("\n")) {
  if (/^\|\s*Rule\s*\|/.test(line)) inRuleTable = true;
  else if (!line.startsWith("|")) inRuleTable = false;
  else if (inRuleTable) {
    const match = line.match(/^\|\s*`([a-z_]+)`/);
    if (match) docIds.add(match[1]);
  }
}

const codeIds = new Set([...code.matchAll(/\brule(?:<[^>]*>)?\(\s*"([a-z_]+)"/g), ...code.matchAll(/\bid:\s*"([a-z_]+)"/g)].map((m) => m[1]));
const testIds = new Set([...tests.matchAll(/\btest\(\s*"([a-z_]+)[ :(]/g)].map((m) => m[1]));

const sources = { "docs/turn-rules.md": docIds, "server/turn.ts": codeIds, "test/turn.test.ts": testIds };
const all = new Set([...docIds, ...codeIds, ...testIds]);
const problems = [];
for (const id of [...all].sort()) {
  const missing = Object.entries(sources)
    .filter(([, ids]) => !ids.has(id))
    .map(([file]) => file);
  if (missing.length) problems.push(`  ${id}: missing from ${missing.join(", ")}`);
}
// Every obligation reason needs a sidebar label; local states have their own map.
const labelled = new Set([...sidebar.matchAll(/case\s+"([a-z_]+)"/g), ...sidebar.matchAll(/^\s+([a-z_]+):\s*"/gm)].map((m) => m[1]));
for (const id of [...docIds].sort()) {
  if (!labelled.has(id)) problems.push(`  ${id}: no label in client/sidebar.tsx (reasonLabel or LOCAL_LABEL)`);
}
if (problems.length) {
  console.error("Turn-rule ids are out of sync:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`Turn-rule ids in sync: ${all.size} ids in the doc, the code and the tests.`);
