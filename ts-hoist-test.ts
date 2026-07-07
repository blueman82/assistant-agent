process.env["FOO2"] = "set-before-import-ts";
import { bar } from "./ts-hoist-check.ts";
console.log(bar());
