"""Neighbourhood boundaries: the city outline and the map's place labels."""

from __future__ import annotations

from pathlib import Path

from sf_flat_routes.config import CRS_PROJECTED, PROCESSED_DIR
from sf_flat_routes.download import NEIGHBORHOODS_GEOJSON
from sf_flat_routes.utils import get_logger

log = get_logger("sf_flat_routes.neighborhoods")

NEIGHBORHOODS_GPKG = PROCESSED_DIR / "neighborhoods.gpkg"


def load_neighborhoods(path: Path = NEIGHBORHOODS_GEOJSON, force: bool = False):
    """Load neighborhood polygons, projected, with cleaned attributes."""
    import geopandas as gpd

    if NEIGHBORHOODS_GPKG.exists() and not force:
        return gpd.read_file(NEIGHBORHOODS_GPKG)

    gdf = gpd.read_file(path)
    gdf = gdf.rename(columns={"name": "neighborhood"})
    gdf = gdf[["neighborhood", "geometry"]].copy()
    gdf = gdf.to_crs(CRS_PROJECTED)
    gdf["geometry"] = gdf.geometry.buffer(0)  # repair any self-touching rings
    gdf["area_km2"] = gdf.geometry.area / 1e6
    gdf = gdf.sort_values("neighborhood").reset_index(drop=True)
    NEIGHBORHOODS_GPKG.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(NEIGHBORHOODS_GPKG, driver="GPKG")
    log.info("loaded %d neighborhoods, %.1f km2 total", len(gdf), gdf["area_km2"].sum())
    return gdf


def city_boundary(neighborhoods=None, buffer_m: float = 250.0):
    """Union of the neighborhood polygons, optionally buffered."""
    from shapely.ops import unary_union

    nb = load_neighborhoods() if neighborhoods is None else neighborhoods
    geom = unary_union(nb.geometry.values)
    if buffer_m:
        geom = geom.buffer(buffer_m)
    return geom
