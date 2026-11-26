#!/usr/bin/env node

import { Command } from "commander";
import { openDeck, databaseFile, getOverview, rescheduleEasyDays, dumpDatabase, restoreDatabase, localDay, PACKAGE_VERSION } from "../sdk/index.js";

const program = new Command();

program
  .name("srs")
  .description("Admin commands for the deck; studying and card work go through the MCP server and the app")
  .version(PACKAGE_VERSION);

// Errors thrown from an action are printed by the run at the bottom, which
// exits non-zero; actions never call process.exit, so the client disconnects.

/** An integer option of at least `min`, or a clean error naming the flag. */
function intOption(value: string, flag: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be a whole number of at least ${min}, got "${value}"`);
  }
  return n;
}

// --- overview ---
program
  .command("overview")
  .description("Pending cards and a rough progress picture, as JSON (the Omvida bar panel reads it)")
  .option("--pending <n>", "How many pending cards to list", "8")
  .action(async (opts: { pending: string }) => {
    // stdout is a machine interface (Omvida's bar reads it): the JSON and nothing else.
    const pendingLimit = intOption(opts.pending, "--pending", 0);
    console.log(JSON.stringify(await getOverview({ pendingLimit })));
  });

// --- easy-days ---
program
  .command("easy-days")
  .description("Move already-scheduled reviews off Easy Days' reduced days, as a review would (a dry run without --apply)")
  .option("--apply", "Write the moves")
  .action(async (opts: { apply?: boolean }) => {
    const moves = await rescheduleEasyDays(opts.apply === true);
    const day = (d: Date) => `${localDay(d)} ${d.toLocaleDateString("en", { weekday: "short" })}`;
    for (const m of moves) console.log(`  ${day(m.from)} → ${day(m.to)}  ${m.front.slice(0, 60).replace(/\s+/g, " ")}`);
    console.log(`  ${moves.length} card(s) ${opts.apply === true ? "moved" : "would move (dry run; --apply to write)"}`);
  });

// --- db:dump / db:restore ---
program
  .command("db:dump <file>")
  .description("Export full database as a portable SQL dump")
  .option("--source <path>", "Source DB path (defaults to DATABASE_URL)")
  .action((file: string, opts: { source?: string }) => {
    const src = opts.source ?? databaseFile();
    const result = dumpDatabase(src, file);
    console.log(`  Dumped ${result.rows} rows across ${result.tables} table(s) from ${src} → ${file}`);
  });

program
  .command("db:restore <file>")
  .description("Restore database from a SQL dump")
  .option("--target <path>", "Target DB path (defaults to DATABASE_URL)")
  .option("--force", "Overwrite target if it already exists")
  .action((file: string, opts: { target?: string; force?: boolean }) => {
    const target = opts.target ?? databaseFile();
    const result = restoreDatabase(target, file, { force: opts.force === true });
    console.log(`  Restored ${result.rows} rows across ${result.tables} table(s) from ${file} → ${target}`);
  });

// Run
void openDeck()
  .then(async (deck) => {
    try {
      await program.parseAsync(process.argv);
    } finally {
      await deck.close();
    }
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
