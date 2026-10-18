# Roll SF: specification

Version 1.1, 2026-10-18 (1.0 of 2026-10-17, amended during the build; see §13). Owner: Arnaud Debray ([ADebray95](https://github.com/ADebray95)).

This spec is written for a coding agent working on its own. Read it fully before starting, follow the
milestones in order, and treat the acceptance criteria (§10) as the definition of done. When the
spec is silent, follow the "Decisions" table (§2) and the existing flattensf code, then note the
assumption in the PR description.

---

## 1. Goal

A public, mobile-first web app that finds wheelchair-friendly routes in San Francisco. Google Maps
picks the shortest path and ignores slope; a manual wheelchair user can push on flat and moderate
grades but struggles on steep uphills, and a detour of one or two blocks often avoids a steep block.

The app lets the user:

1. Set a **maximum uphill steepness** (hard constraint, slider). No route ever climbs a street
   steeper than that.
2. Slide between **shortest** and **least climbing** among routes that respect the limit, each
   option labelled "+X m distance · −Y m climb".
3. Generate **flat loops** of a chosen length from a starting point, under the same limit.

Primary user: Arnaud, a manual wheelchair user in SF, on an iPhone in the street. Phase 1 is
personal use; the repo and site are public.

### Non-goals (v1)

- Turn-by-turn navigation, voice guidance, automatic rerouting.
- Sidewalk geometry, sidewalk cross-slope, curb ramps, surface quality beyond excluding unpaved ways.
  Slope is the slope of the road centreline.
- A downhill limit.
- Cities other than San Francisco (keep region settings in config, but build only SF).
- Accounts, server backend, analytics, GPX export, bike or walking modes, Photon/online geocoding.
- A native app or App Store build.

---

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Audience | Personal first, public repo and public site. No accounts. |
| D2 | Region | San Francisco only. |
| D3 | Platform | Mobile-first website (works in iPhone Safari), installable to the home screen (PWA manifest + service worker). |
| D4 | Scope | Route preview with a live GPS dot. No turn-by-turn. |
| D5 | Objectives | Hard **uphill** max-grade constraint (slider) + distance-vs-climb trade-off slider. |
| D6 | Downhill | No downhill limit. |
| D7 | Surface | Road centreline slope only. Sidewalks and curb ramps out of scope. |
| D8 | Max-grade slider | 3–20 %, 1 % steps, default 8 %. Live recompute. |
| D9 | Budget | $0/month. Static site, no server. |
| D10 | Repo | GitHub fork of `almostimplemented/flattensf` into `ADebray95`, renamed `sf-roll`. App name "Roll SF". |
| D11 | Hosting | GitHub Pages, deployed by GitHub Actions. |
| D12 | Routable ways | See §5.1. Freeways always excluded; trunk excluded only where marked no-sidewalk/no-foot. Stairs, private and unpaved ways excluded. |
| D13 | Grade measure | A directed arc's grade = steepest uphill over any 15 m window of its smoothed profile; arcs < 15 m take the 15 m window centred on them along the same street (§13). |
| D14 | Trade-off slider | flattensf's Pareto frontier (bi-objective search on distance and climb), computed on arcs within the cap, thinned to ≤ 10 visibly different routes. No weighted-sum fallback. |
| D15 | Excluded streets | Arcs over the cap shown faintly grey on the map, updated live. |
| D16 | Inputs | Start and destination each by address search, map tap, or GPS. Start defaults to GPS. Favourites stored in `localStorage`. |
| D17 | Geocoding | flattensf's built-in offline place search (addresses, intersections, ~10k places). No Photon. |
| D18 | Route display | Colour by grade, faint shortest route, summary vs shortest, elevation profile, live GPS dot. |
| D19 | Infeasible | If no route fits the cap: say so, show the route that minimises the steepest uphill, and name the block that forces it. |
| D20 | Units | Metres/km and % by default; toggle to feet/miles, remembered in `localStorage`. |
| D21 | Modes | Remove bike mode and walking-only rules (steps cost 1.6×). One wheelchair profile. |
| D22 | Offline | Service worker caches app shell and graph. Map tiles stay online. |
| D23 | Stack | Keep flattensf's Python pipeline and vanilla JS. Add ruff, ty, pytest, oxlint, oxfmt, `tsc --checkJs`. No TypeScript rewrite. |
| D24 | Loops | Keep flattensf's loop mode. Respects the cap. Length 0.5–15 km, 0.5 km steps, default 3 km. "Allow out and back" kept, off by default. |
| D25 | GPX | Drop. |

---

## 3. Starting point: flattensf

Upstream: <https://github.com/almostimplemented/flattensf> (MIT, live at <https://flattensf.com>).
Facts verified on 2026-10-17 at the commit pushed 2026-10-08:

- **Pipeline** (`sf_flat_routes/`, Python, CLI `python -m sf_flat_routes <cmd>` with `sources`,
  `download`, `build-network`, `analyze`, `validate`, `map`, `report`, `all`, `sensitivity`, `route`).
  - Streets: Overture Maps transportation (release `2026-08-19.0`, ODbL), `network.py`.
  - Elevation: USGS 3DEP 1 m lidar DEM, project `CA_SanFrancisco_B23` (`elevation.py`,
    `sources.py`). Gaussian σ = 3 m pre-filter, 5 m sampling, Savitzky–Golay smoothing
    (`ElevationConfig` in `config.py`), bridges/tunnels interpolated rather than sampled.
  - Signed per-direction metrics: `metrics.directional_metrics`.
  - Modes: `WALK`, `BIKE` in `config.py` (`ModeConfig`, `NEVER_ROUTABLE_CLASSES`,
    `NEVER_ROUTABLE_SUBCLASSES`). Steps are routable for walking at 1.6×.
  - Browser graph: `webgraph.py` packs CSR arrays + polylines, gzip → `site/data/graph-<hash>.bin.gz`
    (~69.9k nodes, ~161k arcs, 4.8 MB).
  - Ground-truth validation: `validate.py`.
- **Browser app** (`sf_flat_routes/web/`): `engine.js` (graph decode, `MinHeap`, Dijkstra `route()`,
  `pareto()` bi-objective search), `simple.html/js/css` (the live UI), `app.js`, `warp.js`,
  vendored Leaflet 1.9.4. Loop mode and offline place search live in `simple.js` / `places.py`.
- **Site**: `site/` is committed **pre-built**, because building needs ~750 MB of cached lidar and
  Overture data that CI does not have. `.github/workflows/pages.yml` uploads `site/` to Pages.
  `site/CNAME` points at `flattensf.com` and must be removed.
- **Tests**: 155 pytest functions in `tests/` (routing, metrics invariants, passes, webgraph
  round-trip, places, route page via Playwright) plus `qa_*.py` scripts. Many assume the cached data.

Before changing anything, read `README.md`, `config.py`, `webgraph.py`, `engine.js` and `simple.js`
end to end, and record in `docs/architecture.md` which page is the live entry point and how
`site/` is produced from `sf_flat_routes/web/`.

Prior art for the hard cap (pattern only, no code import): `RJoshi141/even` (MIT),
`api/routing.py` `profile_sql()` makes an arc impassable when `grade > max_uphill`, mirrored for
the reverse direction.

---

## 4. Repository setup (Milestone 0)

1. Done on 2026-10-17: <https://github.com/ADebray95/sf-roll> (public fork), cloned at
   `~/Documents/sf-roll`, remotes `origin` (fork) and `upstream` (flattensf). The fork has **no
   `main` branch**: its default is `claude/sf-flat-routes-analysis-e33in5`, plus 11 upstream feature
   branches. Create `main` from the default branch's HEAD (`e4845cc`), push it, make it the default
   branch (`gh repo edit --default-branch main`), and ask Arnaud before deleting the other branches.
2. Delete `site/CNAME`. Set `pages.yml` to trigger on `main` only (remove the
   `claude/sf-flat-routes-analysis-*` branch). Pin all actions to full SHAs with version comments,
   `persist-credentials: false`, and pass `zizmor` and `actionlint`.
3. Add `NOTICE`: flattensf (MIT, copyright notice kept), USGS 3DEP (public domain), Overture Maps /
   OpenStreetMap (ODbL, with attribution shown in the app footer and map attribution).
4. Rewrite `README.md` for Roll SF: what it does, how to run locally, how to rebuild data, credits.
5. Move to `uv` + Python 3.13. Pin dependencies exactly (`==`) in `pyproject.toml`, commit `uv.lock`.
6. Add `package.json` (Node 22, ESM, exact pins) for dev tooling only: `oxlint`, `oxfmt`,
   `typescript` (for `tsc --noEmit --checkJs` over JSDoc-annotated JS), `vitest`, `fast-check`,
   `@playwright/test`, `@axe-core/playwright`. No bundler unless the existing build needs one.
   Look up current stable versions; don't assume.
7. Add a CI workflow (`ci.yml`) on PRs and `main`: `ruff check`, `ruff format --check`, `ty check`,
   `pytest -q -m "not needs_data"`, `oxlint`, `oxfmt --check`, `tsc`, `vitest run`, Playwright
   e2e against the committed `site/`. Mark data-dependent tests with a `needs_data` pytest marker.
8. Add `prek` hooks mirroring CI, plus a secret scanner (`betterleaks` or `gitleaks`).

Each milestone ends with a PR to `main` that passes CI.

---

## 5. Data pipeline (Milestone 1)

### 5.1 Wheelchair mode

Replace `WALK` and `BIKE` with a single `WHEELCHAIR` `ModeConfig`. Delete `BIKE`, `bikeways.py`,
`data/raw/sfmta_bike_network.geojson`, the edge-stress/"calm streets" logic and every bike code path
in Python and JS, plus their tests.

Routable (Overture `class`): `trunk`*, `primary`, `secondary`, `tertiary`, `residential`,
`living_street`, `unclassified`, `service`, `pedestrian`, `footway`, `path`, `cycleway`, `unknown`.

Excluded:

- `motorway`, `motorway_link`, and any `is_link` ramp off a trunk/motorway (already handled in
  `network.py`, keep it).
- `steps` (class or subclass), `track`, `bridleway`.
- `NEVER_ROUTABLE_SUBCLASSES` as today (`sidewalk`, `crosswalk`, `driveway`, `parking_aisle`).
- Private or destination-only access (existing `_PRIVATE_RECOGNIZED` logic) and
  `access_restrictions` denying `foot`.
- Unpaved surfaces: Overture `road_surface` in {`unpaved`, `dirt`, `gravel`, `grass`, `sand`, `ground`}.
- *`trunk` is excluded only where data marks it as having no sidewalk or no foot access.
  Overture exposes foot access via `access_restrictions`, but may not carry OSM's `sidewalk=no`.
  Check this first. If it doesn't, join `sidewalk=*` from an OSM extract (by OSM way id in
  Overture `sources`) or, if that is impractical, keep a short, documented blocklist of trunk
  segments in `config.py`. Record which path you took in `docs/architecture.md`.

No per-class comfort multipliers: the distance objective is real length.

Expected effect, to assert in tests: Van Ness Ave, Lombard St (US-101 section) and 19th Ave
remain routable; I-80, I-280, US-101 Central Freeway and their ramps are not.

### 5.2 Directional max grade (15 m window)

For every directed arc, compute `max_up_grade_15m`: the largest value of
`(z(s + 15 m) − z(s)) / 15 m` over the arc's **smoothed** elevation profile, in its direction of
travel, sampled at the existing 5 m spacing (windows slide by one sample). Arcs shorter than 15 m take
the 15 m window centred on them along the same street (§13). Steepness only counts when climbing,
so values are ≥ 0.

- Compute it per street segment's continuous profile, then cut per arc, so windows near arc ends
  can use neighbouring samples on the same street (do not reset at intersections inside a
  segment).
- Bridges and tunnels: use the interpolated profile flattensf already builds; never raw DEM.
- Clamp to `max_plausible_grade` (0.60) and log any arc that hits the clamp.
- Store per arc in the webgraph as a `uint16` in units of 0.01 % (or `uint8` in 0.25 % steps if
  size matters; the graph must stay under budget, §10.4). Add `webgraph` round-trip tests.

Keep the existing per-arc `gain` (climb) and `length`.

### 5.3 Graph build and publish

- `python -m sf_flat_routes build-network` then `python -m sf_flat_routes site` regenerates `site/data/graph-*.bin.gz`.
  Document the full rebuild in `docs/data.md`: required disk (~750 MB cache), runtime, commands.
- The built `site/` stays committed (CI cannot build data).
- Write `site/data/manifest.json` with the Overture release, lidar project, build date, git SHA and
  node/arc counts. Show the build date in the app's "About" sheet.

---

## 6. Routing engine (Milestone 2)

All routing runs in the browser in `engine.js`. Keep functions pure (graph + parameters → result)
so they are testable under Node with vitest on small synthetic graphs and on the real graph.

### 6.1 Cap filter

`allowed(arc, cap) = max_up_grade_15m[arc] ≤ cap`. Every search (shortest, Pareto, loops,
fallback) skips arcs where `allowed` is false. Cap changes must not require rebuilding the graph;
precomputing a bitmask per cap value (3–20 %, 18 masks) is fine if it helps speed.

### 6.2 Trade-off slider (Pareto)

1. Run flattensf's `pareto()` from start to destination on allowed arcs, objectives
   `(length, gain)`.
2. **Thin** the frontier, ordered by length ascending: always keep the first (shortest) and last
   (least climb) routes; keep an intermediate route only if it climbs at least
   `max(2 m, 5 % × climb of the shortest route)` less than the last kept route. If more than 10
   remain, keep the 10 that best spread over climb (always including both ends).
3. The slider has one notch per kept route. Notch 0 = shortest under the cap.
   Label: "+X m · −Y m climb" relative to notch 0 (notch 0 shows "Shortest").
4. Default notch: the flattest route whose length is within +25 % of notch 0. If none, notch 0.

### 6.3 Infeasible fallback

If the destination is unreachable under the cap:

1. Find the **minimum feasible cap** `c*`: the smallest `max_up_grade_15m` bottleneck over all
   start→destination paths (minimax path via modified Dijkstra, or binary search over the sorted
   distinct grades with reachability checks).
2. Compute the Pareto frontier at cap `c*` and show it as in §6.2.
3. Banner: "No route stays under 8 %. The gentlest route needs 11 % on Clay St between Jones St and
   Leavenworth St." Name the arc(s) with grade > user cap, using the street name plus cross-street
   names of its end nodes (intersection names from the places index). If several, name the steepest
   and say "+N other blocks".
4. Offer a button "Use 11 %" that sets the slider to `ceil(c*)`.

If start and destination are not connected at all (e.g. both endpoints snapped to separate components),
say so explicitly. Do not show a fallback.

### 6.4 Loops

Keep flattensf's loop generator. Changes:

- Only allowed arcs (§6.1).
- Length range 0.5–15 km, step 0.5 km, default 3 km.
- "Allow out and back" toggle kept, off by default.
- If no loop within ±15 % of the requested length exists under the cap, say "No loop of about
  3 km stays under 8 % from here" and suggest the nearest length or cap that works, if the search
  found one.

### 6.5 Snapping

Snap GPS/tapped/searched points to the nearest allowed arc within 150 m. If none, show
"No wheelchair-accessible street within 150 m".

---

## 7. User interface (Milestone 3)

Mobile-first (design at 375×812, works up to desktop). Rework `simple.html/js/css`; keep Leaflet
and the existing tile source unless its terms forbid this use (check and note in `NOTICE`).

### 7.1 Layout

- Full-screen map. Bottom sheet with:
  - **Start** field: defaults to "My location" (GPS). Address search, map tap ("Set as start"), or a favourite.
  - **Destination** field: address search, map tap, or a favourite. Swap button. Loop toggle
    (replaces destination with a length slider).
  - **Max uphill** slider: 3–20 %, default 8 %, value shown large ("Max uphill 8 %").
  - **Shortest ↔ Flattest** slider (§6.2) with the "+X m · −Y m climb" label.
  - Summary row: distance · climb · steepest uphill, each compared with the unconstrained
    shortest route, e.g. "1.4 km (+180 m) · 12 m climb (−22 m) · max 7 % (vs 17 %)".
  - Elevation profile chart for the selected route, with the uphill-cap line drawn on it.
- Favourites: star button on a chosen place; list in the search dropdown. Stored in `localStorage`
  (key `sfroll.favourites.v1`), each `{name, lat, lon}`. Wrap all storage access in try/catch.
- Units toggle (m/km ↔ ft/mi) in a settings sheet; stored in `localStorage`.
- About sheet: credits (§4.3), data build date, link to repo.

### 7.2 Map rendering

- Selected route coloured per arc by `max_up_grade_15m` in travel direction:
  green < 5 %, yellow 5–8 %, orange 8–12 %, red > 12 %. Downhill arcs shown green with a lighter
  tone (they are not a constraint).
- Unconstrained shortest route drawn faintly (thin grey dashed) for comparison.
- Arcs over the cap: faint grey overlay, updated live as the cap slider moves (render via a canvas
  layer; must stay smooth while dragging). Tapping one shows "Steeper than 8 % going uphill
  (14 %). Fine downhill."
- Live GPS dot with accuracy circle (`navigator.geolocation.watchPosition`). Recenter button. Handle
  permission denied with a clear message and fall back to tap/search.

### 7.3 Interaction rules

- Every change (cap, trade-off notch, endpoints, loop length) recomputes without a "Go" button.
  Throttle cap dragging so routing runs at most every 100 ms, and always on release.
- URL hash encodes state (start, destination, cap, notch, loop params) so a route can be shared
  and reloaded. Keep flattensf's "Copy link".
- All text in English. Touch targets ≥ 44 px. Sliders operable by VoiceOver (native
  `<input type="range">` with labels and `aria-valuetext` like "8 percent").

---

## 8. Offline and install (Milestone 4)

- `manifest.webmanifest` (name "Roll SF", icons 192/512 and Apple touch icon, `display: standalone`,
  theme colour).
- Service worker: precache app shell + `graph-<hash>.bin.gz` + places index; cache-first for hashed
  assets, network-first for `index.html`. A new graph hash invalidates the old cache entry.
- Map tiles: browser cache only (respect the tile provider's policy; no bulk precache).
- Once loaded, routing, search and loops work in airplane mode (map tiles excepted).

---

## 9. Code quality rules

- Functions ≤ 100 lines, cyclomatic complexity ≤ 8 for new or touched code. When touching a long
  existing function, split it.
- Line length 100. Absolute imports in Python.
- Google-style docstrings on public Python APIs; JSDoc types on all exported JS functions
  (checked by `tsc --checkJs`).
- Zero warnings from every tool. Inline ignores need a justification comment.
- Delete dead code left behind by removing bike/walk modes and GPX. Don't add feature flags.
- Commits: imperative, ≤ 72-char subject, one logical change each.

---

## 10. Acceptance criteria and evaluation

All automated checks run in CI unless marked `needs_data` (run locally with the cache, results
committed to `docs/validation.md`).

### 10.1 Data checks (`needs_data`, pytest)

Ground-truth blocks. Published grades are secondary-source peak values, so the check is a band. Any
miss must be investigated and written up, not "fixed" by tuning toward the number.

| Block | Published grade | Pass if `max_up_grade_15m` (uphill direction) |
|---|---|---|
| Filbert St, Hyde ↔ Leavenworth | 31.5 % | 25–38 % |
| 22nd St, Vicksburg ↔ Church | 31.5 % | 25–38 % |
| Bradford St, above Tompkins Ave | 40–41 % (short) | ≥ 25 % |
| Lombard St crooked section (Hyde → Leavenworth) | 27 % straight-line | ≥ 10 % along the switchbacks; record actual |
| The Embarcadero (Ferry Building ± 1 km) | flat | every arc < 3 % |
| Marina Blvd | flat | every arc < 3 % |
| Great Highway | flat | every arc < 4 % |

Also, for all arcs:

- `max_up_grade_15m(arc) ≥ average uphill grade(arc)` for arcs of 15 m or more, and it is 0 when the arc only descends.
- `gain − loss = z_end − z_start` per arc (existing invariant, keep).
- No routable arc has class `motorway`, `motorway_link`, or `steps`. Van Ness Ave, Lombard St
  (US-101) and 19th Ave have routable arcs.
- Histogram of `max_up_grade_15m` written to `docs/validation.md`. The share above 20 % should be
  small (sanity check, no hard threshold).

### 10.2 Routing properties (CI, vitest on the real graph + fast-check on synthetic graphs)

Run on ≥ 200 seeded random SF start/destination pairs, at caps {5, 8, 12, 20} %:

1. **Cap respected**: every arc of every returned route (any notch) has `max_up_grade_15m ≤ cap`.
2. **Shortest end is exact**: notch 0 length equals plain Dijkstra on allowed arcs (±0.5 m).
3. **Frontier ordering**: notches are strictly increasing in length and strictly decreasing in climb.
4. **Non-dominance**: no kept route is dominated by another route the search found.
5. **Thinning rule**: consecutive notches differ by ≥ the §6.2 climb threshold; ≤ 10 notches.
6. **Monotonic cap**: raising the cap never makes notch 0 longer.
7. **Fallback optimality**: when infeasible, `c*` equals the brute-force minimax on synthetic graphs
   (fast-check property), and the reported blocking arcs are exactly the route's arcs with grade > cap.
8. **Loops**: start = end, every arc respects the cap, length within ±15 % of target, no out-and-back
   unless allowed.
9. **Downhill unconstrained**: on a synthetic graph, a steep descent is used when it is shortest.

Mutation check: deliberately break `allowed()` (flip the comparison, then remove the check) and
confirm property 1 fails; record this in the PR.

### 10.3 Scenario trips (CI, snapshot after human review)

Stored in `tests/scenarios.yaml` as `{name, start, destination | loop_km, cap, expectations}`.
Expectations are properties, not exact geometry:

| # | Trip | Cap | Expectation |
|---|---|---|---|
| S1 | Filbert & Leavenworth → Filbert & Hyde | 8 % | Does not use Filbert between them uphill; route found or fallback names a block |
| S2 | 22nd & Church → 22nd & Vicksburg | 8 % | Does not use 22nd St between them uphill; detour or fallback |
| S3 | S2 reversed (downhill) | 8 % | May use 22nd St (downhill is unconstrained) |
| S4 | Ferry Building → Coit Tower | 8 % | Fallback triggered; banner names a Telegraph Hill block |
| S5 | Union Square → Fairmont Hotel (Nob Hill) | 8 % | Fallback or detour; steepest uphill on route ≤ reported value |
| S6 | Civic Center BART → Alamo Square | 8 % | Route found; steepest uphill ≤ 8 % |
| S7 | Castro & Market → Church & 20th (Dolores Park top) | 8 % | Route or fallback; if route, climb ≤ shortest-route climb |
| S8 | Mission & 24th → Castro & 24th | 8 % | Avoids the steepest 24th St blocks if a ≤ 8 % alternative exists |
| S9 | Embarcadero & Market → Marina Green | 5 % | Route found, mostly along the waterfront, max ≤ 5 % |
| S10 | Loop 3 km from Ferry Building | 5 % | Loop found |
| S11 | Loop 5 km from Dolores Park (Church & 18th) | 8 % | Loop found or clear "no loop" message |

Process: the agent runs the scenarios, writes results (length, climb, max grade, notches, fallback
text, screenshot) to `docs/scenarios.md`, and **asks Arnaud to review them** before freezing them as
snapshots. Arnaud will add his own real trips to the same file; they need no code changes.

### 10.4 Performance and size

- Route (Pareto + thinning) for any scenario: p95 < 500 ms on a mid-range phone (measure in
  Playwright with Chromium 4× CPU throttling as the proxy; also report a real iPhone timing
  manually if available). Loops: p95 < 2 s.
- Cap slider drag stays smooth: no long tasks > 100 ms while dragging (Performance API in Playwright).
- First load transferred size ≤ 6 MB excluding map tiles; repeat load served from service worker.
- Graph decode + ready-to-route < 2 s on throttled Chromium.

### 10.5 End-to-end (Playwright, iPhone 13 viewport, CI)

1. Load, search "24th & Mission" as start and "Dolores Park" as destination → route drawn, summary
   shows three metrics with comparisons.
2. Drag max uphill from 8 % to 5 % → route changes or fallback banner appears; grey overlay changes.
3. Move trade-off slider → label updates "+X m · −Y m climb", route redraws.
4. Toggle loop, set 3 km → loop drawn, returns to start.
5. Save a favourite, reload → favourite listed.
6. Switch units → values in ft/mi, persists after reload.
7. Mock geolocation → GPS dot appears, start = "My location"; deny permission → clear message.
8. Offline: load once, go offline (`context.setOffline(true)`), reload → app loads and routes.
9. Shared URL hash reproduces the same route.
10. Accessibility: `axe-core` scan reports no serious/critical issues.

### 10.6 Definition of done

- All CI checks green with zero warnings.
- `docs/validation.md` and `docs/scenarios.md` committed and reviewed by Arnaud.
- Site live at `https://adebray95.github.io/sf-roll/`, installable on iPhone, works offline after
  first load.
- README, NOTICE, `docs/architecture.md`, `docs/data.md` up to date.

---

## 11. Milestones

| M | Content | Exit |
|---|---|---|
| M0 | Fork, rename, cleanup (CNAME, branches), tooling + CI, NOTICE, README | CI green on unchanged behaviour |
| M1 | Wheelchair mode, bike/steps/GPX removal, `max_up_grade_15m`, webgraph field, data checks | §10.1 passes, graph rebuilt and committed |
| M2 | Cap filter, thinning, fallback, loops under cap | §10.2 passes |
| M3 | UI rework (§7) | §10.5 items 1–7, 9, 10 pass |
| M4 | PWA/offline, performance pass | §10.4 and §10.5 item 8 pass |
| M5 | Scenarios run and reviewed, docs, deploy | §10.3 reviewed, §10.6 met |

One PR per milestone. Don't merge without Arnaud's go-ahead.

---

## 12. Risks and open points to resolve during build

1. **Trunk sidewalk data** (§5.1): Overture may lack `sidewalk=no`. Resolve as described and document.
2. **Grade accuracy**: ground-truth grades come from secondary sources. If the pipeline disagrees
   with a published grade, sample the raw 1 m raster along the block before changing smoothing
   parameters, and record the finding.
3. **15 m window vs smoothing**: flattensf smooths with a Savitzky–Golay window (25–50 m). A long
   smoothing window can flatten a short steep pitch below the 15 m window's resolution. Compare
   `max_up_grade_15m` on the fully smoothed vs lightly smoothed (σ = 3 m only) profile for the
   §10.1 blocks, pick the smoothing that best matches ground truth without noise, and document it.
4. **Pareto blow-up** on long trips: if p95 > 500 ms, prune with ε-dominance on climb (e.g. 1 m
   buckets) inside the search before considering anything else.
5. **Tile provider policy**: confirm the tile source allows this use; switch to another free
   provider if not.
6. **Data licence**: the derived graph is ODbL (Overture/OSM). Keep attribution visible; the
   published graph file is a derived database and must carry the ODbL notice.

---

## 13. Amendments during the build

1. **Short arcs (D13, §5.2).** Arcs shorter than 15 m do not use their own average grade: half of
   all routable arcs are that short, and over a 1–3 m stub the lidar's decimetre noise reads as a
   10–60% grade (3,082 such arcs, 16th Street and Grant Avenue among them, would have been closed
   at an 8% cap). They take the 15 m window centred on them along the same street; a street
   segment shorter than 15 m spreads its rise over 15 m. The "≥ average uphill grade" invariant
   applies to arcs of 15 m or more. Details in `docs/validation.md`.
2. **flattensf's analysis removed.** The neighbourhood-pair study, corridors, passes, the explorer
   page, the static maps and `outputs/` are deleted; the site build no longer depends on them. The
   CLI is `sources`, `download`, `build-network`, `site`, `validate`, `all`.
3. **Trunk roads (§5.1, §12.1).** Overture has no sidewalk tag, but trunk segments without a footway
   carry `foot: denied`, which access evaluation already honours; no OSM join or blocklist was
   needed. Ramps (`is_link`) off trunk roads are excluded.
