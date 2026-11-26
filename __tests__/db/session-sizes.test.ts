import { describe, it, expect, afterEach } from "vitest";
import { migrateSessionSizes } from "../../src/db/session-sizes.js";
import { getDb } from "../../src/db/client.js";

describe("migrateSessionSizes", () => {
  const sizes = async () =>
    getDb().config.findUniqueOrThrow({ where: { id: "default" }, select: { maxNewCardsPerSession: true, maxReviewCardsPerSession: true } });
  const save = (maxNewCardsPerSession: number, maxReviewCardsPerSession: number) =>
    getDb().config.upsert({
      where: { id: "default" },
      create: { id: "default", maxNewCardsPerSession, maxReviewCardsPerSession },
      update: { maxNewCardsPerSession, maxReviewCardsPerSession },
    });
  afterEach(async () => {
    await getDb().config.deleteMany();
  });

  it("moves a row on the old defaults (5 + 15) to 20 + 20", async () => {
    await save(5, 15);
    await migrateSessionSizes(getDb());
    expect(await sizes()).toEqual({ maxNewCardsPerSession: 20, maxReviewCardsPerSession: 20 });
  });

  it("leaves a row set to anything else alone", async () => {
    await save(5, 30);
    await migrateSessionSizes(getDb());
    expect(await sizes()).toEqual({ maxNewCardsPerSession: 5, maxReviewCardsPerSession: 30 });
  });

  it("does nothing without a row", async () => {
    await migrateSessionSizes(getDb());
    expect(await getDb().config.count()).toBe(0);
  });
});
