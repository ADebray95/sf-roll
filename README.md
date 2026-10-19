# Roll SF

Wheelchair-friendly routes in San Francisco, in the browser.

Google Maps picks the shortest path and ignores slope. A manual wheelchair user can push on flat and
moderate grades but struggles on steep uphills, and a detour of a block or two often avoids a steep
one. Roll SF lets you:

1. set a **maximum uphill steepness**; no route ever climbs a street steeper than that,
2. slide between the **shortest** and the **least climbing** routes that respect the limit,
3. generate **flat loops** of a chosen length from a starting point, under the same limit.

Everything runs on your phone: the whole street graph is downloaded once (about 5 MB) and routing,
place search and loops run locally. There is no server, no account and no tracking.

Design notes are in [`docs/architecture.md`](docs/architecture.md).

## Status

Roll SF is a fork of [flattensf](https://github.com/almostimplemented/flattensf), built in
milestones from [`docs/spec.md`](docs/spec.md). Routing under the uphill cap, the trade-off
slider, loops, offline search, favourites, the infeasible-route explanation, installing to the
home screen and offline use all work; the scenario trips are being reviewed.

## Running locally

The built site is committed in [`site/`](site/). Serve it with any static file server:

```bash
python3 -m http.server 8000 --directory site
# open http://127.0.0.1:8000/
```

## Development

Requirements: [uv](https://docs.astral.sh/uv/) (it installs Python 3.13), Node 22 and pnpm.

```bash
uv sync                      # Python 3.13 and the pinned dependencies
pnpm install                 # JS dev tooling (no runtime dependencies)
pnpm exec playwright install chromium
uv run prek install          # git hooks that mirror CI
```

Checks, as CI runs them:

```bash
uv run ruff check && uv run ruff format --check && uv run ty check
uv run pytest -q -m "not needs_data"
pnpm exec oxlint --deny-warnings && pnpm exec oxfmt --check && pnpm run typecheck
pnpm run test                # vitest unit tests of the routing engine
pnpm run e2e                 # Playwright against the committed site/
```

Tests marked `needs_data` need the cached source data (below) and only run locally.

The scenario trips in [`tests/scenarios.yaml`](tests/scenarios.yaml) run in the e2e suite; to
refresh [`docs/scenarios.md`](docs/scenarios.md) and its screenshots, run
`SCENARIO_REPORT=1 pnpm exec playwright test e2e/scenarios.spec.js`. Add your own trips to the
YAML file: places are searched the way the app's search box does, so no code changes are needed.

## Rebuilding the data

Building the street graph needs about 775 MB of public source data (USGS 1 m lidar and an Overture
Maps extract), which is why `site/` is committed already built and CI does not rebuild it.

```bash
uv run python -m sf_flat_routes all   # download, build-network, site, validate
```

[`docs/data.md`](docs/data.md) has the stages, the routing rules and the timings;
[`docs/validation.md`](docs/validation.md) has the ground-truth checks of the grades.

## Deploying

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `site/` to GitHub Pages on
every push to `main` that touches it: <https://adebray95.github.io/sf-roll/>.

## Credits

- [flattensf](https://github.com/almostimplemented/flattensf) by Drew Edwards (MIT): the elevation
  pipeline, the packed browser graph, the bi-objective router, loops and offline place search.
- Street data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors via
  [Overture Maps](https://overturemaps.org), ODbL 1.0.
- Elevation: USGS 3D Elevation Program, public domain.
- [Leaflet](https://leafletjs.com) (BSD 2-Clause).

Full notices are in [`NOTICE`](NOTICE). Code is MIT ([`LICENSE`](LICENSE)); the published street
graph is a derived database under the ODbL.
