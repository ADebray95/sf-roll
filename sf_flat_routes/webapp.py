"""The app as a static site: ``site/`` is written from ``sf_flat_routes/web/``.

The page is ``web/simple.html`` with its placeholders filled in; the scripts
(``engine.js`` then ``simple.js``, concatenated), the stylesheet, Leaflet and
the packed graph are written alongside as files whose names carry a content
hash, so a browser that cached yesterday's script cannot run it against
today's page. ``site/data/manifest.json`` records what the graph was built
from.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

from sf_flat_routes.config import PRODUCT_NAME, REPO_URL, SITE_DIR, SITE_URL
from sf_flat_routes.utils import get_logger, human_bytes, step

log = get_logger("sf_flat_routes.webapp")

SITE_INDEX = SITE_DIR / "index.html"
MANIFEST_JSON = SITE_DIR / "data" / "manifest.json"
WEB_DIR = Path(__file__).resolve().parent / "web"
VENDOR_DIR = Path(__file__).resolve().parent / "vendor"

_DESCRIPTION = (
    "Wheelchair-friendly routes in San Francisco: never climb a street steeper than you choose, "
    "and trade distance for less climbing."
)

_FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0f8f6f"/>
<path d="M5 22 C10 22 11 12 16 12 S22 20 27 10" fill="none" stroke="#fff"
 stroke-width="3.2" stroke-linecap="round"/>
</svg>
"""


def _asset(name: str) -> str:
    return (WEB_DIR / name).read_text(encoding="utf-8")


def _vendor(name: str) -> str:
    """Read a vendored asset (see ``vendor/README.md``)."""
    return (VENDOR_DIR / name).read_text(encoding="utf-8")


def fill(html: str, placeholder: str, value: str) -> str:
    """Replace ``<tag>/*__NAME__*/</tag>``-style placeholders, whitespace-tolerant.

    Raises ``ValueError`` if the placeholder is missing, so a template edit
    cannot silently drop an asset from the page.
    """
    pattern = re.compile(placeholder.replace("\\s*", r"\s*"), re.DOTALL)
    out, n = pattern.subn(lambda _m: value, html)
    if n != 1:
        raise ValueError(f"placeholder {placeholder!r} found {n} times in simple.html")
    return out


def page_html(payload: dict, assets: dict[str, str]) -> str:
    """The page, linking the hashed assets and embedding ``payload`` as ``window.DATA``."""
    html = _asset("simple.html")
    html = fill(html, r"/\*__REPO_URL__\*/", REPO_URL)
    html = fill(
        html,
        r"<style>\s*/\*__LEAFLET_CSS__\*/\s*</style>",
        f'<link rel="stylesheet" href="{assets["leaflet.css"]}">',
    )
    html = fill(
        html,
        r"<style>\s*/\*__APP_CSS__\*/\s*</style>",
        f'<link rel="stylesheet" href="{assets["app.css"]}">',
    )
    html = fill(
        html,
        r"<script>\s*/\*__LEAFLET_JS__\*/\s*</script>",
        f'<script src="{assets["leaflet.js"]}"></script>',
    )
    html = fill(
        html,
        r"<script>\s*/\*__APP_JS__\*/\s*</script>",
        f'<script src="{assets["app.js"]}"></script>',
    )
    head = "\n".join(
        [
            f'<link rel="canonical" href="{SITE_URL}">',
            '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
            '<meta property="og:type" content="website">',
            f'<meta property="og:title" content="{PRODUCT_NAME}">',
            f'<meta property="og:site_name" content="{PRODUCT_NAME}">',
            f'<meta property="og:description" content="{_DESCRIPTION}">',
            f'<meta property="og:url" content="{SITE_URL}">',
            f'<link rel="preload" href="{payload["bundle_url"]}" as="fetch" crossorigin>',
        ]
    )
    html = fill(html, r"<!--__HEAD_EXTRA__-->", head)
    return fill(html, r"/\*__DATA__\*/", json.dumps(payload, separators=(",", ":")))


def _git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=Path(__file__).resolve().parent,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(f"could not read the git commit for the manifest: {exc}") from exc
    return out.stdout.strip()


def build_manifest(meta: dict, graph_file: str) -> dict:
    """What the published graph was built from, for the About sheet and audits."""
    from sf_flat_routes import sources
    from sf_flat_routes.config import ELEVATION

    return {
        "graph": graph_file,
        "built": dt.datetime.now(dt.UTC).strftime("%Y-%m-%d"),
        "git_sha": _git_sha(),
        "overture_release": sources.OVERTURE_RELEASE,
        "lidar_project": sources.LIDAR_PROJECT,
        "nodes": meta["n_nodes"],
        "arcs": meta["n_arcs"],
        "edges": meta["n_edges"],
        "smoothing_window_m": 2 * ELEVATION.smooth_window_m,
        "licence": "Street data (c) OpenStreetMap contributors via Overture Maps, ODbL 1.0; "
        "this graph is a derived database under the ODbL 1.0. Elevation: USGS 3DEP.",
    }


def _labels(neighborhoods) -> list[dict]:
    """Sparse neighbourhood labels for the base map."""
    nb = neighborhoods.to_crs("EPSG:4326")
    out = []
    for _, r in nb.iterrows():
        p = r.geometry.representative_point()
        out.append({"n": r["neighborhood"], "lon": round(p.x, 5), "lat": round(p.y, 5)})
    return out


def _clean_site() -> Path:
    data_dir = SITE_DIR / "data"
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)
    for stale in SITE_DIR.glob("*-*.??*"):
        if re.match(r"^(app|leaflet)-[0-9a-f]{10}\.(js|css)$", stale.name):
            stale.unlink()
    return data_dir


def _hashed(stem: str, ext: str, text: str) -> str:
    name = f"{stem}-{hashlib.sha1(text.encode('utf-8')).hexdigest()[:10]}.{ext}"
    (SITE_DIR / name).write_text(text, encoding="utf-8")
    return name


def _pack(graph: dict) -> tuple[dict, dict | None]:
    """The graph plus the place and address index, bundled and gzipped."""
    from sf_flat_routes.download import ADDRESSES_PARQUET, PLACES_PARQUET
    from sf_flat_routes.places import build_addresses, build_places
    from sf_flat_routes.webgraph import bundle

    for path in (PLACES_PARQUET, ADDRESSES_PARQUET):
        if not path.exists():
            raise FileNotFoundError(
                f"{path} is missing; run `python -m sf_flat_routes download` again "
                "(the place search needs it)"
            )
    strings = {"geom": graph["geom"]}
    arrays = dict(graph["arrays"])
    strings["places"] = json.dumps(build_places(), separators=(",", ":"))
    addr = build_addresses()
    strings["addr_streets"] = json.dumps(addr["streets"], separators=(",", ":"))
    for k in ("street", "number", "lon", "lat"):
        arrays["addr_" + k] = addr[k]
    with step("bundling the graph and place index", log):
        packed = bundle(dict(graph, arrays=arrays), strings)
    return packed, {"origin": addr["origin"], "step": 1e-5}


def write_site(ctx) -> Path:
    """Build the packed graph and write ``site/``."""
    from sf_flat_routes.places import build_hillshade
    from sf_flat_routes.webgraph import build_payload

    graph = build_payload(ctx.edges, ctx.directed)
    packed, addr_meta = _pack(graph)
    hillshade = build_hillshade()

    data_dir = _clean_site()
    gz = packed["gz"]
    gz_name = f"graph-{hashlib.sha1(gz).hexdigest()[:10]}.bin.gz"
    (data_dir / gz_name).write_bytes(gz)
    png = hillshade["png"]
    png_name = f"hillshade-{hashlib.sha1(png).hexdigest()[:10]}.png"
    (data_dir / png_name).write_bytes(png)
    manifest = build_manifest(packed["meta"], "data/" + gz_name)
    MANIFEST_JSON.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    assets = {
        "app.css": _hashed("app", "css", _asset("simple.css")),
        "app.js": _hashed("app", "js", _asset("engine.js") + "\n" + _asset("simple.js")),
        "leaflet.css": _hashed("leaflet", "css", _vendor("leaflet-1.9.4.css")),
        "leaflet.js": _hashed("leaflet", "js", _vendor("leaflet-1.9.4.min.js")),
    }
    payload = {
        "manifest": packed["manifest"],
        "meta": packed["meta"],
        "addr": addr_meta,
        "labels": _labels(ctx.neighborhoods),
        "build": manifest,
        "bundle_url": "data/" + gz_name,
        "bundle_bytes": len(gz),
        "hillshade": {"bounds": hillshade["bounds"], "url": "data/" + png_name},
    }
    SITE_INDEX.write_text(page_html(payload, assets), encoding="utf-8")
    (SITE_DIR / "favicon.svg").write_text(_FAVICON, encoding="utf-8")
    (SITE_DIR / ".nojekyll").write_text("", encoding="utf-8")
    site_bytes = sum(f.stat().st_size for f in SITE_DIR.rglob("*") if f.is_file())
    log.info("wrote the site in %s (%s)", SITE_DIR.name, human_bytes(site_bytes))
    return SITE_INDEX
