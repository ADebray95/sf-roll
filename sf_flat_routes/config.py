"""Central configuration: paths, CRS, elevation processing and the wheelchair profile.

Everything tunable in the pipeline lives here so that a rebuild is
reproducible and the routing rules are auditable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
PROJECT_ROOT = Path(os.environ.get("SFFR_ROOT", Path(__file__).resolve().parent.parent))
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
#: ``SFFR_RUN_DIR`` redirects the processed data and the site under one
#: directory, so an experiment (another smoothing setting, say) can rebuild
#: the pipeline without touching the main results.
_RUN_DIR = os.environ.get("SFFR_RUN_DIR")
PROCESSED_DIR = Path(_RUN_DIR) / "processed" if _RUN_DIR else DATA_DIR / "processed"
#: The app as a static site, deployed to GitHub Pages from here.
SITE_DIR = Path(_RUN_DIR) / "site" if _RUN_DIR else PROJECT_ROOT / "site"
#: Written documentation that the pipeline generates (validation tables).
DOCS_DIR = PROJECT_ROOT / "docs"
#: The product is "Roll SF"; the Python package keeps flattensf's name.
PRODUCT_NAME = "Roll SF"
REPO_URL = "https://github.com/ADebray95/sf-roll"
#: Where GitHub Pages serves the site: the project page, no custom domain.
#: Used for the canonical link and the social preview tags.
SITE_URL = "https://adebray95.github.io/sf-roll/"

for _d in (RAW_DIR, PROCESSED_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# Coordinate reference systems
# --------------------------------------------------------------------------
#: Geographic CRS of the source vector data (Overture) and of all map output.
CRS_GEOGRAPHIC = "EPSG:4326"
#: Projected CRS used for *every* length, slope and distance computation.
#: NAD83 / UTM zone 10N -- the native CRS of the USGS 3DEP 1 m tiles for SF,
#: so elevation sampling needs no reprojection of the raster.
CRS_PROJECTED = "EPSG:26910"

# --------------------------------------------------------------------------
# Study area
# --------------------------------------------------------------------------
#: Analysis bounding box (lon_min, lon_max, lat_min, lat_max).
#: Covers the City & County of San Francisco land area plus a small margin.
#: Deliberately excludes the Marin headlands and the Farallones.
SF_BBOX = (-122.5200, -122.3300, 37.6950, 37.8350)


# --------------------------------------------------------------------------
# Elevation sampling / smoothing
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class ElevationConfig:
    #: Spacing (m) of elevation samples along each edge. 5 m was chosen
    #: empirically: at 10 m spacing the short steep pitches that give San
    #: Francisco its reputation were measurably clipped (Bradford St came out
    #: at 36.8% against a documented 41%, Prentiss St at 32.9% against 37%),
    #: while 5 m recovers them. Cost is ~1M sample points citywide.
    sample_spacing_m: float = 5.0
    #: Minimum number of samples per edge (endpoints always included).
    min_samples: int = 3
    #: Half-width (m) of the Savitzky-Golay window applied along the profile.
    #: 25 m either side => ~50 m window, shorter than a city block, so real
    #: block-scale grade is preserved while curb/vehicle/vegetation artefacts
    #: in the lidar DEM are suppressed. Narrower windows were tested and
    #: rejected: at a 12.5 m half-width, localised DEM artefacts on 22nd St
    #: and Baden St survived and pushed those streets to the 60% plausibility
    #: clip, whereas 25 m returns 32.9% and 30.6% against documented values
    #: of 31.5% and 32%.
    smooth_window_m: float = 25.0
    #: Polynomial order of the Savitzky-Golay filter.
    smooth_polyorder: int = 2
    #: Dead-band (m). Elevation wiggles smaller than this are not counted as
    #: cumulative gain/loss. Standard practice in altimetry; without it a flat
    #: street accumulates tens of metres of phantom climbing from DEM noise.
    gain_deadband_m: float = 0.5
    #: Grades above this magnitude are treated as DEM artefacts and clipped.
    #: Filbert St between Hyde and Leavenworth is ~31.5%, the steepest
    #: drivable street in SF; public stairways reach ~50%+, so the clip is
    #: generous and only removes physically impossible values.
    max_plausible_grade: float = 0.60
    #: Elevation on bridges/tunnels is taken as a linear interpolation between
    #: the endpoints instead of from the DEM (the DEM samples the ground or
    #: water surface beneath the structure).
    interpolate_structures: bool = True
    #: Standard deviation (m) of the Gaussian applied to the DEM before any
    #: sampling. 3 m is far narrower than a street and far narrower than the
    #: block scale on which real gradient varies; 0 disables it.
    dem_sigma_m: float = 3.0


def _overrides() -> dict:
    """Parameter overrides from ``SFFR_OVERRIDES`` (a JSON object).

    Used with ``SFFR_RUN_DIR`` to rebuild the pipeline under different
    elevation settings (the smoothing study in docs/validation.md). Keys are
    ``ElevationConfig`` field names.
    """
    raw = os.environ.get("SFFR_OVERRIDES")
    if not raw:
        return {}
    import json

    try:
        return dict(json.loads(raw))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"SFFR_OVERRIDES is not a JSON object: {raw!r}") from exc


_OV = _overrides()


def _apply(instance, overrides: dict):
    names = {f.name for f in instance.__dataclass_fields__.values()}
    picked = {k: v for k, v in overrides.items() if k in names}
    return replace(instance, **picked) if picked else instance


ELEVATION = _apply(ElevationConfig(), _OV)

# --------------------------------------------------------------------------
# Grades
# --------------------------------------------------------------------------
#: Grade thresholds (as fractions) at which "distance above grade" is tallied
#: per directed edge, for the validation tables.
GRADE_THRESHOLDS = (0.03, 0.05, 0.08, 0.10, 0.15)

#: Percentile used for the "typical steep" grade statistic of an edge.
GRADE_PERCENTILE = 95

#: Minimum edge length (m) for its *maximum* grade to be treated as reliable.
#: Over a 5 m stub a single decimetre of DEM artefact reads as a 20% grade;
#: the worst real example found was a 5 m connector at Market and 5th which
#: reported 41%. Short edges keep their metrics but are judged on average
#: grade instead.
MIN_RELIABLE_GRADE_LENGTH_M = 15.0

#: Window (m) over which the steepest uphill of a directed arc is measured:
#: ``max_up_grade_15m`` is the largest rise over any stretch this long of the
#: smoothed profile, in the direction of travel. Arcs shorter than the window
#: use their average climb instead.
UPHILL_WINDOW_M = 15.0


# --------------------------------------------------------------------------
# The wheelchair profile
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class ModeConfig:
    name: str
    #: Overture ``class`` values allowed for this mode.
    allowed_classes: frozenset = field(default_factory=frozenset)
    #: Overture ``subclass`` values that are always excluded.
    excluded_subclasses: frozenset = field(default_factory=frozenset)
    #: Overture ``road_surface`` values that rule an edge out.
    excluded_surfaces: frozenset = field(default_factory=frozenset)
    #: Mode token checked against Overture ``access_restrictions``.
    access_mode: str = "foot"


#: Classes that are never routable: grade-separated freeways and their ramps,
#: stairs, and rail. ``trunk`` is not here: in San Francisco it is Van Ness
#: Avenue, 19th Avenue, Lombard Street and part of Mission Street, ordinary
#: streets with sidewalks; trunk segments without foot access carry a
#: foot-denied rule in Overture and drop out through access evaluation.
NEVER_ROUTABLE_CLASSES = frozenset(
    {
        "motorway",
        "motorway_link",
        "steps",
        "track",
        "bridleway",
        "light_rail",
        "subway",
        "tram",
        "standard_gauge",
        "funicular",
        "rail",
    }
)

#: Subclasses excluded from the routable graph. ``sidewalk`` and
#: ``crosswalk`` are excluded because travel is modelled along street
#: centrelines: including the sidewalk network would represent every street
#: two or three times.
NEVER_ROUTABLE_SUBCLASSES = frozenset(
    {"sidewalk", "crosswalk", "driveway", "parking_aisle", "steps"}
)

#: Overture ``road_surface`` values a manual wheelchair cannot use.
UNPAVED_SURFACES = frozenset({"unpaved", "dirt", "gravel", "grass", "sand", "ground"})

WHEELCHAIR = ModeConfig(
    name="wheelchair",
    allowed_classes=frozenset(
        {
            "trunk",
            "primary",
            "secondary",
            "tertiary",
            "residential",
            "living_street",
            "unclassified",
            "service",
            "pedestrian",
            "footway",
            "path",
            "cycleway",
            "unknown",
        }
    ),
    excluded_subclasses=NEVER_ROUTABLE_SUBCLASSES,
    excluded_surfaces=UNPAVED_SURFACES,
    access_mode="foot",
)

#: Slider range for the maximum uphill grade, in percent (spec D8).
CAP_MIN_PCT, CAP_MAX_PCT, CAP_DEFAULT_PCT = 3, 20, 8
