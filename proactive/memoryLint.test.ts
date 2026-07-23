import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintMemoryStore, validateFrontmatter } from "./memoryLint.ts";

function makeStore(): string {
  return mkdtempSync(join(tmpdir(), "rachel-memory-lint-test-"));
}

function write(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content);
}

const VALID_FACT = `---
name: units-preference
description: Gary uses metric units.
type: preference
date: 2026-07-22
---

Gary uses metric units: Celsius, km, kilos.
`;

// --- validateFrontmatter: standalone unit tests (not only through lintMemoryStore) ---
// This is the pure, content-based validator that PR3's write-time hook
// imports directly (no fs access, callable pre-write). Each assertion below
// is paired with a removed-check control per SO-15: confirm the finding
// disappears when the violation is fixed, so a stub returning [] for
// everything cannot pass this file trivially.

test("validateFrontmatter: a fully valid frontmatter string returns no findings", () => {
  assert.deepEqual(validateFrontmatter(VALID_FACT, "units-preference.md"), []);
});

test("validateFrontmatter: no leading --- block returns exactly one missing-frontmatter error", () => {
  const findings = validateFrontmatter("just plain prose, no frontmatter at all\n", "something.md");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "missing-frontmatter");
  assert.equal(findings[0]?.level, "error");
});

test("validateFrontmatter: an unclosed frontmatter block is missing-frontmatter", () => {
  const findings = validateFrontmatter("---\nname: x\n\nbody with no closing marker\n", "x.md");
  assert.ok(findings.some((f) => f.code === "missing-frontmatter"));
});

test("validateFrontmatter: missing name is reported and disappears once name is present", () => {
  const missing = validateFrontmatter("---\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(missing.some((f) => f.code === "missing-field" && f.message.includes("name")));
  const fixed = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!fixed.some((f) => f.code === "missing-field" && f.message.includes("name")));
});

test("validateFrontmatter: missing description is reported and disappears once description is present", () => {
  const missing = validateFrontmatter("---\nname: x\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(missing.some((f) => f.code === "missing-field" && f.message.includes("description")));
  const fixed = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!fixed.some((f) => f.code === "missing-field" && f.message.includes("description")));
});

test("validateFrontmatter: missing type is reported and disappears once type is present", () => {
  const missing = validateFrontmatter("---\nname: x\ndescription: d\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(missing.some((f) => f.code === "missing-field" && f.message.includes("type")));
  const fixed = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!fixed.some((f) => f.code === "missing-field" && f.message.includes("type")));
});

test("validateFrontmatter: an invalid type enum value is an error, and a valid one clears it", () => {
  const bad = validateFrontmatter("---\nname: x\ndescription: d\ntype: todo\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(bad.some((f) => f.code === "invalid-type" && f.level === "error"));
  const fixed = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!fixed.some((f) => f.code === "invalid-type"));
});

test("validateFrontmatter: a name/filename slug mismatch is an error, and a match clears it", () => {
  const mismatched = validateFrontmatter("---\nname: wrong-slug\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(mismatched.some((f) => f.code === "name-mismatch" && f.level === "error"));
  const matched = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!matched.some((f) => f.code === "name-mismatch"));
});

test("validateFrontmatter: missing date is a warning (never an error), and clears once present", () => {
  const missing = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\n---\n\nbody\n", "x.md");
  assert.ok(missing.some((f) => f.code === "missing-date" && f.level === "warning"));
  assert.ok(!missing.some((f) => f.code === "missing-date" && f.level === "error"));
  const fixed = validateFrontmatter("---\nname: x\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n", "x.md");
  assert.ok(!fixed.some((f) => f.code === "missing-date"));
});

test("validateFrontmatter: lintMemoryStore calls this same function rather than duplicating it (missing-field parity)", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  const content = "---\ndescription: only\n---\n\nbody\n";
  write(dir, "something.md", content);
  const viaDirectory = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  const viaDirect = validateFrontmatter(content, "something.md");
  assert.deepEqual(viaDirectory, viaDirect);
});

// --- Absent-is-empty (matches memoryIndex.ts / push.ts's established contract) ---

test("a missing memory directory returns no findings, not a throw", () => {
  const dir = join(tmpdir(), "rachel-memory-lint-does-not-exist-" + Date.now());
  assert.doesNotThrow(() => lintMemoryStore(dir));
  assert.deepEqual(lintMemoryStore(dir), []);
});

// --- Schema validity ---

test("a fact file with no frontmatter block at all is flagged, and MEMORY.md itself is excluded from the scan", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n");
  write(dir, "units-preference.md", "Gary uses metric units: Celsius, km, kilos.\n");
  const findings = lintMemoryStore(dir);
  const schemaFindings = findings.filter((f) => f.file === "units-preference.md");
  assert.ok(
    schemaFindings.some((f) => f.code === "missing-frontmatter" && f.level === "error"),
    "expected a missing-frontmatter error for units-preference.md",
  );
  assert.ok(
    !findings.some((f) => f.file === "MEMORY.md" && f.code === "missing-frontmatter"),
    "MEMORY.md is the index, not a fact file — it must not be scanned for fact frontmatter",
  );
});

test("a clean fact file with full valid frontmatter reports no schema findings", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n");
  write(dir, "units-preference.md", VALID_FACT);
  const findings = lintMemoryStore(dir);
  assert.deepEqual(
    findings.filter((f) => f.file === "units-preference.md"),
    [],
  );
});

test("a frontmatter block missing the name/description/type keys is flagged per missing key", () => {
  const dir = makeStore();
  const content = `---\ndescription: something\n---\n\nbody\n`;
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", content);
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  assert.ok(findings.some((f) => f.code === "missing-field" && f.message.includes("name")));
  assert.ok(findings.some((f) => f.code === "missing-field" && f.message.includes("type")));
  assert.ok(!findings.some((f) => f.code === "missing-field" && f.message.includes("description")));
});

test("a type value outside the enum is flagged", () => {
  const dir = makeStore();
  const content = `---\nname: something\ndescription: something\ntype: todo\n---\n\nbody\n`;
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", content);
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  assert.ok(findings.some((f) => f.code === "invalid-type" && f.level === "error"));
});

test("each valid type enum value (preference | decision | ongoing | reference) passes cleanly", () => {
  const dir = makeStore();
  const pointers: string[] = [];
  for (const type of ["preference", "decision", "ongoing", "reference"]) {
    const filename = `fact-${type}.md`;
    write(dir, filename, `---\nname: fact-${type}\ndescription: d\ntype: ${type}\ndate: 2026-07-22\n---\n\nbody\n`);
    pointers.push(`- [Fact ${type}](${filename}) — hook`);
  }
  write(dir, "MEMORY.md", `# Memory Index\n\n${pointers.join("\n")}\n`);
  const findings = lintMemoryStore(dir).filter((f) => f.code === "invalid-type" || f.code === "missing-field");
  assert.deepEqual(findings, []);
});

test("a name that doesn't match the filename slug is flagged", () => {
  const dir = makeStore();
  const content = `---\nname: wrong-slug\ndescription: something\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n`;
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", content);
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  assert.ok(findings.some((f) => f.code === "name-mismatch" && f.level === "error"));
});

test("a matching name/filename slug passes cleanly", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", `---\nname: something\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n`);
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md" && f.code === "name-mismatch");
  assert.deepEqual(findings, []);
});

test("missing-frontmatter suppresses the per-key cascade — one finding, not five", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", "just plain prose, no frontmatter at all\n");
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "missing-frontmatter");
});

// --- date field (warning, not error, on pre-existing files) ---

test("a fact file with otherwise-valid frontmatter but no date field is a WARNING, not an error", () => {
  const dir = makeStore();
  const content = `---\nname: something\ndescription: d\ntype: preference\n---\n\nbody\n`;
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", content);
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md");
  assert.ok(findings.some((f) => f.code === "missing-date" && f.level === "warning"));
  assert.ok(!findings.some((f) => f.code === "missing-date" && f.level === "error"));
});

test("a fact file with a date field reports no missing-date finding", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Something](something.md) — hook\n");
  write(dir, "something.md", VALID_FACT.replace("units-preference", "something"));
  const findings = lintMemoryStore(dir).filter((f) => f.file === "something.md" && f.code === "missing-date");
  assert.deepEqual(findings, []);
});

// --- Index <-> store consistency ---

test("a pointer in MEMORY.md whose target file does not exist is a dangling-pointer error", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Ghost](ghost.md) — hook\n");
  const findings = lintMemoryStore(dir);
  assert.ok(findings.some((f) => f.code === "dangling-pointer" && f.level === "error" && f.message.includes("ghost.md")));
});

test("a fact file with no pointer line in MEMORY.md is an orphan warning", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n");
  write(dir, "orphan.md", VALID_FACT.replace("units-preference", "orphan"));
  const findings = lintMemoryStore(dir);
  assert.ok(findings.some((f) => f.code === "orphan-file" && f.file === "orphan.md"));
});

test("a fully consistent index and store report neither dangling-pointer nor orphan-file", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n");
  write(dir, "units-preference.md", VALID_FACT);
  const findings = lintMemoryStore(dir).filter((f) => f.code === "dangling-pointer" || f.code === "orphan-file");
  assert.deepEqual(findings, []);
});

// --- Index purity ---

test("a MEMORY.md line that embeds content instead of pointing is flagged impure", () => {
  const dir = makeStore();
  // Real observed shape: a line with no markdown link at all, just prose —
  // as if memory content leaked into the index directly.
  write(
    dir,
    "MEMORY.md",
    "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n- Gary uses metric units always, never Fahrenheit or miles under any circumstances.\n",
  );
  write(dir, "units-preference.md", VALID_FACT);
  const findings = lintMemoryStore(dir);
  assert.ok(findings.some((f) => f.code === "impure-index" && f.file === "MEMORY.md"));
});

test("an index of pointer-only lines reports no impure-index finding", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n");
  write(dir, "units-preference.md", VALID_FACT);
  const findings = lintMemoryStore(dir).filter((f) => f.code === "impure-index");
  assert.deepEqual(findings, []);
});

test("a pointer whose title contains a nested bracket is recognised as a pointer, not flagged impure or orphan", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Foo [bar]](foo.md) — hook\n");
  write(dir, "foo.md", VALID_FACT.replace("units-preference", "foo"));
  const findings = lintMemoryStore(dir);
  assert.deepEqual(
    findings,
    [],
    "a nested-bracket title is a real pointer — must not be impure-index or falsely orphan-file",
  );
});

test("control: the same fixture with the nested bracket removed also reports nothing (isolates the bracket as the variable)", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Foo bar](foo.md) — hook\n");
  write(dir, "foo.md", VALID_FACT.replace("units-preference", "foo"));
  const findings = lintMemoryStore(dir);
  assert.deepEqual(findings, []);
});

// --- Entry count threshold ---

test("an index past the ~50-entry threshold is flagged for consolidation", () => {
  const dir = makeStore();
  const pointers: string[] = [];
  for (let i = 0; i < 51; i++) {
    const filename = `fact-${i}.md`;
    write(dir, filename, `---\nname: fact-${i}\ndescription: d\ntype: preference\ndate: 2026-07-22\n---\n\nbody\n`);
    pointers.push(`- [Fact ${i}](${filename}) — hook`);
  }
  write(dir, "MEMORY.md", `# Memory Index\n\n${pointers.join("\n")}\n`);
  const findings = lintMemoryStore(dir);
  assert.ok(findings.some((f) => f.code === "consolidation-threshold" && f.file === "MEMORY.md"));
});

test("an index at 2 entries reports no consolidation-threshold finding", () => {
  const dir = makeStore();
  write(
    dir,
    "MEMORY.md",
    "# Memory Index\n\n- [Units preference](units-preference.md) — hook\n- [Other](other.md) — hook\n",
  );
  write(dir, "units-preference.md", VALID_FACT);
  write(dir, "other.md", VALID_FACT.replace("units-preference", "other"));
  const findings = lintMemoryStore(dir).filter((f) => f.code === "consolidation-threshold");
  assert.deepEqual(findings, []);
});

// --- Real-store regression: the known-bad case named in the brief ---

test("regression: reproduces the real store's units-preference.md shape (no frontmatter) and flags it", () => {
  const dir = makeStore();
  write(dir, "MEMORY.md", "# Memory Index\n\n- [Units preference](units-preference.md) — Gary uses metric: Celsius, km, kilos. Never Fahrenheit/miles/lbs by default.\n");
  write(dir, "units-preference.md", "Gary uses metric units: Celsius (not Fahrenheit), km (not miles), kilos (not lbs/stone). Always report weather, distances, and weights in metric by default.\n");
  const findings = lintMemoryStore(dir).filter((f) => f.file === "units-preference.md");
  assert.ok(findings.some((f) => f.code === "missing-frontmatter"));
});
