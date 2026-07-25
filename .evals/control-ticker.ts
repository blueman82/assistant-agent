// Negative-control entrypoint for the ticker eval. A separate file, rather than a
// flag on the main command, because the eval gate refuses a negative_control
// whose text merely wraps its cmd — and that refusal is correct in general.
//
// This runs the SAME harness with the SAME assertions, with only the
// triggering condition removed (see EVAL_NEGATIVE_CONTROL in harness-ticker.ts).
// It therefore fails for a CONTENT reason both before the feature is built
// and after, rather than flipping to a pass at the merge gate.
process.env["EVAL_NEGATIVE_CONTROL"] = "1";
await import("./harness-ticker.ts");
