import type { PrismaClient } from "@prisma/client";

/** Earlier session defaults (new, reviews) a Config row may still hold: 5 + 15, then 20 + 20. */
const OLD_DEFAULTS = [
  [5, 15],
  [20, 20],
] as const;

/**
 * Moves a Config row still on an earlier session default (OLD_DEFAULTS) to the
 * current one (30 + 30: a session of 30, new cards filling what reviews leave,
 * schema.prisma). A schema default only reaches rows created after it, and
 * nothing ever wrote these two columns but their defaults, so this is how every
 * machine's existing row follows without a manual step. A row with any other
 * values was set on purpose and is left alone; once moved, nothing matches, so
 * later starts are a single no-op update.
 */
export async function migrateSessionSizes(db: PrismaClient): Promise<void> {
  await db.config.updateMany({
    where: { OR: OLD_DEFAULTS.map(([n, r]) => ({ maxNewCardsPerSession: n, maxReviewCardsPerSession: r })) },
    data: { maxNewCardsPerSession: 30, maxReviewCardsPerSession: 30 },
  });
}
