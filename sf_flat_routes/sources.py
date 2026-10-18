"""Registry of every external dataset used by the project.

Each entry records the URL, the access date, resolution/vintage, licence and
the limitations that matter for this analysis.  ``python -m sf_flat_routes
sources`` prints this table, and it is the single source of truth for the
data-provenance section of the README.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Date on which every URL below was last fetched and verified.
ACCESS_DATE = "2026-09-16"

#: Overture Maps release used for the street network.
OVERTURE_RELEASE = "2026-08-19.0"
OVERTURE_BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
OVERTURE_PREFIX = f"release/{OVERTURE_RELEASE}/theme=transportation"
#: Places and addresses themes of the same release, used only for the route
#: page's offline place search (fetched 2026-10-04).
OVERTURE_PLACES_PREFIX = f"release/{OVERTURE_RELEASE}/theme=places"
OVERTURE_ADDRESSES_PREFIX = f"release/{OVERTURE_RELEASE}/theme=addresses"
OVERTURE_BASE_PREFIX = f"release/{OVERTURE_RELEASE}/theme=base"

#: USGS 3DEP 1 m lidar project covering San Francisco.
TNM_BUCKET = "https://prd-tnm.s3.amazonaws.com"
LIDAR_PROJECT = "CA_SanFrancisco_B23"
LIDAR_PREFIX = f"StagedProducts/Elevation/1m/Projects/{LIDAR_PROJECT}/TIFF"
LIDAR_TILES = (
    "USGS_1M_10_x54y418_CA_SanFrancisco_B23.tif",
    "USGS_1M_10_x54y419_CA_SanFrancisco_B23.tif",
    "USGS_1M_10_x55y418_CA_SanFrancisco_B23.tif",
    "USGS_1M_10_x55y419_CA_SanFrancisco_B23.tif",
)

#: USGS 1/3 arc-second seamless DEM tile, used only to cross-validate the
#: lidar product (it is ~10 m and far too coarse for street grades).
SEAMLESS_DEM_URL = (
    f"{TNM_BUCKET}/StagedProducts/Elevation/13/TIFF/current/n38w123/USGS_13_n38w123.tif"
)

#: San Francisco neighborhood polygons.
NEIGHBORHOOD_URL = (
    "https://raw.githubusercontent.com/codeforamerica/click_that_hood/"
    "master/public/data/san-francisco.geojson"
)


@dataclass(frozen=True)
class Dataset:
    key: str
    title: str
    publisher: str
    url: str
    accessed: str
    resolution: str
    licence: str
    limitations: str
    role: str
    local: str = ""
    notes: str = ""
    optional: bool = False
    substituted: bool = False
    substitution_reason: str = ""


DATASETS: tuple[Dataset, ...] = (
    Dataset(
        key="overture_segments",
        title=f"Overture Maps transportation segments (release {OVERTURE_RELEASE})",
        publisher="Overture Maps Foundation (derived from OpenStreetMap)",
        url=f"{OVERTURE_BUCKET}/{OVERTURE_PREFIX}/type=segment/",
        accessed=ACCESS_DATE,
        resolution="Vector linestrings; OSM-equivalent positional accuracy (~1-5 m)",
        licence="ODbL 1.0 (OpenStreetMap contributors); Overture schema CDLA-Permissive 2.0",
        role="Routable street network: geometry, road class, per-mode access "
        "restrictions, bridge/tunnel flags and connector topology.",
        local="data/raw/overture_segments_sf.parquet",
        limitations=(
            "OSM-derived, so completeness and tagging quality vary by area. "
            "Road classification of SF arterials is inconsistent in places "
            "(Van Ness Ave, 19th Ave, Lombard St and part of Mission St are "
            "tagged 'trunk' although they are ordinary surface streets, so "
            "'trunk' cannot be excluded from walking/biking). A few freeway "
            "ramp segments carry the surface street's name (Octavia Blvd, "
            "Junipero Serra Blvd). Sidewalk and crosswalk geometry is present "
            "but of uneven completeness and is deliberately not used."
        ),
        notes="Read with Parquet row-group bbox pruning: only 7 of 16,384 "
        "global row groups intersect San Francisco, so the whole "
        "extract costs a few seconds and ~10 MB instead of 64 GB.",
    ),
    Dataset(
        key="overture_connectors",
        title=f"Overture Maps transportation connectors (release {OVERTURE_RELEASE})",
        publisher="Overture Maps Foundation (derived from OpenStreetMap)",
        url=f"{OVERTURE_BUCKET}/{OVERTURE_PREFIX}/type=connector/",
        accessed=ACCESS_DATE,
        resolution="Vector points",
        licence="ODbL 1.0; Overture schema CDLA-Permissive 2.0",
        role="Authoritative intersection nodes. Using connector IDs for graph "
        "topology avoids geometric snapping tolerances entirely.",
        local="data/raw/overture_connectors_sf.parquet",
        limitations="Connectors exist only where OSM ways share a node; "
        "grade-separated crossings correctly do not connect.",
    ),
    Dataset(
        key="dem_1m",
        title=f"USGS 3DEP 1 metre bare-earth DEM, project {LIDAR_PROJECT}",
        publisher="U.S. Geological Survey, 3D Elevation Program",
        url=f"{TNM_BUCKET}/{LIDAR_PREFIX}/",
        accessed=ACCESS_DATE,
        resolution="1 m ground sample distance; NAD83/UTM 10N (EPSG:26910); "
        "float32 metres above NAVD88",
        licence="Public domain (U.S. Government work)",
        role="Primary elevation source for all grade and climbing metrics.",
        local="data/raw/dem/*.tif",
        limitations=(
            "Bare-earth interpolation leaves artefacts on bridges, tunnels and "
            "elevated structures, where the DEM samples the ground or water "
            "surface underneath rather than the deck -- handled explicitly by "
            "interpolating elevation across segments flagged is_bridge or "
            "is_tunnel. Residual noise of a few decimetres from vehicles, "
            "curbs and vegetation misclassification is handled by "
            "Savitzky-Golay smoothing plus a gain dead-band. Four 10 km tiles "
            "(~523 MB total) are cloud-optimised GeoTIFFs, so windowed reads "
            "are cheap."
        ),
    ),
    Dataset(
        key="dem_13",
        title="USGS 3DEP 1/3 arc-second seamless DEM, tile n38w123",
        publisher="U.S. Geological Survey, 3D Elevation Program",
        url=SEAMLESS_DEM_URL,
        accessed=ACCESS_DATE,
        resolution="1/3 arc-second (~10 m); EPSG:4269",
        licence="Public domain (U.S. Government work)",
        role="Independent cross-check on the 1 m lidar elevations (validation "
        "only -- too coarse for street grades).",
        local="data/raw/dem_13_n38w123.tif",
        limitations="~10 m posting smooths away street-scale relief and "
        "systematically under-reports maximum grades.",
        optional=True,
    ),
    Dataset(
        key="neighborhoods",
        title="San Francisco neighborhoods (37-neighborhood planning set)",
        publisher="San Francisco Planning Department / DataSF, "
        "mirrored by Code for America (click_that_hood)",
        url=NEIGHBORHOOD_URL,
        accessed=ACCESS_DATE,
        resolution="Vector polygons, 37 features",
        licence="Public domain / open data (City & County of San Francisco)",
        role="Neighborhood boundaries for origin/destination selection and corridor attribution.",
        local="data/raw/sf_neighborhoods.geojson",
        limitations=(
            "This is the long-standing 37-unit San Francisco planning "
            "neighborhood set, not the newer 41-unit 'Analysis Neighborhoods' "
            "product. It is used because data.sfgov.org is unreachable from "
            "the build environment (blocked by egress policy), so the DataSF "
            "API could not be called; this Code for America mirror is the "
            "closest reachable equivalent. Boundary vintage is not stated by "
            "the mirror. The two products differ mainly in how the Sunset, "
            "Richmond and Twin Peaks areas are subdivided, which affects "
            "representative-point placement but not the street model."
        ),
        substituted=True,
        substitution_reason=(
            "DataSF (data.sfgov.org) and sfgov.org are blocked by the "
            "environment's network policy; the official 41-neighborhood "
            "Analysis Neighborhoods GeoJSON could not be downloaded."
        ),
    ),
    Dataset(
        key="overture_places",
        title=f"Overture Maps places (release {OVERTURE_RELEASE})",
        publisher="Overture Maps Foundation (Meta and Microsoft POI data)",
        url=f"{OVERTURE_BUCKET}/{OVERTURE_PLACES_PREFIX}/type=place/",
        accessed="2026-10-04",
        resolution="Point features with names, categories and a confidence score",
        licence="CDLA Permissive 2.0",
        role="Offline place search in the route page (parks, landmarks, "
        "transit, schools, shops, cafes).",
        local="data/raw/overture_places_sf.parquet",
        limitations="Point-of-interest coverage and naming are uneven; only "
        "records with confidence >= 0.6 in routable categories "
        "are kept. Not used by the analysis itself.",
        optional=True,
    ),
    Dataset(
        key="overture_base",
        title=f"Overture Maps base theme: land use, infrastructure, land (release {OVERTURE_RELEASE})",
        publisher="Overture Maps Foundation (derived from OpenStreetMap)",
        url=f"{OVERTURE_BUCKET}/{OVERTURE_BASE_PREFIX}/",
        accessed="2026-10-04",
        resolution="Mapped outlines and points with names and OSM-derived classes",
        licence="ODbL 1.0 (OpenStreetMap contributors)",
        role="Mapped parks, schools, hospitals, plazas, stations, piers, "
        "bridges, viewpoints, peaks and beaches for the route page's "
        "offline search; these outrank the POI feed, which places the "
        "same names unreliably.",
        local="data/raw/overture_{land_use,infrastructure,land}_sf.parquet",
        limitations="Only named features in a fixed class list are used. "
        "Not used by the analysis itself.",
        optional=True,
    ),
    Dataset(
        key="overture_addresses",
        title=f"Overture Maps addresses (release {OVERTURE_RELEASE})",
        publisher="Overture Maps Foundation (OpenAddresses / City of San Francisco)",
        url=f"{OVERTURE_BUCKET}/{OVERTURE_ADDRESSES_PREFIX}/type=address/",
        accessed="2026-10-04",
        resolution="Address points with street number and street name",
        licence="Open (OpenAddresses sources; SF data is public domain)",
        role="Offline street-address search in the route page.",
        local="data/raw/overture_addresses_sf.parquet",
        limitations="One point per (street, number) is kept; unit numbers "
        "are dropped. Not used by the analysis itself.",
        optional=True,
    ),
    Dataset(
        key="bike_network",
        title="SFMTA Bike Network (linear features)",
        publisher="SFMTA via DataSF",
        url="https://data.sfgov.org/Transportation/MTA-Bike-Network-Linear-Features/",
        accessed="2026-10-05 (downloaded by hand; data.sfgov.org is blocked "
        "from the build environment)",
        resolution="5,457 centreline segments with SFMTA facility class "
        "(I path, II lane, III route, IV separated), buffering and "
        "barrier type; data_as_of 2023-10 to 2026-04",
        licence="Open data (City & County of San Francisco)",
        role="Bike-mode comfort weighting on the route page ('prefer calm "
        "streets'); see bikeways.py.",
        local="data/raw/sfmta_bike_network.geojson",
        limitations=(
            "Keyed by CNN, which Overture does not carry, so segments are "
            "matched to graph edges geometrically (within 12 m and 25 degrees, "
            "over at least half the edge). Roughly 580 of 760 km match; the "
            "rest is Presidio and park paths outside the routable graph or "
            "double-counted one-way pairs. Slow Streets are not in this "
            "dataset; they are handled through Overture access rules."
        ),
        optional=True,
    ),
)

DATASETS_BY_KEY = {d.key: d for d in DATASETS}


def format_table() -> str:
    """Human-readable provenance report."""
    lines = [f"Data sources (all URLs verified {ACCESS_DATE})", "=" * 78]
    for d in DATASETS:
        flag = " [OPTIONAL]" if d.optional else ""
        flag += " [SUBSTITUTED]" if d.substituted else ""
        lines += [
            f"\n{d.key}{flag}",
            f"  title       : {d.title}",
            f"  publisher   : {d.publisher}",
            f"  url         : {d.url}",
            f"  accessed    : {d.accessed}",
            f"  resolution  : {d.resolution}",
            f"  licence     : {d.licence}",
            f"  local cache : {d.local}",
            f"  role        : {d.role}",
            f"  limitations : {d.limitations}",
        ]
        if d.notes:
            lines.append(f"  notes       : {d.notes}")
        if d.substitution_reason:
            lines.append(f"  substitution: {d.substitution_reason}")
    return "\n".join(lines)


def markdown_table() -> str:
    """Compact markdown table for the README."""
    rows = [
        "| Dataset | Publisher | Resolution / vintage | Licence | Role |",
        "|---|---|---|---|---|",
    ]
    for d in DATASETS:
        rows.append(f"| {d.title} | {d.publisher} | {d.resolution} | {d.licence} | {d.role} |")
    return "\n".join(rows)
