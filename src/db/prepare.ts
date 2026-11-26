import type { PrismaClient } from "@prisma/client";
import { normalizeDates } from "./normalize.js";
import { syncSchema } from "./schema-sync.js";
import { migrateSessionSizes } from "./session-sizes.js";

/**
 * What every start of the CLI, the MCP server and the app server does to the
 * database before using it: bring its tables up to the schema (schema-sync.ts),
 * then make its dates uniform (normalize.ts) and move old session-size defaults
 * (session-sizes.ts), in that order, since the later steps read the tables the
 * first makes. All three are cheap when there is nothing to do.
 */
export async function prepareDatabase(db: PrismaClient): Promise<{ schemaPushed: boolean }> {
  const schemaPushed = await syncSchema(db);
  await normalizeDates(db);
  await migrateSessionSizes(db);
  return { schemaPushed };
}
