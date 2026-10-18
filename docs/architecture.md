# Architecture

Roll SF is a static site. A Python pipeline turns public elevation and street data into one packed
graph file; the browser downloads that file once and does all routing, place search and loop
generation itself. There is no server.

```
USGS 3DEP lidar ─┐                                     ┌─ site/index.html
Overture streets ┼─► sf_flat_routes (Python) ─► site/ ─┼─ site/app-<hash>.js   (engine.js + simple.js)
Overture places ─┘   download → build-network          ├─ site/data/graph-<hash>.bin.gz
                     → analyze → map                   └─ site/data/hillshade-<hash>.png
```

## The live entry point

The deployed page is **`site/index.html`**, the route finder. It is generated, never edited by
hand, from these sources in `sf_flat_routes/web/`:

| Built file                           | Source                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `site/index.html`                    | `simple.html`, with placeholders filled in by `viz_interactive._route_page_html`                |
| `site/app-<hash>.js`                 | `engine.js` + `"\n"` + `simple.js`, concatenated (one classic script, no bundler)               |
| `site/app-<hash>.css`                | `simple.css`                                                                                    |
| `site/leaflet-<hash>.{js,css}`       | `sf_flat_routes/vendor/leaflet-1.9.4.*`, unmodified                                             |
| `site/data/graph-<hash>.bin.gz`      | `webgraph.build_payload` + `webgraph.bundle`, plus the place and address index from `places.py` |
| `site/data/hillshade-<hash>.png`     | `places.build_hillshade`, from the lidar DEM                                                    |
| `site/favicon.svg`, `site/.nojekyll` | written by `viz_interactive._write_route_page`                                                  |

Every asset name carries a content hash, so a browser holding yesterday's `app.js` cannot run it
against today's `index.html`. `site/preview.jpg` (the social preview card) and `site/robots.txt`
are not produced by the pipeline; they were committed by hand upstream.

`viz_interactive._write_route_page` writes the same page a second time as one self-contained file,
`outputs/sf_flat_route_finder.html`, with every asset inlined. `outputs/sf_flat_routes_map.html` is
flattensf's analysis explorer (`index.html`, `app.js`, `warp.js` and `engine.js`); it is not part of
the deployed site.

The placeholders in `simple.html` (`<style>/*__APP_CSS__*/</style>`, `<!--__HEAD_EXTRA__-->`,
`/*__DATA__*/`, …) are replaced verbatim, which is why the HTML templates are excluded from `oxfmt`.

### How `site/` is produced

`python -m sf_flat_routes map` (`__main__.cmd_map`) loads the pipeline context, reads the
corridor, pass and barrier layers written by `analyze`, and calls
`viz_interactive.make_interactive_map`, which writes the explorer and then the route page in both
forms. Building needs the cached source data in `data/raw/` (~725 MB), so CI never rebuilds the
site: `site/` is committed already built and `.github/workflows/pages.yml` uploads it as is.

## Pipeline (Python, `sf_flat_routes/`)

`python -m sf_flat_routes <cmd>`; every stage caches its output under `data/processed/`.

1. **`download`** (`download.py`, `sources.py`): Overture Maps transportation segments and
   connectors for the SF bounding box (Parquet row-group pruning keeps it to ~10 MB), the four USGS
   3DEP 1 m lidar tiles of project `CA_SanFrancisco_B23`, a 1/3 arc-second cross-check tile,
   neighbourhood boundaries, and Overture places, base and addresses for search.
2. **`build-network`** (`network.py`, `elevation.py`, `metrics.py`): splits segments at Overture
   connectors into edges (exact topology, no snapping), evaluates access rules per mode, samples the
   DEM every 5 m after a σ = 3 m Gaussian, interpolates bridges and tunnels, smooths each street
   segment's concatenated profile with a Savitzky–Golay filter, reconciles one elevation per
   intersection, and computes signed per-direction metrics (`metrics.directional_metrics`): gain,
   loss, maximum grade and distance above grade thresholds. Parameters live in
   `config.ElevationConfig`.
3. **`analyze`**: flattensf's neighbourhood-pair study (pairs, Pareto fronts, corridors, passes,
   barriers). The route finder does not use its results, but `map` reads its layers.
4. **`map`**: packs the graph and writes the pages (above).

Travel modes are `config.ModeConfig` entries; `webgraph._mode_availability` restricts each mode to
its largest strongly connected component so the browser and Python route identically.

## The packed graph (`webgraph.py`)

One gzipped buffer of typed arrays plus a JSON manifest of offsets embedded in the page:

- nodes: `node_lon`/`node_lat` (int32 micro-degrees), `node_elev` (int16, 5 cm), `node_flags`
  (bit per mode: node in that mode's component);
- arcs in CSR order (`indptr`, `arc_head`): `arc_len` (uint16, 5 cm), `arc_gain`/`arc_loss`
  (uint16, cm), `arc_maxgrade` (int16, 0.01 %), `arc_meangrade`, `arc_th<k>` (distance above each
  grade threshold), `arc_cls`, `arc_flags` (bit 0 walk, bit 1 bike, bit 2 drawn reversed);
- edges: one Google-encoded polyline string with per-edge offsets, names, class and display grade;
- place search: Overture places (JSON) and 230,000 addresses (10 bytes each).

## Browser (`sf_flat_routes/web/`)

- **`engine.js`**: decoding (`Bundle`, `loadBundle`), `Graph` with Dijkstra `route()`,
  `pareto()` (BOA*, bi-objective search on length and climb, stepped in time slices so the page
  keeps painting), `loops()` (petals and polygons around a start, ranked by climb), `summarise()`
  and `profile()`; `Geometry` (decoded edge polylines with bounding boxes); `Grid` (nearest-node
  lookup). It is a classic script that publishes its classes on `window`; the unit tests load it
  into a Node `vm` context.
- **`simple.js`**: the route finder UI on Leaflet: offline place search (`Index`), the street canvas
  layer, the shortest-to-flattest slider over the Pareto family, loop mode, the elevation profile,
  the URL hash (`#t~…` trips, `#l~…` loops) and units.
- The base map is a lidar hillshade image plus the street lines painted from the graph on a canvas.
  The app loads no third-party map tiles.

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
