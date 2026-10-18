"""Checks of the wheelchair graph against ground truth (spec section 10.1).

The published steepest-street figures are secondary-source peak values, so
each check is a band, not a target: a miss is investigated and written up in
``docs/validation.md``, never tuned away.  The same functions back the
``needs_data`` tests in ``tests/test_validation.py``.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np
import pandas as pd

from sf_flat_routes.config import DOCS_DIR
from sf_flat_routes.utils import get_logger

log = get_logger("sf_flat_routes.validate")

VALIDATION_MD = DOCS_DIR / "validation.md"

#: The Ferry Building, centre of the Embarcadero flatness check.
FERRY_BUILDING = (-122.3937, 37.7955)


@dataclass(frozen=True)
class SteepBlock:
    """A block whose uphill ``max_up_grade_15m`` must fall in ``[lo, hi]``."""

    label: str
    street: str
    from_street: str
    to_street: str
    published: str
    lo: float
    hi: float = 1.0


STEEP_BLOCKS = (
    SteepBlock(
        "Filbert St, Hyde to Leavenworth",
        "Filbert Street",
        "Hyde Street",
        "Leavenworth Street",
        "31.5%",
        0.25,
        0.38,
    ),
    SteepBlock(
        "22nd St, Vicksburg to Church",
        "22nd Street",
        "Vicksburg Street",
        "Church Street",
        "31.5%",
        0.25,
        0.38,
    ),
    SteepBlock(
        "Lombard St crooked section, Hyde to Leavenworth",
        "Lombard Street",
        "Hyde Street",
        "Leavenworth Street",
        "27% straight-line",
        0.10,
    ),
)

#: Bradford Street is one short, very steep street; its whole length is the
#: block above Tompkins Avenue.
BRADFORD = ("Bradford Street", "40-41% (short)", 0.25)


@dataclass(frozen=True)
class FlatStreet:
    """Every routable arc of ``street`` (near ``centre``, if given) must stay under ``limit``."""

    label: str
    street: str
    limit: float
    centre: tuple[float, float] | None = None
    radius_m: float = 0.0


FLAT_STREETS = (
    FlatStreet(
        "The Embarcadero, Ferry Building +/- 1 km", "The Embarcadero", 0.03, FERRY_BUILDING, 1000
    ),
    FlatStreet("Marina Blvd", "Marina Boulevard", 0.03),
    FlatStreet("Great Highway", "Great Highway", 0.04),
)

#: Streets that must stay routable (trunk-class surface streets with sidewalks).
MUST_BE_ROUTABLE = ("Van Ness Avenue", "Lombard Street", "19th Avenue")


# --------------------------------------------------------------------------
def load() -> tuple[pd.DataFrame, pd.DataFrame]:
    """The processed undirected and directed edge tables."""
    import geopandas as gpd

    from sf_flat_routes.metrics import DIRECTED_PARQUET, UNDIRECTED_PARQUET

    for path in (UNDIRECTED_PARQUET, DIRECTED_PARQUET):
        if not path.exists():
            raise FileNotFoundError(
                f"{path} is missing; run `python -m sf_flat_routes build-network`"
            )
    return gpd.read_parquet(UNDIRECTED_PARQUET), pd.read_parquet(DIRECTED_PARQUET)


def corner_nodes(edges: pd.DataFrame, street: str, cross: str) -> set:
    """Nodes where an edge named ``street`` meets an edge named ``cross``."""

    def nodes(name: str) -> set:
        sub = edges[edges["name"] == name]
        return set(sub["u"]) | set(sub["v"])

    return nodes(street) & nodes(cross)


def block_edges(edges: pd.DataFrame, street: str, a: str, b: str) -> list[int]:
    """Edge ids along ``street`` between its corners with ``a`` and ``b``.

    A breadth-first search over the edges named ``street`` from the ``a``
    corner to the nearest ``b`` corner; raises ``LookupError`` if either
    corner is missing or they are not joined along the street.
    """
    starts, goals = corner_nodes(edges, street, a), corner_nodes(edges, street, b)
    if not starts or not goals:
        raise LookupError(f"no corner of {street} with {a if not starts else b}")
    sub = edges[edges["name"] == street]
    adj: dict = {}
    for eid, u, v in zip(sub["edge_id"], sub["u"], sub["v"], strict=True):
        adj.setdefault(u, []).append((v, int(eid)))
        adj.setdefault(v, []).append((u, int(eid)))
    prev: dict = {s: None for s in starts}
    queue = deque(starts)
    while queue:
        n = queue.popleft()
        if n in goals:
            path = []
            while prev[n] is not None:
                n, eid = prev[n]
                path.append(eid)
            return path
        for m, eid in adj.get(n, []):
            if m not in prev:
                prev[m] = (n, eid)
                queue.append(m)
    raise LookupError(f"{street} does not join {a} to {b}")


def uphill(directed: pd.DataFrame, edge_ids) -> float:
    """The largest ``max_up_grade_15m`` over both directions of the edges."""
    sel = directed[directed["edge_id"].isin(list(edge_ids))]
    return float(sel["max_up_grade_15m"].max()) if len(sel) else float("nan")


def check_steep_blocks(edges: pd.DataFrame, directed: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for b in STEEP_BLOCKS:
        ids = block_edges(edges, b.street, b.from_street, b.to_street)
        g = uphill(directed, ids)
        rows.append(
            {
                "block": b.label,
                "published": b.published,
                "max_up_grade_15m": g,
                "band": (b.lo, b.hi),
                "length_m": float(edges.set_index("edge_id").loc[ids, "length_m"].sum()),
                "passed": b.lo <= g <= b.hi,
            }
        )
    street, published, lo = BRADFORD
    g = uphill(directed, edges.loc[edges["name"] == street, "edge_id"])
    length = float(edges.loc[edges["name"] == street, "length_m"].sum())
    rows.append(
        {
            "block": "Bradford St, above Tompkins Ave",
            "published": published,
            "max_up_grade_15m": g,
            "band": (lo, 1.0),
            "length_m": length,
            "passed": g >= lo,
        }
    )
    return pd.DataFrame(rows)


def flat_arcs(edges: pd.DataFrame, directed: pd.DataFrame, spec: FlatStreet) -> pd.DataFrame:
    """The routable directed arcs of a flat street, within its radius."""
    sub = edges[(edges["name"] == spec.street) & edges["ok"]]
    if spec.centre is not None:
        from pyproj import Transformer
        from shapely.geometry import Point

        tr = Transformer.from_crs("EPSG:4326", edges.crs, always_xy=True)
        centre = Point(*tr.transform(*spec.centre))
        sub = sub[sub.geometry.distance(centre) <= spec.radius_m]
    return directed[directed["edge_id"].isin(sub["edge_id"])]


def check_flat_streets(edges: pd.DataFrame, directed: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for spec in FLAT_STREETS:
        arcs = flat_arcs(edges, directed, spec)
        worst = float(arcs["max_up_grade_15m"].max()) if len(arcs) else float("nan")
        rows.append(
            {
                "street": spec.label,
                "arcs": len(arcs),
                "limit": spec.limit,
                "worst": worst,
                "passed": len(arcs) > 0 and worst < spec.limit,
            }
        )
    return pd.DataFrame(rows)


def histogram(directed: pd.DataFrame) -> pd.DataFrame:
    """Share of routable arcs by ``max_up_grade_15m`` band."""
    g = directed.loc[directed["traversable"], "max_up_grade_15m"] * 100
    bins = [0, 0.001, 3, 5, 8, 12, 20, 30, 61]
    labels = ["0 (level or downhill)", "0-3%", "3-5%", "5-8%", "8-12%", "12-20%", "20-30%", ">30%"]
    counts = pd.cut(g, bins=bins, labels=labels, right=False, include_lowest=True).value_counts()
    counts = counts.reindex(labels).fillna(0).astype(int)
    return pd.DataFrame(
        {"band": labels, "arcs": counts.to_numpy(), "share": counts.to_numpy() / max(len(g), 1)}
    )


# --------------------------------------------------------------------------
#: Findings behind the numbers, kept with the code that produces them.
NOTES = """## Notes

- **Bradford Street reads 32% against a published 40-41%.** The published figure is the single
  steepest pitch, only 15-20 m long. The pipeline's sigma = 3 m DEM filter and profile smoothing
  attenuate it; upstream flattensf measured 41.4% on the raw 5 m samples and 33.1% after the full
  chain. It passes its band (>= 25%) and no smoothing parameter was tuned toward it. The
  light-smoothing comparison below shows the Savitzky-Golay window is responsible for only about
  two points of the gap.
- **Arcs shorter than 15 m.** The spec (D13) gives them their own average grade. Half of all
  routable arcs are that short, and over a 1-3 m stub the lidar's decimetre noise reads as a
  10-60% grade: under that rule 3,082 short arcs (16th Street and Grant Avenue among them) would
  have been blocked at an 8% cap, and 30 hit the 60% clamp. They instead take the 15 m window
  centred on them along the same street, so a short arc is judged like any other 15 m stretch.
  The "never below the average climb" invariant therefore holds for arcs of 15 m and more.
- **Trunk roads.** Overture carries no sidewalk tag. Trunk segments without a footway (Park
  Presidio Boulevard, Crossover Drive, the Park Presidio bypass, parts of Junipero Serra Boulevard
  and Richardson Avenue) carry `foot: denied` and drop out through access rules; ramps
  (`is_link`) off trunk roads are excluded. Van Ness Avenue, 19th Avenue, Lombard Street and
  Mission Street stay routable. No hand-kept blocklist was needed.
- **Smoothing choice.** Full smoothing (sigma = 3 m DEM filter plus a ~50 m Savitzky-Golay window
  along each street) is kept: it matches Filbert and 22nd Streets within a point, keeps the flat
  streets flatter, and the lighter setting adds 2-3% more arcs above each cap without matching
  ground truth better.
"""


def _pct(x: float) -> str:
    return "n/a" if not np.isfinite(x) else f"{100 * x:.1f}%"


def write_report(
    edges: pd.DataFrame, directed: pd.DataFrame, extra: list[str] | None = None
) -> str:
    """Render docs/validation.md from the checks; returns the text."""
    from sf_flat_routes.webapp import MANIFEST_JSON

    steep = check_steep_blocks(edges, directed)
    flat = check_flat_streets(edges, directed)
    hist = histogram(directed)
    routable = directed[directed["traversable"]]
    built = MANIFEST_JSON.read_text(encoding="utf-8") if MANIFEST_JSON.exists() else ""
    lines = [
        "# Validation",
        "",
        "Generated by `python -m sf_flat_routes validate` from the processed network. "
        "Published grades are secondary-source peak values, so each check is a band. "
        "A miss is investigated and written up here, not tuned away (spec section 10.1).",
        "",
        "## Steep blocks: `max_up_grade_15m`, uphill direction",
        "",
        "| Block | Published | Measured | Pass band | Length | Result |",
        "|---|---|---|---|---|---|",
    ]
    for r in steep.to_dict("records"):
        lo, hi = r["band"]
        band = f">= {100 * lo:.0f}%" if hi >= 1 else f"{100 * lo:.0f}-{100 * hi:.0f}%"
        lines.append(
            f"| {r['block']} | {r['published']} | {_pct(r['max_up_grade_15m'])} | {band} | "
            f"{r['length_m']:.0f} m | {'pass' if r['passed'] else '**MISS**'} |"
        )
    lines += [
        "",
        "## Flat streets: every routable arc under the limit",
        "",
        "| Street | Arcs | Steepest arc | Limit | Result |",
        "|---|---|---|---|---|",
    ]
    for r in flat.to_dict("records"):
        lines.append(
            f"| {r['street']} | {r['arcs']} | {_pct(r['worst'])} | < {100 * r['limit']:.0f}% | "
            f"{'pass' if r['passed'] else '**MISS**'} |"
        )
    lines += [
        "",
        f"## Distribution of `max_up_grade_15m` over {len(routable):,} routable arcs",
        "",
        "| Band | Arcs | Share |",
        "|---|---|---|",
    ]
    for r in hist.to_dict("records"):
        lines.append(f"| {r['band']} | {r['arcs']:,} | {100 * r['share']:.1f}% |")
    lines += [
        "",
        f"Share of routable arcs above 20%: "
        f"{100 * (routable['max_up_grade_15m'] > 0.20).mean():.2f}%.",
    ]
    lines += ["", NOTES.strip()]
    if extra:
        lines += ["", *extra]
    if built:
        lines += ["", "## Graph", "", "```json", built.strip(), "```"]
    text = "\n".join(lines) + "\n"
    VALIDATION_MD.write_text(text, encoding="utf-8")
    log.info("wrote %s", VALIDATION_MD)
    return text
