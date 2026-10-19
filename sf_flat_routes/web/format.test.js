import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { loadScripts } from "./engine.fixtures.js";

const F = loadScripts("format.js");
const CAP = { min: 3, max: 20 };
const plain = (s) => s.replaceAll("\u00a0", " ");

describe("numbers", () => {
  test("distances in metres, kilometres, feet and miles", () => {
    expect(plain(F.fmtDistance(850, "metric"))).toBe("850 m");
    expect(plain(F.fmtDistance(1430, "metric"))).toBe("1.4 km");
    expect(plain(F.fmtDistance(12600, "metric"))).toBe("13 km");
    expect(plain(F.fmtDistance(100, "imperial"))).toBe("330 ft");
    expect(plain(F.fmtDistance(2414, "imperial"))).toBe("1.5 mi");
  });
  test("climb and grade", () => {
    expect(plain(F.fmtClimb(12.4, "metric"))).toBe("12 m");
    expect(plain(F.fmtClimb(10, "imperial"))).toBe("33 ft");
    expect(plain(F.fmtGrade(0.0749))).toBe("7 %");
  });
  test("the cap slider speaks percent", () => {
    expect(plain(F.capLabel(8))).toBe("Max uphill 8 %");
    expect(F.capValueText(8)).toBe("8 percent");
  });
});

describe("trade-off and summary", () => {
  const first = { length: 1220, gain: 34 };
  test("notch 0 is Shortest; others read +distance and −climb", () => {
    expect(F.tradeoffLabel(0, first, first, "metric")).toBe("Shortest");
    expect(plain(F.tradeoffLabel(2, { length: 1400, gain: 12 }, first, "metric"))).toBe(
      "+180 m · −22 m climb",
    );
  });
  test("the summary compares each metric with the unconstrained shortest route", () => {
    const parts = F.summaryParts(
      { distance_m: 1400, elev_gain_m: 12, steepest: 0.07 },
      { distance_m: 1220, elev_gain_m: 34, steepest: 0.17 },
      "metric",
    );
    expect(plain(`${parts.distance} · ${parts.climb} · ${parts.steepest}`)).toBe(
      "1.4 km (+180 m) · 12 m climb (−22 m) · max 7 % (vs 17 %)",
    );
  });
  test("an unchanged metric says so", () => {
    const s = { distance_m: 900, elev_gain_m: 5, steepest: 0.04 };
    const parts = F.summaryParts(s, s, "metric");
    expect(plain(parts.distance)).toBe("900 m (same)");
    expect(plain(parts.climb)).toBe("5 m climb (same)");
  });
});

describe("banners and notes", () => {
  const clay = {
    street: "Clay Street",
    from: "Jones Street",
    to: "Leavenworth Street",
    grade: 0.11,
  };
  test("the infeasible banner names the steepest block and counts the rest", () => {
    expect(plain(F.infeasibleText(8, 11, [clay]))).toBe(
      "No route stays under 8 %. The gentlest route needs 11 % on Clay St between Jones St and Leavenworth St.",
    );
    expect(plain(F.infeasibleText(8, 11, [clay, clay, clay]))).toMatch(/\(\+2 other blocks\)\.$/);
    expect(plain(F.infeasibleText(8, 11, [clay, clay]))).toMatch(/\(\+1 other block\)\.$/);
  });
  test("an unnamed path is placed by its nearest corner", () => {
    expect(F.blockName({ street: "", from: "Filbert Street & Kearny Street", to: "" })).toBe(
      "a path near Filbert St & Kearny St",
    );
  });
  test("tapping a steep street", () => {
    expect(plain(F.steepNote(8, 0.14, 0))).toBe(
      "Steeper than 8 % going uphill (14 %). Fine downhill.",
    );
    expect(plain(F.steepNote(8, 0.11, 0.14))).toBe("Steeper than 8 % both ways (14 % and 11 %).");
  });
  test("no loop of that length", () => {
    expect(plain(F.loopMissText(3, 8, 2.5, "metric"))).toBe(
      "No loop of about 3 km stays under 8 % from here. Try 2.5 km.",
    );
    expect(plain(F.loopMissText(3, 8, null, "imperial"))).toBe(
      "No loop of about 3 km (1.9 mi) stays under 8 % from here.",
    );
  });
});

describe("the URL state", () => {
  const place = fc.record({
    lon: fc.double({ min: -122.52, max: -122.33, noNaN: true }).map((v) => +v.toFixed(5)),
    lat: fc.double({ min: 37.7, max: 37.83, noNaN: true }).map((v) => +v.toFixed(5)),
    label: fc.string({ maxLength: 30 }),
  });
  const trip = fc.record({
    cap: fc.integer({ min: 3, max: 20 }),
    notch: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
    from: place,
    to: place,
    loop: fc.constant(null),
  });
  const loop = fc.record({
    cap: fc.integer({ min: 3, max: 20 }),
    notch: fc.constant(null),
    from: place,
    to: fc.constant(null),
    loop: fc.record({
      km: fc.integer({ min: 1, max: 30 }).map((h) => h / 2),
      outBack: fc.boolean(),
      idx: fc.integer({ min: 0, max: 5 }),
    }),
  });
  test("a trip or a loop survives a round trip through the hash", () => {
    fc.assert(
      fc.property(fc.oneof(trip, loop), (s) => {
        const token = F.encodeState(s);
        expect(token).toMatch(/^[A-Za-z0-9._~-]+$/);
        expect(F.decodeState("#" + token, CAP)).toEqual(s);
      }),
      { numRuns: 500 },
    );
  });
  test("nothing to share without a start", () => {
    expect(F.encodeState({ cap: 8, notch: null, from: null, to: null, loop: null })).toBe("");
  });
  test("malformed or foreign fragments are refused, and caps are clamped", () => {
    expect(F.decodeState("#t~-122.4~37.7~-122.4~37.8~1.000~a~b", CAP)).toBeNull();
    expect(F.decodeState("#r~x~-~1~2~3~4~a~b", CAP)).toBeNull();
    expect(F.decodeState("", CAP)).toBeNull();
    expect(F.decodeState("#r~50~-~-122.4~37.7~-122.4~37.8~a~b", CAP).cap).toBe(20);
  });
});
