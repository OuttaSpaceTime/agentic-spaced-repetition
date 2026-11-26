import type { Prisma } from "@prisma/client";
import { getDb } from "../db/client.js";
import { parseTags } from "./types.js";

/**
 * The deck as plain data, for callers that are not TypeScript (the study repo's
 * anki-sync, card-quality gate and sweep, the wiki-viewer): whole cards and
 * reviews with every datetime as an ISO-8601 UTC string, nothing Prisma-shaped,
 * and no embedding, which no reader wants. They used to open master.db and run
 * SQL for this, which made each of them re-derive what a column means.
 */

/** A card as a caller outside this process sees it. */
export interface CardRecord {
  id: string;
  deckId: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  type: string;
  /** The code card's exercise JSON exactly as stored, or null on any other card. */
  exercise: string | null;
  suspended: boolean;
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** ts-fsrs State: 0 new, 1 learning, 2 review, 3 relearning. */
  state: number;
  lastReview: string | null;
  interval: number;
  inheritedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRecord {
  cardId: string;
  reviewedAt: string;
  rating: number;
  responseMs: number | null;
  /** The card's state before the review (ts-fsrs), null on rows from before it was kept. */
  state: number | null;
}

export interface CardRecordFilter {
  /** Only these cards (unknown ids are simply absent from the result). */
  ids?: string[];
  /** Only cards split off this parent (Card.inheritedFrom). */
  inheritedFrom?: string;
  /** Default true; false leaves suspended cards out. */
  includeSuspended?: boolean;
}

/** Cards matching every given filter, newest first. */
export async function cardRecords(filter: CardRecordFilter = {}): Promise<CardRecord[]> {
  const where: Prisma.CardWhereInput = {};
  if (filter.ids !== undefined) where.id = { in: filter.ids };
  if (filter.inheritedFrom !== undefined) where.inheritedFrom = filter.inheritedFrom;
  if (filter.includeSuspended === false) where.suspended = false;

  const cards = await getDb().card.findMany({
    where,
    omit: { embedding: true },
    include: { deck: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return cards.map((c) => ({
    id: c.id,
    deckId: c.deckId,
    deck: c.deck.name,
    front: c.front,
    back: c.back,
    tags: parseTags(c.tags),
    type: c.type,
    exercise: c.exercise,
    suspended: c.suspended,
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.lastReview?.toISOString() ?? null,
    interval: c.interval,
    inheritedFrom: c.inheritedFrom,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));
}

/** Review history, oldest first; of the given cards, or of every card. */
export async function reviewRecords(cardIds?: string[]): Promise<ReviewRecord[]> {
  const reviews = await getDb().review.findMany({
    where: cardIds === undefined ? {} : { cardId: { in: cardIds } },
    select: { cardId: true, reviewedAt: true, rating: true, responseMs: true, state: true },
    orderBy: { reviewedAt: "asc" },
  });
  return reviews.map((r) => ({ ...r, reviewedAt: r.reviewedAt.toISOString() }));
}

/** Ids of cards deleted here (DeletedCard): how anki-sync tells a local delete from a card made elsewhere. */
export async function tombstoneIds(): Promise<string[]> {
  const rows = await getDb().deletedCard.findMany({ select: { cardId: true } });
  return rows.map((r) => r.cardId);
}
