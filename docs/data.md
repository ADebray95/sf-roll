# Data: sources and how to rebuild

The street graph in `site/data/graph-<hash>.bin.gz` is built from public data by the Python
pipeline in `sf_flat_routes/`. CI cannot rebuild it (the source data is ~775 MB), so the built
`site/` is committed; rebuild it locally after changing the pipeline or the routing rules.

## Sources

`uv run python -m sf_flat_routes sources` prints the full table with URLs, dates and licences.

| Data                                                             | What it is for                         | Size    | Licence           |
| ---------------------------------------------------------------- | -------------------------------------- | ------- | ----------------- |
| USGS 3DEP 1 m lidar DEM, project `CA_SanFrancisco_B23`, 4 tiles  | street grades                          | ~500 MB | public domain     |
| USGS 3DEP 1/3 arc-second DEM, tile `n38w123`                     | cross-check only                       | ~210 MB | public domain     |
| Overture Maps transportation, release `2026-08-19.0`, SF extract | the street network                     | ~10 MB  | ODbL 1.0          |
| Overture places, base theme and addresses, same release          | offline place search                   | ~25 MB  | ODbL / CDLA-P 2.0 |
| SF planning neighbourhoods                                       | city outline (clipping) and map labels | small   | open data         |

## Rebuilding

Requirements: [uv](https://docs.astral.sh/uv/), about 1.5 GB of free disk (source data plus the
processed cache in `data/processed/`), and a network connection for the first step.

```bash
uv run python -m sf_flat_routes download        # ~1 min on a fast connection; cached in data/raw/
uv run python -m sf_flat_routes build-network   # ~2-3 min: edges, elevation, per-arc metrics
uv run python -m sf_flat_routes site            # ~20 s: packs the graph, writes site/
uv run python -m sf_flat_routes validate        # ground-truth checks -> docs/validation.md
uv run pytest -q -m needs_data                  # the same checks as tests
```

or `uv run python -m sf_flat_routes all`. Every stage caches its output; `--force` recomputes it.
After changing `metrics.py` or `network.py`, delete `data/processed/edges_*.parquet` (or pass
`--force` to `build-network`, which also resamples the DEM).

`download` logs a warning and carries on if the Overture places or addresses request fails
(a dropped connection has been seen); `site` then refuses to build. Run `download` again: what is
already cached is skipped.

Commit `site/` and `docs/validation.md` together after a rebuild. The site's
`data/manifest.json` records the build date, the git commit the pipeline ran from, the Overture
release, the lidar project and the node and arc counts.

### The smoothing comparison

`docs/validation.md` compares the steep blocks under the normal pipeline and under light smoothing
(the σ = 3 m DEM filter only, spec section 12.3). The light build goes in its own run directory:

```bash
SFFR_RUN_DIR=data/runs/light-smoothing SFFR_OVERRIDES='{"smooth_window_m": 5}' \
  uv run python -m sf_flat_routes build-network
uv run python -m sf_flat_routes validate        # picks the comparison up when it exists
```

## What the pipeline computes

- **Routable ways** (`network.py`, `config.WHEELCHAIR`): Overture road classes trunk, primary,
  secondary, tertiary, residential, living_street, unclassified, service, pedestrian, footway,
  path, cycleway and unknown. Excluded: motorways and their links, ramps (`is_link`) off trunk
  roads, steps, tracks, bridleways, sidewalk/crosswalk/driveway/parking-aisle subclasses, anything
  closed to pedestrians or private/destination-only in Overture's access rules, and unpaved
  surfaces (`road_surface` unpaved, dirt, gravel, grass, sand, ground; a partial rule excludes the
  edges whose midpoint it covers). One-way rules are ignored.
- **Elevation** (`elevation.py`): the DEM is filtered with a σ = 3 m Gaussian and sampled every
  5 m along each edge; bridges and tunnels are interpolated between their ends rather than
  sampled; each street segment's concatenated profile is smoothed with a Savitzky–Golay filter
  (~50 m window); every intersection is reconciled to one elevation.
- **Per directed arc** (`metrics.py`): length, climb and descent (with a 0.5 m dead-band), and
  `max_up_grade_15m`, the steepest climb over any 15 m stretch in the direction of travel, computed
  on the street segment's continuous profile so windows near an arc's ends reach into the next
  block of the same street. Arcs shorter than 15 m take the 15 m window centred on them; values are
  clamped at 60%, and a direction that never rises gets 0. `docs/validation.md` explains the
  short-arc rule.
- **Packing** (`webgraph.py`): only arcs in the largest strongly connected component are kept
  (Treasure Island and isolated footway fragments drop out); `max_up_grade_15m` is stored as a
  uint16 in 0.01% steps.
