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
