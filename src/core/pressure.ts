import type { Prisma } from "@prisma/client";
import { getDb } from "../db/client.js";
import { listDeckStats } from "./deck-service.js";
import type { DeckStats } from "./types.js";
import { State } from "ts-fsrs";
import { startOfLocalDay } from "./days.js";
import { dueClause } from "./due.js";

export const WARN_FLASHCARDS = 20;
export const PAUSE_FLASHCARDS = 50;
export const WARN_NEW_TODAY = 5;
export const PAUSE_NEW_TODAY = 15;

export type PressureVerdict = "ok" | "warn" | "pause";

export interface AxisClearance {
  due: number;
  toExitWarn: number;
  toExitPause: number;
}

export interface PressureReport {
  verdict: PressureVerdict;
  flashcardsDue: number;
  newAvailable: number;
  newToday: number;
  reasons: string[];
  thresholds: {
    flashcards: { warn: number; pause: number };
    newToday: { warn: number; pause: number };
  };
  /**
   * Flashcards axis only. The cards-added-today axis has no clearance because
   * reviewing cannot lower it — only the start of the next day resets intake.
   */
  clearance: { flashcards: AxisClearance };
  decks: DeckStats[];
}

/**
 * Scheduled review backlog: cards due by `now`, not suspended, not New. New
 * cards are excluded on purpose: they are an optional pool you draw from, not a
 * scheduled debt, so they must never drive review pressure — otherwise a pile
 * of fresh material would block its own studying. New-card intake is policed by
 * the cards-added-today axis instead. Sessions and the overview queue from the
 * same predicate, so "due" means one thing everywhere.
 */
export function dueReviewWhere(now: Date = new Date()): Prisma.CardWhereInput {
  return { ...dueClause(now), suspended: false, state: { not: State.New } };
}

/**
 * The new-card pool: every New card that is not suspended. Its `due` is
 * ignored: a New card has no schedule yet (its `due` is just its creation
 * time), and a session draws from the whole pool, so the pool reported here is
 * the one a session would take from.
 */
export const NEW_CARD_WHERE: Prisma.CardWhereInput = { state: State.New, suspended: false };

async function reviewBacklogCount(): Promise<number> {
  return getDb().card.count({ where: dueReviewWhere() });
}

/**
 * Cards created since the start of the local day (days.ts), the developer's
 * own calendar day in the process timezone, like every day count here.
 *
 * Splits are excluded via the explicit `inheritedFrom` column: they reshape
 * material already in the deck, so counting them would push a developer toward
 * warn/pause for doing the healthy thing under a backlog. Suspended cards are
 * still counted, so suspending is never a way to dodge the intake gate.
 */
async function cardsAddedTodayCount(): Promise<number> {
  return getDb().card.count({
    where: { createdAt: { gte: startOfLocalDay(new Date()) }, inheritedFrom: null },
  });
}

/** The new-card pool — reported for visibility only, never counted as pressure. */
async function newAvailableCount(): Promise<number> {
  return getDb().card.count({ where: NEW_CARD_WHERE });
}

/**
 * The fewest new cards a study session brings in while the day's new-card
 * limit leaves room for them (session-service's startSession), so a full queue
 * of reviews still lets new material in. A review backlog at warn caps a
 * session at exactly this many (backlogNewCap).
 */
export const MIN_NEW_PER_SESSION = 3;

/**
 * The cap the review backlog puts on a session's new cards: none while it is
 * ok, the per-session floor at warn, and no new cards at pause. Intake never
 * caps them (backlogHoldsNewBack says why). /study's Phase 2 table and the
 * app's startSession both follow it.
 */
export function backlogNewCap(pressure: Pick<PressureReport, "flashcardsDue">): number | undefined {
  const verdict = axisVerdict(pressure.flashcardsDue, WARN_FLASHCARDS, PAUSE_FLASHCARDS);
  if (verdict === "pause") return 0;
  if (verdict === "warn") return MIN_NEW_PER_SESSION;
  return undefined;
}

/**
 * Whether new cards are held back from studying: by the review backlog's
 * verdict alone. A warn raised by intake (cards added today) is about creating
 * cards; studying the ones already made adds no load, so it must not lock them
 * away. The rule for a rest day's share ahead, in the overview's plan and the
 * app's session that studies it; regular sessions take backlogNewCap instead.
 */
export function backlogHoldsNewBack(pressure: Pick<PressureReport, "flashcardsDue">): boolean {
  return axisVerdict(pressure.flashcardsDue, WARN_FLASHCARDS, PAUSE_FLASHCARDS) !== "ok";
}

export function axisVerdict(count: number, warn: number, pause: number): PressureVerdict {
  if (count >= pause) return "pause";
  if (count >= warn) return "warn";
  return "ok";
}

function axisClearance(count: number, warn: number, pause: number): AxisClearance {
  return {
    due: count,
    toExitWarn: Math.max(0, count - warn + 1),
    toExitPause: Math.max(0, count - pause + 1),
  };
}

/**
 * One axis, phrased once. `summary` is the single source for both the machine
 * -facing `reasons` entry and the human-facing block message, so the two can
 * never drift apart on the numbers.
 */
interface AxisStatus {
  verdict: PressureVerdict;
  summary: string;
  remedy: string;
  pause: number;
}

function axisStatus(
  count: number,
  warn: number,
  pause: number,
  noun: string,
  remedy: string
): AxisStatus {
  return { verdict: axisVerdict(count, warn, pause), summary: `${count} ${noun}`, remedy, pause };
}

interface PressureCore {
  verdict: PressureVerdict;
  flashcardsDue: number;
  newToday: number;
  reasons: string[];
  thresholds: PressureReport["thresholds"];
  clearance: PressureReport["clearance"];
  axes: AxisStatus[];
}

/**
 * Counts-only pressure: two queries, no per-deck breakdown. The create gate
 * runs on every fresh card and reads nothing but the verdict and its numbers,
 * so it must not pay for the reporting wrapper's deck stats.
 */
async function checkPressureCore(): Promise<PressureCore> {
  const [flashcardsDue, newToday] = await Promise.all([
    reviewBacklogCount(),
    cardsAddedTodayCount(),
  ]);

  const clearance = {
    flashcards: axisClearance(flashcardsDue, WARN_FLASHCARDS, PAUSE_FLASHCARDS),
  };

  const axes = [
    axisStatus(
      flashcardsDue,
      WARN_FLASHCARDS,
      PAUSE_FLASHCARDS,
      "flashcards due",
      `review ${clearance.flashcards.toExitPause} to drop below the line`
    ),
    axisStatus(
      newToday,
      WARN_NEW_TODAY,
      PAUSE_NEW_TODAY,
      "cards added today",
      "intake resets at the start of the next day"
    ),
  ];

  const verdict: PressureVerdict = axes.some((a) => a.verdict === "pause")
    ? "pause"
    : axes.some((a) => a.verdict === "warn")
      ? "warn"
      : "ok";

  const reasons = axes
    .filter((a) => a.verdict !== "ok")
    .map((a) => (a.verdict === "pause" ? `${a.summary} (>= ${a.pause})` : a.summary));

  return {
    verdict,
    flashcardsDue,
    newToday,
    reasons,
    thresholds: {
      flashcards: { warn: WARN_FLASHCARDS, pause: PAUSE_FLASHCARDS },
      newToday: { warn: WARN_NEW_TODAY, pause: PAUSE_NEW_TODAY },
    },
    clearance,
    axes,
  };
}

/** Full report: the counts plus the per-deck breakdown the /study skill reads. */
export async function checkPressure(): Promise<PressureReport> {
  const [core, newAvailable, decks] = await Promise.all([
    checkPressureCore(),
    newAvailableCount(),
    listDeckStats(),
  ]);

  return {
    verdict: core.verdict,
    flashcardsDue: core.flashcardsDue,
    newAvailable,
    newToday: core.newToday,
    reasons: core.reasons,
    thresholds: core.thresholds,
    clearance: core.clearance,
    decks,
  };
}

/**
 * Throws when pressure is at pause; the message is the UX, mirroring assertCardContent.
 *
 * Must call the core, never `checkPressure()`: this runs on every card creation,
 * and the full report spends four more queries (the new-card pool and the
 * per-deck stats) on fields the gate discards.
 */
export async function assertCanCreateCard(): Promise<void> {
  const core = await checkPressureCore();
  if (core.verdict !== "pause") return;

  const lines = core.axes
    .filter((a) => a.verdict === "pause")
    .map((a) => `- ${a.summary} (pause at ${a.pause}): ${a.remedy}`);

  throw new Error(
    `Card creation blocked: SRS pressure is at pause.\n${lines.join("\n")}\nEditing cards (update_card) and splitting (create_card with inheritFrom) remain allowed — both improve deck health under load.`
  );
}
