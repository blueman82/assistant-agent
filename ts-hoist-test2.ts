console.error("[test2] before setting env");
process.env["FOO3"] = "set-before-import-ts2";
console.error("[test2] after setting env, before import statement executes (but import already resolved above per spec ordering)");
import { bar } from "./ts-hoist-check2.ts";
console.log(bar());
