import { describe, it, expect, beforeEach } from "vitest";
import { State } from "ts-fsrs";
import { createDeck } from "../../src/core/deck-service.js";
import { rescheduleEasyDays } from "../../src/core/easy-days.js";
import { getDb } from "../../src/db/client.js";

// Thursday 2026-11-19, noon local; weekends at minimum.
const thursday = new Date(2026, 10, 19, 12);
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour);
const edited = new Date(2026, 0, 1);
let deckId: string;

beforeEach(async () => {
  deckId = (await createDeck("EasyDays")).id;
  const easyDays = "[1,1,1,1,1,0,0]";
  await getDb().config.upsert({ where: { id: "default" }, create: { id: "default", easyDays }, update: { easyDays } });
});

async function card(front: string, due: Date, interval: number) {
  const data = { deckId, front, back: "b", state: State.Review, due, interval, stability: 20, difficulty: 5, reps: 5, lastReview: at(11) };
  const { id } = await getDb().card.create({ data });
  await getDb().$executeRaw`UPDATE Card SET updatedAt = ${edited} WHERE id = ${id}`;
  return id;
}

describe("rescheduleEasyDays", () => {
  it("moves a scheduled weekend review as a review would, and only when applied", async () => {
    const saturday = await card("saturday?", at(21), 10);
    const friday = await card("friday?", at(20), 10);
    const short = await card("short?", at(21), 2);

    const preview = await rescheduleEasyDays(false, thursday);
    expect(preview.map((m) => m.id)).toEqual([saturday]);
    expect((await getDb().card.findUniqueOrThrow({ where: { id: saturday } })).due).toEqual(at(21));

    expect(await rescheduleEasyDays(true, thursday)).toEqual(preview);
    const moved = await getDb().card.findUniqueOrThrow({ where: { id: saturday } });
    expect(moved.due).toEqual(at(20)); // Friday: as near as Monday, and shorter
    expect(moved.interval).toBe(9);
    expect(moved.updatedAt).toEqual(edited);
    expect(await getDb().review.count()).toBe(0);
    for (const id of [friday, short]) expect((await getDb().card.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(edited);

    expect(await rescheduleEasyDays(true, thursday)).toEqual([]); // a second run finds nothing
  });

  it("takes the best day still ahead, never one past", async () => {
    const id = await card("tomorrow?", at(21), 10); // Friday 09:00 would be best, but it is Friday noon

    expect((await rescheduleEasyDays(true, at(20, 12))).map((m) => m.to)).toEqual([at(23)]);
    expect((await getDb().card.findUniqueOrThrow({ where: { id } })).interval).toBe(12);
  });

  it("leaves a card whose only weekday is past", async () => {
    await card("short range?", at(21), 5); // range 4-6 days: Friday (past), Saturday, Sunday

    expect(await rescheduleEasyDays(true, at(20, 12))).toEqual([]);
  });
});
