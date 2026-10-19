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
