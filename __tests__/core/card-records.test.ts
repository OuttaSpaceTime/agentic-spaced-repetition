import { describe, it, expect, beforeEach } from "vitest";
import { State } from "ts-fsrs";
import { cardRecords, reviewRecords, tombstoneIds } from "../../src/core/card-records.js";
import { deckOverview } from "../../src/core/deck-overview.js";
import { createCard, deleteCard, suspendCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";

let deckId: string;

beforeEach(async () => {
  deckId = (await createDeck("Records")).id;
});

async function seed(front: string, extra: { tags?: string[]; inheritFrom?: string } = {}): Promise<string> {
  const { card } = await createCard({ deckId, front, back: "An answer.", skipPressureGate: true, ...extra });
  return card.id;
}

describe("cardRecords", () => {
  it("returns whole cards as plain data: ISO dates, tag list, deck name, no embedding", async () => {
    const id = await seed("What is a record?", { tags: ["a", "b"] });
    const [card] = await cardRecords();
    expect(card).toMatchObject({
      id,
      deck: "Records",
      deckId,
      front: "What is a record?",
      back: "An answer.",
      tags: ["a", "b"],
      type: "guided",
      exercise: null,
      suspended: false,
      state: State.New,
      reps: 0,
      lapses: 0,
      lastReview: null,
      inheritedFrom: null,
    });
    expect(card.due).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(card.createdAt).toMatch(/Z$/);
    expect("embedding" in card).toBe(false);
  });

  it("narrows by ids, parent and suspension", async () => {
    const parent = await seed("Parent?");
    const child = await seed("Child?", { inheritFrom: parent });
    const other = await seed("Other?");
    await suspendCard(other);

    expect((await cardRecords({ ids: [parent, other, "nope"] })).map((c) => c.id).sort()).toEqual([parent, other].sort());
    expect((await cardRecords({ ids: [] }))).toEqual([]);
    expect((await cardRecords({ inheritedFrom: parent })).map((c) => c.id)).toEqual([child]);
    expect((await cardRecords({ includeSuspended: false })).map((c) => c.id).sort()).toEqual([parent, child].sort());
    expect(await cardRecords({ ids: [other], includeSuspended: false })).toEqual([]);
    expect(await cardRecords()).toHaveLength(3);
  });

  it("hands back a code card's exercise exactly as stored", async () => {
    const id = await seed("Code?");
    const json = '{"kind":"predict"}';
    await getDb().card.update({ where: { id }, data: { exercise: json } });
    expect((await cardRecords({ ids: [id] }))[0].exercise).toBe(json);
  });
});

describe("reviewRecords", () => {
  it("lists reviews oldest first, of the given cards or of all", async () => {
    const [a, b] = [await seed("a?"), await seed("b?")];
    const mk = (cardId: string, iso: string, rating: number, state: number | null) =>
      getDb().review.create({ data: { cardId, rating, reviewedAt: new Date(iso), stability: 1, difficulty: 5, elapsedDays: 0, responseMs: 500, state } });
    await mk(a, "2026-09-02T10:00:00Z", 3, State.Review);
    await mk(b, "2026-09-01T10:00:00Z", 1, null);

    const all = await reviewRecords();
    expect(all.map((r) => r.cardId)).toEqual([b, a]);
    expect(all[1]).toEqual({ cardId: a, reviewedAt: "2026-09-02T10:00:00.000Z", rating: 3, responseMs: 500, state: State.Review });
    expect(all[0].state).toBeNull();
    expect((await reviewRecords([a])).map((r) => r.cardId)).toEqual([a]);
  });
});

describe("tombstoneIds", () => {
  it("lists the ids of cards deleted here", async () => {
    const [keep, gone] = [await seed("keep?"), await seed("gone?")];
    await deleteCard(gone);
    expect(await tombstoneIds()).toEqual([gone]);
    expect(keep).not.toBe(gone);
  });
});

describe("deckOverview", () => {
  it("counts unsuspended cards per state, in State order, with the decks they sit in", async () => {
    const [a, b, c] = [await seed("a?"), await seed("b?"), await seed("c?")];
    await getDb().card.update({ where: { id: b }, data: { state: State.Review } });
    await suspendCard(c);
    const second = (await createDeck("Other")).id;
    await createCard({ deckId: second, front: "d?", back: "D.", skipPressureGate: true });

    expect(await deckOverview()).toEqual({
      total: 3,
      deckCount: 2,
      states: [
        { label: "new", count: 2 },
        { label: "learning", count: 0 },
        { label: "review", count: 1 },
        { label: "relearning", count: 0 },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("is empty for an empty deck", async () => {
    expect((await deckOverview()).total).toBe(0);
  });
});
