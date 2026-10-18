# Data directory

This directory is populated by the pipeline and is **not** tracked in git.

- `raw/`: cached source downloads, never modified after they land: the
  Overture Maps extracts, the four USGS 3DEP 1 m lidar tiles, the 1/3
  arc-second cross-check tile and the neighbourhood boundaries. Populate with
  `python -m sf_flat_routes download` (~775 MB).
- `processed/`: cached intermediate products: the clipped DEM mosaic, the edge
  table, per-edge elevation profiles and the directed arc metrics. Populate
  with `python -m sf_flat_routes build-network`.
- `runs/`: alternative builds under `SFFR_RUN_DIR` (the smoothing comparison).

Nothing here needs to be kept: every file is rebuilt from the sources listed by
`python -m sf_flat_routes sources`. See `docs/data.md`.
