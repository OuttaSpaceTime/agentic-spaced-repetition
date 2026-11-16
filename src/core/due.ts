import type { Prisma } from "@prisma/client";
import { State } from "ts-fsrs";
import { startOfLocalDay } from "./days.js";

/**
 * "Due" as Anki counts it: a Review card is due once its local calendar day
 * has come, whatever the hour (a card due at 18:25 is due at breakfast), while
 * Learning, Relearning and New cards, whose steps are minutes, keep their exact
 * time. Without this, Omvida showed nothing due while Anki showed the cards due
 * later the same day. One predicate for every count, session and list.
 */
export function dueClause(now: Date = new Date()): Prisma.CardWhereInput {
  const endOfToday = startOfLocalDay(now, -1);
  return {
    OR: [
      { state: State.Review, due: { lt: endOfToday } },
      { state: { not: State.Review }, due: { lte: now } },
    ],
  };
}
