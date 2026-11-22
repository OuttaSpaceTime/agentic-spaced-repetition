import { startOfLocalDay } from "./days.js";

/**
 * Rest days and studying ahead on them: the pure rules, no DB (study-ahead.ts
 * gathers the counts these take).
 *
 * A rest day is a weekday Anki's Easy Days set to Minimum (0%), mirrored by
 * anki-sync, so Anki stays the one place the week is set and there is no second
 * setting to drift from it. `avoidEasyDays` keeps reviews off those days; this
 * keeps new cards off them too. Without it the daily new limit still applied on
 * a rest day, and a session there, with nothing due, was all new cards: ten a
 * weekend on top of the week's, the overstudy the rest days were meant to stop.
 *
 * What a rest day offers instead is studying ahead: a seventh of what is left of
 * the week (`aheadShare`), the reviews the study days ahead hold and the new
 * cards they would bring in, in that mix. New cards studied on rest days are
 * borrowed from the study days after them (`borrowedToday`), never added, so the
 * week's new cards stay what the daily limit gives five study days.
 */

/** Monday-first index into Anki's Easy Days list; getDay is Sunday first. */
export function easyDayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** A day Anki's Easy Days set to Minimum: no reviews are scheduled on it, and no new cards come up. */
export function isRestDay(easyDays: readonly number[] | undefined, day: Date): boolean {
  return easyDays?.[easyDayIndex(day)] === 0;
}

/** A rest day takes this share of what is left of the week: a seventh, one day's worth of seven. */
export const AHEAD_SHARE_DAYS = 7;

/** Far enough to cross any week; it only stops the walks when every day is a rest day. */
const WALK_LIMIT = 14;

/**
 * What is left of the week from `now`: from tomorrow past any rest days, then
 * the run of study days up to the next rest day. `end` is the local midnight
 * that run stops at (exclusive), `studyDays` its days' midnights. On a Saturday
 * with weekends off: Monday to Friday, ending the next Saturday at 00:00.
 */
export function weekAhead(easyDays: readonly number[] | undefined, now: Date): { end: Date; studyDays: Date[] } {
  const studyDays: Date[] = [];
  let i = 1;
  while (i <= WALK_LIMIT && isRestDay(easyDays, startOfLocalDay(now, -i))) i++;
  while (i <= WALK_LIMIT && !isRestDay(easyDays, startOfLocalDay(now, -i))) studyDays.push(startOfLocalDay(now, -i++));
  return { end: startOfLocalDay(now, -i), studyDays };
}

/**
 * The run of rest days that `now` is part of, up to the end of today: the new
 * cards first studied in it are what a rest day has borrowed so far.
 */
export function restRunToday(easyDays: readonly number[] | undefined, now: Date): { from: Date; to: Date } {
  let back = 0;
  while (back < WALK_LIMIT && isRestDay(easyDays, startOfLocalDay(now, back + 1))) back++;
  return { from: startOfLocalDay(now, back), to: startOfLocalDay(now, -1) };
}

/**
 * On a study day, the last run of rest days before it, and how many study days
 * have passed since that run ended (0 on the first study day after it), or null
 * when no rest day is near (Easy Days off, or none at Minimum).
 */
export function restRunBefore(
  easyDays: readonly number[] | undefined,
  now: Date,
): { from: Date; to: Date; studyDaysSince: number } | null {
  let back = 1;
  while (back <= WALK_LIMIT && !isRestDay(easyDays, startOfLocalDay(now, back))) back++;
  if (back > WALK_LIMIT) return null;
  // The days walked over before the rest day are the study days since it.
  const studyDaysSince = back - 1;
  const to = startOfLocalDay(now, back - 1);
  while (back < WALK_LIMIT && isRestDay(easyDays, startOfLocalDay(now, back + 1))) back++;
  return { from: startOfLocalDay(now, back), to, studyDaysSince };
}

/**
 * New cards a study day gives up to the rest days before it: those borrowed
 * come off the first study day's limit, any more than one day's off the next,
 * and so on. `borrowed` is the new cards first studied on the rest days,
 * `studyDaysSince` the study days already past since them.
 */
export function borrowedToday(borrowed: number, studyDaysSince: number, newPerDay: number): number {
  return Math.min(newPerDay, Math.max(0, borrowed - studyDaysSince * newPerDay));
}

export interface ShareInput {
  /** Review cards due before the week ahead ends, not yet studied today: due already, or ahead. */
  reviewsAhead: number;
  /** New cards the study days ahead still bring in, after what the rest days borrowed. */
  newAhead: number;
  /** Review cards studied today (reviews of Review cards: never learning steps), and new cards. */
  reviewsToday: number;
  newToday: number;
}

/**
 * The share a rest day has left: a seventh of the week's load as it stood when
 * the day began (what is left plus what today already took), in the week's own
 * mix of reviews and new cards, less what today already studied. Fixed for the
 * day: counting only what is left, a finished share would offer a seventh of
 * the smaller rest at once, and again, until the week was gone.
 */
export function aheadShare(input: ShareInput): { reviews: number; newCards: number } {
  const reviewLoad = input.reviewsAhead + input.reviewsToday;
  const newLoad = input.newAhead + input.newToday;
  const load = reviewLoad + newLoad;
  if (load === 0) return { reviews: 0, newCards: 0 };
  const share = Math.ceil(load / AHEAD_SHARE_DAYS);
  const newShare = Math.round((share * newLoad) / load);
  return {
    reviews: Math.min(input.reviewsAhead, Math.max(0, share - newShare - input.reviewsToday)),
    newCards: Math.min(input.newAhead, Math.max(0, newShare - input.newToday)),
  };
}
