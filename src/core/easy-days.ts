import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { avoidEasyDays } from "./scheduler.js";
import { currentSchedulerParams } from "./session-service.js";

export type EasyDaysMove = { id: string; front: string; from: Date; to: Date };

/**
 * Easy Days for the reviews already scheduled. `avoidEasyDays` runs on each
 * review, so a card scheduled before the setting existed (or changed) keeps
 * its minimum-day due date until it is next reviewed; Anki's own setting is no
 * more retroactive, and its "Reschedule cards on change" recomputes every
 * interval rather than moving days. This applies the same rule a review would
 * have, with that review's elapsed days, so a moved card is where a review
 * under today's setting would have put it. Only `due` and `interval` change:
 * no review is written, and `updatedAt` stays (it means a content edit). Days
 * already past are no candidates: the next best day ahead wins, never an
 * overdue one. anki-sync carries a
 * moved due date to Anki, as the last reviews on both sides still tie.
 */
export async function rescheduleEasyDays(apply: boolean, now: Date = new Date()): Promise<EasyDaysMove[]> {
  const { easyDays } = await currentSchedulerParams();
  if (easyDays === undefined) return [];
  const db = getDb();
  const cards = await db.card.findMany({
    where: { state: State.Review, suspended: false, due: { gt: now } },
    include: { reviews: { orderBy: { reviewedAt: "desc" }, take: 1, select: { elapsedDays: true } } },
  });
  const moves: EasyDaysMove[] = [];
  for (const card of cards) {
    const moved = avoidEasyDays(card, card.reviews[0]?.elapsedDays ?? 0, easyDays, now);
    if (moved === card) continue;
    moves.push({ id: card.id, front: card.front, from: card.due, to: moved.due });
    if (apply) {
      await db.card.update({
        where: { id: card.id },
        data: { due: moved.due, interval: moved.interval, updatedAt: card.updatedAt },
      });
    }
  }
  return moves;
}
