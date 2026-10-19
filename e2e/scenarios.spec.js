/* Spec 10.3: the scenario trips in tests/scenarios.yaml, run in the built app.
 *
 * Each trip is opened as a shared link and checked against its expectations.
 * With SCENARIO_REPORT=1 the run also writes docs/scenarios.md and a
 * screenshot of each trip to docs/scenarios/. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import YAML from "yaml";

const ROOT = new URL("../", import.meta.url);
const SPEC = YAML.parse(readFileSync(new URL("tests/scenarios.yaml", ROOT), "utf8"));
const REPORT = !!process.env["SCENARIO_REPORT"];
const results = [];

test.describe.configure({ mode: "serial" });
test.use({ permissions: [] });

/* In the page: a place from a query (the app's own search) or coordinates. */
async function resolve(page, place) {
  return page.evaluate((place) => {
    if (typeof place === "object") return { lon: place.lon, lat: place.lat, label: place.label };
    const hit = App.index.search(place, 1)[0];
    if (!hit) return null;
    return { lon: hit.lon, lat: hit.lat, label: place };
  }, place);
}

/* In the page: what the app shows now, and the checks that need the graph. */
function inspect(page, scenario, always) {
  return page.evaluate(
    ({ scenario, always }) => {
      const g = App.graph,
        index = App.index;
      const names = (node) => (index.nodeNames[node] || []).map((i) => App.geom.names[i - 1]);
      /* the arcs of `street` between its corners with `a` and `b` that climb */
      const uphillArcs = (spec) => {
        const [street, rest] = spec.split(":").map((s) => s.trim());
        const [a, b] = rest.split("/").map((s) => s.trim());
        const corners = (cross) => {
          const out = new Set();
          for (let n = 0; n < g.n; n++) {
            const s = names(n);
            if (s.includes(street) && s.includes(cross)) out.add(n);
          }
          return out;
        };
        const starts = corners(a),
          goals = corners(b);
        const prev = new Map([...starts].map((n) => [n, -1]));
        const queue = [...starts];
        while (queue.length) {
          const u = queue.shift();
          if (goals.has(u)) {
            const arcs = [];
            for (let v = u; prev.get(v) >= 0; v = g.arcTail(prev.get(v))) arcs.push(prev.get(v));
            const both = new Set();
            for (const a of arcs) {
              const e = g.arcEdge[a];
              for (let k = 0; k < g.m; k++) if (g.arcEdge[k] === e) both.add(k);
            }
            return [...both].filter((k) => g.arcGain[k] > g.arcLoss[k]);
          }
          for (let a = g.indptr[u]; a < g.indptr[u + 1]; a++) {
            if (index.streetOf(a) !== street || !(g.arcFlags[a] & 1)) continue;
            const v = g.head[a];
            if (!prev.has(v)) {
              prev.set(v, a);
              queue.push(v);
            }
          }
        }
        return null;
      };
      const r = App.result;
      const status = document.getElementById("status").textContent;
      const banner = document.getElementById("banner").hidden
        ? ""
        : document.getElementById("banner_t").textContent;
      const out = { status, banner, kind: "none" };
      if (!r || !App.shown) return out;
      const arcs = App.shown.arcs;
      const s = g.summarise(arcs);
      out.length = s.distance_m;
      out.climb = s.elev_gain_m;
      out.steepest = s.steepest;
      out.streets = [];
      for (const a of arcs) {
        const n = index.streetOf(a) || "(path)";
        const last = out.streets[out.streets.length - 1];
        if (!last || last[0] !== n) out.streets.push([n, g.arcLen[a] / g.DM]);
        else last[1] += g.arcLen[a] / g.DM;
      }
      if (r.loops) {
        out.kind = "loop";
        out.closed = g.arcTail(arcs[0]) === g.head[arcs[arcs.length - 1]];
        return out;
      }
      out.kind = r.need === null ? "route" : "fallback";
      out.need = r.need;
      out.notches = r.notches.length;
      out.notch = App.state.notch;
      out.ref = { length: r.ref.distance_m, climb: r.ref.elev_gain_m, steepest: r.ref.steepest };
      const avoid = [...(scenario.expect?.avoid_uphill ?? [])];
      if (scenario.cap <= always.max_cap) avoid.push(...always.blocks);
      out.avoid = avoid.map((spec) => {
        const up = uphillArcs(spec);
        if (up === null) return { spec, found: false, used: false };
        const used = r.notches.some((n) => n.arcs.some((a) => up.includes(a)));
        return { spec, found: true, used };
      });
      return out;
    },
    { scenario, always },
  );
}

function check(sc, got) {
  const e = sc.expect ?? {};
  const cap = sc.cap / 100;
  const problems = [];
  const fail = (msg) => problems.push(msg);
  if (e.route && got.kind !== "route") fail("expected a route under the cap");
  if (e.fallback && got.kind !== "fallback") fail("expected the fallback banner");
  if (e.route_or_fallback && !["route", "fallback"].includes(got.kind))
    fail("expected a route or the fallback banner");
  if (got.kind === "route" && got.steepest > cap + 1e-9) fail("route steeper than the cap");
  if (got.kind === "fallback" && e.banner_mentions) {
    if (!e.banner_mentions.some((n) => got.banner.includes(n)))
      fail(`banner names none of ${e.banner_mentions.join(", ")}`);
  }
  if (got.kind === "route") for (const a of got.avoid ?? []) if (a.used) fail(`climbs ${a.spec}`);
  if (e.climb_le_shortest && got.kind === "route" && got.climb > got.ref.climb + 0.5)
    fail("climbs more than the unconstrained shortest route");
  if (e.along && got.kind === "route") {
    const on = got.streets
      .filter(([n]) => e.along.streets.includes(n))
      .reduce((t, [, l]) => t + l, 0);
    if (on / got.length < e.along.share) fail(`only ${Math.round((100 * on) / got.length)}% along`);
  }
  if (e.loop && !(got.kind === "loop" && got.closed)) fail("expected a closed loop");
  if (e.loop_or_message && got.kind !== "loop" && !got.status.startsWith("No loop of about"))
    fail("expected a loop or the no-loop message");
  return problems;
}

for (const sc of SPEC.scenarios) {
  test(`${sc.id}: ${sc.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    // web fonts are not needed to check a route, and a slow font request
    // holds up every screenshot
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.goto("/");
    await page.waitForFunction(() => window.App && App.index, undefined, { timeout: 60_000 });
    const from = await resolve(page, sc.from);
    const to = sc.to ? await resolve(page, sc.to) : null;
    expect(from, `place not found: ${sc.from}`).not.toBeNull();
    if (sc.to) expect(to, `place not found: ${sc.to}`).not.toBeNull();
    const token = await page.evaluate((s) => encodeState(s), {
      cap: sc.cap,
      notch: null,
      from,
      to,
      loop: sc.loop_km ? { km: sc.loop_km, outBack: false, idx: 0 } : null,
    });
    await page.goto("about:blank");
    await page.goto("/#" + token);
    await page.waitForFunction(
      () =>
        window.App &&
        ((App.result && (App.result.loops || App.result.partial === false)) ||
          /^(No |These |Start and)/.test(document.getElementById("status").textContent)),
      undefined,
      { timeout: 90_000 },
    );
    await page.waitForTimeout(400);
    const got = await inspect(page, sc, SPEC.always_avoid_uphill);
    got.url = "/#" + token;
    const problems = check(sc, got);
    results.push({ sc, got, problems });
    if (REPORT) {
      mkdirSync(new URL("docs/scenarios/", ROOT), { recursive: true });
      await page.screenshot({
        path: new URL(`docs/scenarios/${sc.id}.jpg`, ROOT).pathname,
        type: "jpeg",
        quality: 70,
      });
    }
    if (!sc.pending_review) expect(problems).toEqual([]);
  });
}

test.afterAll(() => {
  if (!REPORT || !results.length) return;
  writeFileSync(new URL("docs/scenarios.md", ROOT), report(results));
});

/* ------------------------------------------------------------------ report */
const pct = (f) => (f === undefined ? "" : `${Math.round(f * 100)} %`);
const km = (m) => (m === undefined ? "" : `${(m / 1000).toFixed(2)} km`);
const m = (v) => (v === undefined ? "" : `${Math.round(v)} m`);

function outcome(got) {
  if (got.kind === "route") return `route, ${got.notches} notch${got.notches === 1 ? "" : "es"}`;
  if (got.kind === "fallback") return `fallback (needs ${got.need} %)`;
  if (got.kind === "loop") return "loop";
  return got.status || "nothing";
}

function verdict(sc, problems) {
  if (!problems.length) return "pass";
  return (sc.pending_review ? "for review: " : "**FAIL** ") + problems.join("; ");
}

function report(rows) {
  const lines = [
    "# Scenarios",
    "",
    "Generated by `SCENARIO_REPORT=1 pnpm exec playwright test e2e/scenarios.spec.js` from",
    "[`tests/scenarios.yaml`](../tests/scenarios.yaml), against the built site. Each trip is",
    "opened the way a shared link opens it, so the numbers are what the app shows (the default",
    "notch). **Waiting for Arnaud's review** before they are frozen as snapshots (spec 10.3).",
    "",
    "| # | Trip | Cap | Outcome | Distance | Climb | Steepest | Unconstrained shortest | Checks |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { sc, got, problems } of rows) {
    const ref = got.ref
      ? `${km(got.ref.length)}, ${m(got.ref.climb)}, ${pct(got.ref.steepest)}`
      : "";
    lines.push(
      `| ${sc.id} | ${sc.name} | ${sc.cap} % | ${outcome(got)} | ${km(got.length)} | ` +
        `${m(got.climb)} | ${pct(got.steepest)} | ${ref} | ${verdict(sc, problems)} |`,
    );
  }
  lines.push("");
  for (const { sc, got } of rows) {
    lines.push(`## ${sc.id}: ${sc.name}`, "");
    if (sc.pending_review) lines.push(`> **For review:** ${sc.pending_review}`, "");
    lines.push(`![${sc.id}](scenarios/${sc.id}.jpg)`, "");
    if (got.banner) lines.push(`Banner: “${got.banner}”`, "");
    if (got.kind !== "route" && got.kind !== "fallback" && got.kind !== "loop" && got.status)
      lines.push(`Message: “${got.status}”`, "");
    if (got.streets) {
      const via = got.streets.filter(([, l]) => l >= 60).map(([n]) => n.replace(/ Street$/, " St"));
      lines.push(`Via: ${via.join(" → ")}`, "");
    }
    for (const a of got.avoid ?? [])
      lines.push(
        `- ${a.spec}: ${a.found ? (a.used ? "**climbed**" : "not climbed") : "block not found in the graph"}`,
      );
    lines.push(`- Link: \`${got.url}\``, "");
  }
  return lines.join("\n") + "\n";
}
