import { describe, expect, it } from "vitest";
import { checkExercise, exerciseSides, runExercise, type Exercise } from "../../src/core/exercises.js";
import { runSandboxed } from "../../src/core/exercise-sandbox.js";

/**
 * Each language's runner, for real, in the sandbox: one card of each kind of
 * check it has to get right. A language with no interpreter here fails these on
 * purpose: its cards could not be written or reviewed on this machine.
 */

const base = { brief: "Brief.", explain: "Because." };

const python: Exercise = {
  ...base,
  kind: "predict",
  lang: "python",
  source: "def add(x, items=[]):\n    items.append(x)\n    return items\n\nadd(1)",
  cases: [{ expr: "add(2)", goal: "[1, 2]" }],
};

const javascript: Exercise = {
  ...base,
  kind: "fill",
  lang: "javascript",
  source: "const double = (list) => list.{{c1::map}}((n) => n * 2);",
  cases: [{ expr: "double([1, 2])", goal: "[2, 4]" }],
};

const typescript: Exercise = {
  ...base,
  kind: "compose",
  lang: "typescript",
  source: "function first<T>(list: T[]): T | undefined {\n{{c1::  return list[0];\n}}}",
  cases: [{ expr: "first([3, 4])", goal: "3" }],
};

const postgres: Exercise = {
  ...base,
  kind: "fill",
  lang: "postgres",
  source:
    "CREATE TABLE t (n int);\nINSERT INTO t VALUES (1), (2), (3);\nCREATE VIEW big AS SELECT n FROM t {{c1::WHERE n > 1}};",
  cases: [{ expr: "SELECT n FROM big ORDER BY n", goal: "[[2], [3]]" }],
};

describe("ruby", () => {
  // Cards require it; it lives in the Ruby mise.toml pins, not every Ruby.
  it("has ActiveSupport, in the pinned Ruby", async () => {
    const res = await runSandboxed({ lang: "ruby", source: 'require "active_support/all"', cases: [{ expr: "false.blank?", goal: "true" }] });
    expect(res.report).toMatchObject({ error: null, cases: [{ pass: true }] });
  });
});

describe("python", () => {
  it("evaluates a prediction by value, and is Good only once it is right", async () => {
    expect((await runExercise(python, ["[2]"])).status).toBe("wrong");
    const right = await runExercise(python, ["[1,2]"]);
    expect(right.status).toBe("pass");
    expect(right.cases[0].actual).toBe("[1, 2]");
  });

  it("does not take 1 for True", async () => {
    const res = await runSandboxed({ lang: "python", source: "", cases: [{ expr: "1 == 1", goal: "1" }] });
    expect(res.report?.cases[0].pass).toBe(false);
  });

  it("reports the line of an error in the source, and a syntax error as the run's own", async () => {
    const boom = await runSandboxed({ lang: "python", source: "x = 1\nraise ValueError('no')", cases: [] });
    expect(boom.report?.error).toMatch(/ValueError: no\n\tfrom main\.py:2/);
    const syntax = await runSandboxed({ lang: "python", source: "def (", cases: [] });
    expect(syntax.report?.error).toMatch(/SyntaxError/);
  });

  it("checks its own card for real", async () => {
    const check = await checkExercise(python);
    expect(check.problems).toEqual([]);
    expect(check.sides?.front).toContain("# =&gt; {{c1::[1, 2]}}");
  });
});

describe("javascript", () => {
  it("passes a fill by value: deep, strict, and an object literal is an object", async () => {
    expect((await runExercise(javascript, ["map"])).status).toBe("pass");
    expect((await runExercise(javascript, ["filter"])).status).toBe("wrong");
    const res = await runSandboxed({
      lang: "javascript",
      source: "",
      cases: [
        { expr: "{ a: [1, new Set([2])] }", goal: "{ a: [1, new Set([2])] }" },
        { expr: "[1]", goal: "['1']" },
        { expr: "Promise.resolve(5)", goal: "5" },
      ],
    });
    expect(res.report?.cases.map((c) => c.pass)).toEqual([true, false, true]);
  });

  it("keeps a source's let and class for every case, and runs an expression once", async () => {
    const res = await runSandboxed({
      lang: "javascript",
      source: "let n = 0; class A {}",
      cases: [{ expr: "++n", goal: "1" }, { expr: "(() => { throw new SyntaxError('mine') })()", goal: "0" }],
    });
    expect(res.report?.cases[0].pass).toBe(true);
    expect(res.report?.cases[1].error).toMatch(/SyntaxError: mine/);
  });

  it("shows a case's thrown error, with where", async () => {
    const res = await runSandboxed({ lang: "javascript", source: "", cases: [{ expr: "null.x", goal: "1" }] });
    expect(res.report?.cases[0].error).toMatch(/TypeError/);
    expect(res.report?.cases[0].error).toMatch(/from case 1:1/);
  });

  it("stops an endless loop", async () => {
    const res = await runSandboxed({ lang: "javascript", source: "while (true) {}", cases: [] });
    expect(res.status).toBe("timeout");
  }, 10_000);

  it("has no network and no environment", async () => {
    process.env.SECRET_FOR_TEST = "hunter2";
    const res = await runSandboxed({
      lang: "javascript",
      source: "",
      cases: [
        { expr: "Object.keys(process.env).sort()", goal: "[]" },
        { expr: "fetch('http://1.1.1.1').then(() => 'reached', () => 'refused')", goal: "'refused'" },
      ],
    });
    delete process.env.SECRET_FOR_TEST;
    expect(res.report?.cases[0].actual).toBe("[ 'LANG', 'PATH', 'PWD' ]");
    expect(res.report?.cases[1].pass).toBe(true);
  });
});

describe("typescript", () => {
  it("runs a body written into its blank, after type-checking", async () => {
    expect((await runExercise(typescript, ["  return list[0];\n"])).status).toBe("pass");
  });

  it("stops at a type error before any case, and says which", async () => {
    const res = await runSandboxed({
      lang: "typescript",
      source: "const n: number = 'x';",
      cases: [{ expr: "1", goal: "1" }],
    });
    expect(res.report?.error).toMatch(/main\.ts:1: error TS2322/);
    expect(res.report?.cases).toEqual([]);
  }, 15_000);

  it("type-checks a case's expression too", async () => {
    const res = await runSandboxed({
      lang: "typescript",
      source: "function f(n: number) { return n; }",
      cases: [{ expr: "f('a')", goal: "1" }],
    });
    expect(res.report?.error).toMatch(/case 1: error TS2345/);
  }, 15_000);

  it("checks its own card for real", async () => {
    const check = await checkExercise(typescript);
    expect(check.problems).toEqual([]);
  }, 15_000);
});

describe("postgres", () => {
  it("runs the filled blank against a real Postgres", async () => {
    expect((await runExercise(postgres, ["WHERE n > 1"])).status).toBe("pass");
    const wrong = await runExercise(postgres, ["WHERE n > 2"]);
    expect(wrong.status).toBe("wrong");
    expect(wrong.cases[0].actual).toBe("[[3]]");
  }, 15_000);

  it("reports SQL's own error, and a failing setup as the run's", async () => {
    const res = await runSandboxed({
      lang: "postgres",
      source: "CREATE TABLE t (n int);",
      cases: [{ expr: "SELECT * FROM nope", goal: "[]" }],
    });
    expect(res.report?.cases[0].error).toMatch(/relation "nope" does not exist/);
    const setup = await runSandboxed({ lang: "postgres", source: "CREATE TABL t", cases: [] });
    expect(setup.report?.error).toMatch(/main\.sql: .*syntax error/);
  }, 20_000);

  it("rolls each case back, and gives a bigint as a number", async () => {
    const res = await runSandboxed({
      lang: "postgres",
      source: "CREATE TABLE t (n int); INSERT INTO t VALUES (1);",
      cases: [
        { expr: "DELETE FROM t RETURNING n", goal: "[[1]]" },
        { expr: "SELECT count(*) FROM t", goal: "[[1]]" },
      ],
    });
    expect(res.report?.cases.map((c) => c.pass)).toEqual([true, true]);
  }, 15_000);

  it("checks its own card for real, and writes SQL comments on its sides", async () => {
    const check = await checkExercise(postgres);
    expect(check.problems).toEqual([]);
    expect(exerciseSides(postgres).front).toContain("-- =&gt; [[2], [3]]");
  }, 20_000);
});

describe("postgres, further", () => {
  it("takes a jsonb object whatever order its keys are typed in", async () => {
    const res = await runSandboxed({
      lang: "postgres",
      source: `CREATE TABLE t (j jsonb); INSERT INTO t VALUES ('{"name": "x", "id": 1}');`,
      cases: [{ expr: "SELECT j FROM t", goal: '[[{"name": "x", "id": 1}]]' }],
    });
    expect(res.report?.cases[0].pass).toBe(true);
  }, 15_000);

  it("starts from a ready-made empty database: a run is well under a fresh PGlite's 1.6 s", async () => {
    await runSandboxed({ lang: "postgres", source: "", cases: [] }); // makes the snapshot, if it isn't there
    const res = await runSandboxed({ lang: "postgres", source: "", cases: [{ expr: "SELECT 1", goal: "[[1]]" }] });
    expect(res.report?.cases[0].pass).toBe(true);
    expect(res.durationMs).toBeLessThan(1400);
  }, 90_000);
});

describe("a blank left empty must fail the card", () => {
  const passing = (lang: Exercise["lang"], source: string, expr: string, goal: string): Exercise => ({
    ...base,
    kind: "fill",
    lang,
    source,
    cases: [{ expr, goal }],
  });

  it.each([
    ["python", passing("python", "value = {{c1::None}}", "value", "None")],
    ["javascript", passing("javascript", "const value = {{c1::null}};", "value", "null")],
    ["typescript", passing("typescript", "const value: null = {{c1::null}};", "value", "null")],
    ["postgres", passing("postgres", "CREATE VIEW v AS SELECT {{c1::NULL}} AS n;", "SELECT n FROM v", "[[null]]")],
  ])("%s", async (_, ex) => {
    const check = await checkExercise(ex);
    expect(check.problems.join()).toMatch(/passes with every blank empty/);
  }, 30_000);
});

it("a card with a language this server doesn't have is unavailable, not a crash", async () => {
  const res = await runSandboxed({ lang: "angular" as never, source: "", cases: [] });
  expect(res.status).toBe("unavailable");
  expect(res.failure).toMatch(/no runner for the language "angular"/);
});

it("a card without a lang runs as Ruby, as the first code cards did", async () => {
  const res = await runSandboxed({ source: "", cases: [{ expr: "[1, 2].sum", goal: "3" }] });
  expect(res.report?.cases[0].pass).toBe(true);
});
