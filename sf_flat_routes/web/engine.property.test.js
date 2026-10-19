/* Spec 10.2 on random synthetic graphs (fast-check). */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { loadEngine, synthetic } from "./engine.fixtures.js";

const engine = loadEngine();
const CAPS = [0.05, 0.08, 0.12, 0.2];

/** A random graph: n nodes on a small grid of coordinates and random arcs,
 * each with a length, a climb and a max_up_grade_15m. */
const graphArb = fc
  .integer({ min: 3, max: 9 })
  .chain((n) =>
    fc.record({
      n: fc.constant(n),
      arcs: fc.array(
        fc.record({
          from: fc.integer({ min: 0, max: n - 1 }),
          to: fc.integer({ min: 0, max: n - 1 }),
          len: fc.integer({ min: 10, max: 400 }),
          gain: fc.integer({ min: 0, max: 30 }),
          maxup: fc.constantFrom(0, 0.02, 0.04, 0.06, 0.09, 0.11, 0.15, 0.25),
        }),
        { minLength: 2, maxLength: 24 },
      ),
    }),
  )
  .map(({ n, arcs }) => ({ n, arcs: arcs.filter((a) => a.from !== a.to) }))
  .filter(({ arcs }) => arcs.length > 0);

function build({ n, arcs }) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    lon: -122.42 + 0.001 * (i % 3),
    lat: 37.77 + 0.001 * Math.floor(i / 3),
    z: 0,
  }));
  return synthetic(engine, nodes, arcs);
}

/** Every simple path's bottleneck, brute force: the reference for minimaxCap. */
function bruteMinimax(spec, src, dst) {
  let best = Infinity;
  const seen = new Set([src]);
  const walk = (u, worst) => {
    if (worst >= best) return;
    if (u === dst) {
      best = worst;
      return;
    }
    for (const a of spec.arcs) {
      if (a.from !== u || seen.has(a.to)) continue;
      seen.add(a.to);
      walk(a.to, Math.max(worst, a.maxup));
      seen.delete(a.to);
    }
  };
  walk(src, 0);
  return best === Infinity ? null : best;
}

function frontier(g, src, dst, cap) {
  const search = g.pareto(src, dst, { cap, eps: 0, epsNode: 0 });
  while (!search.step(1e9));
  return search.solutions;
}

const pairArb = graphArb.chain((spec) =>
  fc.record({
    spec: fc.constant(spec),
    src: fc.integer({ min: 0, max: spec.n - 1 }),
    dst: fc.integer({ min: 0, max: spec.n - 1 }),
    cap: fc.constantFrom(...CAPS),
  }),
);

describe("routing properties on random graphs", () => {
  test("every route and every frontier member respects the cap (1)", () => {
    fc.assert(
      fc.property(pairArb, ({ spec, src, dst, cap }) => {
        const g = build(spec);
        const r = g.route(src, dst, { alpha: 0 }, cap);
        const routes = r ? [r.arcs] : [];
        for (const s of frontier(g, src, dst, cap)) routes.push(s.arcs);
        for (const arcs of routes)
          for (const a of arcs) expect(g.maxUp(a)).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 300 },
    );
  });

  test("notch 0 is the shortest route under the cap (2)", () => {
    fc.assert(
      fc.property(pairArb, ({ spec, src, dst, cap }) => {
        const g = build(spec);
        const r = g.route(src, dst, { alpha: 0 }, cap);
        const notches = engine.thinFrontier(frontier(g, src, dst, cap));
        if (!r) expect(notches).toEqual([]);
        else expect(notches[0].length).toBeCloseTo(g.summarise(r.arcs).distance_m, 1);
      }),
      { numRuns: 300 },
    );
  });

  test("notches grow in length, fall in climb, differ by a step, and are not dominated (3-5)", () => {
    fc.assert(
      fc.property(pairArb, ({ spec, src, dst, cap }) => {
        const g = build(spec);
        const found = frontier(g, src, dst, cap);
        const notches = engine.thinFrontier(found);
        expect(notches.length).toBeLessThanOrEqual(10);
        const step = notches.length ? engine.climbStep(notches[0].gain) : 0;
        for (let i = 1; i < notches.length; i++) {
          expect(notches[i].length).toBeGreaterThan(notches[i - 1].length);
          expect(notches[i - 1].gain - notches[i].gain).toBeGreaterThanOrEqual(step - 1e-9);
        }
        for (const k of notches) {
          const dominated = found.some(
            (f) =>
              f.length <= k.length &&
              f.gain <= k.gain &&
              (f.length < k.length - 1e-9 || f.gain < k.gain - 1e-9),
          );
          expect(dominated).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("raising the cap never makes the shortest route longer (6)", () => {
    fc.assert(
      fc.property(pairArb, ({ spec, src, dst }) => {
        const g = build(spec);
        let previous = Infinity;
        for (const cap of CAPS) {
          const r = g.route(src, dst, { alpha: 0 }, cap);
          const length = r ? g.summarise(r.arcs).distance_m : Infinity;
          expect(length).toBeLessThanOrEqual(previous + 1e-9);
          previous = length;
        }
      }),
      { numRuns: 300 },
    );
  });

  test("the minimum feasible cap is the brute-force minimax, and blocking arcs are exact (7)", () => {
    fc.assert(
      fc.property(pairArb, ({ spec, src, dst, cap }) => {
        fc.pre(src !== dst);
        const g = build(spec);
        const cStar = g.minimaxCap(src, dst);
        const brute = bruteMinimax(spec, src, dst);
        if (brute === null) {
          expect(cStar).toBeNull();
          return;
        }
        expect(cStar).toBeCloseTo(brute, 6);
        // a route exists exactly at c*, and not below it
        expect(g.route(src, dst, { alpha: 0 }, cStar)).not.toBeNull();
        if (cStar > 0) expect(g.route(src, dst, { alpha: 0 }, cStar - 0.0001)).toBeNull();
        const r = g.route(src, dst, { alpha: 0 }, cStar);
        const blocking = g.blockingArcs(r.arcs, cap);
        expect(new Set(blocking)).toEqual(new Set(r.arcs.filter((a) => g.maxUp(a) > cap)));
      }),
      { numRuns: 300 },
    );
  });
});

describe("downhill is not limited (9)", () => {
  test("a steep descent is used when it is the shortest way", () => {
    // 0 -> 1 straight down a 25% street, or around by a gentle 3% detour
    const nodes = [
      { lon: -122.42, lat: 37.77, z: 30 },
      { lon: -122.419, lat: 37.77, z: 5 },
      { lon: -122.4195, lat: 37.771, z: 20 },
    ];
    const g = synthetic(engine, nodes, [
      { from: 0, to: 1, len: 100, gain: 0, maxup: 0, edge: 0 },
      { from: 1, to: 0, len: 100, gain: 25, maxup: 0.25, edge: 0, reversed: true },
      { from: 0, to: 2, len: 150, gain: 0, maxup: 0, edge: 1 },
      { from: 2, to: 1, len: 150, gain: 0, maxup: 0, edge: 2 },
      { from: 1, to: 2, len: 150, gain: 4, maxup: 0.03, edge: 2, reversed: true },
      { from: 2, to: 0, len: 150, gain: 4, maxup: 0.03, edge: 1, reversed: true },
    ]);
    const down = g.route(0, 1, { alpha: 0 }, 0.05);
    expect(down.arcs.map((a) => g.head[a])).toEqual([1]);
    const up = g.route(1, 0, { alpha: 0 }, 0.05);
    expect(up.arcs.map((a) => g.head[a])).toEqual([2, 0]);
  });
});

describe("thinning (spec 6.2)", () => {
  const r = (length, gain) => ({ length, gain });

  test("keeps the shortest and the flattest, and drops near-duplicates in climb", () => {
    const notches = engine.thinFrontier([r(1000, 40), r(1010, 39), r(1100, 30), r(1300, 10)]);
    expect(notches).toEqual([r(1000, 40), r(1100, 30), r(1300, 10)]);
  });

  test("the flattest replaces a kept route that is within a step of it", () => {
    expect(engine.thinFrontier([r(1000, 40), r(1100, 21), r(1200, 20)])).toEqual([
      r(1000, 40),
      r(1200, 20),
    ]);
  });

  test("a frontier whose ends differ by less than a step is one notch", () => {
    expect(engine.thinFrontier([r(1000, 10), r(1500, 9)])).toEqual([r(1000, 10)]);
  });

  test("at most ten notches, spread over climb, ends kept", () => {
    const many = Array.from({ length: 40 }, (_, i) => r(1000 + 10 * i, 200 - 5 * i));
    const notches = engine.thinFrontier(many);
    expect(notches.length).toBe(10);
    expect(notches[0]).toEqual(many[0]);
    expect(notches[9]).toEqual(many[39]);
  });

  test("the default notch is the flattest within +25% of the shortest", () => {
    expect(engine.defaultNotch([r(1000, 40), r(1200, 20), r(1300, 10)])).toBe(1);
    expect(engine.defaultNotch([r(1000, 40), r(1300, 10)])).toBe(0);
    expect(engine.defaultNotch([])).toBe(0);
  });
});
