import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { backlogHoldsNewBack, checkPressure, dueReviewWhere, type PressureReport } from "./pressure.js";
import { checkCalibration, type CalibrationReport } from "./calibration.js";
import { getStudyStreak } from "./analytics-service.js";
import { cardMaturity } from "./scheduler.js";
import type { CardMaturity } from "./types.js";
import { visibleText } from "./content-rules.js";
import { localDay, startOfLocalDay, weekdayLabel } from "./days.js";
import { currentAheadPlan } from "./session-service.js";
import type { AheadPlan } from "./study-ahead.js";

/**
 * A rough picture of where studying stands: what is pending, how retention is
 * holding up, how the deck has matured, and the last week of reviews. One call,
 * shared by the Omvida bar panel (through `master overview`) and the Omvida app,
 * so the two never show different numbers.
 *
 * Every figure comes from the same core the MCP tools use. Pressure and
 * calibration are passed through whole, never recomputed: their verdicts drive
 * /study, and a second implementation drifted within a day the last time one
 * was written (see the study repo's AGENTS.md, "Flashcards in the viewer").
 */

export interface DayCount {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  reviews: number;
  /** Reviews rated Again on that day. */
  again: number;
}

export interface ForecastDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Reviews scheduled on that day as the deck stands now. */
  due: number;
}

export interface LoadBar {
  /** A single day's weekday ("Mo"), or a total's span ("4d"). */
  label: string;
  reviews: number;
  /** Of those reviews, the ones rated Again. */
  again: number;
  /** Reviews still to come: today's backlog, or what is scheduled ahead. */
  due: number;
  today: boolean;
}

export interface PendingCard {
  deck: string;
  /** Front with markup stripped, for a one-line preview. */
  text: string;
  lapses: number;
}

export interface Overview {
  pressure: PressureReport;
  calibration: CalibrationReport;
  streak: number;
  /** Unsuspended cards; the maturity buckets sum to it. */
  totalCards: number;
  maturity: Record<CardMaturity, number>;
  /** Oldest first, ending today: always `days` entries. */
  week: DayCount[];
  /** Reviews by day around today, oldest first: see `loadBars`. */
  load: LoadBar[];
  reviewedToday: number;
  /** Due review cards, most overdue first; new cards are a pool, not pending. */
  pending: PendingCard[];
  /**
   * On a rest day (Easy Days at Minimum), the share of the week it offers to
   * study ahead (study-ahead.ts); null on a study day.
   */
  ahead: AheadPlan | null;
}

/**
 * Reviews per local day for the `days` days ending today.
 */
export function bucketWeek(
  reviews: readonly { reviewedAt: Date; rating: number }[],
  now: Date,
  days = 7
): DayCount[] {
  const out: DayCount[] = [];
  const index = new Map<string, DayCount>();
  for (let i = days - 1; i >= 0; i--) {
    const entry = { day: localDay(startOfLocalDay(now, i)), reviews: 0, again: 0 };
    out.push(entry);
    index.set(entry.day, entry);
  }
  for (const r of reviews) {
    const entry = index.get(localDay(r.reviewedAt));
    if (entry == null) continue;
    entry.reviews += 1;
    if (r.rating === 1) entry.again += 1;
  }
  return out;
}

/**
 * Scheduled reviews per local day for the `days` days after today. Only what
 * is scheduled now: a card reviewed tomorrow comes back later than this shows,
 * and today's backlog is pressure's figure, not carried forward.
 */
export function bucketForecast(cards: readonly { due: Date }[], now: Date, days: number): ForecastDay[] {
  const out = Array.from({ length: days }, (_, i) => ({ day: localDay(startOfLocalDay(now, -(i + 1))), due: 0 }));
  const index = new Map(out.map((entry) => [entry.day, entry]));
  for (const card of cards) {
    const entry = index.get(localDay(card.due));
    if (entry != null) entry.due += 1;
  }
  return out;
}

/** Each side of today, nearest first: single days, then ever wider totals. */
const LOAD_SPANS = [1, 1, 1, 1, 1, 2, 4, 8];
const LOAD_DAYS = LOAD_SPANS.reduce((sum, n) => sum + n, 0);

function spans<T>(days: readonly T[]): T[][] {
  let at = 0;
  return LOAD_SPANS.map((n) => days.slice(at, (at += n)));
}

function spanLabel(run: readonly { day: string }[]): string {
  return run.length === 1 ? weekdayLabel(run[0].day) : `${run.length}d`;
}

/**
 * The review chart the Omvida app and bar panel both draw: the days behind
 * today, today, the days ahead. `history` is oldest first and ends today;
 * `forecast` starts tomorrow. Grouped here so the two can never differ.
 */
export function loadBars(history: readonly DayCount[], forecast: readonly ForecastDay[], dueToday: number): LoadBar[] {
  const today = history[history.length - 1];
  const behind = spans([...history.slice(0, -1)].reverse()).map((run) => ({
    label: spanLabel(run),
    reviews: run.reduce((sum, d) => sum + d.reviews, 0),
    again: run.reduce((sum, d) => sum + d.again, 0),
    due: 0,
    today: false,
  }));
  const ahead = spans(forecast).map((run) => ({
    label: spanLabel(run),
    reviews: 0,
    again: 0,
    due: run.reduce((sum, d) => sum + d.due, 0),
    today: false,
  }));
  return [
    ...behind.reverse(),
    { label: weekdayLabel(today.day), reviews: today.reviews, again: today.again, due: dueToday, today: true },
    ...ahead,
  ];
}

export async function getOverview(opts: { pendingLimit?: number; now?: Date } = {}): Promise<Overview> {
  const db = getDb();
  const now = opts.now ?? new Date();

  const [pressure, calibration, streak, cards, reviews, pending] = await Promise.all([
    checkPressure(),
    checkCalibration(),
    getStudyStreak(now),
    db.card.findMany({ where: { suspended: false }, select: { state: true, interval: true, due: true } }),
    db.review.findMany({
      where: { reviewedAt: { gte: startOfLocalDay(now, LOAD_DAYS) } },
      select: { reviewedAt: true, rating: true },
    }),
    db.card.findMany({
      where: dueReviewWhere(now),
      include: { deck: { select: { name: true } } },
      orderBy: { due: "asc" },
      take: opts.pendingLimit ?? 8,
    }),
  ]);
  // The share with the new cards a session would give it: none while the backlog holds them back.
  const ahead = await currentAheadPlan(now, backlogHoldsNewBack(pressure) ? 0 : undefined);

  // Suspended cards are out of rotation: neither in the buckets nor the total,
  // so the buckets always sum to totalCards.
  const maturity: Record<CardMaturity, number> = { new: 0, learning: 0, familiar: 0, internalized: 0 };
  for (const card of cards) maturity[cardMaturity(card)] += 1;

  const week = bucketWeek(reviews, now);
  // A New card's `due` is only its creation time: it has no schedule yet.
  const forecast = bucketForecast(cards.filter((c) => c.state !== State.New), now, LOAD_DAYS);

  return {
    pressure,
    calibration,
    streak,
    totalCards: cards.length,
    maturity,
    week,
    load: loadBars(bucketWeek(reviews, now, LOAD_DAYS + 1), forecast, pressure.flashcardsDue),
    reviewedToday: week[week.length - 1]?.reviews ?? 0,
    pending: pending.map((c) => ({ deck: c.deck.name, text: visibleText(c.front), lapses: c.lapses })),
    ahead,
  };
}
