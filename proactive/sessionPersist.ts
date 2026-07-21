// Bridge-only session persistence. A launchd bridge restart currently wipes
// the Telegram conversation thread mid-conversation because rachel.ts's
// sessionId is module-scoped and never written to disk. These are pure,
// path-taking functions (mirroring memoryIndex.ts's composeSystemPrompt) so
// rachel.ts can gate every call site on the RACHEL_SESSION_FILE env seam —
// unset means this module is never touched, preserving today's exact
// behaviour for the CLI and all headless one-shots.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface SessionFile {
  schema_version: 1;
  session_id: string;
}

// Absent-is-clean-start is a documented contract, matching
// proactive/push.ts's readJson and proactive/memoryIndex.ts's
// composeSystemPrompt — only ENOENT means "no persisted session yet".
// Anything else (corrupt JSON, EACCES, EISDIR) throws loud with the path
// named: silently treating a broken store as "no session" would mask a
// real failure instead of surfacing it.
export function readSession(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`cannot read session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: SessionFile;
  try {
    parsed = JSON.parse(raw) as SessionFile;
  } catch (err) {
    throw new Error(`corrupt session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsed.session_id;
}

// Temp-file + rename in the same directory — proactive/push.ts's
// writeJsonAtomic idiom. A reader (a fresh bridge process starting up)
// never sees a half-written file.
export function writeSession(path: string, sessionId: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const data: SessionFile = { schema_version: 1, session_id: sessionId };
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, path);
}

// Called from resetSession() so /reset also clears the persisted copy —
// otherwise a restart after /reset would resurrect the just-reset session.
// ENOENT is a clean no-op: resetting before any session was ever persisted
// must not throw.
export function clearSession(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot clear session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
