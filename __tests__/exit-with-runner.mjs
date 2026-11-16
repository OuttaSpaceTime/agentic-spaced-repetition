// Preloaded into every vitest fork worker (vitest.config.ts, --import), before
// it is handed a test file. A worker whose runner died (`vitest run | head`
// kills the runner with EPIPE) otherwise lives on with no parent: idle if it
// had no test file yet, still running and growing to GBs if it had, until the
// machine ran out of memory and a worker crashed. The IPC channel closes with
// the runner, so the worker leaves with it. A setup file is too late: a worker
// still starting up never runs one.
//
// The real exit is kept from here: vitest's worker replaces process.exit with
// one that throws ("process.exit unexpectedly called"), to catch tests calling it.
const exit = process.exit.bind(process);
process.once("disconnect", () => exit(1));
