import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runnerFor, type Lang, type Runner } from "./exercise-runners.js";

/**
 * Runs a code card's code, with nothing to reach.
 *
 * Under bubblewrap: no network, a read-only system, an empty tmpfs and no
 * home, with a clean environment. That last one is not hygiene: this process
 * holds the Anthropic API key (Omvida's bin/omvida-deck hands it over), and the
 * prototype's runner passed its whole environment on to the code it ran. So
 * bubblewrap itself starts without it: its --clearenv cleans what it execs, not
 * its own process, which is PID 1 in there with /proc mounted. The code is the
 * developer's own typing, or a card Claude wrote, so this guards against a
 * mistake rather than an attacker, but `system("rm -rf ~")` should cost nothing
 * either way. The limits are for the same mistakes: a recursive fork, a file
 * written in a loop: per process and per file, and each place a file can go (/tmp,
 * /dev/shm) has a size of its own.
 *
 * A timeout kills the whole tree: bubblewrap's PID namespace dies with it. The
 * run's verdict comes back on a pipe of its own (fd 3), so nothing the code
 * prints can be mistaken for it, nor the other way round.
 *
 * One process per run, about 60 ms for Ruby, Python and JavaScript: fast enough
 * to run at every pause in the typing, and cheap enough not to keep an
 * interpreter around that one run could leave in a bad state. TypeScript (the
 * compiler's start) and Postgres (WASM) take a second or two. What differs per
 * language is in exercise-runners.ts.
 */

/** What is kept of each stream. More than this is a loop, not an answer. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Every shown value is cut in the harness, so only a very odd card gets here. */
const MAX_VERDICT_BYTES = 1024 * 1024;
const TMPFS_BYTES = 16 * 1024 * 1024;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PROCESSES = 64;

export interface SandboxReport {
  error: string | null;
  cases: Array<{ pass: boolean; actual: string | null; goal: string | null; error: string | null }>;
}

export interface SandboxResult {
  status: "ran" | "timeout" | "unavailable";
  report: SandboxReport | null;
  stdout: string;
  stderr: string;
  /** Why there is no report, when there is none. */
  failure: string | null;
  durationMs: number;
}

function bubblewrapArgv(runner: Runner, bin: string, extra: string[], workDir: string): string[] {
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--proc", "/proc",
    // /dev is bubblewrap's tmpfs, as large as half the RAM and writable, and /dev/shm
    // in it too: a loop writing there is no part of any quota. So /dev/shm gets a
    // size, and the rest of /dev, device nodes only, is read-only. Writing to
    // /dev/null still works on a read-only mount.
    "--dev", "/dev",
    "--size", String(TMPFS_BYTES), "--tmpfs", "/dev/shm",
    "--remount-ro", "/dev",
    "--size", String(TMPFS_BYTES), "--tmpfs", "/tmp",
    "--ro-bind", workDir, "/exercise",
    "--chdir", "/tmp",
    ...runner.binds(bin),
    ...extra,
    "/usr/bin/prlimit", `--as=${MEMORY_BYTES}`, `--nproc=${MAX_PROCESSES}`, `--fsize=${TMPFS_BYTES}`, "--core=0",
    bin, ...runner.args,
  ];
}

/** Stops collecting at the cap, and says it stopped. */
class CappedOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number = MAX_OUTPUT_BYTES) {}
  add(chunk: Buffer): void {
    if (this.size < this.cap) this.chunks.push(chunk);
    this.size += chunk.length;
  }
  get full(): boolean {
    return this.size >= this.cap;
  }
  text(): string {
    const all = Buffer.concat(this.chunks).subarray(0, this.cap).toString("utf8");
    return this.full ? `${all}\n... (output cut off)` : all;
  }
}

const UNAVAILABLE = (failure: string, started: number): SandboxResult => ({
  status: "unavailable",
  report: null,
  stdout: "",
  stderr: "",
  failure,
  durationMs: Date.now() - started,
});

/**
 * `signal` stops the run early: its result is a timeout, which nobody is waiting for.
 * No `lang` is Ruby, which is what the first code cards were.
 */
export async function runSandboxed(
  input: { lang?: Lang; source: string; cases: unknown[] },
  signal?: AbortSignal
): Promise<SandboxResult> {
  const started = Date.now();
  const runner = runnerFor(input.lang ?? "ruby");
  const bin = await runner.locate();
  if (bin == null) return UNAVAILABLE(runner.missing, started);
  const extra = (await runner.prepare?.()) ?? [];
  const workDir = await mkdtemp(join(tmpdir(), "flashcard-exercise-"));
  try {
    await writeFile(join(workDir, runner.file), runner.harness);
    await writeFile(join(workDir, "input.json"), JSON.stringify({ source: input.source, cases: input.cases }));
    return await spawnBubblewrap(bubblewrapArgv(runner, bin, extra, workDir), runner.timeoutMs, started, signal);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function spawnBubblewrap(argv: string[], timeoutMs: number, started: number, signal?: AbortSignal): Promise<SandboxResult> {
  return new Promise((resolve) => {
    // PATH alone, to find bwrap: see the top of this file.
    const child = spawn("bwrap", argv, { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    const verdict = new CappedOutput(MAX_VERDICT_BYTES);
    let timedOut = false;
    let cancelled = false;
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const cancel = (): void => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const collect = (into: CappedOutput) => (chunk: Buffer): void => {
      into.add(chunk);
      // A program printing forever is stopped now, not at the timeout.
      if (into.full) kill();
    };
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", collect(verdict));
    const finished = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    child.on("error", (e) => {
      finished();
      resolve(UNAVAILABLE(`could not start the sandbox (${e.message}): is bubblewrap installed?`, started));
    });
    child.on("close", (code) => {
      finished();
      const durationMs = Date.now() - started;
      if (timedOut || cancelled) {
        resolve({
          status: "timeout",
          report: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          failure: cancelled ? "stopped: a newer run took its place" : `stopped after ${timeoutMs / 1000} seconds: an endless loop?`,
          durationMs,
        });
        return;
      }
      let report: SandboxReport | null = null;
      try {
        report = JSON.parse(verdict.text()) as SandboxReport;
      } catch {
        // It ended before reporting: `exit!`, a crash, the output cap.
      }
      // Bubblewrap couldn't set up, so the code never ran (no user namespaces,
      // say). That is the machine's fault, not an error in the answer.
      if (report == null && stderr.text().startsWith("bwrap: ")) {
        resolve(UNAVAILABLE(`could not start the sandbox (${stderr.text().trim()})`, started));
        return;
      }
      resolve({
        status: "ran",
        report,
        stdout: stdout.text(),
        stderr: stderr.text(),
        failure: report == null ? `the code ended before finishing (exit ${code ?? "killed"})` : null,
        durationMs,
      });
    });
  });
}
