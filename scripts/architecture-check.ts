import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES = ["core", "providers", "cli", "telegram", "media", "speech", "supervisor"] as const;
const ALLOWED_IMPORTS: Record<typeof MODULES[number], ReadonlySet<string>> = {
  core: new Set(["core"]),
  providers: new Set(["core", "providers"]),
  cli: new Set(["core", "providers", "cli"]),
  telegram: new Set(["core", "providers", "media", "speech", "supervisor", "telegram"]),
  media: new Set(["core", "media", "providers"]),
  speech: new Set(["core", "media", "providers", "speech"]),
  supervisor: new Set(["core", "providers", "supervisor"]),
};
const MAX_FILE_LINES = 400;
const MAX_FUNCTION_LINES = 60;
const MAX_PARAMETERS = 4;
const LEGACY_NAMES = /(?:^|[-_])(rachel|telegram-bridge|bridge|agent|claude-sdk|cli)(?:[-_.]|$)/i;
const LEGACY_SYMBOLS = /\b(?:Rachel|TelegramBridge|ClaudeAgent|ClaudeAgentSDK)\b/;

function mask(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, (value) => value.replace(/[^\n]/g, " "));
}

function parameterCount(parameters: string): number {
  const trimmed = parameters.trim();
  if (!trimmed) return 0;
  let depth = 0;
  let start = 0;
  let count = 0;
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (character === "," && depth === 0) {
      if (trimmed.slice(start, index).trim()) count++;
      start = index + 1;
    }
  }
  return count + (trimmed.slice(start).trim() ? 1 : 0);
}

function closingBrace(source: string, opening: number): number | undefined {
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return index;
  }
  return undefined;
}

function functionFindings(source: string, file: string): string[] {
  const clean = mask(source);
  const findings: string[] = [];
  const pattern = /\bfunction\s*[A-Za-z_$]*\s*\(([^)]*)\)|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  for (const match of clean.matchAll(pattern)) {
    const open = clean.indexOf("{", (match.index ?? 0) + match[0].length);
    if (open < 0) continue;
    const close = closingBrace(clean, open);
    if (close === undefined) continue;
    const lines = source.slice(match.index ?? 0, close + 1).split("\n").length;
    if (lines > MAX_FUNCTION_LINES) findings.push(`${file}:${source.slice(0, match.index).split("\n").length}: function is ${lines} lines (max ${MAX_FUNCTION_LINES})`);
    const parameters = parameterCount(match[1] ?? match[2] ?? "");
    if (parameters > MAX_PARAMETERS) findings.push(`${file}:${source.slice(0, match.index).split("\n").length}: function has ${parameters} parameters (max ${MAX_PARAMETERS})`);
  }
  return findings;
}

function topLevelMutableState(source: string): boolean {
  const clean = mask(source);
  let depth = 0;
  for (const line of clean.split("\n")) {
    if (depth === 0 && /^\s*(?:let|var)\b/.test(line)) return true;
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
  }
  return false;
}

export function checkSource(source: string, file: string): string[] {
  const clean = mask(source);
  const findings: string[] = [];
  const lines = source.split("\n").length;
  if (lines > MAX_FILE_LINES) findings.push(`${file}: production file is ${lines} lines (max ${MAX_FILE_LINES})`);
  findings.push(...functionFindings(source, file));
  if (/\bany\b/.test(clean)) findings.push(`${file}: production any is forbidden`);
  if (topLevelMutableState(source)) findings.push(`${file}: mutable top-level let/var state is forbidden`);
  if (LEGACY_SYMBOLS.test(clean)) findings.push(`${file}: forbidden legacy symbol`);
  if (/(?:from|import\s*\(|require\s*\()\s*["']@anthropic-ai\/claude-agent-sdk["']/.test(source) && !file.startsWith("src/providers/")) {
    findings.push(`${file}: SDK imports are limited to src/providers`);
  }
  if (file.startsWith("src/core/") && /\b(?:telegram|readline|process\.argv|commander|yargs)\b/i.test(clean)) {
    findings.push(`${file}: Telegram and CLI concerns are forbidden in core`);
  }
  if (/api\.telegram\.org|https:\/\/[^\s"']*telegram/i.test(clean) && file !== "src/telegram/api.ts") {
    findings.push(`${file}: direct Telegram HTTP is limited to src/telegram/api.ts`);
  }
  if (/(?:node:child_process|\b(?:execFile|execSync|spawn|spawnSync)\s*\(|(?<![.\w])exec\s*\()/.test(clean)
    && !file.startsWith("src/speech/") && file !== "src/media/telegram-audio.ts") {
    findings.push(`${file}: subprocess usage is limited to speech/media infrastructure`);
  }
  if (LEGACY_NAMES.test(file.split("/").at(-1) ?? "")) findings.push(`${file}: forbidden legacy filename`);
  findings.push(...importFindings(source, file));
  return findings;
}

function importFindings(source: string, file: string): string[] {
  const from = file.match(/^src\/([^/]+)\//)?.[1];
  if (!from || !MODULES.includes(from as typeof MODULES[number])) return [];
  const findings: string[] = [];
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu;
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const match of withoutComments.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith(".")) continue;
    if (!specifier.endsWith(".ts")) findings.push(`${file}: relative import must end in .ts: ${specifier}`);
    const path = file.split("/").slice(1, -1);
    for (const part of specifier.split("/")) {
      if (part === "..") path.pop();
      else if (part !== ".") path.push(part);
    }
    const target = path[0];
    if (target && MODULES.includes(target as typeof MODULES[number]) && !ALLOWED_IMPORTS[from as typeof MODULES[number]].has(target)) {
      findings.push(`${file}: ${from} may not import ${target}: ${specifier}`);
    }
  }
  return findings;
}

function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...productionFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

export function checkArchitecture(root: string): string[] {
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) return ["src/: rewrite source tree is missing"];
  return productionFiles(sourceRoot).flatMap((path) => {
    const file = relative(root, path).split("\\").join("/");
    return checkSource(readFileSync(path, "utf8"), file);
  });
}

function main(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const findings = checkArchitecture(root);
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("architecture-check: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
