"""Spec section 10.1: the processed wheelchair graph against ground truth.

Needs the cached source data and a built network
(``python -m sf_flat_routes download build-network``).
"""

import numpy as np
import pytest

from sf_flat_routes import validate as V
from sf_flat_routes.config import MIN_RELIABLE_GRADE_LENGTH_M, PROCESSED_DIR

pytestmark = [
    pytest.mark.needs_data,
    pytest.mark.skipif(
        not (PROCESSED_DIR / "edges_directed.parquet").exists(),
        reason="processed network not built; run `python -m sf_flat_routes build-network`",
    ),
]


@pytest.fixture(scope="module")
def tables():
    return V.load()


@pytest.fixture(scope="module")
def routable(tables):
    edges, directed = tables
    d = directed[directed["traversable"]]
    return d.merge(edges[["edge_id", "subclass"]], on="edge_id", how="left", suffixes=("", "_e"))


@pytest.mark.parametrize("block", V.STEEP_BLOCKS, ids=lambda b: b.label)
def test_steep_block_is_in_its_band(tables, block):
    edges, directed = tables
    g = V.uphill(directed, V.block_edges(edges, block.street, block.from_street, block.to_street))
    assert block.lo <= g <= block.hi, f"{block.label}: {100 * g:.1f}%"


def test_bradford_street_reads_steep(tables):
    edges, directed = tables
    street, _published, lo = V.BRADFORD
    assert V.uphill(directed, edges.loc[edges["name"] == street, "edge_id"]) >= lo


@pytest.mark.parametrize("spec", V.FLAT_STREETS, ids=lambda s: s.label)
def test_flat_street_stays_under_its_limit(tables, spec):
    arcs = V.flat_arcs(*tables, spec)
    assert len(arcs) > 10
    assert arcs["max_up_grade_15m"].max() < spec.limit


def test_window_grade_is_never_below_the_average_climb(tables):
    _, directed = tables
    long_ = directed[directed["length_m"] >= MIN_RELIABLE_GRADE_LENGTH_M]
    avg_up = (long_["net_change"] / long_["length_m"]).clip(lower=0)
    assert (long_["max_up_grade_15m"] >= avg_up - 1e-6).all()  # float32 elevations


def test_an_arc_that_never_rises_has_no_uphill(tables):
    _, directed = tables
    never_rises = directed[directed["max_grade"] <= 0]
    assert len(never_rises) > 1000
    assert (never_rises["max_up_grade_15m"] == 0).all()


def test_values_are_bounded(tables):
    _, directed = tables
    g = directed["max_up_grade_15m"]
    assert g.between(0, 0.60).all() and np.isfinite(g).all()


def test_gain_minus_loss_is_the_net_change(tables):
    _, directed = tables
    resid = (
        directed["cum_gain"]
        - directed["cum_loss"]
        - (directed["end_elev"] - directed["start_elev"])
    )
    assert resid.abs().max() < 1e-6


def test_no_freeway_or_stairway_is_routable(routable):
    assert not routable["cls"].isin(["motorway", "motorway_link", "steps"]).any()
    assert not (routable["subclass"] == "steps").any()
    names = routable["name"].fillna("")
    freeway = names.str.contains(r"\b(?:I-80|I-280|US 101|Central Freeway|James Lick)\b")
    assert not freeway.any(), sorted(set(names[freeway]))


@pytest.mark.parametrize("street", V.MUST_BE_ROUTABLE)
def test_trunk_surface_streets_stay_routable(routable, street):
    assert (routable["name"] == street).sum() > 20


@pytest.mark.parametrize("street", ["Cabrillo Street", "Page Street", "Shotwell Street"])
def test_slow_streets_are_routable(tables, street):
    """SF Slow Streets carry "everyone: destination only" after "foot:
    allowed"; the access parser once read that as closing them on foot."""
    edges, _ = tables
    s = edges[(edges["name"] == street) & (edges["cls"] == "residential")]
    assert len(s) > 20
    assert s["ok"].mean() > 0.95
