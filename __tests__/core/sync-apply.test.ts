import { describe, it, expect, beforeEach } from "vitest";
import { State } from "ts-fsrs";
import { applySync, parseSyncPlan, type SyncImport, type SyncSchedule } from "../../src/core/sync-apply.js";
import { fallbackMemoryState } from "../../src/core/scheduler.js";
import { createCard, getCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { setCardNote } from "../../src/core/card-notes.js";
import { getDb } from "../../src/db/client.js";

const CARD_A = "cmne7xoxj002z0msoiuekt37c";
const CARD_B = "cmne7xoz0003d0mso56mopmir";

let deckId: string;

beforeEach(async () => {
  deckId = (await createDeck("Sync")).id;
});

/** A Review card, as another machine would report it, with no FSRS memory state unless given. */
function sched(overrides: Partial<SyncSchedule> = {}): SyncSchedule {
  return {
    cardId: "c",
    due: new Date("2026-10-01T04:00:00Z"),
    stability: null,
    difficulty: null,
    reps: 5,
    lapses: 1,
    state: State.Review,
    lastReview: new Date("2026-09-01T10:00:00Z"),
    interval: 42,
    ...overrides,
  };
}

function incoming(overrides: Partial<SyncImport> = {}): SyncImport {
  const { cardId: _cardId, ...s } = sched({ stability: 1, difficulty: 5 });
  return {
    id: CARD_A,
    deck: "Imported",
    front: "What is an import?",
    back: "A card first seen elsewhere.",
    tags: ["a", "b"],
    exercise: null,
    suspended: false,
    createdAt: new Date("2025-09-04T00:00:00Z"),
    ...s,
    ...overrides,
  };
}

async function seed(front = "Q?"): Promise<string> {
  const { card } = await createCard({ deckId, front, back: "A.", skipPressureGate: true });
  return card.id;
}

describe("fallbackMemoryState", () => {
  it("passes a real memory state through unchanged", () => {
    expect(fallbackMemoryState({ state: 2, interval: 42, stability: 3.5, difficulty: 6.2 })).toEqual({ stability: 3.5, difficulty: 6.2 });
  });

  it("stands the interval in for stability on a non-New card, with a neutral difficulty", () => {
    expect(fallbackMemoryState({ state: 2, interval: 42 })).toEqual({ stability: 42, difficulty: 5 });
  });

  it("never produces the corruption sentinel: a short interval floors above 0", () => {
    expect(fallbackMemoryState({ state: 3, interval: 0 }).stability).toBeGreaterThan(0);
  });

  it("leaves a New card at 0/0, which is correct for it", () => {
    expect(fallbackMemoryState({ state: 0, interval: 0 })).toEqual({ stability: 0, difficulty: 0 });
  });

  it("falls back when only half the memory state is there", () => {
    expect(fallbackMemoryState({ state: 2, interval: 10, stability: 3.5, difficulty: null })).toEqual({ stability: 10, difficulty: 5 });
  });
});

describe("applySync schedules", () => {
  async function pulled(local: { stability: number; difficulty: number }, s: Partial<SyncSchedule>) {
    const id = await seed();
    await getDb().card.update({ where: { id }, data: { ...local, state: State.New } });
    await applySync({ schedules: [sched({ cardId: id, ...s })] });
    const card = (await getCard(id))!;
    return { stability: card.stability, difficulty: card.difficulty };
  }

  it("gives a locally-new card the fallback when Anki has no memory state", async () => {
    const { stability, difficulty } = await pulled({ stability: 0, difficulty: 0 }, { interval: 7 });
    expect(stability).toBe(7);
    expect(difficulty).toBeGreaterThanOrEqual(1);
    expect(difficulty).toBeLessThanOrEqual(10);
  });

  it("keeps a real local memory state", async () => {
    expect(await pulled({ stability: 12.5, difficulty: 4.2 }, {})).toEqual({ stability: 12.5, difficulty: 4.2 });
  });

  it("leaves a pulled New card at zero", async () => {
    expect(await pulled({ stability: 0, difficulty: 0 }, { state: State.New, reps: 0, interval: 0 })).toEqual({ stability: 0, difficulty: 0 });
  });

  it("treats a stability of 0 on a non-New card as no memory state", async () => {
    const { stability } = await pulled({ stability: 0, difficulty: 0 }, { stability: 0, difficulty: 6, interval: 9 });
    expect(stability).toBe(9);
  });

  it("writes the block Anki won, and not updatedAt, which means a content edit", async () => {
    const id = await seed();
    const before = (await getCard(id))!.updatedAt;
    const result = await applySync({ schedules: [sched({ cardId: id, stability: 8, difficulty: 3, reps: 9, lapses: 2 })] });
    const card = (await getCard(id))!;
    expect(result.schedules).toBe(1);
    expect([card.stability, card.difficulty, card.reps, card.lapses, card.state, card.interval]).toEqual([8, 3, 9, 2, State.Review, 42]);
    expect(card.due.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(card.lastReview?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(card.updatedAt.getTime()).toBe(before.getTime());
  });

  it("skips a card that is not here", async () => {
    expect((await applySync({ schedules: [sched({ cardId: "nope" })] })).schedules).toBe(0);
  });
});

describe("applySync imports", () => {
  it("creates the card under its own id, with its deck, tags and schedule", async () => {
    const result = await applySync({ imports: [incoming()] });
    expect(result.imports).toEqual({ imported: 1, rejected: [] });
    const card = (await getDb().card.findUnique({ where: { id: CARD_A }, include: { deck: true } }))!;
    expect(card.deck.name).toBe("Imported");
    expect(card.tags).toBe("a,b");
    expect(card.reps).toBe(5);
    expect(card.createdAt.toISOString()).toBe("2025-09-04T00:00:00.000Z");
    expect(card.exercise).toBeNull();
  });

  it("gives a card with no memory state the fallback, never a zero stability", async () => {
    await applySync({ imports: [incoming({ stability: null, difficulty: null, interval: 21 })] });
    const card = (await getCard(CARD_A))!;
    expect([card.stability, card.difficulty]).toEqual([21, 5]);
  });

  it("keeps a code card's exercise, so it arrives able to run", async () => {
    const exercise = JSON.stringify({ kind: "predict", lang: "ruby", brief: "b", source: "r = 1", cases: [{ expr: "r", goal: "1" }], explain: "e" });
    await applySync({
      imports: [incoming({ exercise, front: "r = {{c1::1}}", back: "1" }), incoming({ id: CARD_B, exercise: null })],
    });
    expect((await getCard(CARD_A))!.exercise).toBe(exercise);
    expect((await getCard(CARD_B))!.exercise).toBeNull();
  });

  it("reports a card the content rules refuse instead of throwing the batch away", async () => {
    const result = await applySync({ imports: [incoming({ id: CARD_A, back: "**bold** answer" }), incoming({ id: CARD_B })] });
    expect(result.imports.imported).toBe(1);
    expect(result.imports.rejected).toHaveLength(1);
    expect(result.imports.rejected[0].id).toBe(CARD_A);
    expect(result.imports.rejected[0].error).toContain("back:");
    expect(await getCard(CARD_A)).toBeNull();
    expect(await getCard(CARD_B)).not.toBeNull();
  });

  it("refuses a code card whose exercise does not parse", async () => {
    const result = await applySync({ imports: [incoming({ exercise: "{broken" })] });
    expect(result.imports.rejected).toHaveLength(1);
  });

  it("rejects an id the deck already has, and leaves that card as it was", async () => {
    const id = await seed("Existing?");
    const result = await applySync({ imports: [incoming({ id }), incoming({ id: CARD_B })] });
    expect(result.imports.rejected.map((r) => r.id)).toEqual([id]);
    expect((await getCard(id))!.front).toBe("Existing?");
    expect(result.imports.imported).toBe(1);
  });

  it("keeps a card's history with it, and drops the history of a rejected one", async () => {
    const result = await applySync({
      imports: [incoming({ id: CARD_A }), incoming({ id: CARD_B, front: "one? two?" })],
      reviews: [
        { cardId: CARD_A, reviewedAt: new Date("2026-09-01T10:00:00Z"), rating: 3, responseMs: 900, state: State.Review },
        { cardId: CARD_B, reviewedAt: new Date("2026-09-01T10:00:00Z"), rating: 3, responseMs: null, state: null },
      ],
    });
    expect(result.reviews).toBe(1);
    const rows = await getDb().review.findMany();
    expect(rows.map((r) => r.cardId)).toEqual([CARD_A]);
    // the import's memory state is recorded beside its review
    expect(rows[0].stability).toBe(1);
  });
});

describe("applySync reviews", () => {
  const at = (iso: string) => new Date(iso);

  it("appends once: a second run adds nothing", async () => {
    const id = await seed();
    const plan = { reviews: [{ cardId: id, reviewedAt: at("2026-09-01T10:00:00Z"), rating: 3, responseMs: 1200, state: State.Learning }] };
    expect((await applySync(plan)).reviews).toBe(1);
    expect((await applySync(plan)).reviews).toBe(0);
    const [row] = await getDb().review.findMany();
    expect([row.rating, row.responseMs, row.state]).toEqual([3, 1200, State.Learning]);
  });

  it("treats a review within the same second as the same review", async () => {
    const id = await seed();
    await applySync({ reviews: [{ cardId: id, reviewedAt: at("2026-09-01T10:00:00.100Z"), rating: 3, responseMs: null, state: null }] });
    const again = await applySync({ reviews: [{ cardId: id, reviewedAt: at("2026-09-01T10:00:00.900Z"), rating: 3, responseMs: null, state: null }] });
    expect(again.reviews).toBe(0);
  });

  it("records the days since the card's previous review, 0 for its first", async () => {
    const id = await seed();
    await applySync({
      reviews: [
        { cardId: id, reviewedAt: at("2026-09-04T10:00:00Z"), rating: 3, responseMs: null, state: null },
        { cardId: id, reviewedAt: at("2026-09-01T10:00:00Z"), rating: 1, responseMs: null, state: null },
      ],
    });
    const rows = await getDb().review.findMany({ orderBy: { reviewedAt: "asc" } });
    expect(rows.map((r) => r.elapsedDays)).toEqual([0, 3]);
  });

  it("takes the memory snapshot from the review, else from the card's schedule in the same call, else 0", async () => {
    const [a, b, c] = [await seed("a?"), await seed("b?"), await seed("c?")];
    const r = (cardId: string, extra = {}) => ({ cardId, reviewedAt: at("2026-09-01T10:00:00Z"), rating: 3, responseMs: null, state: null, ...extra });
    await applySync({
      schedules: [sched({ cardId: a, stability: 4, difficulty: 6 })],
      reviews: [r(a), r(b, { stability: 9, difficulty: 2 }), r(c)],
    });
    const byCard = new Map((await getDb().review.findMany()).map((x) => [x.cardId, [x.stability, x.difficulty]]));
    expect(byCard.get(a)).toEqual([4, 6]);
    expect(byCard.get(b)).toEqual([9, 2]);
    expect(byCard.get(c)).toEqual([0, 0]);
  });

  it("ignores a review of a card that is not here, and counts it", async () => {
    const result = await applySync({ reviews: [{ cardId: "nope", reviewedAt: at("2026-09-01T10:00:00Z"), rating: 3, responseMs: null, state: null }] });
    expect(result.reviews).toBe(0);
    expect(result.reviewsSkipped).toEqual({ present: 0, noCard: 1 });
  });

  it("counts the reviews it already had apart from the ones with no card", async () => {
    const id = await seed();
    const r = (cardId: string, iso: string) => ({ cardId, reviewedAt: at(iso), rating: 3, responseMs: null, state: null });
    await applySync({ reviews: [r(id, "2026-09-01T10:00:00Z")] });
    const result = await applySync({ reviews: [r(id, "2026-09-01T10:00:00Z"), r(id, "2026-09-02T10:00:00Z"), r("nope", "2026-09-02T10:00:00Z")] });
    expect(result.reviews).toBe(1);
    expect(result.reviewsSkipped).toEqual({ present: 1, noCard: 1 });
  });
});

describe("applySync deletions", () => {
  it("tombstones the card and takes its reviews and note with it", async () => {
    const [keep, gone] = [await seed("keep?"), await seed("gone?")];
    for (const id of [keep, gone]) {
      await getDb().review.create({ data: { cardId: id, rating: 3, stability: 1, difficulty: 5, elapsedDays: 0 } });
    }
    await setCardNote(keep, "fix later");
    await setCardNote(gone, "fix later");

    expect((await applySync({ deletions: [gone] })).deletions).toBe(1);

    expect(await getCard(gone)).toBeNull();
    expect((await getDb().review.findMany()).map((r) => r.cardId)).toEqual([keep]);
    expect((await getDb().cardNote.findMany()).map((n) => n.cardId)).toEqual([keep]);
    expect((await getDb().deletedCard.findMany()).map((t) => t.cardId)).toEqual([gone]);
  });

  it("tombstones an id with no card here, as a note tagged deleted on another machine for a card never seen", async () => {
    await applySync({ deletions: [CARD_B] });
    expect((await getDb().deletedCard.findMany()).map((t) => t.cardId)).toEqual([CARD_B]);
  });

  it("drops the reviews that arrive for a card the same plan deletes", async () => {
    const id = await seed();
    const result = await applySync({
      deletions: [id],
      reviews: [{ cardId: id, reviewedAt: new Date("2026-09-01T10:00:00Z"), rating: 3, responseMs: null, state: null }],
    });
    expect(result.reviews).toBe(0);
    expect(await getDb().review.count()).toBe(0);
  });
});

describe("applySync schedulerOptions", () => {
  const opts = { learningSteps: "2m,30m,1d", relearningSteps: "15m", requestRetention: 0.85 };

  it("writes only the columns that changed, and says which", async () => {
    await getDb().config.create({ data: { id: "default" } });
    expect((await applySync({ schedulerOptions: opts })).schedulerOptions).toEqual(["learningSteps", "relearningSteps", "requestRetention"]);
    const row = (await getDb().config.findUnique({ where: { id: "default" } }))!;
    expect([row.learningSteps, row.relearningSteps, row.requestRetention]).toEqual(["2m,30m,1d", "15m", 0.85]);
    expect(row.newPerDay).toBe(20);
  });

  it("changes nothing the second time", async () => {
    await getDb().config.create({ data: { id: "default" } });
    await applySync({ schedulerOptions: opts });
    expect((await applySync({ schedulerOptions: opts })).schedulerOptions).toEqual([]);
  });

  it("writes nothing while there is no Config row, which the first session creates", async () => {
    expect((await applySync({ schedulerOptions: opts })).schedulerOptions).toEqual([]);
    expect(await getDb().config.count()).toBe(0);
  });

  it("reads Anki's 0/1 as the boolean it stores", async () => {
    await getDb().config.create({ data: { id: "default" } });
    const plan = parseSyncPlan({ schedulerOptions: { newCardsIgnoreReviewLimit: 1 } });
    expect((await applySync(plan)).schedulerOptions).toEqual(["newCardsIgnoreReviewLimit"]);
    expect((await getDb().config.findUnique({ where: { id: "default" } }))!.newCardsIgnoreReviewLimit).toBe(true);
  });
});

describe("applySync as a whole", () => {
  it("does nothing for an empty plan", async () => {
    expect(await applySync({})).toEqual({ schedules: 0, reviews: 0, reviewsSkipped: { present: 0, noCard: 0 }, imports: { imported: 0, rejected: [] }, deletions: 0, schedulerOptions: [] });
  });

  it("undoes every part when one fails", async () => {
    const id = await seed();
    await expect(
      applySync({
        imports: [incoming()],
        // a rating outside what the column holds is not the point; an id-less review row is
        reviews: [{ cardId: id, reviewedAt: new Date("invalid"), rating: 3, responseMs: null, state: null }],
      })
    ).rejects.toThrow();
    expect(await getCard(CARD_A)).toBeNull();
  });
});

describe("parseSyncPlan", () => {
  it("reads the wire format, dates included", () => {
    const plan = parseSyncPlan({
      schedules: [{ cardId: "c", due: "2026-10-01T04:00:00Z", stability: null, difficulty: null, reps: 1, lapses: 0, state: 2, lastReview: null, interval: 3 }],
      deletions: ["x"],
    });
    expect(plan.schedules?.[0].due).toEqual(new Date("2026-10-01T04:00:00Z"));
    expect(plan.schedules?.[0].lastReview).toBeNull();
    expect(plan.deletions).toEqual(["x"]);
  });

  it("names the entry and the field that is wrong", () => {
    expect(() => parseSyncPlan({ schedules: [{ cardId: "c", reps: "1" }] })).toThrow(/schedules\[0\]: reps must be a number/);
    expect(() => parseSyncPlan({ reviews: [{ cardId: "c", reviewedAt: "yesterday", rating: 3 }] })).toThrow(/reviews\[0\]: reviewedAt is not a datetime/);
    expect(() => parseSyncPlan({ deletions: [3] })).toThrow(/deletions\[0\]/);
    expect(() => parseSyncPlan({ imports: "all" })).toThrow(/imports must be an array/);
  });

  it("range-checks ratings, states and counts", () => {
    const review = (extra: object) => ({ reviews: [{ cardId: "c", reviewedAt: "2026-09-01T10:00:00Z", rating: 3, ...extra }] });
    const schedule = (extra: object) => ({
      schedules: [{ cardId: "c", due: null, stability: null, difficulty: null, reps: 1, lapses: 0, state: 2, lastReview: null, interval: 3, ...extra }],
    });
    expect(() => parseSyncPlan(review({}))).not.toThrow();
    for (const rating of [0, 5, 2.5]) expect(() => parseSyncPlan(review({ rating }))).toThrow(/reviews\[0\]: rating must be a whole number from 1 to 4/);
    expect(() => parseSyncPlan(review({ state: 4 }))).toThrow(/state must be a whole number from 0 to 3/);
    expect(parseSyncPlan(review({ state: null })).reviews?.[0].state).toBeNull();
    expect(() => parseSyncPlan(schedule({ state: -1 }))).toThrow(/state must be/);
    expect(() => parseSyncPlan(schedule({ reps: -1 }))).toThrow(/reps must be a whole number of at least 0/);
    expect(() => parseSyncPlan(schedule({ lapses: 1.5 }))).toThrow(/lapses must be a whole number/);
  });
});
