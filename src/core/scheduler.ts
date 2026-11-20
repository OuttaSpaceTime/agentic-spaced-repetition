import {
  fsrs,
  createEmptyCard,
  dateDiffInDays,
  default_maximum_interval,
  getFuzzRange,
  Grades,
  S_MIN,
  State,
  type Card as FsrsCard,
  type Grade,
  type FSRS,
  type Steps,
} from "ts-fsrs";
import type { CardMaturity } from "./types.js";

export type SchedulableCard = {
  due: Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
  interval: number;
  /** Position in the (re)learning steps; absent means the first. */
  learningStep?: number;
};

/**
 * What the scheduler needs besides the card. They mirror the Anki deck options
 * (anki-sync copies them into Config), so a rating key shows what Anki shows.
 * Omitted fields are Anki's defaults: steps 1m 10m / 10m, FSRS default weights,
 * 0.9 retention. Fuzz stays off on purpose: Anki fuzzes day intervals, but the
 * preview and the review run at different moments, so a fuzzed preview would
 * promise an interval the review then does not give.
 */
export type SchedulerParams = {
  requestRetention?: number;
  learningSteps?: Steps;
  relearningSteps?: Steps;
  weights?: readonly number[];
  /** Anki's Easy Days: seven loads, Monday first, 1 normal, 0 minimum. See `avoidEasyDays`. */
  easyDays?: readonly number[];
};

export type ReviewResult = {
  card: SchedulableCard;
  /** Whole days since the card's previous review, as ts-fsrs counted them. */
  elapsedDays: number;
};

/** Days of interval at which a review card counts as mature (Anki's convention). */
export const MATURE_INTERVAL_DAYS = 21;

/** A rating a review can carry: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export function isGrade(x: unknown): x is Grade {
  return (Grades as readonly unknown[]).includes(x);
}

/**
 * Derive a card's maturity from its schedule.
 *
 * Maturity is always computed, never stored: it is a function of `state` and
 * `interval`, both of which every review updates. A persisted copy would only
 * ever go stale — and did, reporting cards with hundreds of reps as "new".
 */
export function cardMaturity(card: { state: number; interval: number }): CardMaturity {
  if (card.state === State.New) return "new";
  if (card.state === State.Learning || card.state === State.Relearning) return "learning";
  return card.interval >= MATURE_INTERVAL_DAYS ? "internalized" : "familiar";
}

const schedulers = new Map<string, FSRS>();

function getScheduler(params: SchedulerParams = {}): FSRS {
  const { easyDays: _easyDays, ...fsrsParams } = params; // not ts-fsrs's: one scheduler whatever the days
  const key = JSON.stringify(fsrsParams);
  let scheduler = schedulers.get(key);
  if (scheduler === undefined) {
    scheduler = fsrs({
      ...(params.requestRetention !== undefined && { request_retention: params.requestRetention }),
      ...(params.learningSteps !== undefined && { learning_steps: params.learningSteps }),
      ...(params.relearningSteps !== undefined && { relearning_steps: params.relearningSteps }),
      ...(params.weights !== undefined && params.weights.length > 0 && { w: params.weights }),
    });
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

export function createNewFsrsCard(now?: Date): SchedulableCard {
  return fromFsrsCard(createEmptyCard(now));
}

/** The scheduling fields of any card-shaped object (a Prisma row, say). */
export function toSchedulableCard(card: SchedulableCard): SchedulableCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.lastReview,
    interval: card.interval,
    learningStep: card.learningStep ?? 0,
  };
}

function toFsrsCard(card: SchedulableCard): FsrsCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.interval,
    learning_steps: card.learningStep ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.lastReview ?? undefined,
  };
}

function fromFsrsCard(fsrsCard: FsrsCard): SchedulableCard {
  return {
    due: fsrsCard.due,
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    state: fsrsCard.state,
    lastReview: fsrsCard.last_review ?? null,
    interval: fsrsCard.scheduled_days,
    learningStep: fsrsCard.learning_steps,
  };
}

/**
 * A non-New card must have a positive, finite stability. If it doesn't
 * (stability 0/negative/NaN — a corruption that ts-fsrs's forgetting curve
 * turns into NaN intervals and an Invalid Date `due`), the card was never
 * properly learned. Recover by re-initializing it as a New card so this
 * review acts as the first learning step.
 */
function sanitizeForReview(card: SchedulableCard): SchedulableCard {
  const stabilityValid = Number.isFinite(card.stability) && card.stability > 0;
  if (card.state !== State.New && !stabilityValid) {
    return {
      ...card,
      stability: 0,
      difficulty: 0,
      state: State.New,
      lastReview: null,
      interval: 0,
    };
  }
  // A New card has no memory yet; ts-fsrs 6 reads a leftover difficulty beside
  // stability 0 as a corrupt state and throws, where 4 ignored it.
  if (card.state === State.New && (card.stability !== 0 || card.difficulty !== 0)) {
    return { ...card, stability: 0, difficulty: 0 };
  }
  // ts-fsrs 6 refuses a memory state below its floors (difficulty 1, stability
  // S_MIN) where 4 computed with it; clamping keeps such a card's due date.
  if (card.state !== State.New && (card.difficulty < 1 || card.stability < S_MIN)) {
    return { ...card, difficulty: Math.max(card.difficulty, 1), stability: Math.max(card.stability, S_MIN) };
  }
  return card;
}

/**
 * Apply a rating. `requestRetention` is the recall probability FSRS schedules
 * the next review at (Config.requestRetention); omitted, ts-fsrs's default.
 */
export function reviewCard(
  card: SchedulableCard,
  rating: Grade,
  now: Date = new Date(),
  params?: SchedulerParams
): ReviewResult {
  const safe = sanitizeForReview(card);
  const item = getScheduler(params).next(toFsrsCard(safe), now, rating);
  // ts-fsrs 6 no longer reports elapsed days; this is its old UTC calendar-day
  // count, which calibration's `elapsedDays >= 1` filter relies on.
  const elapsedDays = safe.state === State.New || safe.lastReview == null ? 0 : dateDiffInDays(safe.lastReview, now);
  return { card: avoidEasyDays(fromFsrsCard(item.card), elapsedDays, params?.easyDays), elapsedDays };
}

/**
 * Anki's Easy Days (deck options, mirrored by anki-sync): a review lands on the
 * day of its fuzz range whose weekday has the highest load, nearest the FSRS
 * interval on a tie, the shorter one on a tie of distance. Anki's load balancer
 * also weighs each day's review count and draws at random; this keeps only the
 * weekday rule, deterministically, so a preview promises what the review gives
 * (the reason fuzz is off). Intervals under 3 days have no fuzz range in Anki
 * either, so a short one can still land on a minimum day. `after` drops the
 * days due by then: a review's are all ahead of it, but `rescheduleEasyDays`
 * moves cards scheduled long ago, whose range can reach into the past.
 */
export function avoidEasyDays(
  card: SchedulableCard,
  elapsedDays: number,
  easyDays?: readonly number[],
  after?: Date,
): SchedulableCard {
  if (easyDays === undefined || card.state !== State.Review || card.interval < 3) return card;
  const { minInterval, maxInterval } = getFuzzRange(card.interval, elapsedDays, default_maximum_interval);
  const dueIn = (days: number) => {
    const d = new Date(card.due);
    d.setDate(d.getDate() + days - card.interval); // a calendar step, so DST moves nothing
    return d;
  };
  const load = (days: number) => easyDays[(dueIn(days).getDay() + 6) % 7]; // getDay is Sunday first, Anki's list Monday first
  const distance = (days: number) => Math.abs(days - card.interval);
  let best = card.interval;
  // Ascending, and replaced only when strictly better, so a full tie keeps the shorter.
  for (let days = minInterval; days <= maxInterval; days++) {
    if (after !== undefined && dueIn(days) <= after) continue;
    if (load(days) > load(best) || (load(days) === load(best) && distance(days) < distance(best))) best = days;
  }
  if (best === card.interval) return card;
  return { ...card, due: dueIn(best), interval: best };
}

/**
 * Probability of recalling the card at `now`, 0 for a card never reviewed. The
 * forgetting curve depends on stability alone, so no request retention here.
 */
export function getRetrievability(card: SchedulableCard, now: Date = new Date(), params?: SchedulerParams): number {
  if (card.state === State.New || card.lastReview == null) return 0;
  return getScheduler(params).retrievability(toFsrsCard(card), now);
}
