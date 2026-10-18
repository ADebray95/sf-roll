"""SFMTA bikeway network, conflated onto the street graph, and the bike
"stress" multiplier the route page uses to prefer calm streets.

The SFMTA Bike Network (DataSF, ``MTA_Bike_Network_Linear_Features``) is a
set of centreline segments keyed by CNN, which Overture does not carry, so
the match is geometric: an edge takes a facility when at least half of the
points sampled along it lie within ``MATCH_M`` of an SFMTA segment that runs
roughly parallel to it.  Where several facilities match, the most protected
one wins.

Facility classes (SFMTA): I = off-street path, II = painted lane (possibly
buffered), III = signed route / sharrows, IV = separated bikeway.
``NEIGHBORWAY`` is a traffic-calmed class III.

The stress multiplier is in equivalent metres per metre: a block that feels
like 1.4 blocks.  It is a comfort scale, not a speed model, and it only ever
applies to the distance objective in bike mode when the rider asks for calm
streets, so the climbing axis of the frontier is untouched.
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString
from shapely.strtree import STRtree

from sf_flat_routes.config import RAW_DIR
from sf_flat_routes.utils import get_logger, step

log = get_logger("sf_flat_routes.bikeways")

BIKEWAYS_GEOJSON = RAW_DIR / "sfmta_bike_network.geojson"

#: distance within which an edge sample point counts as "on" an SFMTA segment
MATCH_M = 12.0
#: and the largest angle between the two for them to count as the same street
MATCH_DEG = 25.0
#: spacing of sample points along an edge
SAMPLE_M = 10.0

#: facility code per edge, most protected first (higher rank wins a tie)
FACILITIES = ("", "route", "neighborway", "lane", "buffered_lane", "separated", "path")
_RANK = {f: i for i, f in enumerate(FACILITIES)}

#: comfort multiplier by road class when there is no bikeway on the street
CLASS_STRESS = {
    "cycleway": 0.8,
    "living_street": 0.9,
    "path": 1.0,
    "residential": 1.0,
    "unclassified": 1.0,
    "track": 1.1,
    "service": 1.1,
    "unknown": 1.1,
    "pedestrian": 1.2,
    "tertiary": 1.2,
    "footway": 1.3,
    "secondary": 1.4,
    "primary": 1.6,
    "trunk": 2.0,
}
#: and by facility where there is one; a class III route keeps the street's
#: own rating, slightly softened and never worse than a tertiary street,
#: because sharrows do not change the traffic but SFMTA did pick the street
FACILITY_STRESS = {
    "path": 0.8,
    "separated": 0.8,
    "buffered_lane": 0.9,
    "lane": 1.0,
    "neighborway": 0.9,
}
ROUTE_SOFTEN = 0.95
ROUTE_CAP = 1.2


def _facility(props: dict) -> str:
    sym = (props.get("symbology") or "").upper()
    cls = (props.get("facility_t") or "").upper()
    if sym == "BIKE PATH" or cls == "CLASS I":
        return "path"
    if sym == "SEPARATED BIKEWAY" or cls == "CLASS IV":
        return "separated"
    if sym == "BIKE LANE" or cls == "CLASS II":
        return "buffered_lane" if (props.get("buffered") or "").upper() == "YES" else "lane"
    if sym == "NEIGHBORWAY":
        return "neighborway"
    if sym == "BIKE ROUTE" or cls == "CLASS III":
        return "route"
    return ""


def load_bikeways(path: Path = BIKEWAYS_GEOJSON) -> gpd.GeoDataFrame:
    """SFMTA bikeway segments with a ``facility`` column, in WGS84."""
    with open(path) as fh:
        data = json.load(fh)
    rows = []
    for f in data["features"]:
        g = f.get("geometry")
        if not g or g["type"] != "LineString" or len(g["coordinates"]) < 2:
            continue
        fac = _facility(f["properties"])
        if fac:
            rows.append(
                {
                    "facility": fac,
                    "street": f["properties"].get("streetname") or "",
                    "geometry": LineString(g["coordinates"]),
                }
            )
    gdf = gpd.GeoDataFrame(rows, crs="EPSG:4326")
    log.info("SFMTA bikeways: %d segments, %s", len(gdf), dict(gdf["facility"].value_counts()))
    return gdf


def _segments(line: LineString) -> np.ndarray:
    c = np.asarray(line.coords)[:, :2]
    return np.c_[c[:-1], c[1:]]  # x0 y0 x1 y1 per segment


def _sample(line: LineString, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """Points along the line and the local bearing (radians) at each."""
    n = max(2, int(line.length // spacing) + 1)
    d = np.linspace(0.0, line.length, n)
    # bearing from a short step along the line, so curves get local headings
    eps = min(1.0, line.length / 2)
    pts = [line.interpolate(x) for x in d]
    ahead = [line.interpolate(min(x + eps, line.length)) for x in d]
    behind = [line.interpolate(max(x - eps, 0.0)) for x in d]
    xy = np.array([(p.x, p.y) for p in pts])
    br = np.arctan2(
        [a.y - b.y for a, b in zip(ahead, behind, strict=False)],
        [a.x - b.x for a, b in zip(ahead, behind, strict=False)],
    )
    return xy, br


def conflate(edges: gpd.GeoDataFrame, bikeways: gpd.GeoDataFrame | None = None) -> pd.Series:
    """Facility per edge ('' where the street has none), aligned to ``edges``."""
    if bikeways is None:
        bikeways = load_bikeways()
    bw = bikeways.to_crs(edges.crs)
    # one straight piece per SFMTA vertex pair, so the heading test is local
    pieces, piece_fac = [], []
    for fac, geom in zip(bw["facility"], bw.geometry, strict=False):
        for x0, y0, x1, y1 in _segments(geom):
            pieces.append(LineString([(x0, y0), (x1, y1)]))
            piece_fac.append(fac)
    piece_fac = np.array(piece_fac)
    piece_br = np.array(
        [
            np.arctan2(p.coords[1][1] - p.coords[0][1], p.coords[1][0] - p.coords[0][0])
            for p in pieces
        ]
    )
    tree = STRtree(pieces)
    out = np.full(len(edges), "", dtype=object)
    cand = (
        edges.index[edges["bike_ok"].fillna(False).astype(bool)]
        if "bike_ok" in edges
        else edges.index
    )
    with step(f"conflating {len(pieces)} SFMTA bikeway pieces onto {len(cand)} edges", log):
        for i in cand:
            geom = edges.geometry.loc[i]
            if geom is None or geom.is_empty or geom.length < 1.0:
                continue
            xy, br = _sample(geom, SAMPLE_M)
            from shapely.geometry import Point

            pts = [Point(x, y) for x, y in xy]
            hit = np.zeros(len(pts), dtype=int) - 1
            for k, p in enumerate(pts):
                best = -1
                for j in tree.query(p.buffer(MATCH_M)):
                    if pieces[j].distance(p) > MATCH_M:
                        continue
                    da = abs((piece_br[j] - br[k] + np.pi / 2) % np.pi - np.pi / 2)
                    if np.degrees(da) > MATCH_DEG:
                        continue
                    if best < 0 or _RANK[piece_fac[j]] > _RANK[piece_fac[best]]:
                        best = j
                hit[k] = best
            matched = hit >= 0
            if matched.sum() * 2 >= len(pts):
                facs = piece_fac[hit[matched]]
                out[edges.index.get_loc(i)] = max(set(facs), key=lambda f: _RANK[f])
    s = pd.Series(out, index=edges.index, name="sfmta_facility")
    log.info("edges with an SFMTA facility: %s", dict(s[s != ""].value_counts()))
    return s


def stress(edges: pd.DataFrame, facility: pd.Series | None = None) -> np.ndarray:
    """Bike comfort multiplier per edge (1.0 = an ordinary residential block)."""
    cls = edges["cls"].fillna("unknown").to_numpy()
    m = np.array([CLASS_STRESS.get(c, 1.1) for c in cls])
    if facility is None:
        facility = (
            edges["sfmta_facility"]
            if "sfmta_facility" in edges
            else pd.Series("", index=edges.index)
        )
    fac = facility.fillna("").to_numpy()
    for f, v in FACILITY_STRESS.items():
        m[fac == f] = np.minimum(m[fac == f], v)
    r = fac == "route"
    m[r] = np.maximum(0.9, np.minimum(m[r], ROUTE_CAP) * ROUTE_SOFTEN)
    return m
