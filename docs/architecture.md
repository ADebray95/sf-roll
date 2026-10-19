# Architecture

Roll SF is a static site. A Python pipeline turns public elevation and street data into one packed
graph file; the browser downloads that file once and does all routing, place search and loop
generation itself. There is no server.

```
USGS 3DEP lidar ─┐                                     ┌─ site/index.html
Overture streets ┼─► sf_flat_routes (Python) ─► site/ ─┼─ site/app-<hash>.js   (engine, format, search, simple)
Overture places ─┘   download → build-network → site   ├─ site/data/graph-<hash>.bin.gz
                                                        ├─ site/data/manifest.json
                                                        └─ site/data/hillshade-<hash>.png
```

## The live entry point

The deployed page is **`site/index.html`**. It is generated, never edited by hand, by
`sf_flat_routes/webapp.py` (`python -m sf_flat_routes site`) from these sources in
`sf_flat_routes/web/`:

| Built file                                                                  | Source                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `site/index.html`                                                           | `simple.html`, placeholders filled by `webapp.page_html`                                          |
| `site/app-<hash>.js`                                                        | `engine.js`, `format.js`, `search.js`, `simple.js`, concatenated (one classic script, no bundler) |
| `site/app-<hash>.css`                                                       | `simple.css`                                                                                      |
| `site/leaflet-<hash>.{js,css}`                                              | `sf_flat_routes/vendor/leaflet-1.9.4.*`, unmodified                                               |
| `site/data/graph-<hash>.bin.gz`                                             | `webgraph.build_payload` + `webgraph.bundle`, plus the place and address index from `places.py`   |
| `site/data/manifest.json`                                                   | `webapp.build_manifest`: build date, git commit, Overture release, lidar project, counts          |
| `site/data/hillshade-<hash>.png`                                            | `places.build_hillshade`, from the lidar DEM                                                      |
| `site/favicon.svg`, `site/.nojekyll`                                        | written by `webapp.write_site`                                                                    |
| `site/manifest.webmanifest`, `site/icon-*.png`, `site/apple-touch-icon.png` | `webapp.web_manifest`, `webapp.app_icon`                                                          |
| `site/sw.js`                                                                | `web/sw.js` with the build's cache version and file list (`webapp.service_worker`)                |

Every asset name carries a content hash, so a browser holding yesterday's `app.js` cannot run it
against today's `index.html`. `site/preview.jpg` and `site/robots.txt` are not produced by the
pipeline; they were committed by hand upstream.

The placeholders in `simple.html` (`<style>/*__APP_CSS__*/</style>`, `<!--__HEAD_EXTRA__-->`,
`/*__DATA__*/`, …) are filled by `webapp.fill`, which tolerates whitespace and refuses to build if
a placeholder is missing or duplicated.

Building needs the cached source data (~775 MB, see [`data.md`](data.md)), so CI never rebuilds
the site: `site/` is committed already built and `.github/workflows/pages.yml` uploads it as is.

## Pipeline (Python, `sf_flat_routes/`)

`python -m sf_flat_routes <cmd>`; every stage caches its output under `data/processed/`.

1. **`download`** (`download.py`, `sources.py`): the Overture transportation extract for the SF
   bounding box, the four USGS 3DEP 1 m lidar tiles, a 1/3 arc-second cross-check tile,
   neighbourhood boundaries, and Overture places, base and addresses for search.
2. **`build-network`** (`network.py`, `elevation.py`, `metrics.py`): wheelchair-routable edges,
   elevation profiles and per-direction metrics including `max_up_grade_15m`. [`data.md`](data.md)
   lists the rules.
3. **`site`** (`webapp.py`, `webgraph.py`, `places.py`): packs the graph and writes `site/`.
4. **`validate`** (`validate.py`): the spec's ground-truth checks, written to
   [`validation.md`](validation.md); `tests/test_validation.py` runs the same checks.

There is one travel profile, `config.WHEELCHAIR`. flattensf's neighbourhood-pair analysis,
explorer page, bicycle mode and GPX export were removed.

## The packed graph (`webgraph.py`)

One gzipped buffer of typed arrays plus a JSON manifest of offsets embedded in the page:

- nodes: `node_lon`/`node_lat` (int32 micro-degrees), `node_elev` (int16, 5 cm), `node_flags`
  (1 = in the routable component);
- arcs in CSR order (`indptr`, `arc_head`): `arc_len` (uint16, 5 cm), `arc_gain`/`arc_loss`
  (uint16, cm), `arc_maxup` (`max_up_grade_15m`, uint16, 0.01%), `arc_edge`, `arc_flags`
  (bit 0 routable, bit 2 drawn reversed);
- edges: one Google-encoded polyline string with per-edge offsets, `edge_name`, `edge_cls`,
  `edge_len`;
- place search: Overture places (JSON) and about 230,000 addresses (10 bytes each).

## Browser (`sf_flat_routes/web/`)

Four classic scripts, concatenated in this order (`webapp.APP_SCRIPTS`) into `site/app-<hash>.js`;
each publishes what it defines on `window`, which is also how the unit tests load them into a
Node `vm` context (`engine.fixtures.js`).

- **`engine.js`**: decoding (`Bundle`, `loadBundle`); `Graph` with `allowedArcs(cap)` (the per-cap
  arc mask every search uses), Dijkstra `route()`, `pareto()` (BOA*, the bi-objective search on
  length and climb, stepped in time slices), `tradeoff()` (shortest, flattest and the frontier for
  the slider), `minimaxCap()` (the smallest feasible cap), `blockingArcs()`, `loops()`,
  `summarise()` and `profile()`; `thinFrontier()` and `defaultNotch()` (spec 6.2); `Geometry`
  (decoded edge polylines); `Grid` (nearest-node lookup).
- **`format.js`**: every piece of text the interface shows (units, slider labels, the summary,
  the infeasible banner, the steep-street note) and the URL hash. Pure functions.
- **`search.js`**: the offline place index (`PlaceIndex`: intersections from the graph's street
  names, Overture places and addresses), block naming for the banner, and favourites and units in
  `localStorage` (`sfroll.favourites.v1`, `sfroll.units.v1`; every access wrapped in try/catch).
- **`simple.js`**: the app on Leaflet. The street canvas greys out streets steeper than the cap
  and repaints on every slider move; the route is drawn per arc in grade colours with the
  unconstrained shortest route dashed beneath; the bottom sheet holds start, destination (or loop
  length), the cap and trade-off sliders, the banner, the summary and the elevation profile.
  Changes recompute at once (cap drags at most every 100 ms); the state lives in the URL hash
  (`#r~cap~notch~…` trips, `#l~cap~km~…` loops).
- The base map is a lidar hillshade image plus the street lines painted from the graph on a canvas.
  The app loads no third-party map tiles.

## Offline and install

The site is a progressive web app: `manifest.webmanifest` makes it installable to the home screen
(standalone, theme colour, 192/512 px icons and an Apple touch icon), and `sw.js` precaches the
page, the scripts, the stylesheets, the graph and the hillshade on the first visit. Hashed files
are served cache-first and the page network-first; each build gets its own cache name and older
caches are deleted when the new worker activates, so a new graph replaces the old one. After one
visit, routing, search and loops work with no connection; only the web fonts fall back to system
fonts. The app has no map tiles to cache.

## Checks

| Layer                        | Tool                                                                          | Where                             |
| ---------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| Python lint / format / types | `ruff check`, `ruff format`, `ty check`                                       | `pyproject.toml`                  |
| Python tests                 | `pytest -m "not needs_data"` in CI; `needs_data` tests locally with the cache | `tests/`                          |
| JS lint / format             | `oxlint --deny-warnings`, `oxfmt --check`                                     | `.oxlintrc.json`, `.oxfmtrc.json` |
| JS types                     | `tsc --noEmit` with `checkJs` over JSDoc                                      | `tsconfig.json`                   |
| JS unit tests                | `vitest` on synthetic graphs                                                  | `sf_flat_routes/web/*.test.js`    |
| End-to-end                   | Playwright (iPhone 13 viewport) against the committed `site/`                 | `e2e/`                            |
| Workflows                    | `actionlint`, `zizmor`                                                        | `.github/workflows/`              |
| Secrets                      | `betterleaks`                                                                 | `prek` hook                       |

`ci.yml` runs all of these on pull requests and on `main`; `prek` runs the fast ones before each
commit.
