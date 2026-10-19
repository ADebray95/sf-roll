/* Roll SF -- the routing engine.
 *
 * The whole routable graph is embedded (see sf_flat_routes/webgraph.py), so
 * routing happens in the browser: a Dijkstra over the directed arcs of one
 * travel mode, costed as length plus alpha times climbing. Used by the route
 * page (simple.js).
 */
"use strict";

/**
 * @typedef {Int8Array | Uint8Array | Int16Array | Uint16Array
 *   | Int32Array | Uint32Array | Float32Array | Float64Array} NumArray
 * @typedef {"i1" | "u1" | "i2" | "u2" | "i4" | "u4" | "f4" | "f8"} DTypeTag
 * @typedef {{
 *   new (buffer: ArrayBufferLike, byteOffset: number, length: number): NumArray,
 *   readonly BYTES_PER_ELEMENT: number,
 * }} NumArrayCtor
 * @typedef {{ t: DTypeTag, o: number, n: number }} ArrayEntry
 * @typedef {{ o: number, b: number }} StringEntry
 * @typedef {{ arrays: Record<string, ArrayEntry>, strings: Record<string, StringEntry> }} Manifest
 * @typedef {{ bundle?: string, bundle_url?: string, bundle_bytes?: number }} BundleSource
 *
 * @typedef {object} GraphMeta
 * @property {number} n_nodes
 * @property {number} n_arcs
 * @property {number} n_edges
 * @property {{ dm: number, cm: number, coord: number, grade: number }} scales
 * @property {string[]} classes
 * @property {string[]} names
 *
 * @typedef {object} Weights
 * @property {number} alpha metres of length one metre of climbing is worth
 *
 * @typedef {{ indptr: Int32Array, arcs: Int32Array, tail: Int32Array }} ReverseAdjacency
 * @typedef {{ arcs: number[], cost: number, settled: number }} RouteResult
 *
 * @typedef {object} Tree
 * @property {number} src
 * @property {Float64Array} dist
 * @property {Int32Array} prev
 * @property {Float64Array} len
 * @property {Float64Array} gain
 * @property {Uint8Array} done
 * @property {boolean} reverse
 *
 * @typedef {object} TreeOptions
 * @property {boolean} [reverse]
 * @property {number} [target]
 * @property {Uint8Array | null} [pen]
 * @property {Uint8Array | null} [penNode]
 * @property {number} [penK]
 * @property {number} [minPerM]
 * @property {Uint8Array} [mask] the arcs it may use (Graph.allowedArcs)
 *
 * @typedef {"petal" | "outback" | "triangle" | "polygon"} LoopKind
 * @typedef {{
 *   arcs: number[], length: number, gain: number, overlap: number, round: number,
 *   kind: LoopKind,
 * }} Loop
 *
 * @typedef {object} LoopOptions
 * @property {number} targetM
 * @property {number} [alpha]
 * @property {number} [sectors]
 * @property {number} [tol]
 * @property {number} [maxOverlap]
 * @property {number} [penK]
 * @property {number} [keep]
 * @property {number} [nearM]
 * @property {number} [perArc]
 * @property {number} [minRound]
 * @property {number} [tolM]
 * @property {number} [retries]
 * @property {boolean} [outBack]
 * @property {number} [cap] maximum uphill grade (fraction)
 *
 * @typedef {object} LoopSearch
 * @property {Loop[]} loops
 * @property {Loop[]} accepted
 * @property {Loop[]} loose
 * @property {Loop[]} all
 * @property {number} tried
 * @property {boolean} done
 * @property {number} ms
 * @property {boolean} shortfall
 * @property {Loop} [last]
 * @property {number} [medianGain]
 * @property {(budgetMs?: number) => boolean} step
 *
 * @typedef {object} ParetoOptions
 * @property {number} [eps]
 * @property {number} [epsNode]
 * @property {number} [dCap]
 * @property {number} [gCap]
 * @property {number} [maxLabels]
 * @property {number} [cap] maximum uphill grade (fraction)
 *
 * @typedef {{ arcs: number[], length: number, weighted: number, gain: number }} ParetoSolution
 *
 * @typedef {object} ParetoSearch
 * @property {ParetoSolution[]} solutions
 * @property {boolean} done
 * @property {number} expanded
 * @property {number} labels
 * @property {boolean} truncated
 * @property {(budgetMs?: number) => boolean} [step]
 *
 * @typedef {{ arcs: number[], length: number, gain: number }} TradeoffRoute
 * @typedef {object} Tradeoffs
 * @property {TradeoffRoute} shortest
 * @property {TradeoffRoute} flattest
 * @property {ParetoSearch} search
 * @property {() => TradeoffRoute[]} notches
 *
 * @typedef {object} RouteSummary
 * @property {number} distance_m
 * @property {number} elev_gain_m
 * @property {number} elev_loss_m
 * @property {number} steepest steepest uphill over 15 m, as a fraction
 * @property {number} n_edges
 * @property {number} start_elev_m
 * @property {number} end_elev_m
 * @property {{ d: number[], z: number[] }} profile
 *
 * @typedef {object} EdgeInfo
 * @property {string | null} name
 * @property {string | undefined} cls
 * @property {number} length_m
 */

/* The flattest end of the trade-off: a metre of climb is worth this many
 * metres of distance. Beyond about 200 the router goes miles to save a few
 * feet, which nobody would call a route. */
const FLAT_ALPHA = 200;
/* Pareto frontier points closer than this in climbing are merged, and the
 * same tolerance (smaller) applies at intermediate nodes. */
const PARETO_EPS_CM = 50;
const PARETO_EPS_NODE_CM = 10;

/* ------------------------------------------------------------------ decode */
/** @type {Record<DTypeTag, NumArrayCtor>} */
const TYPES = {
  i1: Int8Array,
  u1: Uint8Array,
  i2: Int16Array,
  u2: Uint16Array,
  i4: Int32Array,
  u4: Uint32Array,
  f4: Float32Array,
  f8: Float64Array,
};

/**
 * @param {string} str
 * @returns {Uint8Array<ArrayBuffer>}
 */
function base64ToBytes(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** The whole graph ships as one gzipped buffer. Inflating it in the browser
 * costs a few hundred milliseconds and saves about two thirds of the file
 * size, which matters a great deal more.
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function inflateBytes(bytes) {
  // a host that serves .gz with Content-Encoding: gzip hands us the plain
  // bytes already; the gzip magic number tells the two cases apart
  if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "this browser has no DecompressionStream; please use a " +
        "current version of Chrome, Firefox, Edge or Safari",
    );
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {string} b64str base64 of the (possibly gzipped) bundle
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function inflate(b64str) {
  return inflateBytes(base64ToBytes(b64str));
}

/** Fetch the packed graph as a separate file (the hosted site), reporting
 * progress, or inflate the inline copy (the single-file page).
 * @param {BundleSource} data
 * @param {(got: number, total: number) => void} [onProgress]
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function loadBundle(data, onProgress) {
  if (data.bundle) return inflate(data.bundle);
  // without an inline bundle the page always carries bundle_url
  const res = await fetch(/** @type {string} */ (data.bundle_url));
  if (!res.ok) throw new Error("could not load " + data.bundle_url + " (" + res.status + ")");
  // a missing header is null, which + turns into 0 just as it does ""
  const total =
    +(/** @type {string} */ (res.headers.get("Content-Length"))) || data.bundle_bytes || 0;
  // an ok response to a GET always has a body
  const reader = /** @type {ReadableStream<Uint8Array<ArrayBuffer>>} */ (res.body).getReader();
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(got, total);
  }
  const all = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return inflateBytes(all);
}

/* Views onto the inflated buffer -- no copying, no JSON number parsing. */
class Bundle {
  /**
   * @param {Uint8Array<ArrayBuffer>} buf the inflated bundle
   * @param {Manifest} manifest where each named array and string sits in buf
   */
  constructor(buf, manifest) {
    this.buf = buf;
    this.manifest = manifest;
    this.decoder = new TextDecoder();
  }
  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return !!this.manifest.arrays[name];
  }
  /**
   * @param {string} name
   * @returns {boolean} whether the bundle carries the string ``name``
   */
  hasText(name) {
    return !!this.manifest.strings[name];
  }

  /**
   * @param {string} name
   * @returns {NumArray}
   */
  array(name) {
    const m = this.manifest.arrays[name];
    if (!m) throw new Error("missing array " + name);
    const T = TYPES[m.t];
    // the offset need not be aligned for the view type, so copy when it is not
    if ((this.buf.byteOffset + m.o) % T.BYTES_PER_ELEMENT === 0) {
      return new T(this.buf.buffer, this.buf.byteOffset + m.o, m.n);
    }
    const bytes = this.buf.slice(m.o, m.o + m.n * T.BYTES_PER_ELEMENT);
    return new T(bytes.buffer, 0, m.n);
  }
  /**
   * @param {string} name
   * @returns {string}
   */
  text(name) {
    const m = this.manifest.strings[name];
    if (!m) throw new Error("missing string " + name);
    return this.decoder.decode(this.buf.subarray(m.o, m.o + m.b));
  }
}

/**
 * @param {string} s
 * @param {number} start
 * @param {number} end
 * @returns {number[]} flat [lon, lat, ...]
 */
function decodePolylineAt(s, start, end) {
  let i = start,
    lat = 0,
    lon = 0;
  const out = [];
  while (i < end) {
    let b,
      shift = 0,
      result = 0;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push(lon / 1e5, lat / 1e5);
  }
  return out;
}

/* A binary min-heap of (float key, int value) pairs on typed arrays. */
class MinHeap {
  /** @param {number} [cap] initial capacity; it doubles as needed */
  constructor(cap = 1 << 16) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  /**
   * @param {number} key
   * @param {number} val
   */
  push(key, val) {
    if (this.n === this.k.length) {
      const nk = new Float64Array(this.k.length * 2),
        nv = new Int32Array(this.v.length * 2);
      nk.set(this.k);
      nv.set(this.v);
      this.k = nk;
      this.v = nv;
    }
    const k = this.k,
      v = this.v;
    let i = this.n++;
    k[i] = key;
    v[i] = val;
    // indices below this.n are always in bounds, hence the casts
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (/** @type {number} */ (k[p]) <= /** @type {number} */ (k[i])) break;
      const tk = /** @type {number} */ (k[p]),
        tv = /** @type {number} */ (v[p]);
      k[p] = /** @type {number} */ (k[i]);
      v[p] = /** @type {number} */ (v[i]);
      k[i] = tk;
      v[i] = tv;
      i = p;
    }
  }
  /** removes the minimum; its key is left in this.topKey
   * @returns {number} the minimum's value
   */
  pop() {
    const k = this.k,
      v = this.v;
    const top = /** @type {number} */ (v[0]);
    /** @type {number} */
    this.topKey = /** @type {number} */ (k[0]);
    this.n--;
    if (this.n > 0) {
      k[0] = /** @type {number} */ (k[this.n]);
      v[0] = /** @type {number} */ (v[this.n]);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < this.n && /** @type {number} */ (k[l]) < /** @type {number} */ (k[m])) m = l;
        if (r < this.n && /** @type {number} */ (k[r]) < /** @type {number} */ (k[m])) m = r;
        if (m === i) break;
        const tk = /** @type {number} */ (k[m]),
          tv = /** @type {number} */ (v[m]);
        k[m] = /** @type {number} */ (k[i]);
        v[m] = /** @type {number} */ (v[i]);
        k[i] = tk;
        v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

/* -------------------------------------------------------------- the graph */
class Graph {
  /**
   * @param {Bundle} bundle
   * @param {GraphMeta} meta
   */
  constructor(bundle, meta) {
    this.meta = meta;
    this.n = meta.n_nodes;
    this.lon = bundle.array("node_lon");
    this.lat = bundle.array("node_lat");
    this.nodeFlags = bundle.array("node_flags");
    this.nodeElev = bundle.array("node_elev");
    this.indptr = bundle.array("indptr");
    this.head = bundle.array("arc_head");
    this.arcEdge = bundle.array("arc_edge");
    this.arcLen = bundle.array("arc_len");
    this.arcGain = bundle.array("arc_gain");
    this.arcLoss = bundle.array("arc_loss");
    this.arcMaxUp = bundle.array("arc_maxup");
    this.arcFlags = bundle.array("arc_flags");
    this.edgeCls = bundle.array("edge_cls");
    this.m = this.head.length;

    this.DM = meta.scales.dm;
    this.CM = meta.scales.cm;
    this.COORD = meta.scales.coord;
    this.GRADE = meta.scales.grade;

    // scratch arrays reused across searches, with a visit stamp so nothing
    // has to be cleared between runs
    this.dist = new Float64Array(this.n);
    this.prev = new Int32Array(this.n);
    this.seen = new Int32Array(this.n);
    this.done = new Uint8Array(this.n);
    this.stamp = 0;
    this.heapKey = new Float64Array(1 << 16);
    this.heapVal = new Int32Array(1 << 16);
  }

  /**
   * @param {number} i
   * @returns {number}
   */
  nodeLon(i) {
    return /** @type {number} */ (this.lon[i]) / this.COORD;
  }
  /**
   * @param {number} i
   * @returns {number}
   */
  nodeLat(i) {
    return /** @type {number} */ (this.lat[i]) / this.COORD;
  }
  /**
   * @param {number} i
   * @returns {number} elevation in metres
   */
  nodeZ(i) {
    return /** @type {number} */ (this.nodeElev[i]) / this.DM;
  }
  /** Cost of one arc in equivalent metres: its length plus alpha times its
   * climbing.
   * @param {number} a
   * @param {number} alpha
   * @returns {number}
   */
  arcCost(a, alpha) {
    const c =
      /** @type {number} */ (this.arcLen[a]) / this.DM +
      (alpha * /** @type {number} */ (this.arcGain[a])) / this.CM;
    return c > 1e-6 ? c : 1e-6;
  }

  /** Which arcs a search may use under an uphill cap: routable, and whose
   * steepest 15 m uphill (max_up_grade_15m) is at most ``cap``. Descending
   * is never limited, since an arc's value is measured in its own direction
   * of travel. One byte per arc, cached per cap value.
   * @param {number} [cap] the maximum uphill grade as a fraction; Infinity for none
   * @returns {Uint8Array}
   */
  allowedArcs(cap = Infinity) {
    const q = Number.isFinite(cap) ? Math.round(cap * this.GRADE) : Infinity;
    if (!this._masks) this._masks = new Map();
    const hit = this._masks.get(q);
    if (hit) return hit;
    const mask = new Uint8Array(this.m);
    for (let a = 0; a < this.m; a++) {
      mask[a] =
        (/** @type {number} */ (this.arcFlags[a]) & 1) !== 0 &&
        /** @type {number} */ (this.arcMaxUp[a]) <= q
          ? 1
          : 0;
    }
    this._masks.set(q, mask);
    return mask;
  }

  /** The smallest uphill cap under which dst can be reached from src: a
   * bottleneck (minimax) Dijkstra, where a path's key is the steepest
   * max_up_grade_15m along it. Returns the cap as a fraction, or null when
   * dst cannot be reached at any cap.
   * @param {number} src
   * @param {number} dst
   * @returns {number | null}
   */
  minimaxCap(src, dst) {
    if (src < 0 || dst < 0) return null;
    if (src === dst) return 0;
    const routable = this.allowedArcs(Infinity);
    const best = new Float64Array(this.n).fill(Infinity);
    const done = new Uint8Array(this.n);
    const heap = new MinHeap();
    best[src] = 0;
    heap.push(0, src);
    while (heap.n > 0) {
      const u = heap.pop(),
        bu = heap.topKey;
      if (done[u]) continue;
      done[u] = 1;
      if (u === dst) return bu / this.GRADE;
      for (
        let a = /** @type {number} */ (this.indptr[u]);
        a < /** @type {number} */ (this.indptr[u + 1]);
        a++
      ) {
        if (!routable[a]) continue;
        const v = /** @type {number} */ (this.head[a]);
        const b = Math.max(bu, /** @type {number} */ (this.arcMaxUp[a]));
        if (b < /** @type {number} */ (best[v])) {
          best[v] = b;
          heap.push(b, v);
        }
      }
    }
    return null;
  }

  /** The arcs of a route steeper uphill than ``cap``, steepest first.
   * @param {number[]} arcs
   * @param {number} cap a fraction
   * @returns {number[]}
   */
  blockingArcs(arcs, cap) {
    const q = Math.round(cap * this.GRADE);
    return arcs
      .filter((a) => /** @type {number} */ (this.arcMaxUp[a]) > q)
      .sort(
        (x, y) =>
          /** @type {number} */ (this.arcMaxUp[y]) - /** @type {number} */ (this.arcMaxUp[x]),
      );
  }

  /** max_up_grade_15m of one arc, as a fraction.
   * @param {number} a
   * @returns {number}
   */
  maxUp(a) {
    return /** @type {number} */ (this.arcMaxUp[a]) / this.GRADE;
  }

  /** Dijkstra with a flat binary heap, stopping once the target settles.
   * @param {number} src
   * @param {number} dst
   * @param {Weights} w
   * @param {number} [cap] maximum uphill grade (fraction); Infinity for none
   * @returns {RouteResult | null}
   */
  route(src, dst, w, cap = Infinity) {
    if (src === dst || src < 0 || dst < 0) return null;
    const alpha = w.alpha;
    const mask = this.allowedArcs(cap);
    const { dist, prev, seen, done, indptr, head } = this;
    const stamp = ++this.stamp;

    let hk = this.heapKey,
      hv = this.heapVal,
      hn = 0;
    /**
     * @param {number} key
     * @param {number} val
     */
    const push = (key, val) => {
      if (hn === hk.length) {
        const nk = new Float64Array(hk.length * 2),
          nv = new Int32Array(hv.length * 2);
        nk.set(hk);
        nv.set(hv);
        hk = this.heapKey = nk;
        hv = this.heapVal = nv;
      }
      let i = hn++;
      hk[i] = key;
      hv[i] = val;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (/** @type {number} */ (hk[p]) <= /** @type {number} */ (hk[i])) break;
        const tk = /** @type {number} */ (hk[p]),
          tv = /** @type {number} */ (hv[p]);
        hk[p] = /** @type {number} */ (hk[i]);
        hv[p] = /** @type {number} */ (hv[i]);
        hk[i] = tk;
        hv[i] = tv;
        i = p;
      }
    };
    /** @returns {[number, number]} the minimum's key and value */
    const pop = () => {
      const top = /** @type {number} */ (hv[0]),
        topk = /** @type {number} */ (hk[0]);
      hn--;
      if (hn > 0) {
        hk[0] = /** @type {number} */ (hk[hn]);
        hv[0] = /** @type {number} */ (hv[hn]);
        let i = 0;
        for (;;) {
          const l = 2 * i + 1,
            r = l + 1;
          let s = i;
          if (l < hn && /** @type {number} */ (hk[l]) < /** @type {number} */ (hk[s])) s = l;
          if (r < hn && /** @type {number} */ (hk[r]) < /** @type {number} */ (hk[s])) s = r;
          if (s === i) break;
          const tk = /** @type {number} */ (hk[s]),
            tv = /** @type {number} */ (hv[s]);
          hk[s] = /** @type {number} */ (hk[i]);
          hv[s] = /** @type {number} */ (hv[i]);
          hk[i] = tk;
          hv[i] = tv;
          i = s;
        }
      }
      return [topk, top];
    };

    seen[src] = stamp;
    dist[src] = 0;
    prev[src] = -1;
    done[src] = 0;
    push(0, src);
    let settled = 0;
    while (hn > 0) {
      const [dv, u] = pop();
      if (seen[u] !== stamp || done[u]) continue;
      done[u] = 1;
      settled++;
      if (u === dst) break;
      for (
        let a = /** @type {number} */ (indptr[u]);
        a < /** @type {number} */ (indptr[u + 1]);
        a++
      ) {
        if (!mask[a]) continue;
        const v = /** @type {number} */ (head[a]);
        if (seen[v] === stamp && done[v]) continue;
        const nd = dv + this.arcCost(a, alpha);
        if (seen[v] !== stamp || nd < /** @type {number} */ (dist[v])) {
          seen[v] = stamp;
          dist[v] = nd;
          prev[v] = a;
          done[v] = 0;
          push(nd, v);
        }
      }
    }
    if (seen[dst] !== stamp || !done[dst]) return null;

    // walk back: prev[] holds the arc used to reach each node
    const arcs = [];
    let v = dst,
      guard = 0;
    while (v !== src) {
      const a = /** @type {number} */ (prev[v]);
      if (a < 0 || guard++ > this.n) return null;
      arcs.push(a);
      v = this.arcTail(a);
    }
    arcs.reverse();
    return { arcs, cost: /** @type {number} */ (dist[dst]), settled };
  }

  /** One Dijkstra over a per-arc cost array: forward from src, or with
   * reverse, backward into src (dist[v] is then the cost of v -> src and
   * prev[v] the first arc of that path). It can stop at a target, and edges
   * marked in pen cost (1 + penK) times as much, which is how a loop's way
   * home is pushed off the streets it went out on. len and gain carry the
   * real length and climbing (m) of each tree path.
   * @param {number} src
   * @param {Float64Array} cost
   * @param {TreeOptions} [options]
   * @returns {Tree}
   */
  tree(
    src,
    cost,
    {
      reverse = false,
      target = -1,
      pen = null,
      penNode = null,
      penK = 0,
      minPerM = 0,
      mask = this.allowedArcs(Infinity),
    } = {},
  ) {
    const n = this.n,
      rev = reverse ? this.reverse() : null;
    const dist = new Float64Array(n).fill(Infinity),
      prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n),
      len = new Float64Array(n),
      gain = new Float64Array(n);
    const heap = new MinHeap();
    // with a target and a known floor on cost per metre (minPerM), the
    // search is A*: straight-line distance to the target times that floor
    // never overestimates, so the route found is still the cheapest
    const astar = target >= 0 && minPerM > 0;
    const cosT = Math.cos((this.nodeLat(src) * Math.PI) / 180);
    const tx = astar ? this.nodeLon(target) * 111320 * cosT : 0,
      ty = astar ? this.nodeLat(target) * 110540 : 0;
    /** @type {(v: number) => number} */
    const h = astar
      ? (v) =>
          minPerM * Math.hypot(this.nodeLon(v) * 111320 * cosT - tx, this.nodeLat(v) * 110540 - ty)
      : () => 0;
    dist[src] = 0;
    heap.push(h(src), src);
    while (heap.n > 0) {
      const u = heap.pop();
      if (done[u]) continue;
      const du = /** @type {number} */ (dist[u]);
      done[u] = 1;
      if (u === target) break;
      // rev is set whenever reverse is
      const lo = reverse
          ? /** @type {number} */ (/** @type {ReverseAdjacency} */ (rev).indptr[u])
          : /** @type {number} */ (this.indptr[u]),
        hi = reverse
          ? /** @type {number} */ (/** @type {ReverseAdjacency} */ (rev).indptr[u + 1])
          : /** @type {number} */ (this.indptr[u + 1]);
      for (let k = lo; k < hi; k++) {
        const a = reverse
          ? /** @type {number} */ (/** @type {ReverseAdjacency} */ (rev).arcs[k])
          : k;
        if (!mask[a]) continue;
        const v = reverse
          ? /** @type {number} */ (/** @type {ReverseAdjacency} */ (rev).tail[a])
          : /** @type {number} */ (this.head[a]);
        let c = /** @type {number} */ (cost[a]);
        if (
          (pen !== null && pen[/** @type {number} */ (this.arcEdge[a])]) ||
          (penNode !== null && penNode[v])
        )
          c *= 1 + penK;
        const nd = du + c;
        if (nd < /** @type {number} */ (dist[v])) {
          dist[v] = nd;
          prev[v] = a;
          heap.push(nd + h(v), v);
          len[v] =
            /** @type {number} */ (len[u]) + /** @type {number} */ (this.arcLen[a]) / this.DM;
          gain[v] =
            /** @type {number} */ (gain[u]) + /** @type {number} */ (this.arcGain[a]) / this.CM;
        }
      }
    }
    return { src, dist, prev, len, gain, done, reverse };
  }

  /** Corners a loop may turn at: real intersections, where at least three
   * ways meet and at least one is a street (not only footways, service
   * lanes or steps), so a loop never turns around at the end of a
   * parking-lot lane. Built on first use.
   * @returns {Uint8Array}
   */
  corners() {
    if (this._corners) return this._corners;
    const STREETS = new Set([
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "residential",
      "unclassified",
      "living_street",
      "pedestrian",
      "cycleway",
      "path",
    ]);
    const street = this.meta.classes.map((c) => STREETS.has(c));
    const { indptr, arcs, tail } = this.reverse();
    const ok = new Uint8Array(this.n),
      seen = new Int32Array(this.n).fill(-1);
    for (let u = 0; u < this.n; u++) {
      let deg = 0,
        onStreet = false;
      /**
       * @param {number} v
       * @param {number} a
       */
      const touch = (v, a) => {
        if ((/** @type {number} */ (this.arcFlags[a]) & 1) === 0) return;
        if (street[/** @type {number} */ (this.edgeCls[/** @type {number} */ (this.arcEdge[a])])])
          onStreet = true;
        if (seen[v] !== u) {
          seen[v] = u;
          deg++;
        }
      };
      for (
        let a = /** @type {number} */ (this.indptr[u]);
        a < /** @type {number} */ (this.indptr[u + 1]);
        a++
      )
        touch(/** @type {number} */ (this.head[a]), a);
      for (
        let k = /** @type {number} */ (indptr[u]);
        k < /** @type {number} */ (indptr[u + 1]);
        k++
      )
        touch(
          /** @type {number} */ (tail[/** @type {number} */ (arcs[k])]),
          /** @type {number} */ (arcs[k]),
        );
      ok[u] = deg >= 3 && onStreet ? 1 : 0;
    }
    this._corners = ok;
    return ok;
  }

  /** arcs from the tree's root to v (forward tree) or from v to the root
   * (reverse tree)
   * @param {Tree} t
   * @param {number} v
   * @returns {number[] | null}
   */
  treePath(t, v) {
    const tail = this.reverse().tail,
      arcs = /** @type {number[]} */ ([]);
    if (!t.done[v]) return null;
    if (!t.reverse) {
      for (let guard = 0; v !== t.src; guard++) {
        const a = /** @type {number} */ (t.prev[v]);
        if (a < 0 || guard > this.n) return null;
        arcs.push(a);
        v = /** @type {number} */ (tail[a]);
      }
      return arcs.reverse();
    }
    for (let guard = 0; v !== t.src; guard++) {
      const a = /** @type {number} */ (t.prev[v]);
      if (a < 0 || guard > this.n) return null;
      arcs.push(a);
      v = /** @type {number} */ (this.head[a]);
    }
    return arcs;
  }

  /** Flat loops: routes that start and end at src and run about targetM
   * metres, as flat as the streets around src allow.
   *
   * A loop is built from turnaround corners. One search outward and one
   * inward from src give every corner's flattest way out and way back.
   * The corners around src are split into sectors by bearing; in each,
   * the corner that looks cheapest to reach and return from is tried as a
   * petal (out to it, home by a different way: the streets used on the way
   * out cost penK times more on the way back), pairs of corners about a
   * sixth of a turn apart as triangles (out, across, home), and for loops
   * over five miles, three corners a quarter turn apart.
   * A loop whose length misses the target by more than a tolerance is
   * retried once with a corner scaled nearer or farther. Loops that
   * repeat too much of themselves (an out-and-back) are dropped; the rest
   * are ranked by climbing, length breaking ties.
   *
   * Like pareto(), it returns a search object; step(budgetMs) until done.
   * search.last is the most recent well-shaped loop built, so the page can
   * show the scan as it happens.
   * Results: search.loops (best first, mutually distinct) and
   * search.accepted (every loop that met the length and overlap tests).
   * @param {number} src
   * @param {LoopOptions} options
   * @returns {LoopSearch}
   */
  loops(
    src,
    {
      targetM,
      alpha = 30,
      sectors = 24,
      tol = 0.15,
      maxOverlap = 0.3,
      penK = 3,
      keep = 3,
      nearM = 110,
      perArc = 8,
      minRound = 0.2,
      tolM = Infinity,
      retries = 3,
      outBack = false,
      cap = Infinity,
    } = /** @type {LoopOptions} */ ({}),
  ) {
    const g = this,
      T = targetM,
      mask = g.allowedArcs(cap);
    // a few metres per arc keeps routes off zigzags through tiny segments
    const cost = new Float64Array(g.m);
    for (let a = 0; a < g.m; a++)
      cost[a] =
        /** @type {number} */ (g.arcLen[a]) / g.DM +
        (alpha * /** @type {number} */ (g.arcGain[a])) / g.CM +
        perArc;
    // step is attached below, before the search is handed out
    const search = /** @type {LoopSearch} */ ({
      loops: /** @type {Loop[]} */ ([]),
      accepted: /** @type {Loop[]} */ ([]),
      loose: /** @type {Loop[]} */ ([]),
      all: /** @type {Loop[]} */ ([]),
      tried: 0,
      done: false,
      ms: 0,
      shortfall: false,
    });
    // a loop counts when it is within tolM of the target (or tol of it, if
    // that is tighter, for short loops); corners are rescaled up to
    // `retries` times to land in that window
    const t0 = performance.now();
    const band = Math.min(tol * T, tolM);
    // F, B, bySector and nodeGrid are built by the first step(), before any
    // job that reads them runs
    let F = /** @type {Tree | null} */ (null),
      B = /** @type {Tree | null} */ (null),
      bySector = /** @type {number[][] | null} */ (null);
    /** @type {(() => void)[]} */
    const jobs = [];
    const cosLat = Math.cos((g.nodeLat(src) * Math.PI) / 180);
    /** @param {number} v */
    const sectorOf = (v) => {
      const dx = (g.nodeLon(v) - g.nodeLon(src)) * cosLat,
        dy = g.nodeLat(v) - g.nodeLat(src);
      return Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * sectors) % sectors;
    };
    // the corner in a sector whose way out is about `want` metres and whose
    // estimated loop (flattest out + flattest back) climbs least
    /**
     * @param {number} s
     * @param {number} want
     * @param {number} spread
     * @param {boolean} withBack
     * @returns {number} the corner, or -1
     */
    const pick = (s, want, spread, withBack) => {
      let best = -1,
        bestScore = Infinity;
      for (const v of /** @type {number[]} */ (/** @type {number[][]} */ (bySector)[s])) {
        const lf = /** @type {number} */ (/** @type {Tree} */ (F).len[v]);
        if (Math.abs(lf - want) > spread) continue;
        const score =
          /** @type {number} */ (/** @type {Tree} */ (F).gain[v]) +
          (withBack ? /** @type {number} */ (/** @type {Tree} */ (B).gain[v]) : 0) +
          0.002 * Math.abs(lf - want);

        if (score < bestScore) {
          bestScore = score;
          best = v;
        }
      }
      return best;
    };
    // cost per metre is never below 1 (climbing only adds to it), less a
    // little for the quantised lengths: the floor that keeps A* exact
    const minPerM = 0.98;
    /**
     * @param {number} from
     * @param {number} to
     * @param {Uint8Array} pen
     * @param {Uint8Array} penNode
     * @returns {number[] | null}
     */
    const leg = (from, to, pen, penNode) => {
      const t = g.tree(from, cost, { target: to, pen, penNode, penK, minPerM, mask });
      return t.done[to] ? g.treePath(t, to) : null;
    };
    /**
     * @param {Uint8Array} pen
     * @param {number[]} arcs
     */
    const mark = (pen, arcs) => {
      for (const a of arcs) pen[/** @type {number} */ (g.arcEdge[a])] = 1;
    };
    // corners within nearM of the streets already used, except around the
    // start, which every leg has to pass through: the way home avoids them,
    // so a loop is not the same street out and the next street back
    const XM = 111320 * Math.cos((g.nodeLat(src) * Math.PI) / 180),
      YM = 110540;
    const px = (/** @type {number} */ v) => g.nodeLon(v) * XM,
      py = (/** @type {number} */ v) => g.nodeLat(v) * YM;
    const sx = px(src),
      sy = py(src);
    // cell -> nodes, over every corner the loops can reach
    let nodeGrid = /** @type {Map<number, number[]> | null} */ (null);
    /**
     * @param {number} cx
     * @param {number} cy
     */
    const cellKey = (cx, cy) => cx * 100003 + cy;
    /**
     * @param {Uint8Array} penNode
     * @param {number[]} arcs
     */
    const markNear = (penNode, arcs) => {
      const r2 = nearM * nearM,
        home2 = (1.5 * nearM) ** 2;
      for (const a of arcs) {
        const v0 = /** @type {number} */ (g.head[a]),
          x0 = px(v0),
          y0 = py(v0);
        const cx = Math.floor(x0 / nearM),
          cy = Math.floor(y0 / nearM);
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) {
            const cell = /** @type {Map<number, number[]>} */ (nodeGrid).get(
              cellKey(cx + i, cy + j),
            );
            if (!cell) continue;
            for (const v of cell) {
              if (penNode[v]) continue;
              const x = px(v),
                y = py(v);
              if ((x - x0) ** 2 + (y - y0) ** 2 < r2 && (x - sx) ** 2 + (y - sy) ** 2 >= home2)
                penNode[v] = 1;
            }
          }
      }
    };
    /** @param {number[]} arcs */
    const measure = (arcs) => {
      let len = 0,
        gain = 0,
        rep = 0;
      const seen = new Map();
      for (const a of arcs) {
        const l = /** @type {number} */ (g.arcLen[a]) / g.DM,
          e = g.arcEdge[a];
        len += l;
        gain += /** @type {number} */ (g.arcGain[a]) / g.CM;
        if (seen.has(e)) rep += l;
        else seen.set(e, 1);
      }
      let area = 0,
        prevX = sx,
        prevY = sy;
      for (const a of arcs) {
        const x = px(/** @type {number} */ (g.head[a])) - sx,
          y = py(/** @type {number} */ (g.head[a])) - sy;
        area += (prevX - sx) * y - x * (prevY - sy);
        prevX = x + sx;
        prevY = y + sy;
      }
      const round = len > 0 ? (4 * Math.PI * Math.abs(area / 2)) / (len * len) : 0;
      return { len, gain, overlap: len > 0 ? rep / len : 1, round };
    };
    /**
     * @param {number[] | null} arcs
     * @param {LoopKind} kind
     * @returns {Loop | null}
     */
    const consider = (arcs, kind) => {
      if (!arcs || !arcs.length) return null;
      search.tried++;
      const m = measure(arcs);
      const r = { arcs, length: m.len, gain: m.gain, overlap: m.overlap, round: m.round, kind };
      // an out-and-back is allowed to be what it is
      const shaped = kind === "outback" || (m.overlap <= maxOverlap && m.round >= minRound);
      if (shaped) {
        search.all.push(r);
        search.last = r;
      }
      if (shaped && Math.abs(m.len - T) <= band) search.accepted.push(r);
      else if (shaped && Math.abs(m.len - T) <= tol * T) search.loose.push(r);
      return r;
    };
    /**
     * @param {number} s
     * @param {number} want
     * @param {number} tries
     */
    const petal = (s, want, tries) => {
      const w = pick(s, want, Math.max(150, 0.06 * T), true);
      if (w < 0) return;
      const out = g.treePath(/** @type {Tree} */ (F), w);
      if (!out) return;
      const pen = new Uint8Array(g.meta.n_edges),
        penNode = new Uint8Array(g.n);
      mark(pen, out);
      markNear(penNode, out);
      const back = leg(w, src, pen, penNode);
      if (!back) return;
      const r = consider(out.concat(back), "petal");
      if (r && tries > 0 && Math.abs(r.length - T) > band) {
        jobs.push(() => petal(s, (want * T) / r.length, tries - 1));
      }
    };
    // the flattest way out to a turnaround about half the target away, and
    // the flattest way back, which is usually the same streets
    /**
     * @param {number} s
     * @param {number} want
     * @param {number} tries
     */
    const outAndBack = (s, want, tries) => {
      const w = pick(s, want, Math.max(150, 0.06 * T), true);
      if (w < 0) return;
      const out = g.treePath(/** @type {Tree} */ (F), w),
        back = g.treePath(/** @type {Tree} */ (B), w);
      if (!out || !back) return;
      const r = consider(out.concat(back), "outback");
      if (r && tries > 0 && Math.abs(r.length - T) > band) {
        jobs.push(() => outAndBack(s, (want * T) / r.length, tries - 1));
      }
    };
    // out to the first corner, across each next one, then home; every leg
    // avoids the streets the loop has already used
    /**
     * @param {number[]} ss
     * @param {number} want
     * @param {number} tries
     */
    const polygon = (ss, want, tries) => {
      const sp = Math.max(150, 0.06 * T);
      const vs = ss.map((s, i) => pick(s, want, sp, i === ss.length - 1));
      if (vs.some((v) => v < 0) || new Set(vs).size < vs.length) return;
      const pen = new Uint8Array(g.meta.n_edges),
        penNode = new Uint8Array(g.n);
      let arcs = g.treePath(/** @type {Tree} */ (F), /** @type {number} */ (vs[0]));
      if (!arcs) return;
      mark(pen, arcs);
      markNear(penNode, arcs);
      for (const [from, to] of vs
        .slice(1)
        .map((v, i) => [/** @type {number} */ (vs[i]), v])
        .concat([[/** @type {number} */ (vs[vs.length - 1]), src]])) {
        const l = leg(/** @type {number} */ (from), /** @type {number} */ (to), pen, penNode);
        if (!l) return;
        mark(pen, l);
        markNear(penNode, l);
        arcs = arcs.concat(l);
      }
      const r = consider(arcs, vs.length === 2 ? "triangle" : "polygon");
      if (r && tries > 0 && Math.abs(r.length - T) > band) {
        jobs.push(() => polygon(ss, (want * T) / r.length, tries - 1));
      }
    };
    search.step = (budgetMs = 30) => {
      const start = performance.now();
      if (!F) {
        F = g.tree(src, cost, { mask });
        B = g.tree(src, cost, { reverse: true, mask });
        bySector = Array.from({ length: sectors }, () => /** @type {number[]} */ ([]));
        const corner = g.corners();
        nodeGrid = new Map();
        for (let v = 0; v < g.n; v++) {
          if (!F.done[v] || /** @type {number} */ (F.len[v]) > 0.75 * T) continue;
          const k = cellKey(Math.floor(px(v) / nearM), Math.floor(py(v) / nearM));
          let c = nodeGrid.get(k);
          if (!c) nodeGrid.set(k, (c = []));
          c.push(v);
        }
        for (let v = 0; v < g.n; v++) {
          if (!F.done[v] || !B.done[v] || v === src || !corner[v]) continue;
          const lf = /** @type {number} */ (F.len[v]);
          if (lf < 0.1 * T || lf > 0.7 * T) continue;
          /** @type {number[]} */ (bySector[sectorOf(v)]).push(v);
        }
        for (let s = 0; s < sectors; s++) {
          if (outBack) jobs.push(() => outAndBack(s, 0.5 * T, retries));
          jobs.push(() => petal(s, 0.38 * T, retries));
          jobs.push(() => petal(s, 0.46 * T, retries));
        }
        for (const gap of [Math.round(sectors / 6), Math.round(sectors / 4)]) {
          for (let s = 0; s < sectors; s++)
            jobs.push(() =>
              polygon([s, (s + gap) % sectors], (gap > sectors / 5 ? 0.27 : 0.3) * T, retries),
            );
        }
        // longer loops: three corners a quarter turn apart, which keeps the
        // loop inside the city where two far corners would fall in the bay
        if (T > 8000) {
          const q = Math.max(1, Math.round(sectors / 4));
          for (let s = 0; s < sectors; s++)
            jobs.push(() =>
              polygon([s, (s + q) % sectors, (s + 2 * q) % sectors], 0.21 * T, retries),
            );
        }
        if (performance.now() - start > budgetMs) return false;
      }
      while (jobs.length) {
        /** @type {() => void} */ (jobs.shift())();
        if (performance.now() - start > budgetMs) return false;
      }
      // rank, then keep loops that are not near-copies of a better one. When
      // nothing came close enough to the target (a long loop from the edge
      // of the city), offer the loop that came closest, and say so.
      /** @type {Loop[]} */
      let pool = search.accepted.slice();
      if (!pool.length && search.loose.length) {
        pool = search.loose.slice();
        search.shortfall = true;
      }
      if (!pool.length && search.all.length) {
        const closest = /** @type {Loop} */ (
          search.all.slice().sort((x, y) => Math.abs(x.length - T) - Math.abs(y.length - T))[0]
        );
        pool = [closest];
        search.shortfall = true;
      }
      pool.sort((x, y) => x.gain - y.gain || Math.abs(x.length - T) - Math.abs(y.length - T));
      /** @param {Loop} r */
      const edges = (r) => new Set(r.arcs.map((a) => /** @type {number} */ (g.arcEdge[a])));
      /** @type {{ r: Loop, edges: Set<number> }[]} */
      const picked = [];

      for (const r of pool) {
        const er = edges(r);
        const similar = picked.some((p) => {
          let both = 0;
          for (const e of er) if (p.edges.has(e)) both++;
          return both / Math.min(er.size, p.edges.size) > 0.6;
        });
        if (!similar) picked.push({ r, edges: er });
        if (picked.length >= keep) break;
      }
      search.loops = picked.map((p) => p.r);
      const gains = search.accepted.map((r) => r.gain).sort((x, y) => x - y);
      search.medianGain = gains.length
        ? /** @type {number} */ (gains[Math.floor(gains.length / 2)])
        : NaN;
      search.ms = performance.now() - t0;
      search.done = true;
      return true;
    };
    return search;
  }

  /** Reverse adjacency (arcs grouped by head node), built on first use.
   * @returns {ReverseAdjacency}
   */
  reverse() {
    if (this._rev) return this._rev;
    const n = this.n,
      m = this.m;
    const indptr = new Int32Array(n + 1);
    for (let a = 0; a < m; a++)
      /** @type {number} */ (indptr[/** @type {number} */ (this.head[a]) + 1])++;
    for (let i = 0; i < n; i++)
      /** @type {number} */ (indptr[i + 1]) += /** @type {number} */ (indptr[i]);
    const arcs = new Int32Array(m),
      tail = new Int32Array(m),
      fill = indptr.slice(0, n);
    for (let u = 0; u < n; u++) {
      for (
        let a = /** @type {number} */ (this.indptr[u]);
        a < /** @type {number} */ (this.indptr[u + 1]);
        a++
      ) {
        tail[a] = u;
        arcs[/** @type {number} */ (fill[/** @type {number} */ (this.head[a])])++] = a;
      }
    }
    this._rev = { indptr, arcs, tail };
    return this._rev;
  }

  /** Exact lower bound from every node to dst on one per-arc weight (a
   * reverse Dijkstra), in that weight's own integer units.
   * @param {number} dst
   * @param {NumArray} weight
   * @param {Uint8Array} [mask] the arcs it may use (allowedArcs)
   * @returns {Float64Array}
   */
  boundsTo(dst, weight, mask = this.allowedArcs(Infinity)) {
    const { indptr, arcs, tail } = this.reverse();
    const dist = new Float64Array(this.n).fill(Infinity);
    const done = new Uint8Array(this.n);
    const heap = new MinHeap();
    dist[dst] = 0;
    heap.push(0, dst);
    while (heap.n > 0) {
      const u = heap.pop(),
        du = heap.topKey;
      if (done[u] || du > /** @type {number} */ (dist[u])) continue;
      done[u] = 1;
      for (
        let k = /** @type {number} */ (indptr[u]);
        k < /** @type {number} */ (indptr[u + 1]);
        k++
      ) {
        const a = /** @type {number} */ (arcs[k]);
        if (!mask[a]) continue;
        const v = /** @type {number} */ (tail[a]),
          nd = du + /** @type {number} */ (weight[a]);
        if (nd < /** @type {number} */ (dist[v])) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    return dist;
  }

  /** The whole distance-versus-climbing frontier between two nodes: every
   * route that no other route beats on both counts, not only the ones a
   * weighted sum can reach. This is BOA* (Hernandez et al., bi-objective
   * A* with lazy dominance checks): labels (node, length, gain) expand in
   * order of (length + bound, gain + bound), and a label is dropped when it
   * reaches a node with no less climbing than a label that got there first,
   * which, because of the expansion order, was also no longer. The check is
   * one comparison per label, which is what makes the search affordable in
   * a browser.
   *
   * ``eps`` (cm of gain) merges frontier points that differ by less than
   * that in climbing, which keeps the frontier to a readable size, and
   * ``epsNode`` applies the same tolerance at intermediate nodes, where it
   * trades a little exactness (the tolerance can accumulate along a path)
   * for a much smaller search; ``dCap``
   * (5 cm units) and ``gCap`` (cm) bound the search to routes no longer
   * than the flattest route worth showing and no hillier than the shortest.
   * ``maxLabels`` is a safety valve: the search then stops with the short
   * end of the frontier, which it finds first.
   *
   * Returns a search object; call step(budgetMs) until it reports done, so
   * the page can keep painting.
   * @param {number} src
   * @param {number} dst
   * @param {ParetoOptions} [options]
   * @returns {ParetoSearch}
   */
  pareto(
    src,
    dst,
    {
      eps = 50,
      epsNode = eps,
      dCap = Infinity,
      gCap = Infinity,
      maxLabels = 4e6,
      cap: gradeCap = Infinity,
    } = {},
  ) {
    const g = this;
    const len = g.arcLen;
    const mask = g.allowedArcs(gradeCap);
    const h1 = g.boundsTo(dst, len, mask),
      h2 = g.boundsTo(dst, g.arcGain, mask);
    const g2min = new Float64Array(g.n).fill(Infinity);
    let cap = 1 << 16;
    let lNode = new Int32Array(cap),
      lG1 = new Int32Array(cap),
      lG2 = new Int32Array(cap),
      lParent = new Int32Array(cap),
      lArc = new Int32Array(cap);
    let nl = 0;
    const grow = () => {
      cap *= 2;
      /**
       * @param {Int32Array<ArrayBuffer>} old
       * @param {Int32ArrayConstructor} T
       */
      const r = (old, T) => {
        const a = new T(cap);
        a.set(old);
        return a;
      };
      lNode = r(lNode, Int32Array);
      lG1 = r(lG1, Int32Array);
      lG2 = r(lG2, Int32Array);
      lParent = r(lParent, Int32Array);
      lArc = r(lArc, Int32Array);
    };
    const K = 1 << 20; // f1 in the high bits, f2 in the low: expansion order (f1, f2)
    const heap = new MinHeap();
    /**
     * @param {number} node
     * @param {number} g1
     * @param {number} g2
     * @param {number} parent
     * @param {number} arc
     */
    const add = (node, g1, g2, parent, arc) => {
      if (nl === cap) grow();
      lNode[nl] = node;
      lG1[nl] = g1;
      lG2[nl] = g2;
      lParent[nl] = parent;
      lArc[nl] = arc;
      heap.push(
        (g1 + /** @type {number} */ (h1[node])) * K +
          Math.min(g2 + /** @type {number} */ (h2[node]), K - 1),
        nl,
      );
      nl++;
    };
    /** @type {ParetoSearch} */
    const search = { solutions: [], done: false, expanded: 0, labels: 0, truncated: false };
    if (src === dst || !Number.isFinite(/** @type {number} */ (h1[src]))) {
      search.done = true;
      search.step = () => true;
      return search;
    }
    add(src, 0, 0, -1, -1);

    search.step = (budgetMs = 30) => {
      const t0 = performance.now();
      let n = 0;
      while (heap.n > 0) {
        if ((++n & 1023) === 0 && performance.now() - t0 > budgetMs) return false;
        const x = heap.pop();
        const node = /** @type {number} */ (lNode[x]),
          g1 = /** @type {number} */ (lG1[x]),
          g2 = /** @type {number} */ (lG2[x]);
        if (
          g2 + (node === dst ? eps : epsNode) > /** @type {number} */ (g2min[node]) ||
          g2 + /** @type {number} */ (h2[node]) + eps > /** @type {number} */ (g2min[dst])
        )
          continue;
        g2min[node] = g2;
        search.expanded++;
        if (node === dst) {
          const arcs = [];
          for (
            let y = x;
            /** @type {number} */ (lParent[y]) >= 0;
            y = /** @type {number} */ (lParent[y])
          )
            arcs.push(/** @type {number} */ (lArc[y]));
          arcs.reverse();
          let real = 0;
          for (const a of arcs) real += /** @type {number} */ (g.arcLen[a]);
          search.solutions.push({
            arcs,
            length: real / g.DM,
            weighted: g1 / g.DM,
            gain: g2 / g.CM,
          });
          continue;
        }
        for (
          let a = /** @type {number} */ (g.indptr[node]);
          a < /** @type {number} */ (g.indptr[node + 1]);
          a++
        ) {
          if (!mask[a]) continue;
          const v = /** @type {number} */ (g.head[a]),
            n1 = g1 + /** @type {number} */ (len[a]),
            n2 = g2 + /** @type {number} */ (g.arcGain[a]);
          if (
            n1 + /** @type {number} */ (h1[v]) > dCap ||
            n2 + /** @type {number} */ (h2[v]) > gCap
          )
            continue;
          if (
            n2 + epsNode > /** @type {number} */ (g2min[v]) ||
            n2 + /** @type {number} */ (h2[v]) + eps > /** @type {number} */ (g2min[dst])
          )
            continue;
          add(v, n1, n2, x, a);
        }
        if (nl > maxLabels) {
          search.truncated = true;
          break;
        }
      }
      search.labels = nl;
      search.done = true;
      return true;
    };
    return search;
  }

  /** The trade-off slider's routes between two nodes under an uphill cap
   * (spec 6.2). ``shortest`` and ``flattest`` are found at once (plain
   * Dijkstra, and a heavy climbing weight); ``search`` is the Pareto search
   * between them, to be stepped until done; ``notches()`` then thins the
   * frontier it found (with the flattest route closing it, in case the
   * search's tolerances left it out) and returns them shortest first.
   * Returns null when dst cannot be reached under the cap.
   * @param {number} src
   * @param {number} dst
   * @param {number} [cap] maximum uphill grade (fraction)
   * @returns {Tradeoffs | null}
   */
  tradeoff(src, dst, cap = Infinity) {
    const shortest = this.route(src, dst, { alpha: 0 }, cap);
    if (!shortest) return null;
    const flat = this.route(src, dst, { alpha: FLAT_ALPHA }, cap) || shortest;
    const sum = (/** @type {number[]} */ arcs) => this.summarise(arcs);
    const s0 = sum(shortest.arcs),
      sf = sum(flat.arcs);
    const search = this.pareto(src, dst, {
      cap,
      eps: PARETO_EPS_CM,
      epsNode: PARETO_EPS_NODE_CM,
      dCap: Math.round(sf.distance_m * this.DM) + 1,
      gCap: Math.round(s0.elev_gain_m * this.CM) + 1,
    });
    const asRoute = (/** @type {number[]} */ arcs) => {
      const st = sum(arcs);
      return { arcs, length: st.distance_m, gain: st.elev_gain_m };
    };
    const first = asRoute(shortest.arcs),
      last = asRoute(flat.arcs);
    return {
      shortest: first,
      flattest: last,
      search,
      notches: () => {
        // the search already knows each solution's length and climb
        const found = search.solutions.map((x) => ({
          arcs: x.arcs,
          length: x.length,
          gain: x.gain,
        }));
        if (!found.length) found.push(first);
        if (!found.some((r) => r.gain <= last.gain + 1e-9)) found.push(last);
        return thinFrontier(found);
      },
    };
  }

  /** Arc index for an (edge id, reversed) pair. Built on first use; the map
   * itself does not need it, but it makes the router addressable from tests
   * and from the console.
   * @param {number} edgeId
   * @param {boolean} reversed
   * @returns {number} the arc, or -1
   */
  arcOf(edgeId, reversed) {
    if (!this._arcLookup) {
      this._arcLookup = new Map();
      for (let a = 0; a < this.m; a++) {
        this._arcLookup.set(
          /** @type {number} */ (this.arcEdge[a]) * 2 +
            (/** @type {number} */ (this.arcFlags[a]) & 4 ? 1 : 0),
          a,
        );
      }
    }
    const a = this._arcLookup.get(edgeId * 2 + (reversed ? 1 : 0));
    return a === undefined ? -1 : a;
  }

  /** Total cost of an explicit arc sequence, for comparison against other
   * implementations of the same cost model.
   * @param {number[]} arcs
   * @param {Weights} w
   * @returns {number}
   */
  pathCost(arcs, w) {
    let c = 0;
    for (const a of arcs) c += this.arcCost(a, w.alpha);
    return c;
  }

  /** tail node of an arc, by binary search over the CSR row pointers
   * @param {number} a
   * @returns {number}
   */
  arcTail(a) {
    const p = this.indptr;
    let lo = 0,
      hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (/** @type {number} */ (p[mid + 1]) <= a) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Totals for a route: length, climbing and descent, and the steepest
   * uphill stretch (over 15 m, in the direction of travel) it contains.
   * @param {number[]} arcs
   * @returns {RouteSummary}
   */
  summarise(arcs) {
    let dist = 0,
      gain = 0,
      loss = 0,
      steep = 0;
    for (const a of arcs) {
      dist += /** @type {number} */ (this.arcLen[a]) / this.DM;
      gain += /** @type {number} */ (this.arcGain[a]) / this.CM;
      loss += /** @type {number} */ (this.arcLoss[a]) / this.CM;
      const up = /** @type {number} */ (this.arcMaxUp[a]) / this.GRADE;
      if (up > steep) steep = up;
    }
    const prof = this.profile(arcs);
    return {
      distance_m: dist,
      elev_gain_m: gain,
      elev_loss_m: loss,
      steepest: steep,
      n_edges: arcs.length,
      start_elev_m: prof.z.length ? /** @type {number} */ (prof.z[0]) : 0,
      end_elev_m: prof.z.length ? /** @type {number} */ (prof.z[prof.z.length - 1]) : 0,
      profile: prof,
    };
  }

  /** Elevation series along a route, sampled at every intersection.
   * @param {number[]} arcs
   * @returns {{ d: number[], z: number[] }}
   */
  profile(arcs) {
    const d = /** @type {number[]} */ ([]),
      z = /** @type {number[]} */ ([]);
    let acc = 0;
    if (!arcs.length) return { d, z };
    const first = this.arcTail(/** @type {number} */ (arcs[0]));
    d.push(0);
    z.push(this.nodeZ(first));
    for (const a of arcs) {
      acc += /** @type {number} */ (this.arcLen[a]) / this.DM;
      d.push(acc);
      z.push(this.nodeZ(/** @type {number} */ (this.head[a])));
    }
    return { d, z };
  }

  /** Route geometry in [lat,lon] pairs, honouring per-arc direction.
   * @param {number[]} arcs
   * @param {Geometry} geom
   * @returns {number[][]}
   */
  geometry(arcs, geom) {
    /** @type {number[][]} */
    const out = [];
    for (const a of arcs) {
      let pts = geom.edgeCoords(/** @type {number} */ (this.arcEdge[a]));
      if (/** @type {number} */ (this.arcFlags[a]) & 4) {
        /** @type {number[]} */
        const rev = [];
        for (let i = pts.length - 2; i >= 0; i -= 2)
          rev.push(/** @type {number} */ (pts[i]), /** @type {number} */ (pts[i + 1]));
        pts = rev;
      }
      for (let i = 0; i < pts.length; i += 2) {
        const ll = [/** @type {number} */ (pts[i + 1]), /** @type {number} */ (pts[i])];
        const last = out[out.length - 1];
        if (!last || last[0] !== ll[0] || last[1] !== ll[1]) out.push(ll);
      }
    }
    return out;
  }
}

/* ------------------------------------------------- edge geometry + indexes */
class Geometry {
  /**
   * @param {Bundle} bundle
   * @param {GraphMeta} meta
   */
  constructor(bundle, meta) {
    this.s = bundle.text("geom");
    this.off = bundle.array("geom_off");
    this.nEdges = meta.n_edges;
    this.name = bundle.array("edge_name");
    this.cls = bundle.array("edge_cls");
    this.len = bundle.array("edge_len");
    this.names = meta.names;
    this.classes = meta.classes;
    this.DM = meta.scales.dm;

    // decode every edge once into flat coordinate storage
    const coords = [],
      starts = new Int32Array(this.nEdges + 1);
    let n = 0;
    for (let i = 0; i < this.nEdges; i++) {
      const pts = decodePolylineAt(
        this.s,
        /** @type {number} */ (this.off[i]),
        /** @type {number} */ (this.off[i + 1]),
      );
      starts[i] = n;
      for (let k = 0; k < pts.length; k++) coords.push(/** @type {number} */ (pts[k]));
      n += pts.length;
    }
    starts[this.nEdges] = n;
    this.coords = Float32Array.from(coords);
    this.starts = starts;
    this.s = null; // the encoded string is no longer needed

    // per-edge bounding boxes, for viewport culling
    this.bbox = new Float32Array(this.nEdges * 4);
    for (let i = 0; i < this.nEdges; i++) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (
        let k = /** @type {number} */ (starts[i]);
        k < /** @type {number} */ (starts[i + 1]);
        k += 2
      ) {
        const x = /** @type {number} */ (this.coords[k]),
          y = /** @type {number} */ (this.coords[k + 1]);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      this.bbox[i * 4] = x0;
      this.bbox[i * 4 + 1] = y0;
      this.bbox[i * 4 + 2] = x1;
      this.bbox[i * 4 + 3] = y1;
    }
  }

  /** flat [lon,lat,...] for an edge id (ids are a contiguous 0..n-1 range)
   * @param {number} i
   * @returns {ArrayLike<number>}
   */
  edgeCoords(i) {
    if (i < 0 || i >= this.nEdges) return [];
    return this.coords.subarray(this.starts[i], this.starts[i + 1]);
  }

  /**
   * @param {number} row
   * @returns {EdgeInfo}
   */
  edgeInfo(row) {
    return {
      name: this.name[row]
        ? /** @type {string} */ (this.names[/** @type {number} */ (this.name[row]) - 1])
        : null,
      cls: this.classes[/** @type {number} */ (this.cls[row])],
      length_m: /** @type {number} */ (this.len[row]) / this.DM,
    };
  }
}

/* Uniform grid for nearest-node and nearest-edge queries. */
class Grid {
  /**
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>} ys
   * @param {number} cell
   */
  constructor(xs, ys, cell) {
    this.cell = cell;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (/** @type {number} */ (xs[i]) < x0) x0 = /** @type {number} */ (xs[i]);
      if (/** @type {number} */ (xs[i]) > x1) x1 = /** @type {number} */ (xs[i]);
      if (/** @type {number} */ (ys[i]) < y0) y0 = /** @type {number} */ (ys[i]);
      if (/** @type {number} */ (ys[i]) > y1) y1 = /** @type {number} */ (ys[i]);
    }
    this.x0 = x0;
    this.y0 = y0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
    const counts = new Int32Array(this.nx * this.ny + 1);
    const cellOf = new Int32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const cx = Math.min(
        this.nx - 1,
        Math.max(0, ((/** @type {number} */ (xs[i]) - x0) / cell) | 0),
      );
      const cy = Math.min(
        this.ny - 1,
        Math.max(0, ((/** @type {number} */ (ys[i]) - y0) / cell) | 0),
      );
      const c = cy * this.nx + cx;
      cellOf[i] = c;
      /** @type {number} */ (counts[c + 1])++;
    }
    for (let c = 0; c < counts.length - 1; c++)
      /** @type {number} */ (counts[c + 1]) += /** @type {number} */ (counts[c]);
    this.start = counts;
    this.items = new Int32Array(xs.length);
    const fill = counts.slice();
    for (let i = 0; i < xs.length; i++)
      this.items[/** @type {number} */ (fill[/** @type {number} */ (cellOf[i])])++] = i;
    this.xs = xs;
    this.ys = ys;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} [rings]
   * @returns {number[]} items in the cells up to `rings` around (x, y)
   */
  near(x, y, rings = 2) {
    const cx = Math.min(this.nx - 1, Math.max(0, ((x - this.x0) / this.cell) | 0));
    const cy = Math.min(this.ny - 1, Math.max(0, ((y - this.y0) / this.cell) | 0));
    const out = [];
    for (let r = 0; r <= rings; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = cx + dx,
            gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= this.nx || gy >= this.ny) continue;
          const c = gy * this.nx + gx;
          for (
            let k = /** @type {number} */ (this.start[c]);
            k < /** @type {number} */ (this.start[c + 1]);
            k++
          )
            out.push(/** @type {number} */ (this.items[k]));
        }
      }
      if (out.length && r >= 1) break;
    }
    return out;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {(i: number) => boolean} [filter]
   * @returns {number} the nearest item passing filter, or -1
   */
  nearest(x, y, filter) {
    let best = -1,
      bestD = Infinity;
    /** @param {number} i */
    const consider = (i) => {
      if (filter && !filter(i)) return;
      const dx = /** @type {number} */ (this.xs[i]) - x,
        dy = /** @type {number} */ (this.ys[i]) - y;

      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    for (let rings = 1; rings <= 6 && best < 0; rings++) {
      for (const i of this.near(x, y, rings)) consider(i);
    }
    // nothing within a few cells (a click far out in the bay): scan everything
    if (best < 0) for (let i = 0; i < this.xs.length; i++) consider(i);
    return best;
  }
}

/* ------------------------------------------------------ the trade-off slider */
/**
 * @typedef {{ length: number, gain: number }} Tradeoff
 */

/** The climb a notch must save over the one before it: 2 m, or 5% of the
 * shortest route's climb if that is more (spec 6.2).
 * @param {number} shortestGain metres
 * @returns {number} metres
 */
function climbStep(shortestGain) {
  return Math.max(2, 0.05 * shortestGain);
}

/** Thin a Pareto frontier to the notches of the trade-off slider (spec 6.2).
 *
 * ``routes`` is the frontier, any order. Sorted by length, the shortest is
 * notch 0; a route is kept when it climbs at least climbStep() less than the
 * last kept one, so neighbouring notches always differ visibly, and the
 * least-climbing route closes the list (replacing the last kept route if
 * the two are closer than a step). At most ``maxNotches`` survive: the
 * shortest, the flattest, and between them the routes nearest to evenly
 * spaced climb targets. Removing notches only widens the gaps, so the
 * step rule still holds.
 * @template {Tradeoff} T
 * @param {T[]} routes
 * @param {number} [maxNotches]
 * @returns {T[]}
 */
function thinFrontier(routes, maxNotches = 10) {
  if (!routes.length) return [];
  const byLength = routes.slice().sort((x, y) => x.length - y.length || x.gain - y.gain);
  const first = /** @type {T} */ (byLength[0]);
  const flattest = byLength.reduce((b, r) => (r.gain < b.gain - 1e-9 ? r : b), first);
  const step = climbStep(first.gain);
  /** @type {T[]} */
  const kept = [first];
  for (const r of byLength) {
    if (r === first || r === flattest || r.length > flattest.length) continue;
    if (/** @type {T} */ (kept[kept.length - 1]).gain - r.gain >= step) kept.push(r);
  }
  if (flattest !== first) {
    while (kept.length > 1 && /** @type {T} */ (kept[kept.length - 1]).gain - flattest.gain < step)
      kept.pop();
    if (first.gain - flattest.gain >= step) kept.push(flattest);
  }
  if (kept.length <= maxNotches) return kept;
  const last = /** @type {T} */ (kept[kept.length - 1]);
  const used = new Set([0, kept.length - 1]);
  for (let j = 1; j < maxNotches - 1; j++) {
    const target = first.gain - ((first.gain - last.gain) * j) / (maxNotches - 1);
    let best = -1,
      bestErr = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(/** @type {T} */ (kept[i]).gain - target);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    used.add(best);
  }
  return kept.filter((_, i) => used.has(i));
}

/** The notch the slider opens on: the flattest route no more than 25% longer
 * than notch 0 (spec 6.2).
 * @param {Tradeoff[]} notches sorted as thinFrontier returns them
 * @returns {number}
 */
function defaultNotch(notches) {
  const first = notches[0];
  if (!first) return 0;
  let best = 0;
  notches.forEach((r, i) => {
    if (r.length <= 1.25 * first.length + 1e-9) best = i;
  });
  return best;
}

window.Graph = Graph;
window.Geometry = Geometry;
window.Grid = Grid;
window.Bundle = Bundle;
window.inflate = inflate;
window.loadBundle = loadBundle;
window.MinHeap = MinHeap;
window.thinFrontier = thinFrontier;
window.defaultNotch = defaultNotch;
window.climbStep = climbStep;

/* Roll SF -- text the interface shows, and the shareable URL state.
 *
 * Pure functions only (no DOM), so they are unit-tested under Node and
 * type-checked. Loaded after engine.js and before search.js and simple.js,
 * as one classic script.
 */
"use strict";

/**
 * @typedef {"metric" | "imperial"} Units
 * @typedef {{ lon: number, lat: number, label: string }} Place
 * @typedef {object} ShareState
 * @property {number} cap maximum uphill, whole percent
 * @property {number | null} notch the trade-off notch, or null for the default
 * @property {Place | null} from
 * @property {Place | null} to
 * @property {{ km: number, outBack: boolean, idx: number } | null} loop
 * @typedef {{ distance_m: number, elev_gain_m: number, steepest: number }} Stats
 * @typedef {{ street: string, from: string, to: string, grade: number }} Block
 */

const FT_PER_M = 3.28084;
const M_PER_MI = 1609.344;
const MINUS = "−";
const NBSP = " ";

/* -------------------------------------------------------------- numbers */
/** A distance: metres and kilometres, or feet and miles.
 * @param {number} m
 * @param {Units} units
 * @returns {string}
 */
function fmtDistance(m, units) {
  if (units === "imperial") {
    const mi = m / M_PER_MI;
    if (mi < 0.1) return Math.round((m * FT_PER_M) / 10) * 10 + NBSP + "ft";
    return (mi < 10 ? mi.toFixed(1) : String(Math.round(mi))) + NBSP + "mi";
  }
  if (m < 1000) return Math.round(m / 10) * 10 + NBSP + "m";
  const km = m / 1000;
  return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + NBSP + "km";
}

/** A climb (or any height): metres or feet.
 * @param {number} m
 * @param {Units} units
 * @returns {string}
 */
function fmtClimb(m, units) {
  return units === "imperial" ? Math.round(m * FT_PER_M) + NBSP + "ft" : Math.round(m) + NBSP + "m";
}

/** A grade as a whole percentage, "7 %".
 * @param {number} fraction
 * @returns {string}
 */
function fmtGrade(fraction) {
  return Math.round(fraction * 100) + NBSP + "%";
}

/** A signed difference with a real minus sign, "+180 m" / "−22 m".
 * @param {number} value
 * @param {(v: number) => string} fmt formats the magnitude
 * @returns {string}
 */
function signed(value, fmt) {
  return (value < 0 ? MINUS : "+") + fmt(Math.abs(value));
}

/* ------------------------------------------------------------ the cap */
/** @param {number} pct @returns {string} */
function capLabel(pct) {
  return "Max uphill " + pct + NBSP + "%";
}

/** What a screen reader says for the cap slider.
 * @param {number} pct
 * @returns {string}
 */
function capValueText(pct) {
  return pct + " percent";
}

/* ------------------------------------------------------ the trade-off */
/** The trade-off slider's label for one notch, relative to notch 0.
 * @param {number} index
 * @param {{ length: number, gain: number }} notch
 * @param {{ length: number, gain: number }} first
 * @param {Units} units
 * @returns {string}
 */
function tradeoffLabel(index, notch, first, units) {
  if (index === 0) return "Shortest";
  const extra = signed(notch.length - first.length, (v) => fmtDistance(v, units));
  const saved = signed(notch.gain - first.gain, (v) => fmtClimb(v, units));
  return extra + " · " + saved + " climb";
}

/** What the trade-off slider says to a screen reader.
 * @param {number} index
 * @param {number} count
 * @param {string} label
 * @returns {string}
 */
function tradeoffValueText(index, count, label) {
  return "Route " + (index + 1) + " of " + count + ": " + label;
}

/** The summary row: each metric against the unconstrained shortest route.
 * @param {Stats} route
 * @param {Stats} ref the unconstrained shortest route
 * @param {Units} units
 * @returns {{ distance: string, climb: string, steepest: string }}
 */
function summaryParts(route, ref, units) {
  const dd = route.distance_m - ref.distance_m;
  const dc = route.elev_gain_m - ref.elev_gain_m;
  // under 5 m of distance or half a metre of climb is the same route, not a detour
  const diff = (
    /** @type {number} */ v,
    /** @type {number} */ tol,
    /** @type {(m: number) => string} */ fmt,
  ) => (Math.abs(v) < tol ? "same" : signed(v, fmt));
  const distance =
    fmtDistance(route.distance_m, units) + " (" + diff(dd, 5, (v) => fmtDistance(v, units)) + ")";
  const climb =
    fmtClimb(route.elev_gain_m, units) +
    " climb (" +
    diff(dc, 0.5, (v) => fmtClimb(v, units)) +
    ")";
  const steepest = "max " + fmtGrade(route.steepest) + " (vs " + fmtGrade(ref.steepest) + ")";
  return { distance, climb, steepest };
}

/* ----------------------------------------------------- names and notes */
const STREET_SHORT = /** @type {Record<string, string>} */ ({
  Street: "St",
  Avenue: "Ave",
  Boulevard: "Blvd",
  Drive: "Dr",
  Road: "Rd",
  Terrace: "Ter",
  Place: "Pl",
  Court: "Ct",
  Lane: "Ln",
  Highway: "Hwy",
  Parkway: "Pkwy",
});

/** "Clay Street" -> "Clay St".
 * @param {string} name
 * @returns {string}
 */
function shortStreet(name) {
  return String(name)
    .split(" ")
    .map((w) => STREET_SHORT[w] || w)
    .join(" ");
}

/** "Clay St between Jones St and Leavenworth St" (or less, when a corner is unnamed).
 * @param {Block} block
 * @returns {string}
 */
function blockName(block) {
  if (!block.street)
    return block.from ? "a path near " + shortStreet(block.from) : "an unnamed path";
  const street = shortStreet(block.street);
  if (block.from && block.to && block.from !== block.to)
    return street + " between " + shortStreet(block.from) + " and " + shortStreet(block.to);
  const corner = block.from || block.to;
  return corner ? street + " near " + shortStreet(corner) : street;
}

/** The banner when no route stays under the cap (spec 6.3).
 * @param {number} capPct the user's cap
 * @param {number} needPct the smallest cap that works, in percent (shown to one decimal)
 * @param {Block[]} blocks the shown route's arcs over the cap, steepest first
 * @returns {string}
 */
function infeasibleText(capPct, needPct, blocks) {
  const need = Number.isInteger(needPct) ? String(needPct) : needPct.toFixed(1);
  let text =
    "No route stays under " + capPct + NBSP + "%. The gentlest route needs " + need + NBSP + "%";
  const first = blocks[0];
  if (first) {
    text += " on " + blockName(first);
    if (blocks.length > 1)
      text += " (+" + (blocks.length - 1) + " other block" + (blocks.length > 2 ? "s" : "") + ")";
  }
  return text + ".";
}

/** What tapping a street steeper than the cap says.
 * @param {number} capPct
 * @param {number} fwd max_up_grade_15m one way (fraction)
 * @param {number} rev the other way
 * @returns {string}
 */
function steepNote(capPct, fwd, rev) {
  const cap = capPct / 100;
  const up = Math.max(fwd, rev),
    down = Math.min(fwd, rev);
  if (down > cap)
    return (
      "Steeper than " +
      capPct +
      NBSP +
      "% both ways (" +
      fmtGrade(up) +
      " and " +
      fmtGrade(down) +
      ")."
    );
  return "Steeper than " + capPct + NBSP + "% going uphill (" + fmtGrade(up) + "). Fine downhill.";
}

/** A loop length in the chosen units: "3 km", or "3 km (1.9 mi)".
 * @param {number} km
 * @param {Units} units
 * @returns {string}
 */
function fmtLoopLength(km, units) {
  const base = (Number.isInteger(km) ? String(km) : km.toFixed(1)) + NBSP + "km";
  return units === "imperial" ? base + " (" + fmtDistance(km * 1000, units) + ")" : base;
}

/** When no loop of about the asked length fits under the cap (spec 6.4).
 * @param {number} km
 * @param {number} capPct
 * @param {number | null} nearestKm the closest length the search did find, if any
 * @param {Units} units
 * @returns {string}
 */
function loopMissText(km, capPct, nearestKm, units) {
  const text =
    "No loop of about " +
    fmtLoopLength(km, units) +
    " stays under " +
    capPct +
    NBSP +
    "% from here.";
  return nearestKm === null ? text : text + " Try " + fmtLoopLength(nearestKm, units) + ".";
}

/* ------------------------------------------------------- the URL hash */
/** Labels travel hex-escaped so the fragment stays one bare token.
 * @param {string} s
 * @returns {string}
 */
function encLabel(s) {
  let out = "";
  for (const ch of String(s || "")) {
    if (/[A-Za-z0-9.-]/.test(ch)) out += ch;
    else {
      const c = /** @type {number} */ (ch.codePointAt(0));
      out +=
        c < 256 ? "_" + c.toString(16).padStart(2, "0") : "_u" + c.toString(16).padStart(4, "0");
    }
  }
  return out;
}

/** @param {string} s @returns {string} */
function decLabel(s) {
  return String(s || "").replace(/_u([0-9a-f]{4})|_([0-9a-f]{2})/gi, (_m, u, b) =>
    String.fromCodePoint(parseInt(u || b, 16)),
  );
}

/** @param {Place} p @returns {string[]} */
function placeTokens(p) {
  return [p.lon.toFixed(5), p.lat.toFixed(5)];
}

/** The shareable state as a URL fragment (without "#"):
 * ``r~cap~notch~lon~lat~lon~lat~from~to`` for a trip, and
 * ``l~cap~km~o|-~idx~lon~lat~label`` for a loop. "" when there is nothing to share.
 * @param {ShareState} s
 * @returns {string}
 */
function encodeState(s) {
  if (!s.from) return "";
  if (s.loop) {
    return [
      "l",
      String(s.cap),
      String(s.loop.km),
      s.loop.outBack ? "o" : "-",
      String(s.loop.idx),
      ...placeTokens(s.from),
      encLabel(s.from.label),
    ].join("~");
  }
  if (!s.to) return "";
  return [
    "r",
    String(s.cap),
    s.notch === null ? "-" : String(s.notch),
    ...placeTokens(s.from),
    ...placeTokens(s.to),
    encLabel(s.from.label),
    encLabel(s.to.label),
  ].join("~");
}

/** Read a fragment written by encodeState; null if it is not one.
 * @param {string} hash with or without the leading "#"
 * @param {{ min: number, max: number }} capRange
 * @returns {ShareState | null}
 */
function decodeState(hash, capRange) {
  const parts = String(hash || "")
    .replace(/^#/, "")
    .split("~");
  const num = (/** @type {string | undefined} */ v) => (v === undefined ? NaN : Number(v));
  const capOf = (/** @type {string | undefined} */ v) => {
    const c = Math.round(num(v));
    return Number.isFinite(c) ? Math.min(capRange.max, Math.max(capRange.min, c)) : NaN;
  };
  const place = (/** @type {number} */ i, /** @type {string | undefined} */ label) => {
    const lon = num(parts[i]),
      lat = num(parts[i + 1]);
    return Number.isFinite(lon) && Number.isFinite(lat)
      ? { lon, lat, label: decLabel(label || "") }
      : null;
  };
  if (parts[0] === "l" && parts.length >= 8) {
    const cap = capOf(parts[1]),
      km = num(parts[2]),
      idx = Math.max(0, Math.round(num(parts[4])) || 0);
    const from = place(5, parts[7]);
    if (!Number.isFinite(cap) || !(km > 0) || !from) return null;
    return { cap, notch: null, from, to: null, loop: { km, outBack: parts[3] === "o", idx } };
  }
  if (parts[0] === "r" && parts.length >= 9) {
    const cap = capOf(parts[1]);
    const notch = parts[2] === "-" ? null : Math.max(0, Math.round(num(parts[2])));
    const from = place(3, parts[7]),
      to = place(5, parts[8]);
    if (!Number.isFinite(cap) || !from || !to || (notch !== null && !Number.isFinite(notch)))
      return null;
    return { cap, notch, from, to, loop: null };
  }
  return null;
}

// one classic script with engine.js and simple.js: publish what simple.js
// and the tests use
Object.assign(window, {
  fmtDistance,
  fmtClimb,
  fmtGrade,
  capLabel,
  capValueText,
  tradeoffLabel,
  tradeoffValueText,
  summaryParts,
  shortStreet,
  blockName,
  infeasibleText,
  steepNote,
  fmtLoopLength,
  loopMissText,
  encodeState,
  decodeState,
});

/* Roll SF -- offline place search, street naming and favourites.
 *
 * The index is built in the page from the graph's own street names
 * (intersections), plus Overture places and addresses packed into the
 * bundle (see sf_flat_routes/places.py). No geocoding service.
 */
"use strict";

/**
 * @typedef {object} SearchHit
 * @property {string} name
 * @property {string} kind
 * @property {number} lon
 * @property {number} lat
 * @property {number} [node] set for intersections: the graph node itself
 * @property {number} score lower is better
 * @property {number} rank lower is better, after score
 *
 * @typedef {{ name: string, lon: number, lat: number }} Favourite
 * @typedef {{ origin: [number, number], step: number }} AddressMeta
 */

/* Street-type words collapse to their abbreviations on both the index and
 * the query, so "Geary Blvd", "Geary Boulevard" and "geary" all match. */
const ABBREV = /** @type {Record<string, string>} */ ({
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  drive: "dr",
  road: "rd",
  court: "ct",
  place: "pl",
  lane: "ln",
  terrace: "ter",
  highway: "hwy",
  parkway: "pkwy",
  circle: "cir",
  alley: "aly",
  square: "sq",
  stairway: "stwy",
  stairs: "stwy",
  way: "wy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  saint: "st",
  mount: "mt",
});

/** Lower-case, unpunctuated, street types abbreviated.
 * @param {string} s
 * @returns {string}
 */
function normName(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => ABBREV[w] || w)
    .join(" ");
}

/** 0 exact, 1 starts with, 2 every token is a word prefix, 3 substring, -1 none.
 * @param {string} nn normalised candidate
 * @param {string} q normalised query
 * @param {string[]} toks query tokens
 * @returns {number}
 */
function matchScore(nn, q, toks) {
  if (nn === q) return 0;
  if (nn.startsWith(q)) return 1;
  if (toks.every((t) => (" " + nn).includes(" " + t))) return 2;
  if (q.length >= 3 && nn.includes(q)) return 3;
  return -1;
}

const KIND_RANK = /** @type {Record<string, number>} */ ({
  landmark: 1,
  transit: 1,
  civic: 1,
  shop: 2,
  food: 2,
  lodging: 2,
});

class PlaceIndex {
  /**
   * @param {Graph} graph
   * @param {Geometry} geom
   * @param {Bundle} bundle
   * @param {AddressMeta | null} addrMeta
   */
  constructor(graph, geom, bundle, addrMeta) {
    this.graph = graph;
    this.geom = geom;
    /** @type {(number[] | undefined)[]} street name indices (1-based) meeting at each node */
    this.nodeNames = [];
    /** @type {{ name: string, parts: string[], node: number, lon: number, lat: number }[]} */
    this.intersections = [];
    this.buildIntersections();
    /** @type {{ name: string, nn: string, kind: string, lon: number, lat: number }[]} */
    this.places = [];
    if (bundle.hasText("places")) {
      const p = JSON.parse(bundle.text("places"));
      for (let i = 0; i < p.names.length; i++) {
        this.places.push({
          name: p.names[i],
          nn: normName(p.names[i]),
          kind: p.groups[p.group[i]],
          lon: p.lon[i],
          lat: p.lat[i],
        });
      }
    }
    this.addr = null;
    if (addrMeta && bundle.hasText("addr_streets")) {
      /** @type {string[]} */
      const streets = JSON.parse(bundle.text("addr_streets"));
      const st = bundle.array("addr_street");
      const start = new Int32Array(streets.length + 1);
      for (let i = 0; i < st.length; i++)
        /** @type {number} */ (start[/** @type {number} */ (st[i]) + 1])++;
      for (let i = 0; i < streets.length; i++)
        /** @type {number} */ (start[i + 1]) += /** @type {number} */ (start[i]);
      this.addr = {
        streets,
        nn: streets.map(normName),
        start,
        number: bundle.array("addr_number"),
        lon: bundle.array("addr_lon"),
        lat: bundle.array("addr_lat"),
        origin: addrMeta.origin,
        step: addrMeta.step,
      };
    }
  }

  /* "24th St & Mission St": a node where two or more street names meet */
  buildIntersections() {
    const g = this.graph,
      geom = this.geom;
    const per = this.nodeNames;
    /** @param {number} node @param {number} nameIdx */
    const add = (node, nameIdx) => {
      if (!nameIdx) return;
      const s = per[node] || (per[node] = []);
      if (s.indexOf(nameIdx) < 0) s.push(nameIdx);
    };
    for (let u = 0; u < g.n; u++) {
      for (
        let a = /** @type {number} */ (g.indptr[u]);
        a < /** @type {number} */ (g.indptr[u + 1]);
        a++
      ) {
        const ni = /** @type {number} */ (geom.name[/** @type {number} */ (g.arcEdge[a])]);
        add(u, ni);
        add(/** @type {number} */ (g.head[a]), ni);
      }
    }
    const seen = new Set();
    for (let u = 0; u < g.n; u++) {
      const s = per[u];
      if (!s || s.length < 2) continue;
      const names = s.map((i) => /** @type {string} */ (geom.names[i - 1])).sort();
      const key = names.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      this.intersections.push({
        name: names.slice(0, 3).join(" & "),
        parts: names.map(normName),
        node: u,
        lon: g.nodeLon(u),
        lat: g.nodeLat(u),
      });
    }
  }

  /** Street names meeting at a node, other than ``street``.
   * @param {number} node
   * @param {string | null} street
   * @returns {string[]}
   */
  crossStreets(node, street) {
    return (this.nodeNames[node] || [])
      .map((i) => /** @type {string} */ (this.geom.names[i - 1]))
      .filter((n) => n !== street);
  }

  /** The street crossing ``street`` at ``node``, or, when the node is
   * mid-block, at the nearest corner of ``street``; "" if there is none.
   * @param {number} node
   * @param {string} street
   * @returns {string}
   */
  crossNear(node, street) {
    const here = this.crossStreets(node, street)[0];
    if (here) return here;
    const g = this.graph;
    const lon = g.nodeLon(node),
      lat = g.nodeLat(node),
      kx = Math.cos((lat * Math.PI) / 180);
    const want = normName(street);
    let best = "",
      bestD = Infinity;
    for (const it of this.intersections) {
      if (!it.parts.includes(want)) continue;
      const d = ((it.lon - lon) * kx) ** 2 + (it.lat - lat) ** 2;
      if (d < bestD) {
        bestD = d;
        best = it.name.split(" & ").find((n) => n !== street) || "";
      }
    }
    return best;
  }

  /** The street an arc belongs to ("" for an unnamed path).
   * @param {number} arc
   * @returns {string}
   */
  streetOf(arc) {
    const ni = /** @type {number} */ (
      this.geom.name[/** @type {number} */ (this.graph.arcEdge[arc])]
    );
    return ni ? /** @type {string} */ (this.geom.names[ni - 1]) : "";
  }

  /** A block for the infeasible banner: a run of a route's arcs along one
   * street, named by the street and the cross streets at its two ends. An
   * unnamed path is placed by the nearest named corner instead.
   * @param {number[]} arcs consecutive arcs on one street
   * @returns {{ street: string, from: string, to: string }}
   */
  blockOf(arcs) {
    const g = this.graph;
    const first = /** @type {number} */ (arcs[0]),
      last = /** @type {number} */ (arcs[arcs.length - 1]);
    const street = this.streetOf(first);
    const tail = g.arcTail(first),
      head = /** @type {number} */ (g.head[last]);
    if (!street) return { street: "", from: this.describe(tail), to: "" };
    return { street, from: this.crossNear(tail, street), to: this.crossNear(head, street) };
  }

  /** The nearest named corner, for labelling a dropped pin or an unnamed path.
   * @param {number} node
   * @returns {string}
   */
  describe(node) {
    const g = this.graph;
    const s = this.nodeNames[node];
    if (s && s.length >= 2)
      return s
        .slice(0, 2)
        .map((i) => this.geom.names[i - 1])
        .join(" & ");
    const lon = g.nodeLon(node),
      lat = g.nodeLat(node),
      kx = Math.cos((lat * Math.PI) / 180);
    let best = null,
      bestD = Infinity;
    for (const it of this.intersections) {
      const d = ((it.lon - lon) * kx) ** 2 + (it.lat - lat) ** 2;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    if (best) return best.name.split(" & ").slice(0, 2).join(" & ");
    return lat.toFixed(4) + ", " + lon.toFixed(4);
  }

  /** Street addresses like "1234 Valencia": the nearest number on the best streets.
   * @param {string} q normalised query
   * @returns {SearchHit[]}
   */
  searchAddresses(q) {
    const am = /^(\d+)\s+(\D.*)$/.exec(q);
    const a = this.addr;
    if (!am || !a) return [];
    const want = Number(am[1]),
      sq = /** @type {string} */ (am[2]),
      stoks = sq.split(" ");
    /** @type {[number, number][]} */
    const hits = [];
    a.nn.forEach((nn, i) => {
      const sc = matchScore(nn, sq, stoks);
      if (sc >= 0 && sc <= 2) hits.push([sc, i]);
    });
    hits.sort(
      (x, y) =>
        x[0] - y[0] ||
        /** @type {string} */ (a.streets[x[1]]).length -
          /** @type {string} */ (a.streets[y[1]]).length,
    );
    const num = (/** @type {number} */ i) => /** @type {number} */ (a.number[i]);
    return hits.slice(0, 4).map(([sc, si]) => {
      const lo = /** @type {number} */ (a.start[si]),
        hi = /** @type {number} */ (a.start[si + 1]);
      // numbers are sorted within a street: binary search for the nearest
      let l = lo,
        h = hi - 1;
      while (l < h) {
        const m = (l + h) >> 1;
        if (num(m) < want) l = m + 1;
        else h = m;
      }
      const best = l > lo && Math.abs(num(l - 1) - want) < Math.abs(num(l) - want) ? l - 1 : l;
      const exact = num(best) === want;
      return {
        score: exact ? -1 : sc,
        rank: 0,
        name: num(best) + " " + a.streets[si],
        kind: exact ? "address" : "nearest address",
        lon: a.origin[0] + /** @type {number} */ (a.lon[best]) * a.step,
        lat: a.origin[1] + /** @type {number} */ (a.lat[best]) * a.step,
      };
    });
  }

  /** Intersections ("24th & Mission") and places for a query, best first.
   * @param {string} raw what the user typed
   * @param {number} [limit]
   * @returns {SearchHit[]}
   */
  search(raw, limit = 8) {
    const q = normName(raw);
    if (!q) return [];
    const toks = q.split(" ");
    const qq = q.replace(/ /g, "");
    /** @type {SearchHit[]} */
    const out = this.searchAddresses(q);
    const parts = raw
      .toLowerCase()
      .split(/\s+(?:and|at)\s+|\s*[&/@+]\s*/)
      .map(normName)
      .filter(Boolean);
    for (const it of this.intersections) {
      if (parts.length === 2) {
        const ok = parts.filter((p) =>
          it.parts.some((n) => n.startsWith(p) || (" " + n).includes(" " + p)),
        ).length;
        if (ok === 2) out.push({ ...it, kind: "intersection", score: 1, rank: 1 });
      } else if (parts.length === 1 && it.parts.some((n) => n.startsWith(q))) {
        out.push({ ...it, kind: "intersection", score: 2, rank: 3 });
      }
    }
    for (const p of this.places) {
      let sc = matchScore(p.nn, q, toks);
      if (sc < 0 && qq.length >= 4 && p.nn.replace(/ /g, "").startsWith(qq)) sc = 2;
      if (sc >= 0) out.push({ ...p, score: sc, rank: 1 + (KIND_RANK[p.kind] || 0) });
    }
    out.sort((a, b) => a.score - b.score || a.rank - b.rank || a.name.length - b.name.length);
    const seen = new Set(),
      res = [];
    for (const r of out) {
      const k = r.kind + "|" + r.name;
      if (seen.has(k)) continue;
      seen.add(k);
      res.push(r);
      if (res.length >= limit) break;
    }
    return res;
  }
}

/* -------------------------------------------------------------- storage */
const FAVOURITES_KEY = "sfroll.favourites.v1";
const UNITS_KEY = "sfroll.units.v1";

/** Read a value from localStorage; null when storage is unavailable (private
 * browsing, blocked site data) or the key is absent.
 * @param {string} key
 * @returns {string | null}
 */
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a value to localStorage; false when storage is unavailable.
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Saved places, oldest first; invalid entries are dropped.
 * @returns {Favourite[]}
 */
function loadFavourites() {
  const raw = storageGet(FAVOURITES_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (f) => f && typeof f.name === "string" && Number.isFinite(f.lat) && Number.isFinite(f.lon),
    );
  } catch {
    return [];
  }
}

/** Add a place, or remove it if a favourite with the same name is already there.
 * @param {Favourite} place
 * @returns {{ list: Favourite[], saved: boolean, stored: boolean }}
 */
function toggleFavourite(place) {
  const list = loadFavourites();
  const i = list.findIndex((f) => f.name === place.name);
  const saved = i < 0;
  if (saved) list.push({ name: place.name, lat: place.lat, lon: place.lon });
  else list.splice(i, 1);
  return { list, saved, stored: storageSet(FAVOURITES_KEY, JSON.stringify(list)) };
}

/** @returns {Units} */
function loadUnits() {
  return storageGet(UNITS_KEY) === "imperial" ? "imperial" : "metric";
}

/** @param {Units} units @returns {boolean} */
function saveUnits(units) {
  return storageSet(UNITS_KEY, units);
}

Object.assign(window, {
  PlaceIndex,
  normName,
  loadFavourites,
  toggleFavourite,
  loadUnits,
  saveUnits,
});

/* Roll SF -- the app.
 *
 * A full-screen map and a bottom sheet: start and destination (or a loop
 * length), the maximum uphill grade, and a slider from the shortest route
 * to the one with the least climbing among those that respect the cap.
 * Routing comes from engine.js, text from format.js, search and storage
 * from search.js. Everything runs in the page.
 */
"use strict";

(function () {
  const DATA = window.DATA;
  const CAP = { min: 3, max: 20, def: 8 };
  const LOOP = { min: 0.5, max: 15, def: 3 };
  const SNAP_M = 150; // spec 6.5
  const CAP_THROTTLE_MS = 100; // spec 7.3
  const SLICE_MS = 25; // searches run in slices this long, so the page keeps painting
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ------------------------------------------------- grade colours (7.2) */
  function gradeColour(g, a) {
    const up = g.maxUp(a);
    if (up <= 0) return g.arcLoss[a] > 0 ? css("--g-down") : css("--g0");
    if (up < 0.05) return css("--g0");
    if (up < 0.08) return css("--g1");
    if (up <= 0.12) return css("--g2");
    return css("--g3");
  }

  /* ---------------------------------------- the street canvases (7.2) */
  /* Street coordinates projected once to Web Mercator pixels at zoom 0, so a
   * repaint only scales and shifts them. */
  function projectAll(geom) {
    const n = geom.coords.length,
      out = new Float64Array(n);
    for (let k = 0; k < n; k += 2) {
      const lon = geom.coords[k],
        lat = (geom.coords[k + 1] * Math.PI) / 180;
      out[k] = ((lon + 180) / 360) * 256;
      out[k + 1] = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * 256;
    }
    return out;
  }

  /* One canvas over the map. ``blocked`` false paints every street faintly
   * and repaints only when the map moves; ``blocked`` true paints just the
   * streets steeper than the cap (grey dots) and also repaints when the cap
   * changes, which is what keeps dragging the cap slider smooth. */
  const StreetLayer = L.Layer.extend({
    initialize(app, blocked) {
      this.app = app;
      this.blocked = blocked;
    },
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create(
        "canvas",
        "leaflet-zoom-animated " + (this.blocked ? "streets-blocked" : "streets"),
      );
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on("moveend zoomend resize", this.redraw, this);
      map.on("zoomanim", this._animate, this);
      this.redraw();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off("moveend zoomend resize", this.redraw, this);
      map.off("zoomanim", this._animate, this);
    },
    _animate(e) {
      const scale = this._map.getZoomScale(e.zoom);
      const offset = this._map._latLngToNewLayerPoint(
        this._map.getBounds().getNorthWest(),
        e.zoom,
        e.center,
      );
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },
    /* repaint on the next frame; repeated calls while dragging coalesce */
    schedule() {
      if (this._frame) return;
      this._frame = requestAnimationFrame(() => {
        this._frame = 0;
        this.redraw();
      });
    },
    redraw() {
      const map = this._map;
      if (!map) return;
      // two device pixels per CSS pixel are plenty for hairlines, and a third
      // would more than double what every repaint has to composite
      const size = map.getSize(),
        dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this._canvas.width !== size.x * dpr || this._canvas.height !== size.y * dpr) {
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + "px";
        this._canvas.style.height = size.y + "px";
      }
      const nw = map.getBounds().getNorthWest();
      L.DomUtil.setTransform(this._canvas, map.latLngToLayerPoint(nw), 1);
      const ctx = this._canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      const z = map.getZoom();
      const b = map.getBounds().pad(0.05);
      const west = b.getWest(),
        east = b.getEast(),
        south = b.getSouth(),
        north = b.getNorth();
      const { geom, edgeUp, projected } = this.app;
      const capQ = this.app.state.cap / 100;
      const scale = Math.pow(2, z),
        o = map.project(nw, z);
      const minLen = this.blocked ? 0 : z >= 15 ? 0 : z >= 14 ? 10 : z >= 13 ? 20 : 40;
      const width = z >= 16 ? 1.6 : z >= 14 ? 1.1 : 0.8;
      let count = 0;
      ctx.lineCap = "round";
      if (this.blocked) {
        // grey dots, the same whatever the zoom (the unconstrained route is dashed)
        ctx.strokeStyle = css("--blocked");
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = width + 1.4;
        ctx.setLineDash([0.1, 4]);
      } else {
        ctx.strokeStyle = css("--street");
        ctx.lineWidth = width;
      }
      ctx.beginPath();
      for (let i = 0; i < geom.nEdges; i++) {
        if (this.blocked !== edgeUp[i] > capQ) continue;
        const q = i * 4;
        if (
          geom.bbox[q + 2] < west ||
          geom.bbox[q] > east ||
          geom.bbox[q + 3] < south ||
          geom.bbox[q + 1] > north
        )
          continue;
        if (minLen && geom.len[i] / geom.DM < minLen) continue;
        count++;
        const s = geom.starts[i],
          e = geom.starts[i + 1];
        ctx.moveTo(projected[s] * scale - o.x, projected[s + 1] * scale - o.y);
        for (let k = s + 2; k < e; k += 2)
          ctx.lineTo(projected[k] * scale - o.x, projected[k + 1] * scale - o.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (this.blocked) {
        this._canvas.dataset.overCap = String(count);
        this._canvas.dataset.cap = String(this.app.state.cap);
      }
    },
  });

  /* ----------------------------------------------------------- the app */
  const App = {
    state: {
      cap: CAP.def,
      notch: null,
      from: null,
      to: null,
      loop: null,
      units: loadUnits(),
    },
    gen: 0,
    gps: null, // the latest position fix: { lon, lat, accuracy }
    result: null,

    async start() {
      setStatus("Loading the street network…");
      const buf = await loadBundle(DATA, (got, total) => {
        setStatus(
          "Loading the street network… " +
            (total ? Math.round((100 * got) / total) + "%" : (got / 1e6).toFixed(1) + " MB"),
        );
      });
      // startup phases, readable with performance.getEntriesByType("mark")
      performance.mark("rollsf:downloaded");
      const bundle = new Bundle(buf, DATA.manifest);
      const g = (this.graph = new Graph(bundle, DATA.meta));
      performance.mark("rollsf:graph");
      this.geom = new Geometry(bundle, DATA.meta);
      performance.mark("rollsf:geometry");
      DATA.bundle = null;
      this.buildEdgeGrades();
      this.projected = projectAll(this.geom);
      const routable = [];
      for (let i = 0; i < g.n; i++) if (g.nodeFlags[i]) routable.push(i);
      this.routable = Int32Array.from(routable);
      this.nodeGrid = new Grid(
        Float32Array.from(routable, (i) => g.nodeLon(i)),
        Float32Array.from(routable, (i) => g.nodeLat(i)),
        0.004,
      );
      performance.mark("rollsf:grids");
      this.index = new PlaceIndex(g, this.geom, bundle, DATA.addr);
      performance.mark("rollsf:index");
      this.buildMap();
      performance.mark("rollsf:map");
      // Chrome rasterises a canvas layer from scratch the first time it
      // changes after its first paint, a one-off that would stall the first
      // drag of the cap slider; repainting on the next frame takes it now
      requestAnimationFrame(() => requestAnimationFrame(() => this.streets.redraw()));
      this.buildUI();
      setStatus("");
      const shared = decodeState(location.hash, CAP);
      if (shared) this.applyShared(shared);
      else this.useGps(true);
      this.renderControls();
      this.recompute(true);
      performance.mark("rollsf:ready");
      this.registerWorker();
    },

    /* the service worker caches the app and the graph for offline use (spec 8) */
    registerWorker() {
      if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("offline use is unavailable:", err);
      });
    },

    /* the steeper direction of every edge, for the over-cap overlay, and
     * each direction separately, for the note when a street is tapped */
    buildEdgeGrades() {
      const g = this.graph,
        n = this.geom.nEdges;
      this.edgeUp = new Float32Array(n);
      this.edgeFwd = new Float32Array(n);
      this.edgeRev = new Float32Array(n);
      for (let a = 0; a < g.m; a++) {
        const e = g.arcEdge[a],
          up = g.maxUp(a);
        if (g.arcFlags[a] & 4) this.edgeRev[e] = up;
        else this.edgeFwd[e] = up;
        if (up > this.edgeUp[e]) this.edgeUp[e] = up;
      }
    },

    /* --------------------------------------------------------------- map */
    buildMap() {
      const map = L.map("map", {
        zoomControl: false,
        attributionControl: true,
        center: [37.765, -122.44],
        zoom: 13,
        minZoom: 11,
        maxZoom: 18,
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix("");
      map.attributionControl.addAttribution(
        "Streets © <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> via " +
          "<a href='https://overturemaps.org'>Overture</a> (ODbL) · Elevation USGS 3DEP",
      );
      this.map = map;
      if (DATA.hillshade) {
        L.imageOverlay(DATA.hillshade.url, DATA.hillshade.bounds, {
          interactive: false,
          className: "hillshade",
          alt: "",
        }).addTo(map);
      }
      new StreetLayer(this, false).addTo(map);
      this.streets = new StreetLayer(this, true).addTo(map);
      const labels = L.layerGroup().addTo(map);
      for (const l of DATA.labels || []) {
        L.marker([l.lat, l.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: "nblabel", html: l.n, iconSize: null }),
        }).addTo(labels);
      }
      const zoomClass = () => {
        const z = map.getZoom();
        map.getContainer().classList.toggle("z-low", z < 12);
        map.getContainer().classList.toggle("z-high", z >= 15.5);
      };
      map.on("zoomend", zoomClass);
      zoomClass();
      this.svg = L.svg({ padding: 0.5 });
      this.shortestLayer = L.layerGroup().addTo(map);
      this.routeLayer = L.layerGroup().addTo(map);
      this.markers = L.layerGroup().addTo(map);
      this.gpsLayer = L.layerGroup().addTo(map);
      map.on("click", (e) => this.onMapTap(e.latlng));
    },

    /* A tap offers "Set as start" / "Set as destination", and says so when
     * the street under the finger is steeper than the cap. */
    onMapTap(latlng) {
      const box = document.createElement("div");
      const edge = this.edgeNear(latlng, 14);
      if (edge >= 0 && this.edgeUp[edge] > this.state.cap / 100) {
        const p = document.createElement("p");
        p.className = "popup-note";
        p.textContent = steepNote(this.state.cap, this.edgeFwd[edge], this.edgeRev[edge]);
        box.appendChild(p);
      }
      const actions = document.createElement("div");
      actions.className = "popup-actions";
      const add = (label, which) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          this.map.closePopup();
          const pt = this.pointAt(latlng.lng, latlng.lat);
          if (!pt) return;
          this.setPoint(which, pt);
          this.recompute("auto");
        });
        actions.appendChild(b);
      };
      add("Set as start", "from");
      if (!this.state.loop) add("Set as destination", "to");
      box.appendChild(actions);
      L.popup({ closeButton: true, autoPan: true })
        .setLatLng(latlng)
        .setContent(box)
        .openOn(this.map);
    },

    /* the edge nearest a point, within px screen pixels, or -1 */
    edgeNear(latlng, px) {
      const map = this.map,
        geom = this.geom;
      const p0 = map.latLngToContainerPoint(latlng);
      const pad = map.containerPointToLatLng([p0.x + px, p0.y + px]);
      const dLon = Math.abs(pad.lng - latlng.lng),
        dLat = Math.abs(pad.lat - latlng.lat);
      let best = -1,
        bestD = px * px;
      for (let i = 0; i < geom.nEdges; i++) {
        const o = i * 4;
        if (
          geom.bbox[o + 2] < latlng.lng - dLon ||
          geom.bbox[o] > latlng.lng + dLon ||
          geom.bbox[o + 3] < latlng.lat - dLat ||
          geom.bbox[o + 1] > latlng.lat + dLat
        )
          continue;
        let prev = null;
        for (let k = geom.starts[i]; k < geom.starts[i + 1]; k += 2) {
          const q = map.latLngToContainerPoint([geom.coords[k + 1], geom.coords[k]]);
          if (prev) {
            const d = segDist2(p0, prev, q);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          prev = q;
        }
      }
      return best;
    },

    /* ---------------------------------------------------------- endpoints */
    /* Whatever was searched, tapped or located snaps to the nearest routable
     * corner within 150 m (spec 6.5); null, with a message, if there is none. */
    pointAt(lon, lat, label, gps = false) {
      const k = this.nodeGrid.nearest(lon, lat);
      const node = k >= 0 ? this.routable[k] : -1;
      const g = this.graph;
      if (node < 0 || metres(lon, lat, g.nodeLon(node), g.nodeLat(node)) > SNAP_M) {
        setStatus("No wheelchair-accessible street within 150 m.");
        return null;
      }
      return {
        lon: g.nodeLon(node),
        lat: g.nodeLat(node),
        node,
        gps,
        label: label || "Near " + this.index.describe(node),
      };
    },

    setPoint(which, pt) {
      this.state[which] = pt;
      if (which === "from" || which === "to") this.state.notch = null;
      const input = $(which);
      input.value = pt ? pt.label : "";
      this.updateStar(which);
      this.drawMarkers();
    },

    /* Start from the device's position (spec D16): on first load, and when
     * "My location" is picked. Denied or unavailable says so clearly. */
    useGps(initial) {
      if (!("geolocation" in navigator)) {
        if (!initial)
          setStatus("This browser cannot share its location. Search for a start instead.");
        return;
      }
      if (this.watchId === undefined) {
        this.watchId = navigator.geolocation.watchPosition(
          (pos) => this.onPosition(pos),
          (err) => this.onPositionError(err),
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
        );
      }
      this.wantGpsStart = true;
      if (this.gps) this.onPosition(null);
      else if (!this.state.from) {
        $("from").value = "My location";
        setStatus("Finding your location…");
      }
    },

    onPosition(pos) {
      if (pos) {
        this.gps = {
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
        };
        this.drawGps();
      }
      if (!this.wantGpsStart || !this.gps) return;
      this.wantGpsStart = false;
      const pt = this.pointAt(this.gps.lon, this.gps.lat, "My location", true);
      if (!pt) {
        $("from").value = "";
        return;
      }
      setStatus("");
      this.setPoint("from", pt);
      this.recompute(true);
    },

    onPositionError(err) {
      this.wantGpsStart = false;
      if (this.state.from && this.state.from.gps) this.setPoint("from", null);
      if ($("from").value === "My location") $("from").value = "";
      setStatus(
        err && err.code === 1
          ? "Location access is off. Search for a start, or tap the map."
          : "Your location is unavailable right now. Search for a start, or tap the map.",
      );
    },

    drawGps() {
      const p = this.gps;
      this.gpsLayer.clearLayers();
      if (!p) return;
      L.circle([p.lat, p.lon], {
        radius: p.accuracy,
        color: "#1f6fe5",
        weight: 1,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(this.gpsLayer);
      this.gpsDot = L.marker([p.lat, p.lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "gps-dot", iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(this.gpsLayer);
      $("recenter").hidden = false;
    },

    drawMarkers() {
      this.markers.clearLayers();
      for (const which of ["from", "to"]) {
        const p = this.state[which];
        if (!p || (which === "to" && this.state.loop)) continue;
        const m = L.marker([p.lat, p.lon], {
          draggable: true,
          keyboard: false,
          title: which === "from" ? "Start" : "Destination",
          alt: which === "from" ? "Start" : "Destination",
          icon: L.divIcon({
            className: "pin-icon " + which,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        }).addTo(this.markers);
        m.on("dragend", () => {
          const ll = m.getLatLng();
          const pt = this.pointAt(ll.lng, ll.lat);
          if (pt) this.setPoint(which, pt);
          else this.drawMarkers();
          this.recompute(false);
        });
      }
    },

    /* --------------------------------------------------------- the sheet */
    buildUI() {
      for (const which of ["from", "to"]) this.bindField(which);
      $("swap").addEventListener("click", () => {
        const a = this.state.from,
          b = this.state.to;
        this.setPoint("from", b);
        this.setPoint("to", a);
        this.recompute("auto");
      });
      $("loopbtn").addEventListener("click", () => {
        this.state.loop = this.state.loop ? null : { km: LOOP.def, outBack: false, idx: 0 };
        this.renderControls();
        this.drawMarkers();
        this.recompute(true);
      });
      $("loopkm").addEventListener("input", () => {
        this.state.loop.km = Number($("loopkm").value);
        this.state.loop.idx = 0;
        this.renderControls();
        this.throttle(() => this.recompute("auto"), 350);
      });
      $("loopkm").addEventListener("change", () => this.recompute("auto"));
      $("outback").addEventListener("change", () => {
        this.state.loop.outBack = $("outback").checked;
        this.state.loop.idx = 0;
        this.recompute(true);
      });
      const cap = $("cap");
      cap.addEventListener("input", () => {
        this.state.cap = Number(cap.value);
        this.state.notch = null;
        this.renderControls();
        this.streets.schedule();
        this.throttle(() => this.recompute("auto", true), CAP_THROTTLE_MS);
      });
      cap.addEventListener("change", () => {
        clearTimeout(this._throttle);
        this._throttle = null;
        this.recompute("auto");
      });
      $("notch").addEventListener("input", () => {
        this.state.notch = Number($("notch").value);
        this.showNotch();
        this.writeHash();
      });
      $("usecap").addEventListener("click", () => {
        this.state.cap = Number($("usecap").dataset.cap);
        this.renderControls();
        this.streets.redraw();
        this.recompute("auto");
      });
      $("nextloop").addEventListener("click", () => {
        const r = this.result;
        if (!r || !r.loops) return;
        this.state.loop.idx = (this.state.loop.idx + 1) % r.loops.length;
        this.showLoop();
        this.writeHash();
      });
      $("share").addEventListener("click", () => this.share());
      $("recenter").addEventListener("click", () => {
        if (this.gps)
          this.map.setView([this.gps.lat, this.gps.lon], Math.max(this.map.getZoom(), 16));
      });
      $("settingsbtn").addEventListener("click", () => $("settings").showModal());
      $("aboutbtn").addEventListener("click", () => $("about").showModal());
      for (const r of document.querySelectorAll("input[name=units]")) {
        r.checked = r.value === this.state.units;
        r.addEventListener("change", () => {
          this.state.units = r.value;
          saveUnits(r.value);
          this.renderControls();
          this.renderResult();
        });
      }
      const b = DATA.build || {};
      $("buildinfo").textContent =
        "Street data built " +
        (b.built || "?") +
        " from Overture " +
        (b.overture_release || "?") +
        " and USGS lidar " +
        (b.lidar_project || "?") +
        " (" +
        (b.git_sha || "?") +
        ").";
      window.addEventListener("resize", () => this.drawProfile());
    },

    /* a search field: suggestions as you type, favourites and "My location"
     * when empty, a star to keep the chosen place */
    bindField(which) {
      const input = $(which),
        list = $(which + "_s");
      let items = [],
        sel = -1;
      const render = () => {
        list.innerHTML = "";
        items.forEach((it, i) => {
          const li = document.createElement("li");
          li.id = which + "_opt" + i;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", i === sel ? "true" : "false");
          const n = document.createElement("span"),
            k = document.createElement("span");
          n.textContent = it.name;
          k.className = "k";
          k.textContent = it.kind;
          li.append(n, k);
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            pick(i);
          });
          list.appendChild(li);
        });
        list.hidden = items.length === 0;
        input.setAttribute("aria-expanded", items.length ? "true" : "false");
        if (sel >= 0) input.setAttribute("aria-activedescendant", which + "_opt" + sel);
        else input.removeAttribute("aria-activedescendant");
      };
      const suggestions = () => {
        const q = input.value.trim();
        const favs = loadFavourites().map((f) => ({ ...f, kind: "favourite" }));
        if (!q || q === (this.state[which] && this.state[which].label)) {
          const base =
            which === "from" && "geolocation" in navigator
              ? [{ name: "My location", kind: "GPS", gps: true }]
              : [];
          return base.concat(favs);
        }
        const nq = normName(q);
        const favHits = favs.filter((f) => normName(f.name).includes(nq));
        return favHits.concat(this.index.search(q, 8 - Math.min(favHits.length, 3)));
      };
      const pick = (i) => {
        const it = items[i];
        if (!it) return;
        items = [];
        render();
        if (it.gps) {
          this.state.from = null;
          this.useGps(false);
          input.blur();
          return;
        }
        const pt =
          it.node !== undefined
            ? { lon: it.lon, lat: it.lat, node: it.node, label: it.name, gps: false }
            : this.pointAt(it.lon, it.lat, it.name);
        if (!pt) return;
        this.setPoint(which, pt);
        const other = which === "from" ? "to" : "from";
        if (!this.state.loop && !this.state[other]) $(other).focus();
        else input.blur();
        this.recompute("auto");
      };
      input.addEventListener("focus", () => {
        items = suggestions();
        sel = -1;
        render();
        input.select();
      });
      input.addEventListener("input", () => {
        items = suggestions();
        sel = items.length ? 0 : -1;
        render();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && items.length) {
          sel = (sel + 1) % items.length;
          render();
          e.preventDefault();
        } else if (e.key === "ArrowUp" && items.length) {
          sel = (sel - 1 + items.length) % items.length;
          render();
          e.preventDefault();
        } else if (e.key === "Enter") {
          if (sel >= 0) pick(sel);
          e.preventDefault();
        } else if (e.key === "Escape") {
          items = [];
          render();
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        setTimeout(() => {
          items = [];
          render();
          const p = this.state[which];
          if (p) input.value = p.label;
        }, 150);
      });
      $(which + "_star").addEventListener("click", () => {
        const p = this.state[which];
        if (!p || p.gps) return;
        const res = toggleFavourite({ name: p.label, lon: p.lon, lat: p.lat });
        if (!res.stored)
          setStatus("This browser is not keeping data, so favourites cannot be saved.");
        this.updateStar(which);
      });
    },

    updateStar(which) {
      const p = this.state[which],
        star = $(which + "_star");
      star.hidden = !p || p.gps;
      if (!p) return;
      const on = loadFavourites().some((f) => f.name === p.label);
      star.setAttribute("aria-pressed", on ? "true" : "false");
      const what = which === "from" ? "start" : "destination";
      star.setAttribute(
        "aria-label",
        on ? "Remove " + what + " from favourites" : "Save " + what + " as a favourite",
      );
    },

    /* sliders and labels from the state */
    renderControls() {
      const s = this.state;
      $("cap").value = String(s.cap);
      $("cap_v").textContent = capLabel(s.cap);
      $("cap").setAttribute("aria-valuetext", capValueText(s.cap));
      const looping = !!s.loop;
      $("sheet").classList.toggle("looping", looping);
      $("loopbtn").setAttribute("aria-pressed", looping ? "true" : "false");
      $("loopbtn").setAttribute("aria-label", looping ? "Plan a trip instead" : "Make it a loop");
      $("looprow").hidden = !looping;
      $("traderow").hidden = looping;
      if (looping) {
        $("loopkm").value = String(s.loop.km);
        $("loopkm_v").textContent = fmtLoopLength(s.loop.km, s.units);
        $("loopkm").setAttribute("aria-valuetext", fmtLoopLength(s.loop.km, s.units));
        $("outback").checked = s.loop.outBack;
      }
    },

    throttle(fn, ms) {
      this._pending = fn;
      if (this._throttle) return;
      fn();
      this._pending = null;
      this._throttle = setTimeout(() => {
        this._throttle = null;
        if (this._pending) {
          const f = this._pending;
          this._pending = null;
          f();
        }
      }, ms);
    },

    /* ------------------------------------------------------------ routing */
    /* Route again after any change. The shortest route under the cap (or,
     * when none exists, under the smallest cap that works) shows at once;
     * the trade-off search then runs in slices. ``quick`` (while the cap
     * slider is being dragged) stops after the shortest route, so a drag
     * stays smooth; the full search runs on release. */
    recompute(fit, quick = false) {
      const gen = ++this.gen;
      this.result = null;
      this.writeHash();
      if (this.state.loop) return this.recomputeLoop(gen, fit);
      const { from, to, cap } = this.state;
      if (!from || !to) {
        this.clearRoute();
        if (!$("status").textContent || $("status").dataset.prompt)
          setStatus(!from ? "Where do you start?" : "Where to?", true);
        return;
      }
      if (from.node === to.node) {
        this.clearRoute();
        setStatus("Start and destination are the same corner.");
        return;
      }
      const g = this.graph;
      // the unconstrained shortest route does not depend on the cap
      const key = from.node + ">" + to.node;
      if (!this._plain || this._plain.key !== key) {
        const route = g.route(from.node, to.node, { alpha: 0 });
        this._plain = { key, route, ref: route ? g.summarise(route.arcs) : null };
      }
      let limit = cap / 100,
        need = null;
      let first = g.route(from.node, to.node, { alpha: 0 }, limit);
      if (!first) {
        const cStar = g.minimaxCap(from.node, to.node);
        if (cStar === null || !this._plain.route) {
          this.clearRoute();
          setStatus("These two places are not connected by wheelchair-accessible streets.");
          return;
        }
        need = Math.max(cap + 1, Math.ceil(cStar * 100 - 1e-9));
        this._needExact = Math.round(cStar * 1000) / 10;
        limit = cStar;
        first = g.route(from.node, to.node, { alpha: 0 }, limit);
      }
      const s0 = g.summarise(first.arcs);
      this.result = {
        need,
        ref: this._plain.ref,
        plainArcs: this._plain.route.arcs,
        notches: [{ arcs: first.arcs, length: s0.distance_m, gain: s0.elev_gain_m }],
        partial: true,
      };
      setStatus("");
      this.showNotch();
      // the map holds still while the cap is dragged; it refits on release
      if (quick) return;
      if (fit === true || (fit === "auto" && !this.inView())) this.fit();
      setTimeout(() => {
        if (gen !== this.gen) return;
        const t = g.tradeoff(from.node, to.node, limit);
        const run = () => {
          if (gen !== this.gen) return;
          if (!t.search.step(SLICE_MS)) {
            setTimeout(run, 0);
            return;
          }
          const notches = t.notches();
          this.result.notches = notches;
          this.result.partial = false;
          if (this.state.notch === null || this.state.notch >= notches.length)
            this.state.notch = defaultNotch(notches);
          this.showNotch();
          this.writeHash();
        };
        setTimeout(run, 0);
      }, 0);
    },

    recomputeLoop(gen, fit) {
      const { from, cap, loop } = this.state;
      if (!from) {
        this.clearRoute();
        setStatus("Where do you start?", true);
        return;
      }
      setStatus("Trying loops…");
      const search = this.graph.loops(from.node, {
        targetM: loop.km * 1000,
        cap: cap / 100,
        outBack: loop.outBack,
      });
      const run = () => {
        if (gen !== this.gen) return;
        if (!search.step(SLICE_MS)) {
          setTimeout(run, 0);
          return;
        }
        if (!search.loops.length || search.shortfall) {
          this.clearRoute();
          const near = nearestLoopKm(search, loop.km);
          setStatus(loopMissText(loop.km, cap, near, this.state.units));
          return;
        }
        this.result = { loops: search.loops };
        this.state.loop.idx = Math.min(loop.idx, search.loops.length - 1);
        setStatus("");
        this.showLoop();
        if (fit === true || (fit === "auto" && !this.inView())) this.fit();
        this.writeHash();
      };
      setTimeout(run, 0);
    },

    /* the trade-off notch on show */
    showNotch() {
      const r = this.result;
      if (!r || !r.notches) return;
      const n = r.notches.length;
      const i = r.partial ? 0 : clamp(this.state.notch ?? 0, 0, n - 1);
      const route = r.notches[i];
      const sl = $("notch");
      sl.max = String(Math.max(0, n - 1));
      sl.value = String(i);
      sl.disabled = r.partial || n < 2;
      const label = r.partial
        ? "Finding flatter routes…"
        : n < 2
          ? "Shortest is also the flattest"
          : tradeoffLabel(i, route, r.notches[0], this.state.units);
      $("notch_v").textContent = label;
      sl.setAttribute("aria-valuetext", tradeoffValueText(i, n, label));
      this.shown = route;
      this.renderBanner();
      this.renderResult();
      this.drawRoute(route.arcs, r.plainArcs);
    },

    showLoop() {
      const r = this.result;
      if (!r || !r.loops) return;
      const loop = r.loops[this.state.loop.idx];
      this.shown = { arcs: loop.arcs, length: loop.length, gain: loop.gain };
      $("nextloop").hidden = r.loops.length < 2;
      $("nextloop").textContent =
        "Another loop (" + (this.state.loop.idx + 1) + " of " + r.loops.length + ")";
      $("banner").hidden = true;
      this.renderResult();
      this.drawRoute(loop.arcs, null);
    },

    /* the infeasible banner (spec 6.3), for the route on show */
    renderBanner() {
      const r = this.result;
      if (!r || r.need === null) {
        $("banner").hidden = true;
        return;
      }
      const cap = this.state.cap;
      const blocks = steepBlocks(this.graph, this.index, this.shown.arcs, cap / 100);
      $("banner_t").textContent = infeasibleText(cap, this._needExact, blocks);
      const use = $("usecap");
      use.hidden = r.need > CAP.max;
      use.dataset.cap = String(r.need);
      use.textContent = "Use " + r.need + " %";
      $("banner").hidden = false;
    },

    renderResult() {
      const r = this.result;
      if (!r || !this.shown) return;
      const stats = this.graph.summarise(this.shown.arcs);
      this.shownStats = stats;
      const u = this.state.units;
      if (r.ref) {
        const parts = summaryParts(stats, r.ref, u);
        $("s_dist").textContent = parts.distance;
        $("s_climb").textContent = parts.climb;
        $("s_max").textContent = parts.steepest;
      } else {
        $("s_dist").textContent = fmtDistance(stats.distance_m, u);
        $("s_climb").textContent = fmtClimb(stats.elev_gain_m, u) + " climb";
        $("s_max").textContent = "max " + fmtGrade(stats.steepest);
      }
      $("summary").hidden = false;
      $("share").hidden = false;
      if (this.state.loop) {
        this.renderControls();
      }
      this.drawProfile();
    },

    clearRoute() {
      this.result = null;
      this.shown = null;
      this.routeLayer.clearLayers();
      this.shortestLayer.clearLayers();
      for (const id of ["summary", "prof", "share", "nextloop", "banner", "sharebox"])
        $(id).hidden = true;
      $("notch").disabled = true;
      $("notch_v").textContent = "";
    },

    /* the route coloured per arc by its uphill grade, over a white casing;
     * the unconstrained shortest route faint and dashed beneath */
    drawRoute(arcs, plainArcs) {
      const g = this.graph,
        geom = this.geom;
      this.routeLayer.clearLayers();
      this.shortestLayer.clearLayers();
      if (plainArcs && !sameArcs(plainArcs, arcs)) {
        L.polyline(g.geometry(plainArcs, geom), {
          color: css("--shortest"),
          weight: 3,
          opacity: 0.8,
          dashArray: "6 7",
          interactive: false,
        }).addTo(this.shortestLayer);
      }
      L.polyline(g.geometry(arcs, geom), {
        color: css("--casing"),
        weight: 10,
        opacity: 0.95,
        lineJoin: "round",
        lineCap: "round",
        interactive: false,
        renderer: this.svg,
      }).addTo(this.routeLayer);
      let run = [],
        colour = null;
      const flush = () => {
        if (!run.length) return;
        L.polyline(g.geometry(run, geom), {
          color: colour,
          weight: 6,
          lineJoin: "round",
          lineCap: "round",
          interactive: false,
          renderer: this.svg,
          className: "route-run",
        }).addTo(this.routeLayer);
      };
      for (const a of arcs) {
        const c = gradeColour(g, a);
        if (c !== colour) {
          flush();
          run = [];
          colour = c;
        }
        run.push(a);
      }
      flush();
      $("map").dataset.routeArcs = String(arcs.length);
      $("map").dataset.routeLength = String(Math.round(this.graph.summarise(arcs).distance_m));
    },

    /* elevation along the route, coloured like the map, with a dashed line
     * at the cap's slope for scale */
    drawProfile() {
      const cv = $("prof");
      if (!this.shown) return;
      cv.hidden = false;
      const g = this.graph,
        arcs = this.shown.arcs,
        prof = g.profile(arcs);
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth || 340,
        H = cv.clientHeight || 120;
      cv.width = W * dpr;
      cv.height = H * dpr;
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const d = prof.d,
        z = prof.z;
      if (d.length < 2) return;
      const total = d[d.length - 1] || 1;
      let zmin = Math.min(...z),
        zmax = Math.max(...z);
      const span = Math.max(zmax - zmin, 15);
      zmin -= span * 0.1;
      zmax = zmin + span * 1.25;
      const pad = 8,
        top = 10,
        bottom = 20;
      const X = (v) => pad + ((W - 2 * pad) * v) / total;
      const Y = (v) => top + (H - top - bottom) * (1 - (v - zmin) / (zmax - zmin));
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (let i = 0; i < arcs.length; i++) {
        ctx.strokeStyle = gradeColour(g, arcs[i]);
        ctx.beginPath();
        ctx.moveTo(X(d[i]), Y(z[i]));
        ctx.lineTo(X(d[i + 1]), Y(z[i + 1]));
        ctx.stroke();
      }
      // the cap as a slope, from the lowest point of the chart's left edge
      const cap = this.state.cap / 100;
      const mPerPxX = total / (W - 2 * pad),
        mPerPxY = (zmax - zmin) / (H - top - bottom);
      const slopePx = (cap * mPerPxX) / mPerPxY;
      const x0 = pad,
        y0 = H - bottom,
        run = Math.min(W - 2 * pad, (H - top - bottom) / Math.max(slopePx, 1e-6));
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = css("--muted");
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + run, y0 - run * slopePx);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--muted");
      ctx.font = "500 11px " + css("--mono");
      ctx.textAlign = "left";
      // labelled at the far end of the line, inside the chart
      const capText = this.state.cap + " % slope";
      const lx = Math.min(x0 + run + 6, W - pad - ctx.measureText(capText).width);
      ctx.fillText(capText, lx, Math.max(top + 10, y0 - run * slopePx + 4));
      const u = this.state.units;
      ctx.fillText(fmtClimb(z[0], u), pad, H - 5);
      ctx.textAlign = "right";
      ctx.fillText(fmtClimb(z[z.length - 1], u), W - pad, H - 5);
      ctx.textAlign = "center";
      ctx.fillText(fmtDistance(total, u), W / 2, H - 5);
      cv.setAttribute(
        "aria-label",
        "Elevation profile: " +
          fmtDistance(total, u) +
          ", from " +
          fmtClimb(z[0], u) +
          " to " +
          fmtClimb(z[z.length - 1], u) +
          ", steepest uphill " +
          fmtGrade(this.shownStats ? this.shownStats.steepest : 0),
      );
    },

    /* ---------------------------------------------------------- the view */
    viewBounds() {
      const b = L.latLngBounds([]);
      if (this.shown)
        for (const ll of this.graph.geometry(this.shown.arcs, this.geom)) b.extend(ll);
      for (const p of [this.state.from, this.state.loop ? null : this.state.to])
        if (p) b.extend([p.lat, p.lon]);
      return b;
    },
    padding() {
      const size = this.map.getSize(),
        sheet = $("sheet").getBoundingClientRect();
      return size.x >= 720
        ? { paddingTopLeft: [sheet.right + 24, 48], paddingBottomRight: [48, 48] }
        : { paddingTopLeft: [32, 64], paddingBottomRight: [32, sheet.height + 24] };
    },
    inView() {
      const b = this.viewBounds();
      if (!b.isValid()) return true;
      const pad = this.padding();
      const size = this.map.getSize();
      const sw = this.map.latLngToContainerPoint(b.getSouthWest()),
        ne = this.map.latLngToContainerPoint(b.getNorthEast());
      return (
        sw.x >= pad.paddingTopLeft[0] &&
        ne.y >= pad.paddingTopLeft[1] &&
        ne.x <= size.x - pad.paddingBottomRight[0] &&
        sw.y <= size.y - pad.paddingBottomRight[1]
      );
    },
    fit() {
      const b = this.viewBounds();
      if (!b.isValid()) return;
      this.map.fitBounds(b, { ...this.padding(), maxZoom: 16 });
    },

    /* ------------------------------------------------------------ sharing */
    shareState() {
      const s = this.state;
      const place = (p) => (p ? { lon: p.lon, lat: p.lat, label: p.label } : null);
      return {
        cap: s.cap,
        notch: s.notch,
        from: place(s.from),
        to: place(s.to),
        loop: s.loop ? { ...s.loop } : null,
      };
    },
    writeHash() {
      const token = encodeState(this.shareState());
      try {
        history.replaceState(null, "", token ? "#" + token : location.pathname + location.search);
      } catch {
        /* sandboxed: sharing still works through the Copy link button */
      }
    },
    applyShared(s) {
      this.state.cap = s.cap;
      this.state.notch = s.notch;
      this.state.loop = s.loop;
      const from = this.pointAt(s.from.lon, s.from.lat, s.from.label || undefined);
      if (from) this.setPoint("from", from);
      if (s.to) {
        const to = this.pointAt(s.to.lon, s.to.lat, s.to.label || undefined);
        if (to) this.setPoint("to", to);
      }
      this.state.notch = s.notch;
    },
    share() {
      const token = encodeState(this.shareState());
      const url = location.href.split("#")[0] + "#" + token;
      const btn = $("share"),
        box = $("sharebox");
      const done = () => {
        btn.textContent = "Link copied";
        setTimeout(() => {
          btn.textContent = "Copy link";
        }, 1800);
      };
      const fallback = () => {
        box.value = url;
        box.hidden = false;
        box.focus();
        box.select();
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(url).then(done, fallback);
      else fallback();
    },
  };

  /* ------------------------------------------------------------- helpers */
  function setStatus(text, prompt = false) {
    const el = $("status");
    el.textContent = text;
    if (prompt) el.dataset.prompt = "1";
    else delete el.dataset.prompt;
  }
  function metres(lon1, lat1, lon2, lat2) {
    const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
    return Math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * 110540);
  }
  function segDist2(p, a, b) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t =
      dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
    const x = a.x + t * dx - p.x,
      y = a.y + t * dy - p.y;
    return x * x + y * y;
  }
  function sameArcs(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  /* The route's arcs steeper than the cap, as blocks: consecutive steep
   * arcs along one street count once. Steepest first. */
  function steepBlocks(g, index, arcs, cap) {
    const steep = new Set(g.blockingArcs(arcs, cap));
    const runs = [];
    let run = null;
    for (const a of arcs) {
      if (!steep.has(a)) {
        run = null;
        continue;
      }
      const street = index.streetOf(a);
      if (run && run.street === street) run.arcs.push(a);
      else runs.push((run = { street, arcs: [a] }));
    }
    return runs
      .map((r) => ({
        ...index.blockOf(r.arcs),
        grade: Math.max(...r.arcs.map((a) => g.maxUp(a))),
      }))
      .sort((x, y) => y.grade - x.grade);
  }

  /* the loop length closest to what was asked that the search did find,
   * rounded to the slider's half kilometres, if it differs */
  function nearestLoopKm(search, km) {
    const all = search.all || [];
    if (!all.length) return null;
    const best = all.reduce((b, r) =>
      Math.abs(r.length / 1000 - km) < Math.abs(b.length / 1000 - km) ? r : b,
    );
    const k = clamp(Math.round((best.length / 1000) * 2) / 2, LOOP.min, LOOP.max);
    return k === km ? null : k;
  }

  window.App = App;
  App.start().catch((err) => {
    console.error(err);
    setStatus("Could not start: " + err.message);
  });
})();
