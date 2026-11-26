/**
 * The deck SDK: the only way into agentic-spaced-repetition's core and database.
 *
 * The three adapters (MCP server, app server, CLI) import from here and from
 * nowhere deeper, so each is transport only: parse a request, call the SDK,
 * shape the answer. Rules (content, pressure, scheduling, leeches, tombstones)
 * and every query live below this line, once. Callers that are not TypeScript
 * (the study repo's anki-sync, card-quality gate and sweep; the wiki-viewer;
 * Omvida) reach the same functions over the app server's JSON-lines protocol,
 * which is why the record readers and `applySync` exist: they used to open
 * master.db and run SQL, and re-derived these rules by hand.
 *
 * This file is a facade: it re-exports, it does not wrap. A new capability is a
 * core function, exported here, then a one-line adapter method.
 */

import type { Card, CardNote, PrismaClient } from "@prisma/client";
import { createClient, setDb } from "../db/client.js";
import { prepareDatabase } from "../db/prepare.js";

/** Database rows as Prisma returns them, for adapters that reshape them. */
export type DbCard = Card;
export type DbCardNote = CardNote;

/**
 * Opens the deck at DATABASE_URL (default prisma/master.db) for this process:
 * creates the client, installs it for the SDK and brings the database up to
 * date (schema, dates, session sizes), as every start does. `close` disconnects.
 */
export async function openDeck(): Promise<{ db: PrismaClient; schemaPushed: boolean; close: () => Promise<void> }> {
  const db = createClient();
  setDb(db);
  try {
    const { schemaPushed } = await prepareDatabase(db);
    return { db, schemaPushed, close: () => db.$disconnect() };
  } catch (err) {
    await db.$disconnect();
    throw err;
  }
}

export { databaseFile } from "../db/client.js";
export { PACKAGE_VERSION } from "../core/version.js";
export { localDay } from "../core/days.js";
export { CARD_STATE_NAMES, parseTags, type CardStateName } from "../core/types.js";

export { cardMaturity, isGrade } from "../core/scheduler.js";

export {
  createCard,
  createCodeCard,
  getCard,
  getCodeCardExercise,
  updateCard,
  updateCodeCard,
  deleteCard,
  deleteCards,
  searchCards,
  listCards,
  allCards,
  suspendCard,
  unsuspendCard,
  getDueCards,
  countDueCards,
  findSimilar,
} from "../core/card-service.js";
export { listDeckStats, getDeckStats, deleteDeck, deckNames } from "../core/deck-service.js";

export {
  startSession,
  getNextCard,
  getNextCardOrBlock,
  getQueuePosition,
  submitReview,
  undoLastReview,
  previewSchedules,
  skipCard,
  adjustSession,
  endSession,
} from "../core/session-service.js";

export { checkPressure, backlogHoldsNewBack, backlogNewCap } from "../core/pressure.js";
export { checkCalibration } from "../core/calibration.js";
export { deferLeech, leechPayload } from "../core/leeches.js";
export { listCardNotes, resolveCardNote, setCardNote } from "../core/card-notes.js";
export { getFullStats, getSessionHistory, recentlyStudied } from "../core/analytics-service.js";
export { getOverview } from "../core/overview.js";
export { recentSessions } from "../core/recent-sessions.js";
export { changeTokens } from "../core/change-tokens.js";
export { Grader, type GradeCall } from "../core/grading.js";
export { rescheduleEasyDays } from "../core/easy-days.js";
export { dumpDatabase, restoreDatabase } from "../core/db-dump.js";

export { clozeSides } from "../core/cloze.js";
export {
  EXERCISE_KINDS,
  LANGS,
  checkExercise,
  exerciseView,
  parseExercise,
  revealExercise,
  runExercise,
  type ExerciseView,
} from "../core/exercises.js";

// Plain-data readers and the sync writer, for callers outside TypeScript.
export { cardRecords, reviewRecords, tombstoneIds } from "../core/card-records.js";
export type { CardRecord, ReviewRecord, CardRecordFilter } from "../core/card-records.js";
export { deckOverview, type DeckOverview } from "../core/deck-overview.js";
export { applySync, parseSyncPlan } from "../core/sync-apply.js";
export type { SyncPlan, SyncResult } from "../core/sync-apply.js";
