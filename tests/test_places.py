"""The route page's offline place index."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from sf_flat_routes import places
from sf_flat_routes.config import SF_BBOX
from sf_flat_routes.download import ADDRESSES_PARQUET, BASE_PARQUETS, PLACES_PARQUET


def test_street_names_are_title_cased_with_suffixes_kept_short():
    assert places._title_street("JOHN MUIR DR") == "John Muir Dr"
    assert places._title_street("24TH ST") == "24th St"
    assert places._title_street("VAN NESS AVE") == "Van Ness Ave"
    assert places._title_street("DR CARLTON B GOODLETT PL") == "Dr Carlton B Goodlett Pl"


def test_core_strips_a_trailing_city_name():
    assert places._core("Dolores Park, San Francisco") == "dolores park"
    assert places._core("Coit Tower, SF") == "coit tower"
    assert places._core("Ocean Beach - San Francisco") == "ocean beach"
    assert places._core("Marina Green") == "marina green"
    # a suffix that is part of the name is not a city suffix
    assert places._core("Cafe California") == "cafe california"


def test_support_counts_nearby_records_that_mention_the_name():
    names = pd.Series(
        ["Dolores Park", "Dolores Park Cafe", "Dolores Park Tennis", "Dolores Park", "Nowhere"]
    )
    lon = np.array([-122.427, -122.4265, -122.4275, -122.414, -122.5])
    lat = np.array([37.7596, 37.7600, 37.7593, 37.784, 37.7])
    sup = places._support(names, lon, lat, names, lon, lat)
    assert sup[0] == 2  # the real park: two neighbours mention it
    assert sup[3] == 0  # the stray copy across town: none


def test_variant_pruning_keeps_different_kinds_and_distant_namesakes():
    df = pd.DataFrame(
        {
            "name": [
                "Dolores Park",
                "Dolores Park, San Francisco",
                "Dolores Park Cafe",
                "Golden Gate Park",
                "Golden Gate Park - East",
                "Golden Gate Park Carousel",
            ],
            "group": ["park", "park", "food", "park", "park", "landmark"],
            "lon": [-122.427, -122.421, -122.4259, -122.482, -122.458, -122.458],
            "lat": [37.7596, 37.7736, 37.7613, 37.7694, 37.7691, 37.7691],
            "conf": [0.97, 0.72, 0.99, 0.98, 0.9, 0.9],
            "support": [3, 0, 0, 5, 0, 0],
        }
    )
    out = places._prune_variants(df)
    kept = set(out["name"])
    assert "Dolores Park" in kept
    assert "Dolores Park, San Francisco" not in kept  # city suffix, any distance
    assert "Dolores Park Cafe" in kept  # a different kind of place
    assert "Golden Gate Park" in kept
    assert "Golden Gate Park Carousel" in kept  # different kind
    assert "Golden Gate Park - East" not in kept  # same kind, unsupported variant


needs_places = pytest.mark.skipif(
    not PLACES_PARQUET.exists(), reason="Overture places not downloaded"
)
needs_base = pytest.mark.skipif(
    not all(p.exists() for p in BASE_PARQUETS.values()), reason="Overture base theme not downloaded"
)
needs_addresses = pytest.mark.skipif(
    not ADDRESSES_PARQUET.exists(), reason="Overture addresses not downloaded"
)


@pytest.fixture(scope="module")
def index():
    return places.build_places()


@pytest.mark.needs_data
@needs_places
@needs_base
def test_place_index_is_compact_and_inside_the_city(index):
    n = len(index["names"])
    assert 5000 < n < 20000
    assert len(index["group"]) == n == len(index["lon"]) == len(index["lat"])
    assert max(index["group"]) < len(index["groups"])
    assert min(index["lon"]) >= SF_BBOX[0] and max(index["lon"]) <= SF_BBOX[1]
    assert min(index["lat"]) >= SF_BBOX[2] and max(index["lat"]) <= SF_BBOX[3]
    assert len(set(index["names"])) == n or len(set(zip(index["names"], index["group"]))) == n


@pytest.mark.needs_data
@needs_places
@needs_base
def test_mapped_features_win_over_the_poi_feed(index):
    """The POI feed drops 'Dolores Park' in the Tenderloin and in Bayview;
    the mapped park is the only record that remains under that name."""
    hits = {
        (n, index["groups"][g]): (lo, la)
        for n, g, lo, la in zip(index["names"], index["group"], index["lon"], index["lat"])
    }
    assert ("Mission Dolores Park", "park") in hits
    lo, la = hits[("Mission Dolores Park", "park")]
    assert abs(lo + 122.427) < 0.003 and abs(la - 37.7596) < 0.003
    assert ("Dolores Park", "park") not in hits
    # famous things sit where they belong
    for name, kind, lon, lat in [
        ("Coit Tower", "viewpoint", -122.4058, 37.8024),
        ("Pier 39", "pier", -122.4103, 37.8095),
        ("Golden Gate Park", "park", -122.482, 37.769),
        ("Ocean Beach", "beach", -122.510, 37.757),
    ]:
        assert (name, kind) in hits, name
        lo, la = hits[(name, kind)]
        assert abs(lo - lon) < 0.004 and abs(la - lat) < 0.004, name


@pytest.mark.needs_data
@needs_addresses
def test_addresses_pack_into_sorted_uint16_offsets():
    a = places.build_addresses()
    n = len(a["number"])
    assert n > 100_000
    assert a["street"].dtype == np.dtype("<u2") and a["number"].dtype == np.dtype("<u2")
    assert a["lon"].dtype == np.dtype("<u2") and a["lat"].dtype == np.dtype("<u2")
    # sorted by street then number, so the browser can binary-search
    key = a["street"].astype(np.int64) * 100_000 + a["number"]
    assert np.all(np.diff(key) > 0)
    lon = a["origin"][0] + a["lon"] * 1e-5
    lat = a["origin"][1] + a["lat"] * 1e-5
    assert lon.min() >= SF_BBOX[0] and lon.max() <= SF_BBOX[1] + 1e-4
    assert lat.min() >= SF_BBOX[2] and lat.max() <= SF_BBOX[3] + 1e-4
    assert "Valencia St" in a["streets"]
