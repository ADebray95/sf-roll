import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const SOURCE = readFileSync(new URL("engine.js", import.meta.url), "utf8");

/** engine.js is a classic browser script that publishes its classes on window. */
function loadEngine() {
  const window = {};
  runInNewContext(SOURCE, { window, performance, atob, Blob, Response, TextDecoder });
  return window;
}

const SCALES = { dm: 20, cm: 100, coord: 1e6, grade: 10000 };
const CLASSES = ["residential", "service"];

/**
 * A packed graph from a list of directed arcs, as webgraph.py would pack it.
 * Arcs that share an `edge` id are the two directions of one street.
 *
 * @param {{lon: number, lat: number, z: number}[]} nodes
 * @param {{from: number, to: number, len: number, gain: number, maxup?: number,
 *   edge?: number, cls?: number, reversed?: boolean}[]} arcs  metres; maxup a fraction
 */
function synthetic(engine, nodes, arcs) {
  const sorted = arcs
    .map((a, i) => ({ edge: i, cls: 0, maxup: 0, reversed: false, ...a }))
    .sort((a, b) => a.from - b.from);
  const nEdges = Math.max(...sorted.map((a) => a.edge)) + 1;
  const edgeCls = new Uint8Array(nEdges);
  const edgeLen = new Uint16Array(nEdges);
  for (const a of sorted) {
    edgeCls[a.edge] = a.cls;
    edgeLen[a.edge] = Math.round(a.len * SCALES.dm);
  }
  const indptr = new Int32Array(nodes.length + 1);
  for (const a of sorted) indptr[a.from + 1]++;
  for (let i = 0; i < nodes.length; i++) indptr[i + 1] += indptr[i];
  const u16 = (f) => Uint16Array.from(sorted, f);
  const arrays = {
    node_lon: Int32Array.from(nodes, (n) => Math.round(n.lon * SCALES.coord)),
    node_lat: Int32Array.from(nodes, (n) => Math.round(n.lat * SCALES.coord)),
    node_flags: Uint8Array.from(nodes, () => 1),
    node_elev: Int16Array.from(nodes, (n) => Math.round(n.z * SCALES.dm)),
    indptr,
    arc_head: Int32Array.from(sorted, (a) => a.to),
    arc_edge: Int32Array.from(sorted, (a) => a.edge),
    arc_len: u16((a) => Math.round(a.len * SCALES.dm)),
    arc_gain: u16((a) => Math.round(a.gain * SCALES.cm)),
    arc_loss: u16(() => 0),
    arc_maxup: u16((a) => Math.round(a.maxup * SCALES.grade)),
    arc_flags: Uint8Array.from(sorted, (a) => (a.reversed ? 1 | 4 : 1)),
    edge_name: new Uint16Array(nEdges),
    edge_cls: edgeCls,
    edge_len: edgeLen,
  };
  const bundle = {
    has: (name) => name in arrays,
    array: (name) => {
      if (!(name in arrays)) throw new Error("missing array " + name);
      return arrays[name];
    },
  };
  const meta = {
    n_nodes: nodes.length,
    n_arcs: sorted.length,
    n_edges: nEdges,
    scales: SCALES,
    classes: CLASSES,
    names: [],
  };
  return new engine.Graph(bundle, meta);
}

/* A diamond: 0 -> 3 directly over a hill (short, 20 m climb) or around it
 * through 1 or 2 (longer, flatter). */
const NODES = [
  { lon: -122.42, lat: 37.77, z: 10 },
  { lon: -122.419, lat: 37.771, z: 12 },
  { lon: -122.419, lat: 37.769, z: 15 },
  { lon: -122.418, lat: 37.77, z: 12 },
];
const ARCS = [
  { from: 0, to: 3, len: 200, gain: 20, maxup: 0.12 },
  { from: 0, to: 1, len: 150, gain: 2, maxup: 0.02 },
  { from: 1, to: 3, len: 150, gain: 0, maxup: 0 },
  { from: 0, to: 2, len: 120, gain: 5, maxup: 0.06 },
  { from: 2, to: 3, len: 120, gain: 3, maxup: 0.035 },
];

describe("engine.js on a synthetic graph", () => {
  const engine = loadEngine();
  const graph = synthetic(engine, NODES, ARCS);

  test("the shortest route takes the direct arc", () => {
    const r = graph.route(0, 3, { alpha: 0 });
    expect(r.arcs.map((a) => graph.head[a])).toEqual([3]);
  });

  test("a heavy climbing weight goes around the hill", () => {
    const r = graph.route(0, 3, { alpha: 100 });
    expect(graph.summarise(r.arcs).elev_gain_m).toBeCloseTo(2, 5);
  });

  test("the Pareto frontier holds every non-dominated route, shortest first", () => {
    const search = graph.pareto(0, 3, { eps: 0, epsNode: 0 });
    while (!search.step(1e9));
    const front = search.solutions.map((s) => [s.length, s.gain]).sort((a, b) => a[0] - b[0]);
    expect(front).toEqual([
      [200, 20],
      [240, 8],
      [300, 2],
    ]);
  });

  test("arcCost is length plus alpha times climbing", () => {
    const direct = graph.indptr[0] + [...graph.head.subarray(0, 3)].indexOf(3);
    expect(graph.arcCost(direct, 0)).toBeCloseTo(200, 5);
    expect(graph.arcCost(direct, 10)).toBeCloseTo(400, 5);
    expect(graph.pathCost([direct], { alpha: 10 })).toBeCloseTo(400, 5);
  });

  test("summarise reports the steepest arc_maxup on the route", () => {
    const middle = graph.route(0, 3, { alpha: 5 });
    const s = graph.summarise(middle.arcs);
    expect(s.distance_m).toBeCloseTo(240, 5);
    expect(s.steepest).toBeCloseTo(0.06, 5);
    expect(graph.summarise(graph.route(0, 3, { alpha: 0 }).arcs).steepest).toBeCloseTo(0.12, 5);
  });

  test("summarise of an empty route is all zeros", () => {
    const s = graph.summarise([]);
    expect(s.steepest).toBe(0);
    expect(s.distance_m).toBe(0);
    expect(s.profile).toEqual({ d: [], z: [] });
  });
});

/* A 3x3 grid of two-way streets, nodes numbered row by row:
 *   0 - 1 - 2
 *   |   |   |
 *   3 - 4 - 5
 *   |   |   |
 *   6 - 7 - 8
 * Every street touching node 1 is a service lane. */
describe("corners on a grid", () => {
  const engine = loadEngine();
  const nodes = Array.from({ length: 9 }, (_, i) => ({
    lon: -122.42 + (i % 3) * 0.001,
    lat: 37.77 - Math.floor(i / 3) * 0.001,
    z: 10,
  }));
  const streets = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
    [6, 7],
    [7, 8],
    [0, 3],
    [3, 6],
    [1, 4],
    [4, 7],
    [2, 5],
    [5, 8],
  ];
  const arcs = streets.flatMap(([u, v], edge) => {
    const cls = u === 1 || v === 1 ? 1 : 0;
    return [
      { from: u, to: v, len: 100, gain: 0, edge, cls },
      { from: v, to: u, len: 100, gain: 0, edge, cls, reversed: true },
    ];
  });
  const graph = synthetic(engine, nodes, arcs);

  test("three or more ways with at least one street make a corner", () => {
    expect([...graph.corners()]).toEqual([0, 0, 0, 1, 1, 1, 0, 1, 0]);
  });

  test("the result is cached", () => {
    expect(graph.corners()).toBe(graph.corners());
  });
});
