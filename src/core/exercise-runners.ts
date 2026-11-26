import { execFile } from "child_process";
import { access, mkdir, readFile, realpath, rename } from "fs/promises";
import { createRequire } from "module";
import { homedir } from "os";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

/**
 * What differs between the languages a code card can be in: the interpreter, the
 * harness that evaluates the source and each case, and a few words of the card's
 * own text. The sandbox around them (exercise-sandbox.ts) is the same for all.
 *
 * Every harness does the same: evaluate the source, then each case's expression
 * and goal, compare them as values the language's own way, and write
 * `{error, cases: [{pass, actual, goal, error}]}` to fd 3. A syntax or type error
 * in the source is `error`, which stops before any case.
 */

export const LANGS = ["ruby", "python", "javascript", "typescript", "postgres"] as const;
export type Lang = (typeof LANGS)[number];

export interface Runner {
  /** The harness's file name in /exercise: its extension tells the interpreter what it is. */
  file: string;
  harness: string;
  /** The interpreter, or null when this machine has none. */
  locate(): Promise<string | null>;
  /** Said when `locate` finds none. */
  missing: string;
  /** What a run needs besides the interpreter, read-only. */
  binds(bin: string): string[];
  /** More binds that take some work to have ready, once (Postgres's snapshot). */
  prepare?(): Promise<string[]>;
  /** The interpreter's arguments, the harness and its input last. */
  args: string[];
  timeoutMs: number;
  /** Starts a comment: the card shows each case's goal after it. */
  comment: string;
  /** What a blank holds when nothing is typed: a card passing with it asks nothing. */
  nothing: string;
}

// ---- finding an interpreter -----------------------------------------------------

/** An interpreter outside /usr brings its install directory with it. */
function prefixBinds(bin: string): string[] {
  if (bin.startsWith("/usr/")) return [];
  const prefix = dirname(dirname(bin));
  return ["--ro-bind", prefix, prefix];
}

/**
 * The newest `name` this machine has: mise's when it has one, else the first on
 * the PATH. Not through mise's shims: a shim needs mise and its config, which the
 * sandbox hides. Asked in this repo, so its mise.toml's pin (Ruby's) holds for the
 * MCP server too, which runs in the study repo.
 */
async function findOnMachine(name: string, envVar: string): Promise<string | null> {
  const given = process.env[envVar];
  if (given != null && given !== "") return realpath(given).catch(() => null);
  try {
    const cwd = fileURLToPath(new URL("../..", import.meta.url));
    const { stdout } = await promisify(execFile)("mise", ["which", name], { timeout: 5000, cwd });
    if (stdout.trim() !== "") return await realpath(stdout.trim());
  } catch {
    // No mise, or it pins none: the PATH's, below.
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.includes("mise/shims")) continue;
    try {
      return await realpath(join(dir, name));
    } catch {
      continue;
    }
  }
  return null;
}

/** Cached: a machine's interpreters don't move while the server runs. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => (cached ??= make());
}

/**
 * The Node that runs this server. Not looked up: it is the one already running,
 * and it types and runs TypeScript and SQL's WASM Postgres as well as JavaScript.
 */
const locateNode = once(() => {
  const given = process.env.FLASHCARD_NODE;
  return realpath(given != null && given !== "" ? given : process.execPath).catch(() => null);
});

/** An npm package's directory, found the way this server finds its own dependencies. */
function packageDir(name: string): string {
  const entry = createRequire(import.meta.url).resolve(name);
  const marker = `node_modules/${name}`;
  return entry.slice(0, entry.indexOf(marker) + marker.length);
}

// ---- Ruby ---------------------------------------------------------------------------

/**
 * All in the methods of a nameless module: a local of this file would be visible
 * through TOPLEVEL_BINDING to the code it runs, and a named module could collide
 * with a card's own `class Exercise`, or be reopened by it and pass a wrong answer.
 * Backtraces are cut to the frames in that code: the runner's own are noise to
 * someone reading their mistake. ARGV is emptied, or `gets` in a card would read
 * the input file, solutions and all.
 */
const RUBY_HARNESS = String.raw`
require "json"

Module.new do
  def self.describe(e)
    frames = e.backtrace.to_a.select { |line| line.match?(/\A(main\.rb|case \d+|goal \d+)/) }
    ([e.detailed_message(highlight: false)] + frames.map { |line| "\tfrom #{line}" }).join("\n").scrub
  end

  def self.attempt(code, file)
    [eval(code, TOPLEVEL_BINDING, file, 1), nil]
  rescue Exception => e
    [nil, describe(e)]
  end

  def self.shown(value)
    text = value.inspect.scrub
    text.length > 16_384 ? "#{text[0, 16_384]}... (cut off)" : text
  rescue Exception => e
    "(could not inspect: #{e.class})"
  end

  def self.judge(item, index)
    actual, error = attempt(item["expr"], "case #{index + 1}")
    return { pass: false, actual: nil, goal: nil, error: error } if error
    goal, error = attempt(item["goal"], "goal #{index + 1}")
    return { pass: false, actual: shown(actual), goal: nil, error: error } if error
    { pass: actual == goal, actual: shown(actual), goal: shown(goal), error: nil }
  rescue Exception => e
    { pass: false, actual: nil, goal: nil, error: describe(e) }
  end

  def self.run(input)
    _, error = attempt(input["source"], "main.rb")
    return { error: error, cases: [] } if error
    { error: nil, cases: input["cases"].each_with_index.map { |item, i| judge(item, i) } }
  end

  def self.main
    $stdout.sync = true
    report = run(JSON.parse(File.read(ARGV.shift)))
    verdict = IO.new(3, "w")
    verdict.write(JSON.generate(report))
    verdict.close
  end
end.main
`;

// ---- Python -------------------------------------------------------------------------

/**
 * `==`, but a bool is not the int it equals: `True` answers `True`, not `1`. Cases
 * are expressions (compiled in "eval" mode), so a statement there is a syntax error.
 */
const PYTHON_HARNESS = String.raw`
import json, os, re, sys, traceback

def describe(e):
    if isinstance(e, SyntaxError):
        return f"SyntaxError: {e.msg}\n\tfrom {e.filename}:{e.lineno}"
    mine = re.compile(r"(main\.py|case \d+|goal \d+)\Z")
    frames = [f for f in traceback.extract_tb(e.__traceback__) if mine.match(f.filename)]
    head = f"{type(e).__name__}: {e}"
    return "\n".join([head] + [f"\tfrom {f.filename}:{f.lineno}:in {f.name}" for f in frames])

def shown(value):
    try:
        text = repr(value)
    except BaseException as e:
        return f"(could not repr: {type(e).__name__})"
    return text if len(text) <= 16384 else text[:16384] + "... (cut off)"

def same(a, b):
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    return a == b

def attempt(code, name, mode, ns):
    try:
        return eval(compile(code, name, mode), ns), None
    except BaseException as e:
        return None, describe(e)

def judge(item, i, ns):
    try:
        actual, error = attempt(item["expr"], f"case {i + 1}", "eval", ns)
        if error: return {"pass": False, "actual": None, "goal": None, "error": error}
        goal, error = attempt(item["goal"], f"goal {i + 1}", "eval", ns)
        if error: return {"pass": False, "actual": shown(actual), "goal": None, "error": error}
        return {"pass": bool(same(actual, goal)), "actual": shown(actual), "goal": shown(goal), "error": None}
    except BaseException as e:
        return {"pass": False, "actual": None, "goal": None, "error": describe(e)}

def run(data):
    ns = {"__name__": "__main__"}
    _, error = attempt(data["source"], "main.py", "exec", ns)
    if error: return {"error": error, "cases": []}
    return {"error": None, "cases": [judge(c, i, ns) for i, c in enumerate(data["cases"])]}

path = sys.argv[1]
sys.argv = [sys.argv[0]]
with open(path) as f:
    data = json.load(f)
report = run(data)
sys.stdout.flush()
with os.fdopen(3, "w") as verdict:
    verdict.write(json.dumps(report))
`;

// ---- JavaScript and TypeScript -------------------------------------------------------

/**
 * One evaluator for both: `prepare` turns a snippet into JavaScript (TypeScript's
 * is the compiler's). Everything runs as scripts in the global scope, so a
 * top-level let, const or class of the source is there for each case. An
 * expression is tried in parentheses first, which is what lets \`{ a: 1 }\` be an
 * object and not a block. Values are compared deeply and strictly, Map, Set and
 * NaN included; a promise is awaited. The harness's own names are in a function,
 * out of the card's reach.
 */
const JS_CORE = String.raw`
const vm = require("node:vm");
const util = require("node:util");
const fs = require("node:fs");

function describe(e) {
  if (!(e instanceof Error)) return String(e);
  const mine = /(?:\(|at )(main\.js|case \d+|goal \d+):(\d+)/;
  const frames = String(e.stack).split("\n").map((l) => l.match(mine)).filter(Boolean);
  const where = e.name === "SyntaxError" ? String(e.stack).split("\n")[0].match(/^(main\.js|case \d+|goal \d+):(\d+)/) : null;
  const lines = frames.map((m) => "\tfrom " + m[1] + ":" + m[2]);
  if (where) lines.unshift("\tfrom " + where[1] + ":" + where[2]);
  return [e.name + ": " + e.message, ...lines].join("\n");
}

function shown(value) {
  const text = util.inspect(value, { depth: null, breakLength: Infinity, maxArrayLength: 1000, maxStringLength: 16384 });
  return text.length > 16384 ? text.slice(0, 16384) + "... (cut off)" : text;
}

// Compiled before it runs, so that only a compile error sends an expression to its
// second try: a SyntaxError the code raises itself must not run it twice.
function evaluate(prepare, code, file, parenthesised) {
  let script;
  if (parenthesised) {
    try { script = new vm.Script(prepare(code, true), { filename: file }); } catch (e) { script = null; }
  }
  return (script ?? new vm.Script(prepare(code, false), { filename: file })).runInThisContext();
}

async function attempt(prepare, code, file, parenthesised) {
  try {
    let value = evaluate(prepare, code, file, parenthesised);
    if (value && typeof value.then === "function") value = await value;
    return [value, null];
  } catch (e) {
    return [undefined, describe(e)];
  }
}

async function judge(prepare, item, i) {
  const [actual, error] = await attempt(prepare, item.expr, "case " + (i + 1), true);
  if (error) return { pass: false, actual: null, goal: null, error };
  const [goal, goalError] = await attempt(prepare, item.goal, "goal " + (i + 1), true);
  if (goalError) return { pass: false, actual: shown(actual), goal: null, error: goalError };
  return { pass: util.isDeepStrictEqual(actual, goal), actual: shown(actual), goal: shown(goal), error: null };
}

async function run(prepare, input, early) {
  if (early) return { error: early, cases: [] };
  const [, error] = await attempt(prepare, input.source, "main.js", false);
  if (error) return { error, cases: [] };
  const cases = [];
  for (let i = 0; i < input.cases.length; i++) cases.push(await judge(prepare, input.cases[i], i));
  return { error: null, cases };
}

function report(result) {
  const text = Buffer.from(JSON.stringify(result));
  for (let at = 0; at < text.length; ) at += fs.writeSync(3, text, at);
}
`;

const JAVASCRIPT_HARNESS = String.raw`
${JS_CORE}
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.argv.length = 2;
// A snippet is its own JavaScript; the second try is the snippet bare.
run((code, wrap) => (wrap ? "(" + code + "\n)" : code), input, null).then((r) => { report(r); process.exit(0); });
`;

/**
 * Type-checked first, as `tsc --strict` would: a card about what the compiler
 * rejects is the reason to use TypeScript. The source and every case's
 * expression are one file, so a case sees the source's types. Then each snippet is
 * transpiled and run as JavaScript. The files go in /tmp, which is the one place
 * the sandbox lets a run write; lib comes from the package, mounted read-only.
 * Only \`console\` is declared: there is no @types/node in here, nor the DOM.
 */
const TYPESCRIPT_HARNESS = (tsPath: string): string => String.raw`
${JS_CORE}
const ts = require(${JSON.stringify(tsPath)});
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.argv.length = 2;

function typeErrors() {
  const caseLines = input.cases.map((c) => "void (" + c.expr + "\n);");
  const text = input.source + "\n" + caseLines.join("\n") + "\n";
  fs.writeFileSync("/tmp/main.ts", text);
  fs.writeFileSync("/tmp/env.d.ts", "declare const console: { log(...a: unknown[]): void; error(...a: unknown[]): void; warn(...a: unknown[]): void };\n");
  const options = {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const program = ts.createProgram(["/tmp/env.d.ts", "/tmp/main.ts"], options);
  const file = program.getSourceFile("/tmp/main.ts");
  let found = program.getSyntacticDiagnostics(file);
  if (found.length === 0) found = ts.getPreEmitDiagnostics(program, file);
  if (found.length === 0) return null;
  const sourceLines = input.source.split("\n").length;
  return found.slice(0, 10).map((d) => {
    const at = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0 };
    const line = at.line + 1;
    // Past the source are the cases: line sourceLines + 1 is the first one.
    let place = "main.ts:" + line;
    if (line > sourceLines) {
      let n = 0, upTo = sourceLines;
      for (const c of input.cases) { upTo += c.expr.split("\n").length + 1; n++; if (line <= upTo) break; }
      place = "case " + n;
    }
    return "TypeScript " + place + ": error TS" + d.code + ": " + ts.flattenDiagnosticMessageText(d.messageText, "\n");
  }).join("\n");
}

// A snippet is TypeScript: its types come off, nothing else changes.
function prepare(code, wrap) {
  const js = ts.transpileModule(wrap ? "(" + code + "\n)" : code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
  return js;
}

let early = null;
try { early = typeErrors(); } catch (e) { early = "could not type-check: " + describe(e); }
run(prepare, input, early).then((r) => { report(r); process.exit(0); });
`;

// ---- Postgres -----------------------------------------------------------------------

/**
 * PGlite: Postgres itself, compiled to WASM, in memory and empty on every run. The
 * source is SQL that sets up (it can be many statements); a case's expr is one query
 * and its goal the rows it returns, as an array of rows, each an array of values:
 * \`[[1, "ada"], [2, "bob"]]\`. Rows are compared as they come, so a card whose
 * order matters says ORDER BY. Each case runs in a transaction rolled back after, so
 * an UPDATE in one doesn't change the next. A bigint comes as a number when it fits,
 * a date as its ISO text, and a numeric as the text Postgres prints, which is what
 * the goal has to be.
 */
const POSTGRES_HARNESS = (pglitePath: string): string => String.raw`
import { PGlite } from ${JSON.stringify(pglitePath)};
import fs from "node:fs";
import util from "node:util";
import vm from "node:vm";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.argv.length = 2;

const plain = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v)));
const shown = (value) => { const t = JSON.stringify(value); return t.length > 16384 ? t.slice(0, 16384) + "... (cut off)" : t; };
const message = (e) => String(e && e.message ? e.message : e);
// Deep, so a jsonb object's keys are in Postgres's order, not the order the goal was typed in.
const same = (a, b) => util.isDeepStrictEqual(a, b);

function parseGoal(text) {
  return plain(vm.runInNewContext("(" + text + "\n)", {}, { timeout: 1000 }));
}

async function judge(db, item, i) {
  let actual;
  try {
    await db.exec("BEGIN");
    const result = await db.query(item.expr, [], { rowMode: "array" });
    actual = plain(result.rows);
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => {});
    return { pass: false, actual: null, goal: null, error: "case " + (i + 1) + ": " + message(e) };
  }
  await db.exec("ROLLBACK").catch(() => {});
  let goal;
  try { goal = parseGoal(item.goal); }
  catch (e) { return { pass: false, actual: shown(actual), goal: null, error: "goal " + (i + 1) + ": " + message(e) }; }
  return { pass: same(actual, goal), actual: shown(actual), goal: shown(goal), error: null };
}

async function run() {
  // The snapshot is a database already made: the empty one's start-up (its initdb)
  // is most of a run, 1.6 s of 1.7, and loading it takes 0.4.
  const db = new PGlite(fs.existsSync("/snapshot.tar") ? { loadDataDir: new Blob([fs.readFileSync("/snapshot.tar")]) } : {});
  try { await db.exec(input.source); }
  catch (e) { return { error: "main.sql: " + message(e), cases: [] }; }
  const cases = [];
  for (let i = 0; i < input.cases.length; i++) cases.push(await judge(db, input.cases[i], i));
  return { error: null, cases };
}

const result = await run();
const text = Buffer.from(JSON.stringify(result));
for (let at = 0; at < text.length; ) at += fs.writeSync(3, text, at);
process.exit(0);
`;

// ---- the table ---------------------------------------------------------------------------

/** Node ends up with room for TypeScript's compiler and the WASM, and no more. */
const NODE_ARGS = ["--no-warnings", "--max-old-space-size=1024"];

/**
 * An empty Postgres, made once per PGlite version and kept in the user's cache: the
 * data directory a fresh PGlite builds on every start. Made by the same PGlite, in a
 * node with no environment (this process holds the API key), and moved into place
 * whole, so a server killed half way, or two at once, never leave a torn file.
 * Without it (no cache dir, say) a run just starts fresh, slower.
 */
const postgresSnapshot = once(async (): Promise<string[]> => {
  try {
    const dir = packageDir("@electric-sql/pglite");
    const { version } = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version: string };
    const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agentic-spaced-repetition");
    const file = join(cache, `pglite-${version}.tar`);
    const mount = ["--ro-bind", file, "/snapshot.tar"];
    if (await access(file).then(() => true, () => false)) return mount;
    const node = await locateNode();
    if (node == null) return [];
    await mkdir(cache, { recursive: true });
    const partial = `${file}.${process.pid}`;
    const script = `import(process.argv[1]).then(async ({ PGlite }) => {
      const db = new PGlite();
      const dump = await db.dumpDataDir("none");
      require("fs").writeFileSync(process.argv[2], Buffer.from(await dump.arrayBuffer()));
      process.exit(0);
    })`;
    await promisify(execFile)(node, ["--no-warnings", "-e", script, join(dir, "dist", "index.js"), partial], {
      env: {},
      timeout: 60_000,
    });
    await rename(partial, file);
    return mount;
  } catch {
    return [];
  }
});

const runners = new Map<Lang, Runner>();

/** One runner per language for the life of the server: each keeps what it has found. */
export function runnerFor(lang: Lang): Runner {
  let runner = runners.get(lang);
  if (runner == null) {
    runner = makeRunner(lang);
    runners.set(lang, runner);
  }
  return runner;
}

function makeRunner(lang: Lang): Runner {
  switch (lang) {
    case "ruby":
      return {
        file: "harness.rb",
        harness: RUBY_HARNESS,
        locate: once(() => findOnMachine("ruby", "FLASHCARD_RUBY")),
        missing: "no ruby found: install one with mise",
        binds: prefixBinds,
        args: ["/exercise/harness.rb", "/exercise/input.json"],
        timeoutMs: 5000,
        comment: "#",
        nothing: "nil",
      };
    case "python":
      return {
        file: "harness.py",
        harness: PYTHON_HARNESS,
        locate: once(() => findOnMachine("python3", "FLASHCARD_PYTHON")),
        missing: "no python found: install one with mise or pacman",
        binds: prefixBinds,
        // -I: no PYTHON* variables and no user site; -B: no bytecode to write.
        args: ["-I", "-B", "-u", "/exercise/harness.py", "/exercise/input.json"],
        timeoutMs: 5000,
        comment: "#",
        nothing: "None",
      };
    case "javascript":
      return {
        file: "harness.cjs",
        harness: JAVASCRIPT_HARNESS,
        locate: locateNode,
        missing: "no node found",
        binds: prefixBinds,
        args: [...NODE_ARGS, "/exercise/harness.cjs", "/exercise/input.json"],
        timeoutMs: 5000,
        comment: "//",
        nothing: "null",
      };
    case "typescript": {
      const dir = packageDir("typescript");
      return {
        file: "harness.cjs",
        harness: TYPESCRIPT_HARNESS(join(dir, "lib", "typescript.js")),
        locate: locateNode,
        missing: "no node found",
        binds: (bin) => [...prefixBinds(bin), "--ro-bind", dir, dir],
        args: [...NODE_ARGS, "/exercise/harness.cjs", "/exercise/input.json"],
        // The compiler starts and checks before the first case: a second or two.
        timeoutMs: 10_000,
        comment: "//",
        nothing: "null",
      };
    }
    case "postgres": {
      const dir = packageDir("@electric-sql/pglite");
      return {
        file: "harness.mjs",
        harness: POSTGRES_HARNESS(join(dir, "dist", "index.js")),
        locate: locateNode,
        missing: "no node found",
        binds: (bin) => [...prefixBinds(bin), "--ro-bind", dir, dir],
        prepare: postgresSnapshot,
        args: [...NODE_ARGS, "/exercise/harness.mjs", "/exercise/input.json"],
        timeoutMs: 10_000,
        comment: "--",
        nothing: "NULL",
      };
    }
    default:
      // A card from a newer machine, or edited by hand: said as a runner that isn't there.
      return {
        file: "",
        harness: "",
        locate: () => Promise.resolve(null),
        missing: `no runner for the language "${String(lang)}" (it has ${LANGS.join(", ")})`,
        binds: () => [],
        args: [],
        timeoutMs: 0,
        comment: "#",
        nothing: "nil",
      };
  }
}
