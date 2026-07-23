// Store-lint for Rachel's persistent memory store (~/.rachel/memory/).
// Pure, deterministic scan: given the memory directory, returns structured
// findings. No writes, no side effects — proactive/sweep.ts's memory-lint
// family is the only production caller, reporting findings through
// proactive/push.ts's chokepoint. See prompts/system.md's Memory section for
// the canonical frontmatter contract this lint enforces.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FindingLevel = "error" | "warning";

export interface Finding {
  file: string;
  code: string;
  level: FindingLevel;
  message: string;
}

const INDEX_FILENAME = "MEMORY.md";

// Canonical enum from prompts/system.md's Memory section — this is Rachel's
// OWN memory schema, unrelated to Claude Code's separate
// user|feedback|project|reference enum used elsewhere in this repo.
const VALID_TYPES = ["preference", "decision", "ongoing", "reference"] as const;

// prompts/system.md: "once the index passes roughly 50 entries, consolidate
// yourself." No code backstop existed before this lint.
const CONSOLIDATION_THRESHOLD = 50;

const REQUIRED_FIELDS = ["name", "description", "type"] as const;

function isFrontmatterKey(line: string, key: string): boolean {
  return new RegExp(`^${key}\\s*:`).test(line.trim());
}

function extractFrontmatterValue(lines: string[], key: string): string | undefined {
  const line = lines.find((l) => isFrontmatterKey(l, key));
  if (line === undefined) {
    return undefined;
  }
  return line.trim().slice(line.trim().indexOf(":") + 1).trim();
}

// Pure frontmatter schema validator — the single source of truth for
// Rachel's memory-fact schema (name/description/type/date, per
// prompts/system.md's Memory contract). No fs access, no sweep coupling:
// takes content as a string so a caller that has NOT yet written to disk
// (e.g. a PreToolUse write-gate hook validating a candidate Write before it
// lands) can call it directly, not just lintMemoryStore's directory scan.
// lintMemoryStore below calls this rather than duplicating the logic — one
// implementation, two callers.
//
// Returns one missing-frontmatter error and stops (no cascade into the
// per-key checks) when there's no leading `---` block at all — one root
// cause, one finding.
export function validateFrontmatter(content: string, filename: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return [
      {
        file: filename,
        code: "missing-frontmatter",
        level: "error",
        message: "no leading frontmatter block (expected a --- ... --- header with name/description/type)",
      },
    ];
  }
  const closeIdx = lines.slice(1).findIndex((l) => l.trim() === "---");
  if (closeIdx === -1) {
    return [
      {
        file: filename,
        code: "missing-frontmatter",
        level: "error",
        message: "frontmatter block never closes with a second ---",
      },
    ];
  }
  const fmLines = lines.slice(1, closeIdx + 1);

  for (const field of REQUIRED_FIELDS) {
    if (extractFrontmatterValue(fmLines, field) === undefined) {
      findings.push({
        file: filename,
        code: "missing-field",
        level: "error",
        message: `frontmatter is missing required field "${field}"`,
      });
    }
  }

  const type = extractFrontmatterValue(fmLines, "type");
  if (type !== undefined && !(VALID_TYPES as readonly string[]).includes(type)) {
    findings.push({
      file: filename,
      code: "invalid-type",
      level: "error",
      message: `type "${type}" is not one of: ${VALID_TYPES.join(" | ")}`,
    });
  }

  const name = extractFrontmatterValue(fmLines, "name");
  if (name !== undefined) {
    const expectedSlug = filename.replace(/\.md$/, "");
    if (name !== expectedSlug) {
      findings.push({
        file: filename,
        code: "name-mismatch",
        level: "error",
        message: `frontmatter name "${name}" does not match filename slug "${expectedSlug}"`,
      });
    }
  }

  // Missing date is a warning, never an error: pre-existing files (written
  // before the date field existed in the contract) would otherwise make the
  // lint permanently red on day one. See PR body for the full rationale.
  if (extractFrontmatterValue(fmLines, "date") === undefined) {
    findings.push({
      file: filename,
      code: "missing-date",
      level: "warning",
      message: "frontmatter is missing the date field (recommended, not required, for pre-existing files)",
    });
  }

  return findings;
}

// A pointer line looks like "- [Title](file.md) — hook". Anything under the
// index heading that isn't shaped like that is index content that should
// have been a pointer, not embedded prose. The title class is greedy
// (`.+`, not `[^\]]+`) so a title containing a nested bracket (e.g.
// "[Rachel [v2] rollout](x.md)") still matches through to the LAST `](` —
// a non-greedy or bracket-excluding class would stop at the first `]` and
// both misclassify the line as impure AND falsely report the target file
// as orphaned (it plainly has a pointer, just missed by the regex).
const POINTER_RE = /^-\s*\[.+\]\(([^)]+\.md)\)/;

function lintIndexPurity(indexLines: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const line of indexLines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("-") && !POINTER_RE.test(trimmed)) {
      findings.push({
        file: INDEX_FILENAME,
        code: "impure-index",
        level: "warning",
        message: `line does not look like a pointer ("- [Title](file.md) — hook"): ${trimmed.slice(0, 80)}`,
      });
    }
  }
  return findings;
}

function extractPointerTargets(indexLines: string[]): string[] {
  const targets: string[] = [];
  for (const line of indexLines) {
    const match = POINTER_RE.exec(line.trim());
    if (match?.[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  return targets;
}

// Scans the memory store directory and returns every finding. Absent
// directory is treated as empty (no memories yet), matching the established
// contract in memoryIndex.ts / push.ts — never a throw.
export function lintMemoryStore(memoryDir: string): Finding[] {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const factFiles = entries.filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME).sort();
  const findings: Finding[] = [];

  for (const filename of factFiles) {
    const content = readFileSync(join(memoryDir, filename), "utf8");
    findings.push(...validateFrontmatter(content, filename));
  }

  let indexLines: string[] = [];
  try {
    indexLines = readFileSync(join(memoryDir, INDEX_FILENAME), "utf8").split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  findings.push(...lintIndexPurity(indexLines));

  const pointerTargets = extractPointerTargets(indexLines);
  const factFileSet = new Set(factFiles);
  for (const target of pointerTargets) {
    if (!factFileSet.has(target)) {
      findings.push({
        file: INDEX_FILENAME,
        code: "dangling-pointer",
        level: "error",
        message: `pointer targets ${target}, which does not exist in the memory store`,
      });
    }
  }

  const pointerTargetSet = new Set(pointerTargets);
  for (const filename of factFiles) {
    if (!pointerTargetSet.has(filename)) {
      findings.push({
        file: filename,
        code: "orphan-file",
        level: "warning",
        message: "fact file has no pointer line in MEMORY.md",
      });
    }
  }

  if (pointerTargets.length > CONSOLIDATION_THRESHOLD) {
    findings.push({
      file: INDEX_FILENAME,
      code: "consolidation-threshold",
      level: "warning",
      message: `index has ${pointerTargets.length} entries, past the ~${CONSOLIDATION_THRESHOLD}-entry consolidation threshold`,
    });
  }

  return findings;
}
