"""Command-line interface.

    python -m sf_flat_routes sources        # dataset provenance table
    python -m sf_flat_routes download       # fetch and cache all source data
    python -m sf_flat_routes build-network  # street graph + elevation + metrics
    python -m sf_flat_routes site           # pack the graph and write site/
    python -m sf_flat_routes validate       # ground-truth checks -> docs/validation.md
    python -m sf_flat_routes all            # everything, in order

Every stage caches its output, so re-running is cheap; pass ``--force`` to
recompute a stage from scratch.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from sf_flat_routes import sources
from sf_flat_routes.utils import get_logger, setup_logging

log = get_logger("sf_flat_routes")

#: Where the smoothing comparison build lives (see docs/data.md).
LIGHT_SMOOTHING_RUN = Path("data/runs/light-smoothing")


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--force", action="store_true", help="recompute instead of using caches")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m sf_flat_routes",
        description="Roll SF data pipeline: from lidar and Overture to the static site.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, helptext in [
        ("sources", "print the dataset provenance table"),
        ("download", "download and cache every source dataset"),
        ("build-network", "build the street graph, sample elevation, compute arc metrics"),
        ("site", "pack the graph and write site/"),
        ("validate", "check grades against ground truth and write docs/validation.md"),
        ("all", "run every stage in order"),
    ]:
        _add_common(sub.add_parser(name, help=helptext))
    return p


def cmd_sources(_args) -> int:
    print(sources.format_table())
    return 0


def cmd_download(args) -> int:
    from sf_flat_routes.download import download_all

    download_all(force=args.force)
    return 0


def cmd_build_network(args) -> int:
    from sf_flat_routes.pipeline import build_context

    ctx = build_context(force=args.force)
    log.info(
        "network ready: %d edges, %d directed arcs, %d traversable",
        len(ctx.edges),
        len(ctx.directed),
        int(ctx.directed["traversable"].sum()),
    )
    return 0


def cmd_site(args) -> int:
    from sf_flat_routes.pipeline import build_context
    from sf_flat_routes.webapp import write_site

    write_site(build_context())
    return 0


def _smoothing_comparison(edges, directed) -> list[str]:
    """The steep blocks under the light-smoothing build, if it has been made."""
    import pandas as pd

    from sf_flat_routes.validate import check_steep_blocks

    light = LIGHT_SMOOTHING_RUN / "processed" / "edges_directed.parquet"
    if not light.exists():
        return []
    alt = pd.read_parquet(light)
    base = check_steep_blocks(edges, directed)
    other = check_steep_blocks(edges, alt)
    lines = [
        "## Smoothing: full pipeline vs light smoothing",
        "",
        "Light smoothing keeps the sigma = 3 m DEM filter and turns the Savitzky-Golay filter "
        "off, the comparison of spec section 12.3 (docs/data.md has the command).",
        "",
        "| Block | Full smoothing | Light smoothing |",
        "|---|---|---|",
    ]
    for a, b in zip(base.to_dict("records"), other.to_dict("records"), strict=True):
        full, light = 100 * a["max_up_grade_15m"], 100 * b["max_up_grade_15m"]
        lines.append(f"| {a['block']} | {full:.1f}% | {light:.1f}% |")
    return lines


def cmd_validate(args) -> int:
    from sf_flat_routes.validate import load, write_report

    edges, directed = load()
    print(write_report(edges, directed, extra=_smoothing_comparison(edges, directed)))
    return 0


def cmd_all(args) -> int:
    for fn in (cmd_download, cmd_build_network, cmd_site, cmd_validate):
        rc = fn(args)
        if rc:
            return rc
    return 0


_DISPATCH = {
    "sources": cmd_sources,
    "download": cmd_download,
    "build-network": cmd_build_network,
    "site": cmd_site,
    "validate": cmd_validate,
    "all": cmd_all,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    setup_logging(getattr(args, "verbose", False))
    if os.environ.get("SFFR_RUN_DIR"):
        log.info("run directory: %s", os.environ["SFFR_RUN_DIR"])
    return _DISPATCH[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
