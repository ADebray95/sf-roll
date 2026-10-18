import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";

const SOURCE = readFileSync(new URL("engine.js", import.meta.url), "utf8");

/** engine.js is a classic browser script that publishes its classes on window. */
export function loadEngine() {
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
export function synthetic(engine, nodes, arcs) {
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

const SITE = new URL("../../site/", import.meta.url);

/** The committed site's packed graph, decoded as the page decodes it. */
export function loadSiteGraph(engine) {
  const html = readFileSync(new URL("index.html", SITE), "utf8");
  const start = html.indexOf("window.DATA = ") + "window.DATA = ".length;
  const data = JSON.parse(html.slice(start, html.indexOf(";</script>", start)));
  const name = readdirSync(new URL("data/", SITE)).find((f) => f.startsWith("graph-"));
  const buf = new Uint8Array(gunzipSync(readFileSync(new URL("data/" + name, SITE))));
  const bundle = new engine.Bundle(buf, data.manifest);
  return { graph: new engine.Graph(bundle, data.meta), data };
}
