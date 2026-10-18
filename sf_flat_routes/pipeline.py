"""Orchestration: assemble the cached street network, elevation and metrics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import pandas as pd

from sf_flat_routes.utils import configure_gdal_for_proxy, get_logger, step

if TYPE_CHECKING:
    import geopandas as gpd

log = get_logger("sf_flat_routes.pipeline")


@dataclass
class Context:
    """Everything the later stages need, loaded from cache where possible."""

    edges: gpd.GeoDataFrame  # undirected, with metrics
    directed: pd.DataFrame  # directed edge table
    profiles: dict  # edge_id -> (dist, elev)
    neighborhoods: gpd.GeoDataFrame


def build_context(force: bool = False) -> Context:
    """Load or build the street network, its elevation profiles and metrics."""
    from sf_flat_routes.download import SEGMENTS_PARQUET
    from sf_flat_routes.elevation import sample_edge_profiles
    from sf_flat_routes.metrics import compute_edge_metrics
    from sf_flat_routes.neighborhoods import load_neighborhoods
    from sf_flat_routes.network import build_edges

    configure_gdal_for_proxy()
    with step("preparing street network", log):
        raw_edges = build_edges(SEGMENTS_PARQUET, force=force)
    with step("sampling elevation", log):
        prof = sample_edge_profiles(raw_edges, None, force=force)
    with step("computing edge metrics", log):
        edges, directed = compute_edge_metrics(raw_edges, prof, force=force)
    return Context(
        edges=edges, directed=directed, profiles=prof, neighborhoods=load_neighborhoods()
    )
