/* Spec 10.2 on the real San Francisco graph committed in site/. */
import { describe, expect, test } from "vitest";

import { loadEngine, loadSiteGraph } from "./engine.fixtures.js";

const engine = loadEngine();
const { graph: g } = loadSiteGraph(engine);
const CAPS = [0.05, 0.08, 0.12, 0.2];
const PAIRS = 200;

/** A small seeded generator (mulberry32), so failures reproduce. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function metres(a, b) {
  const kx = 111320 * Math.cos((g.nodeLat(a) * Math.PI) / 180);
  return Math.hypot((g.nodeLon(a) - g.nodeLon(b)) * kx, (g.nodeLat(a) - g.nodeLat(b)) * 110540);
}

/** Random routable start/destination pairs 300 m to 4 km apart, like real trips. */
function pairs(n, seed) {
  const routable = [];
  for (let v = 0; v < g.n; v++) if (g.nodeFlags[v]) routable.push(v);
  const random = rng(seed),
    out = [];
  while (out.length < n) {
    const a = routable[Math.floor(random() * routable.length)];
    const b = routable[Math.floor(random() * routable.length)];
    const d = metres(a, b);
    if (d >= 300 && d <= 4000) out.push([a, b]);
  }
  return out;
}

function notchesFor(src, dst, cap) {
  const t = g.tradeoff(src, dst, cap);
  if (!t) return null;
  while (!t.search.step(1e9));
  return { t, notches: t.notches() };
}

describe(`${PAIRS} random San Francisco trips at caps ${CAPS.join(", ")}`, () => {
  const trips = pairs(PAIRS, 20261018);
  const results = trips.map(([src, dst]) =>
    CAPS.map((cap) => ({
      src,
      dst,
      cap,
      ...(notchesFor(src, dst, cap) ?? { t: null, notches: [] }),
    })),
  );

  test("every arc of every notch respects the cap (1)", () => {
    for (const row of results)
      for (const { cap, notches } of row)
        for (const n of notches)
          for (const a of n.arcs) expect(g.maxUp(a)).toBeLessThanOrEqual(cap);
  });

  test("notch 0 is the plain shortest path on allowed arcs, to 0.5 m (2)", () => {
    for (const row of results)
      for (const { src, dst, cap, notches } of row) {
        const r = g.route(src, dst, { alpha: 0 }, cap);
        if (!r) {
          expect(notches).toEqual([]);
          continue;
        }
        expect(Math.abs(notches[0].length - g.summarise(r.arcs).distance_m)).toBeLessThanOrEqual(
          0.5,
        );
      }
  });

  test("notches grow in length and fall in climb by at least a step, at most ten (3, 5)", () => {
    for (const row of results)
      for (const { notches } of row) {
        expect(notches.length).toBeLessThanOrEqual(10);
        if (!notches.length) continue;
        const step = engine.climbStep(notches[0].gain);
        for (let i = 1; i < notches.length; i++) {
          expect(notches[i].length).toBeGreaterThan(notches[i - 1].length);
          expect(notches[i - 1].gain - notches[i].gain).toBeGreaterThanOrEqual(step - 1e-6);
        }
      }
  });

  test("no notch is dominated by another route the search found (4)", () => {
    for (const row of results)
      for (const { t, notches } of row) {
        if (!t) continue;
        const found = t.search.solutions;
        for (const k of notches) {
          // no longer and climbing a centimetre less, or shorter by half a
          // metre and climbing no more (the quantisation of the packed graph)
          const dominated = found.some(
            (f) =>
              (f.length <= k.length + 1e-6 && f.gain < k.gain - 0.01) ||
              (f.length < k.length - 0.5 && f.gain <= k.gain + 1e-6),
          );
          expect(dominated).toBe(false);
        }
      }
  });

  test("raising the cap never makes notch 0 longer (6)", () => {
    for (const row of results) {
      let previous = Infinity;
      for (const { notches } of row) {
        const length = notches.length ? notches[0].length : Infinity;
        expect(length).toBeLessThanOrEqual(previous + 0.5);
        previous = length;
      }
    }
  });

  test("when a trip is infeasible, the fallback cap is exact and names exactly the steep arcs (7)", () => {
    let infeasible = 0;
    for (const row of results)
      for (const { src, dst, cap, notches } of row) {
        if (notches.length) continue;
        infeasible++;
        const cStar = g.minimaxCap(src, dst);
        expect(cStar).not.toBeNull();
        expect(cStar).toBeGreaterThan(cap);
        const r = g.route(src, dst, { alpha: 0 }, cStar);
        expect(r).not.toBeNull();
        expect(g.route(src, dst, { alpha: 0 }, cStar - 0.0001)).toBeNull();
        const steep = r.arcs.filter((a) => g.maxUp(a) > cap);
        expect(new Set(g.blockingArcs(r.arcs, cap))).toEqual(new Set(steep));
        expect(steep.length).toBeGreaterThan(0);
      }
    expect(infeasible).toBeGreaterThan(0); // the 5% cap cuts some trips in a hilly city
  });
});

describe("loops (8)", () => {
  const starts = pairs(8, 7).map(([a]) => a);
  for (const cap of [0.05, 0.08]) {
    test(`loops of about 3 km under ${cap * 100}% close, respect the cap and the length`, () => {
      let found = 0;
      for (const src of starts) {
        const s = g.loops(src, { targetM: 3000, cap });
        while (!s.step(1e9));
        for (const loop of s.loops) {
          const tail = g.reverse().tail;
          expect(tail[loop.arcs[0]]).toBe(src);
          expect(g.head[loop.arcs[loop.arcs.length - 1]]).toBe(src);
          for (const a of loop.arcs) expect(g.maxUp(a)).toBeLessThanOrEqual(cap);
          expect(loop.kind).not.toBe("outback");
          if (!s.shortfall) {
            found++;
            expect(Math.abs(loop.length - 3000)).toBeLessThanOrEqual(0.15 * 3000);
          }
        }
      }
      expect(found).toBeGreaterThan(0);
    });
  }
});
