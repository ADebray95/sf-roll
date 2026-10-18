"""Tests for access-rule interpretation and graph construction."""

import numpy as np

from sf_flat_routes.network import _as_dict, _as_list, _flags, evaluate_access, unpaved_spans


def rule(
    access_type, mode=None, heading=None, during=None, between=None, recognized=None, using=None
):
    return {
        "access_type": access_type,
        "between": between,
        "when": {
            "mode": mode,
            "heading": heading,
            "during": during,
            "recognized": recognized,
            "using": using,
        },
    }


def test_no_restrictions_means_allowed():
    r = evaluate_access(None, "foot")
    assert r["allowed"] and not r["restricted"]


def test_one_way_rules_do_not_affect_travel_on_foot():
    assert evaluate_access([rule("denied", heading="backward")], "foot")["allowed"]


def test_a_foot_denial_closes_the_segment():
    """Park Presidio Boulevard and Crossover Drive are trunk roads with no
    footway; Overture marks them foot: denied."""
    assert not evaluate_access([rule("denied", mode=["foot"])], "foot")["allowed"]


def test_a_denial_for_another_mode_does_not_close_it_on_foot():
    assert evaluate_access([rule("denied", mode=["bicycle"])], "foot")["allowed"]


def test_designated_counts_as_permitted():
    assert evaluate_access([rule("designated", mode=["pedestrian"])], "foot")["allowed"]


def test_private_access_is_not_routable_for_through_travel():
    r = evaluate_access([rule("allowed", recognized=["as_private"])], "foot")
    assert not r["allowed"] and r["restricted"]


def test_destination_only_access_is_not_routable():
    r = evaluate_access([rule("allowed", using=["at_destination"])], "foot")
    assert not r["allowed"]


def test_time_conditional_rules_are_ignored():
    rules = [rule("denied", mode=["foot"], during="Mo-Fr 07:00-09:00")]
    assert evaluate_access(rules, "foot")["allowed"]


def test_partial_segment_rules_do_not_veto_the_whole_edge():
    rules = [rule("denied", mode=["foot"], between=[0.0, 0.4])]
    r = evaluate_access(rules, "foot")
    assert r["allowed"] and r["partial_rules"]


def test_later_rule_overrides_an_earlier_general_one():
    rules = [rule("denied"), rule("allowed", mode=["foot"])]
    assert evaluate_access(rules, "foot")["allowed"]


def test_a_mode_specific_permit_outranks_a_later_general_restriction():
    """The Slow Street shape, exactly as Overture carries it for Cabrillo
    Street: an all-modes destination-only rule comes *after* the explicit
    foot permit and must not override it."""
    rules = [
        rule("allowed", mode=["foot"]),
        rule("designated", mode=["bicycle"]),
        rule("allowed", mode=["motor_vehicle"], using=["at_destination"]),
        rule("allowed", using=["at_destination"]),
    ]
    r = evaluate_access(rules, "foot")
    assert r["allowed"] and not r["restricted"]


def test_a_general_restriction_still_applies_without_a_mode_permit():
    rules = [
        rule("allowed", mode=["motor_vehicle"], using=["at_destination"]),
        rule("allowed", using=["at_destination"]),
    ]
    assert not evaluate_access(rules, "foot")["allowed"]


def test_a_mode_specific_denial_outranks_an_earlier_general_permit():
    rules = [rule("allowed"), rule("denied", mode=["foot"])]
    assert not evaluate_access(rules, "foot")["allowed"]


def test_motor_vehicle_denial_does_not_block_travel_on_foot():
    rules = [rule("allowed", mode=["foot", "bicycle"]), rule("denied", mode=["motor_vehicle"])]
    assert evaluate_access(rules, "foot")["allowed"]


# ------------------------------------------- Arrow / numpy coercion helpers
def test_nested_arrow_columns_arrive_as_ndarrays():
    """``to_pandas`` turns Arrow lists into object ndarrays, whose truthiness
    raises; every nested access must go through the coercion helpers."""
    arr = np.array([rule("denied", mode=np.array(["foot"], dtype=object))], dtype=object)
    assert not evaluate_access(arr, "foot")["allowed"]


def test_as_list_handles_none_nan_scalars_and_arrays():
    assert _as_list(None) == []
    assert _as_list(float("nan")) == []
    assert _as_list([1, 2]) == [1, 2]
    assert _as_list(np.array([1, 2])) == [1, 2]


def test_as_dict_rejects_non_mappings():
    assert _as_dict(None) == {}
    assert _as_dict(float("nan")) == {}
    assert _as_dict({"a": 1}) == {"a": 1}


def test_flags_collects_values_from_nested_arrays():
    rf = np.array(
        [{"values": np.array(["is_bridge"], dtype=object)}, {"values": ["is_link"]}], dtype=object
    )
    assert _flags(rf) == {"is_bridge", "is_link"}


def test_flags_of_empty_input():
    assert _flags(None) == set()


# --------------------------------------------------------------- surfaces
def test_unpaved_surface_rule_covers_the_whole_segment():
    assert unpaved_spans([{"value": "gravel", "between": None}]) == [(0.0, 1.0)]


def test_unpaved_surface_rule_with_between_covers_only_that_part():
    rs = np.array([{"value": "dirt", "between": np.array([0.2, 0.6])}], dtype=object)
    assert unpaved_spans(rs) == [(0.2, 0.6)]


def test_paved_and_unknown_surfaces_are_fine():
    rs = [{"value": "paved", "between": None}, {"value": "paving_stones", "between": None}]
    assert unpaved_spans(rs) == []
    assert unpaved_spans(None) == []
