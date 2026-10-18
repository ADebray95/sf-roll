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

const SCALES = { dm: 20, cm: 100, coord: 1e6, grade: 10000, stress: 100 };
const THRESHOLDS = [3, 5, 8, 10, 15];

/**
 * A packed graph from a list of directed arcs, as webgraph.py would pack it.
 *
 * @param {{lon: number, lat: number, z: number}[]} nodes
 * @param {{from: number, to: number, len: number, gain: number}[]} arcs  metres
 */
function synthetic(engine, nodes, arcs) {
  const sorted = arcs.map((a, i) => ({ ...a, edge: i })).sort((a, b) => a.from - b.from);
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
    arc_maxgrade: Int16Array.from(sorted, () => 0),
    arc_meangrade: u16(() => 0),
    arc_cls: Uint8Array.from(sorted, () => 0),
    arc_flags: Uint8Array.from(sorted, () => 1),
  };
  for (const t of THRESHOLDS) arrays["arc_th" + t] = u16(() => 0);
  const bundle = {
    has: (name) => name in arrays,
    array: (name) => arrays[name],
  };
  const meta = {
    n_nodes: nodes.length,
    n_edges: arcs.length,
    thresholds: THRESHOLDS,
    scales: SCALES,
    classes: ["residential"],
    multipliers: { walk: [1], bike: [1] },
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
  { from: 0, to: 3, len: 200, gain: 20 },
  { from: 0, to: 1, len: 150, gain: 2 },
  { from: 1, to: 3, len: 150, gain: 0 },
  { from: 0, to: 2, len: 120, gain: 5 },
  { from: 2, to: 3, len: 120, gain: 3 },
];

describe("engine.js on a synthetic graph", () => {
  const engine = loadEngine();
  const graph = synthetic(engine, NODES, ARCS);
  const weights = (alpha) => ({ alpha, beta: 0, gamma: 0, penalties: [0, 0, 0, 0, 0], extreme: 0 });

  test("the shortest route takes the direct arc", () => {
    const r = graph.route(0, 3, "walk", weights(0));
    expect(r.arcs.map((a) => graph.head[a])).toEqual([3]);
  });

  test("a heavy climbing weight goes around the hill", () => {
    const r = graph.route(0, 3, "walk", weights(100));
    expect(graph.summarise(r.arcs).elev_gain_m).toBeCloseTo(2, 5);
  });

  test("the Pareto frontier holds every non-dominated route, shortest first", () => {
    const search = graph.pareto(0, 3, "walk", { eps: 0, epsNode: 0 });
    while (!search.step(1e9));
    const front = search.solutions.map((s) => [s.length, s.gain]).sort((a, b) => a[0] - b[0]);
    expect(front).toEqual([
      [200, 20],
      [240, 8],
      [300, 2],
    ]);
  });
});
