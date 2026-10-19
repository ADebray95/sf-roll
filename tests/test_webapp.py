"""Tests for the site builder and the hillshade base map."""

import json

import numpy as np
import pytest

from sf_flat_routes.places import hillshade
from sf_flat_routes.webapp import fill, page_html

ASSETS = {
    "app.css": "app-1.css",
    "app.js": "app-1.js",
    "leaflet.css": "l-1.css",
    "leaflet.js": "l-1.js",
}


def test_fill_tolerates_whitespace_inside_the_placeholder():
    html = "<style>\n  /*__APP_CSS__*/\n</style>"
    out = fill(html, r"<style>\s*/\*__APP_CSS__\*/\s*</style>", '<link href="a.css">')
    assert out == '<link href="a.css">'


def test_fill_refuses_a_missing_placeholder():
    with pytest.raises(ValueError, match="found 0 times"):
        fill("<html></html>", r"/\*__DATA__\*/", "{}")


def test_fill_refuses_a_duplicated_placeholder():
    with pytest.raises(ValueError, match="found 2 times"):
        fill("/*__DATA__*/ /*__DATA__*/", r"/\*__DATA__\*/", "{}")


def test_fill_inserts_backslashes_verbatim():
    assert fill("x /*__DATA__*/", r"/\*__DATA__\*/", r'"a\nb"') == r'x "a\nb"'


def test_page_links_every_hashed_asset_and_embeds_the_data():
    payload = {"bundle_url": "data/graph-abc.bin.gz", "meta": {"n_nodes": 3}}
    html = page_html(payload, ASSETS)
    for name in ASSETS.values():
        assert name in html
    assert "/*__" not in html and "__HEAD_EXTRA__" not in html
    start = html.index("window.DATA = ") + len("window.DATA = ")
    embedded = json.loads(html[start : html.index(";</script>", start)])
    assert embedded == payload


def test_hillshade_is_bounded_and_flat_ground_is_uniform():
    flat = np.zeros((20, 20))
    hs = hillshade(flat, res=1.0)
    assert hs.shape == flat.shape
    assert np.all((hs >= 0) & (hs <= 1))
    assert np.ptp(hs) == pytest.approx(0.0, abs=1e-9)


def test_hillshade_distinguishes_slope_direction():
    ramp = np.tile(np.arange(20.0), (20, 1))  # rises to the east
    assert not np.allclose(hillshade(ramp, res=1.0), hillshade(-ramp, res=1.0))


def test_the_web_manifest_is_installable():
    from sf_flat_routes.webapp import web_manifest

    m = web_manifest()
    assert m["name"] == "Roll SF" and m["display"] == "standalone"
    assert m["start_url"] == "./" and m["theme_color"].startswith("#")
    assert {i["sizes"] for i in m["icons"]} == {"192x192", "512x512"}


def test_the_icon_is_a_square_png():
    import io

    from PIL import Image

    from sf_flat_routes.webapp import app_icon

    im = Image.open(io.BytesIO(app_icon(192)))
    assert im.format == "PNG" and im.size == (192, 192)


def test_the_service_worker_precaches_the_shell_under_the_build_version():
    from sf_flat_routes.webapp import service_worker

    shell = ["./", "app-abc.js", "data/graph-123.bin.gz"]
    sw = service_worker(shell, "v42")
    assert 'const CACHE = "rollsf-v42";' in sw
    assert 'const SHELL = ["./", "app-abc.js", "data/graph-123.bin.gz"];' in sw
    assert "__VERSION__" not in sw and "__SHELL__" not in sw
