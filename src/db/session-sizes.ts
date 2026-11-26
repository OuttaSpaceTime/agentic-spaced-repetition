import type { PrismaClient } from "@prisma/client";

/**
 * Moves a Config row still on the old session defaults (5 new + 15 reviews) to
 * the new ones (20 + 20: a session of 20, new cards filling what reviews leave,
 * schema.prisma). A schema default only reaches rows created after it, and
 * nothing ever wrote these two columns but their defaults, so this is how every
 * machine's existing row follows without a manual step. A row with any other
 * values was set on purpose and is left alone; once moved, nothing matches, so
 * later starts are a single no-op update.
 */
export async function migrateSessionSizes(db: PrismaClient): Promise<void> {
  await db.config.updateMany({
    where: { maxNewCardsPerSession: 5, maxReviewCardsPerSession: 15 },
    data: { maxNewCardsPerSession: 20, maxReviewCardsPerSession: 20 },
  });
}
