import { getDb } from "../db/client.js";
import { CARD_STATE_NAMES, type CardStateName } from "./types.js";

/**
 * Headline counts of the deck for a dashboard tile: unsuspended cards in total,
 * how many decks they sit in, and how many are in each FSRS state (every state
 * listed, in State order, empty ones as 0). The wiki-viewer used to count these
 * with SQL of its own.
 */
export interface DeckOverview {
  total: number;
  deckCount: number;
  states: { label: CardStateName; count: number }[];
}

export async function deckOverview(): Promise<DeckOverview> {
  const db = getDb();
  const [byState, byDeck] = await Promise.all([
    db.card.groupBy({ by: ["state"], where: { suspended: false }, _count: { _all: true } }),
    db.card.groupBy({ by: ["deckId"], where: { suspended: false } }),
  ]);
  const counts = new Map(byState.map((r) => [r.state, r._count._all]));
  const states = CARD_STATE_NAMES.map((label, state) => ({ label, count: counts.get(state) ?? 0 }));
  return { total: states.reduce((n, s) => n + s.count, 0), deckCount: byDeck.length, states };
}
