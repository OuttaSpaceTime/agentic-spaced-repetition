import { describe, it, expect } from "vitest";
import {
  aheadShare,
  borrowedToday,
  isRestDay,
  restRunBefore,
  restRunToday,
  weekAhead,
} from "../../src/core/rest-days.js";
import { localDay } from "../../src/core/days.js";

const WEEKENDS_OFF = [1, 1, 1, 1, 1, 0, 0];
// 2026-11-21 is a Saturday.
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour);
const days = (ds: Date[]) => ds.map((d) => localDay(d));

describe("isRestDay", () => {
  it("is a weekday at Minimum, and nothing with Easy Days off", () => {
    expect(isRestDay(WEEKENDS_OFF, at(21))).toBe(true);
    expect(isRestDay(WEEKENDS_OFF, at(22))).toBe(true);
    expect(isRestDay(WEEKENDS_OFF, at(23))).toBe(false);
    expect(isRestDay([1, 1, 1, 1, 1, 0.5, 0.5], at(21))).toBe(false);
    expect(isRestDay(undefined, at(21))).toBe(false);
  });
});

describe("weekAhead", () => {
  it("runs from a Saturday through the next Friday", () => {
    const week = weekAhead(WEEKENDS_OFF, at(21));
    expect(days(week.studyDays)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(week.end).toEqual(new Date(2026, 10, 28));
  });

  it("is the same week from the Sunday", () => {
    expect(weekAhead(WEEKENDS_OFF, at(22, 23)).end).toEqual(new Date(2026, 10, 28));
  });

  it("stops when every day is a rest day", () => {
    expect(weekAhead([0, 0, 0, 0, 0, 0, 0], at(21)).studyDays).toEqual([]);
  });
});

describe("restRunToday", () => {
  it("starts on the Saturday and ends tonight", () => {
    expect(restRunToday(WEEKENDS_OFF, at(22))).toEqual({ from: new Date(2026, 10, 21), to: new Date(2026, 10, 23) });
    expect(restRunToday(WEEKENDS_OFF, at(21))).toEqual({ from: new Date(2026, 10, 21), to: new Date(2026, 10, 22) });
  });
});

describe("restRunBefore", () => {
  it("is the weekend just past, from the Monday and the days after", () => {
    const weekend = { from: new Date(2026, 10, 21), to: new Date(2026, 10, 23) };
    expect(restRunBefore(WEEKENDS_OFF, at(23))).toEqual({ ...weekend, studyDaysSince: 0 });
    expect(restRunBefore(WEEKENDS_OFF, at(24))).toEqual({ ...weekend, studyDaysSince: 1 });
    expect(restRunBefore(WEEKENDS_OFF, at(27))).toEqual({ ...weekend, studyDaysSince: 4 });
  });

  it("is none without a rest day", () => {
    expect(restRunBefore(undefined, at(23))).toBeNull();
    expect(restRunBefore([1, 1, 1, 1, 1, 1, 1], at(23))).toBeNull();
  });
});

describe("borrowedToday", () => {
  it("takes from the first study day, then the next once that one is used up", () => {
    expect(borrowedToday(3, 0, 5)).toBe(3);
    expect(borrowedToday(3, 1, 5)).toBe(0);
    expect(borrowedToday(7, 0, 5)).toBe(5);
    expect(borrowedToday(7, 1, 5)).toBe(2);
    expect(borrowedToday(7, 2, 5)).toBe(0);
  });
});

describe("aheadShare", () => {
  it("takes a seventh of the week, in its mix of reviews and new cards", () => {
    // 55 reviews and 15 new: 10, of which 2 new.
    expect(aheadShare({ reviewsAhead: 55, newAhead: 15, reviewsToday: 0, newToday: 0 })).toEqual({ reviews: 8, newCards: 2 });
  });

  it("is fixed for the day: what today studied is taken off, not a new seventh of the rest", () => {
    expect(aheadShare({ reviewsAhead: 47, newAhead: 13, reviewsToday: 8, newToday: 2 })).toEqual({ reviews: 0, newCards: 0 });
    expect(aheadShare({ reviewsAhead: 50, newAhead: 15, reviewsToday: 5, newToday: 0 })).toEqual({ reviews: 3, newCards: 2 });
  });

  it("never takes more than the week holds", () => {
    expect(aheadShare({ reviewsAhead: 0, newAhead: 3, reviewsToday: 0, newToday: 0 })).toEqual({ reviews: 0, newCards: 1 });
    expect(aheadShare({ reviewsAhead: 0, newAhead: 0, reviewsToday: 0, newToday: 0 })).toEqual({ reviews: 0, newCards: 0 });
  });
});
