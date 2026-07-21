import { existsSync } from "node:fs";
import { join } from "node:path";

// The tracked prompts/system.md is deliberately GENERIC — it names no operator,
// no email address, no absolute home path, because it ships in the repo. The
// operator-specific prompt lives in prompts/system.local.md, which is gitignored
// and never distributed.
//
// Resolution order, first hit wins:
//   1. $RACHEL_SYSTEM_PROMPT    explicit override, any path
//   2. prompts/system.local.md  the operator's own prompt, if present
//   3. prompts/system.md        the generic tracked fallback
//
// The existsSync seam is injectable so the three branches can be tested without
// writing files into the repo under test.
export function resolveSystemPromptPath(
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const explicit = env["RACHEL_SYSTEM_PROMPT"];
  // A blank or whitespace-only value is treated as unset rather than as a path:
  // an empty env var is far more likely to be an unset-variable accident in a
  // launchd plist than a deliberate request to read "".
  if (explicit !== undefined && explicit.trim() !== "") return explicit;

  const local = join(repoDir, "prompts", "system.local.md");
  return exists(local) ? local : join(repoDir, "prompts", "system.md");
}
