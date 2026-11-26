import type { Prisma } from "@prisma/client";
import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { tombstone } from "./card-service.js";
import { assertCardContent } from "./content-rules.js";
import { getOrCreateDeck } from "./deck-service.js";
import { parseExercise } from "./exercises.js";
import { fallbackMemoryState } from "./scheduler.js";
import { serializeTags } from "./types.js";

/**
 * What an anki-sync run writes into the deck, applied in one transaction.
 *
 * The study repo's sync used to write master.db with SQL of its own, and had to
 * re-implement here what only this code base can keep true: the cascade on a
 * delete, the tombstone, which stability a non-New card may hold, that
 * `updatedAt` means a content edit, and (it did not) the content rules. The sync
 * still decides what to write (its plan is the other side's business); this
 * applies the plan.
 *
 * Datetimes are ISO-8601 strings on the wire (see parseSyncApply).
 */

/** A card's scheduling block as the Anki side won it. */
export interface SyncSchedule {
  cardId: string;
  due: Date | null;
  /** null: Anki has no FSRS memory state for the card (see `pullSchedule`). */
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
  interval: number;
}

/** A review made on the other side, to append to the history. */
export interface SyncReview {
  cardId: string;
  reviewedAt: Date;
  rating: number;
  responseMs: number | null;
  state: number | null;
  /**
   * The memory state to record beside the review (analytics only, never read
   * back to schedule). Anki's revlog has none, so a caller gives the card's
   * current one, and a review of a card in this same call falls back to that
   * card's incoming schedule or import; otherwise 0.
   */
  stability?: number | null;
  difficulty?: number | null;
}

/** A card first seen on another machine, created here under its own id. */
export interface SyncImport extends Omit<SyncSchedule, "cardId"> {
  /** The Anki note's guid, which is the CUID this deck minted for the card. */
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  /** A code card's exercise JSON, else null. */
  exercise: string | null;
  suspended: boolean;
  /**
   * When the card was made. These cards are old, and `createdAt` is what the
   * "cards added today" pressure axis counts, so importing them stamped now would
   * read all of them as today's intake and block new cards for the day. Defaults to now.
   */
  createdAt: Date | null;
}

export interface SyncSchedulerOptions {
  learningSteps?: string;
  relearningSteps?: string;
  requestRetention?: number;
  fsrsWeights?: string;
  easyDays?: string;
  newPerDay?: number;
  reviewsPerDay?: number;
  newCardsIgnoreReviewLimit?: boolean;
}

export interface SyncPlan {
  schedules?: SyncSchedule[];
  reviews?: SyncReview[];
  imports?: SyncImport[];
  /** Ids of cards deleted on another machine. */
  deletions?: string[];
  schedulerOptions?: SyncSchedulerOptions;
}

export interface SyncResult {
  /** Cards whose schedule was written (a card that is not here is skipped). */
  schedules: number;
  /** Reviews appended: not ones already present, nor ones of a card that is not here. */
  reviews: number;
  /** Reviews left out: already in the history (same card, same second), or of a card that is not here. */
  reviewsSkipped: { present: number; noCard: number };
  imports: { imported: number; rejected: { id: string; error: string }[] };
  /** Ids tombstoned, whether or not a card was still here. */
  deletions: number;
  /** Config columns that changed. */
  schedulerOptions: string[];
}

const OPTION_COLUMNS = [
  "learningSteps",
  "relearningSteps",
  "requestRetention",
  "fsrsWeights",
  "easyDays",
  "newPerDay",
  "reviewsPerDay",
  "newCardsIgnoreReviewLimit",
] as const;

const WHOLE_SECOND = 1000;

/** The key a review is unique by: whole seconds, as the two sides' clocks agree no finer (anki-sync). */
function reviewKey(cardId: string, at: Date): string {
  return `${cardId}@${Math.floor(at.getTime() / WHOLE_SECOND)}`;
}

/**
 * Anki-side schedule onto a card, `updatedAt` untouched.
 *
 * Stability and difficulty keep the card's current value when Anki has no FSRS
 * memory state (a device with FSRS off), but only a real, positive one: a card
 * that was New here holds 0, and a non-New card at stability 0 is what
 * `sanitizeForReview` resets to New, so it gets `fallbackMemoryState`'s instead.
 * Anki naming stability 0 for a non-New card is the same sentinel and is treated
 * as no memory state. A pulled New card keeps its 0.
 */
async function pullSchedule(tx: Prisma.TransactionClient, s: SyncSchedule): Promise<boolean> {
  const card = await tx.card.findUnique({
    where: { id: s.cardId },
    select: { stability: true, difficulty: true, updatedAt: true },
  });
  if (card == null) return false;
  const given = s.state !== State.New && s.stability != null && s.stability <= 0 ? null : s.stability;
  const fb = fallbackMemoryState({ state: s.state, interval: s.interval, stability: given, difficulty: s.difficulty });
  await tx.card.update({
    where: { id: s.cardId },
    data: {
      updatedAt: card.updatedAt,
      ...(s.due != null ? { due: s.due } : {}),
      stability: given ?? (card.stability > 0 ? card.stability : fb.stability),
      difficulty: s.difficulty ?? (card.difficulty > 0 ? card.difficulty : fb.difficulty),
      reps: s.reps,
      lapses: s.lapses,
      state: s.state,
      lastReview: s.lastReview,
      interval: s.interval,
    },
  });
  return true;
}

/** Content rules apply to an import as to any write; a code card writes its own sides, so it is past them (createCard). */
function assertImportable(card: SyncImport): void {
  if (card.exercise != null) {
    if (parseExercise(card.exercise) == null) throw new Error("exercise is not a valid code card exercise");
    return;
  }
  assertCardContent({ front: card.front, back: card.back });
}

async function importCard(tx: Prisma.TransactionClient, card: SyncImport, now: Date): Promise<void> {
  if ((await tx.card.findUnique({ where: { id: card.id }, select: { id: true } })) != null) {
    throw new Error("a card with this id already exists");
  }
  const deck = await getOrCreateDeck(card.deck, undefined, tx);
  const memory = fallbackMemoryState(card);
  await tx.card.create({
    data: {
      id: card.id,
      deckId: deck.id,
      front: card.front,
      back: card.back,
      tags: serializeTags(card.tags),
      exercise: card.exercise,
      due: card.due ?? now,
      stability: memory.stability,
      difficulty: memory.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      lastReview: card.lastReview,
      interval: card.interval,
      suspended: card.suspended,
      createdAt: card.createdAt ?? now,
      updatedAt: now,
    },
  });
}

/**
 * Appends reviews the history lacks. elapsedDays is the gap to the card's
 * previous review (0 for its first), which calibration's `elapsedDays >= 1`
 * filter reads; stability and difficulty are the snapshots the caller gave.
 */
async function appendReviews(
  tx: Prisma.TransactionClient,
  reviews: SyncReview[],
  memory: Map<string, { stability: number | null; difficulty: number | null }>
): Promise<{ added: number; skipped: SyncResult["reviewsSkipped"] }> {
  const skipped = { present: 0, noCard: 0 };
  const cardIds = [...new Set(reviews.map((r) => r.cardId))];
  if (cardIds.length === 0) return { added: 0, skipped };
  const present = new Set((await tx.card.findMany({ where: { id: { in: cardIds } }, select: { id: true } })).map((c) => c.id));
  const existing = await tx.review.findMany({ where: { cardId: { in: cardIds } }, select: { cardId: true, reviewedAt: true } });
  const seen = new Set(existing.map((r) => reviewKey(r.cardId, r.reviewedAt)));
  const lastSeen = new Map<string, Date>();
  for (const r of existing) {
    const prev = lastSeen.get(r.cardId);
    if (prev === undefined || r.reviewedAt > prev) lastSeen.set(r.cardId, r.reviewedAt);
  }

  const rows: Prisma.ReviewCreateManyInput[] = [];
  for (const rev of [...reviews].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime())) {
    const key = reviewKey(rev.cardId, rev.reviewedAt);
    if (!present.has(rev.cardId)) {
      skipped.noCard++;
      continue;
    }
    if (seen.has(key)) {
      skipped.present++;
      continue;
    }
    seen.add(key);
    const prev = lastSeen.get(rev.cardId);
    const elapsed = prev === undefined ? 0 : Math.max(0, (rev.reviewedAt.getTime() - prev.getTime()) / 86_400_000);
    const incoming = memory.get(rev.cardId);
    rows.push({
      cardId: rev.cardId,
      rating: rev.rating,
      responseMs: rev.responseMs,
      stability: rev.stability ?? incoming?.stability ?? 0,
      difficulty: rev.difficulty ?? incoming?.difficulty ?? 0,
      elapsedDays: Math.round(elapsed * 1e6) / 1e6,
      reviewedAt: rev.reviewedAt,
      state: rev.state,
    });
    lastSeen.set(rev.cardId, rev.reviewedAt);
  }
  if (rows.length > 0) await tx.review.createMany({ data: rows });
  return { added: rows.length, skipped };
}

/** Writes the Config columns that differ; nothing before the first read creates the row. */
async function writeSchedulerOptions(tx: Prisma.TransactionClient, opts: SyncSchedulerOptions): Promise<string[]> {
  const row = await tx.config.findUnique({ where: { id: "default" } });
  if (row == null) return [];
  const changed = OPTION_COLUMNS.filter((name) => opts[name] !== undefined && row[name] !== opts[name]);
  if (changed.length > 0) {
    await tx.config.update({ where: { id: "default" }, data: Object.fromEntries(changed.map((n) => [n, opts[n]])) });
  }
  return [...changed];
}

/**
 * Applies a sync plan atomically. An import that breaks the content rules (or
 * clashes with an existing id) is reported in `imports.rejected` and left out;
 * it does not undo the rest. Anything else that fails undoes everything.
 *
 * Order: imports, deletions, schedules, reviews. Reviews of a card that is not
 * here (rejected, or deleted by the same plan) are dropped, since the history
 * belongs to a card.
 */
export async function applySync(plan: SyncPlan, now: Date = new Date()): Promise<SyncResult> {
  const schedules = plan.schedules ?? [];
  const reviews = plan.reviews ?? [];
  const imports = plan.imports ?? [];
  const deletions = [...new Set(plan.deletions ?? [])];
  const result: SyncResult = { schedules: 0, reviews: 0, reviewsSkipped: { present: 0, noCard: 0 }, imports: { imported: 0, rejected: [] }, deletions: 0, schedulerOptions: [] };

  const memory = new Map<string, { stability: number | null; difficulty: number | null }>();
  for (const s of schedules) memory.set(s.cardId, s);
  for (const i of imports) memory.set(i.id, i);

  const importable: SyncImport[] = [];
  for (const card of imports) {
    try {
      assertImportable(card);
      importable.push(card);
    } catch (err) {
      result.imports.rejected.push({ id: card.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await getDb().$transaction(
    async (tx) => {
      for (const card of importable) {
        try {
          // importCard checks for a clash before its first write, so a card it
          // refuses leaves nothing behind in the transaction.
          await importCard(tx, card, now);
          result.imports.imported++;
        } catch (err) {
          result.imports.rejected.push({ id: card.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (deletions.length > 0) {
        await tombstone(tx, deletions);
        await tx.card.deleteMany({ where: { id: { in: deletions } } });
        result.deletions = deletions.length;
      }

      for (const s of schedules) if (await pullSchedule(tx, s)) result.schedules++;
      const appended = await appendReviews(tx, reviews, memory);
      result.reviews = appended.added;
      result.reviewsSkipped = appended.skipped;
      if (plan.schedulerOptions !== undefined) result.schedulerOptions = await writeSchedulerOptions(tx, plan.schedulerOptions);
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
  return result;
}

// --- wire format ---

type Raw = Record<string, unknown>;

function obj(v: unknown, what: string): Raw {
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Raw;
}

function list(p: Raw, key: string): unknown[] {
  const v = p[key];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`parameter ${key} must be an array`);
  return v;
}

function field<T>(o: Raw, key: string, where: string, check: (v: unknown) => v is T, type: string): T {
  const v = o[key];
  if (!check(v)) throw new Error(`${where}: ${key} must be ${type}`);
  return v;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isText = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === "string");

function date(o: Raw, key: string, where: string): Date {
  const v = field(o, key, where, isStr, "an ISO-8601 datetime string");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${where}: ${key} is not a datetime: ${v}`);
  return d;
}

function optDate(o: Raw, key: string, where: string): Date | null {
  return o[key] == null ? null : date(o, key, where);
}

function optNumber(o: Raw, key: string, where: string): number | null {
  return o[key] == null ? null : field(o, key, where, isNum, "a number");
}

function int(o: Raw, key: string, where: string, min: number, max = Infinity): number {
  const v = field(o, key, where, isNum, "a number");
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${where}: ${key} must be a whole number${max === Infinity ? ` of at least ${min}` : ` from ${min} to ${max}`}, got ${v}`);
  }
  return v;
}

function scheduleOf(o: Raw, where: string): Omit<SyncSchedule, "cardId"> {
  return {
    due: optDate(o, "due", where),
    stability: optNumber(o, "stability", where),
    difficulty: optNumber(o, "difficulty", where),
    reps: int(o, "reps", where, 0),
    lapses: int(o, "lapses", where, 0),
    state: int(o, "state", where, 0, 3),
    lastReview: optDate(o, "lastReview", where),
    interval: field(o, "interval", where, isNum, "a number"),
  };
}

/** Params of the `syncApply` app method, checked into a SyncPlan; throws on the first malformed entry. */
export function parseSyncPlan(params: Raw): SyncPlan {
  const plan: SyncPlan = {
    schedules: list(params, "schedules").map((v, i) => {
      const where = `schedules[${i}]`;
      const o = obj(v, where);
      return { cardId: field(o, "cardId", where, isStr, "a string"), ...scheduleOf(o, where) };
    }),
    reviews: list(params, "reviews").map((v, i) => {
      const where = `reviews[${i}]`;
      const o = obj(v, where);
      return {
        cardId: field(o, "cardId", where, isStr, "a string"),
        reviewedAt: date(o, "reviewedAt", where),
        rating: int(o, "rating", where, 1, 4),
        responseMs: optNumber(o, "responseMs", where),
        state: o["state"] == null ? null : int(o, "state", where, 0, 3),
        stability: optNumber(o, "stability", where),
        difficulty: optNumber(o, "difficulty", where),
      };
    }),
    imports: list(params, "imports").map((v, i) => {
      const where = `imports[${i}]`;
      const o = obj(v, where);
      return {
        id: field(o, "id", where, isStr, "a string"),
        deck: field(o, "deck", where, isStr, "a string"),
        front: field(o, "front", where, isText, "a string"),
        back: field(o, "back", where, isText, "a string"),
        tags: field(o, "tags", where, isStrings, "an array of strings"),
        exercise: o["exercise"] == null || o["exercise"] === "" ? null : field(o, "exercise", where, isText, "a string"),
        suspended: o["suspended"] == null ? false : field(o, "suspended", where, isBool, "a boolean"),
        createdAt: optDate(o, "createdAt", where),
        ...scheduleOf(o, where),
      };
    }),
    deletions: list(params, "deletions").map((v, i) => {
      if (!isStr(v)) throw new Error(`deletions[${i}] must be a card id string`);
      return v;
    }),
  };
  if (params["schedulerOptions"] != null) {
    const o = obj(params["schedulerOptions"], "schedulerOptions");
    const opts: SyncSchedulerOptions = {};
    for (const name of OPTION_COLUMNS) {
      if (o[name] == null) continue;
      const where = "schedulerOptions";
      switch (name) {
        case "learningSteps":
        case "relearningSteps":
        case "fsrsWeights":
        case "easyDays":
          opts[name] = field(o, name, where, isText, "a string");
          break;
        case "requestRetention":
        case "newPerDay":
        case "reviewsPerDay":
          opts[name] = field(o, name, where, isNum, "a number");
          break;
        case "newCardsIgnoreReviewLimit":
          // Anki keeps it as 0/1; Config stores a boolean.
          opts[name] = typeof o[name] === "number" ? o[name] !== 0 : field(o, name, where, isBool, "a boolean or 0/1");
          break;
      }
    }
    plan.schedulerOptions = opts;
  }
  return plan;
}
