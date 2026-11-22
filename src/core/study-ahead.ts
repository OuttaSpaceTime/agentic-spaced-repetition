import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { getRetrievability, toSchedulableCard, type SchedulerParams } from "./scheduler.js";
import { NEW_CARD_WHERE } from "./pressure.js";
import { localDay, startOfLocalDay, weekdayLabel } from "./days.js";
import { aheadShare, borrowedToday, isRestDay, restRunBefore, restRunToday, weekAhead } from "./rest-days.js";
import type { SessionQueueItem } from "./types.js";

/**
 * Studying ahead on a rest day (rest-days.ts has the rules): the counts those
 * rules take, from the deck, and the cards a share picks. session-service reads
 * the settings and passes them in, so this module never reads Config itself.
 */

/** A study day of the week ahead, as scheduled now and as the share leaves it. */
export interface AheadDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Its weekday, "Mo". */
  label: string;
  /** Review cards scheduled on it now. */
  due: number;
  /** What it keeps once the share's reviews ahead are studied. */
  after: number;
}

/**
 * What a rest day offers: today's share, which a session `ahead` queues. Every
 * count is what is left of it today; all zero once it is studied.
 */
export interface AheadPlan {
  /** Learning and relearning steps due now. Never counted in the share or limited, as Anki never limits them. */
  learning: number;
  /** Review cards the share takes, lowest retrievability first. */
  reviews: number;
  /** Of those, the ones already due (an interval too short for Easy Days to move). */
  dueNow: number;
  /** New cards the share takes, borrowed from the study days after the rest days. */
  newCards: number;
  /** The study days up to the next rest day. */
  days: AheadDay[];
  /** The daily new limit, and what the first study day still gets once this share is studied. */
  newPerDay: number;
  nextDayNew: number;
}

export interface AheadSettings {
  params: SchedulerParams;
  newPerDay: number;
  /** New cards studied today, as the daily limits count them (first review today). */
  newToday: number;
  /** A cap on the share's new cards: 0 while the review backlog holds them back (the app's rule). */
  maxNew?: number;
}

/**
 * Distinct cards first studied in [from, to): new on their first review, as
 * Anki counts them. Rest days' new cards are what the study days after lend.
 */
export async function newCardsStudiedBetween(from: Date, to: Date): Promise<number> {
  const db = getDb();
  const ids = (
    await db.review.findMany({ where: { reviewedAt: { gte: from, lt: to } }, select: { cardId: true }, distinct: ["cardId"] })
  ).map((r) => r.cardId);
  if (ids.length === 0) return 0;
  const seenBefore = await db.review.findMany({
    where: { cardId: { in: ids }, reviewedAt: { lt: from } },
    select: { cardId: true },
    distinct: ["cardId"],
  });
  return ids.length - seenBefore.length;
}

/**
 * Review cards studied since `midnight`: distinct cards with a review of a card
 * in Review state, the share's own kind. Not learning or relearning steps,
 * which the share never counts, and not new cards. A row with no state (from
 * before it was kept, or an import) counts as a review, as it always did.
 */
async function reviewsStudiedSince(midnight: Date): Promise<number> {
  const rows = await getDb().review.findMany({
    where: { reviewedAt: { gte: midnight }, OR: [{ state: State.Review }, { state: null }] },
    select: { cardId: true },
    distinct: ["cardId"],
  });
  return rows.length;
}

/**
 * New cards a study day gives up to the rest days before it (rest-days.ts,
 * `borrowedToday`): 0 on a rest day, or with Easy Days off.
 */
export async function newBorrowedToday(params: SchedulerParams, newPerDay: number, now: Date): Promise<number> {
  if (isRestDay(params.easyDays, now)) return 0;
  const run = restRunBefore(params.easyDays, now);
  if (run == null) return 0;
  return borrowedToday(await newCardsStudiedBetween(run.from, run.to), run.studyDaysSince, newPerDay);
}

/**
 * Today's share and the queue it makes, or null on a study day. Reviews ahead
 * go lowest retrievability first: those due soonest for their stability, which
 * picks long intervals near their day, where reviewing early costs FSRS least,
 * over a short one whose review a day early would mostly be wasted. Cards
 * already due have the lowest and come first. Ignores category and deck: the
 * share is of the whole week, as the daily limits are of the whole deck.
 */
export async function planAhead(
  settings: AheadSettings,
  now: Date,
): Promise<{ plan: AheadPlan; queue: SessionQueueItem[] } | null> {
  const { params, newPerDay, newToday } = settings;
  if (!isRestDay(params.easyDays, now)) return null;
  const week = weekAhead(params.easyDays, now);
  // Every day a rest day (a slip in the deck options): no week to be ahead of.
  if (week.studyDays.length === 0) return null;
  const db = getDb();
  const run = restRunToday(params.easyDays, now);
  const midnight = startOfLocalDay(now);

  const [reviewCards, learningCards, borrowed, reviewsToday] = await Promise.all([
    db.card.findMany({ where: { suspended: false, state: State.Review, due: { lt: week.end } } }),
    db.card.findMany({
      where: { suspended: false, state: { in: [State.Learning, State.Relearning] }, due: { lte: now } },
      orderBy: { due: "asc" },
      select: { id: true },
    }),
    newCardsStudiedBetween(run.from, run.to),
    reviewsStudiedSince(midnight),
  ]);
  const newAvailable = await db.card.count({ where: NEW_CARD_WHERE });
  // What the study days ahead still bring in: their limits, less what the rest days borrowed.
  const newAhead = Math.min(newAvailable, Math.max(0, newPerDay * week.studyDays.length - borrowed));

  // A card studied today is in reviewsToday, so it is left out here, whether or not its
  // new due is inside the week: counted twice, the day's share would grow as it is studied,
  // and one rated Again, back due tomorrow, would be picked again.
  const notStudiedToday = reviewCards.filter((card) => card.lastReview == null || card.lastReview < midnight);
  const share = aheadShare({ reviewsAhead: notStudiedToday.length, newAhead, reviewsToday, newToday });
  // The daily new limit holds on a rest day too, and the backlog's verdict.
  const newCards = Math.min(share.newCards, Math.max(0, newPerDay - newToday), settings.maxNew ?? Infinity);

  const picked = notStudiedToday
    .map((card) => ({ card, retrievability: getRetrievability(toSchedulableCard(card), now, params) }))
    .sort((a, b) => a.retrievability - b.retrievability)
    .slice(0, share.reviews)
    .map((r) => r.card);
  const fresh = await db.card.findMany({ where: NEW_CARD_WHERE, orderBy: { createdAt: "asc" }, take: newCards, select: { id: true } });

  const taken = new Map<string, number>();
  for (const card of picked) taken.set(localDay(card.due), (taken.get(localDay(card.due)) ?? 0) + 1);
  const scheduled = new Map<string, number>();
  for (const card of reviewCards) scheduled.set(localDay(card.due), (scheduled.get(localDay(card.due)) ?? 0) + 1);
  const days = week.studyDays.map((d) => {
    const day = localDay(d);
    const due = scheduled.get(day) ?? 0;
    return { day, label: weekdayLabel(day), due, after: due - (taken.get(day) ?? 0) };
  });
  const endOfToday = run.to;

  return {
    plan: {
      learning: learningCards.length,
      reviews: picked.length,
      dueNow: picked.filter((c) => c.due < endOfToday).length,
      newCards: fresh.length,
      days,
      newPerDay,
      nextDayNew: Math.max(0, newPerDay - borrowed - fresh.length),
    },
    queue: [
      ...learningCards.map((c): SessionQueueItem => ({ cardId: c.id, reason: "due_review" })),
      ...picked.map((c): SessionQueueItem => ({ cardId: c.id, reason: c.due < endOfToday ? "due_review" : "review_ahead" })),
      ...fresh.map((c): SessionQueueItem => ({ cardId: c.id, reason: "new_card" })),
    ],
  };
}
