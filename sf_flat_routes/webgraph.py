"""Pack the routable graph into a compact binary payload for the browser.

The app ships the street graph itself, not precomputed answers: about
160,000 directed arcs and 70,000 nodes pack into a few megabytes, and every
search (shortest, Pareto frontier, loops, the uphill cap) runs in the browser.

Packing
-------
Everything is a typed array.  All of them, plus the encoded geometry and the
place index, are concatenated into a single buffer and gzipped; the browser
inflates it with ``DecompressionStream`` and takes ``TypedArray`` views
straight onto the result.  Quantisation is chosen so it is invisible at the
scale the metrics are reported:

* coordinates: ``int32`` micro-degrees (~0.1 m)
* lengths: ``uint16`` in 5 cm units
* climbing: ``uint16`` centimetres
* ``max_up_grade_15m``: ``uint16`` hundredths of a percent

Geometry is one concatenated Google-encoded polyline string with per-edge
character offsets.

Only arcs in the largest strongly connected component of the wheelchair
network are packed, so any two snapped points are mutually reachable unless
the uphill cap cuts them apart.
"""

from __future__ import annotations

import base64
import gzip

import numpy as np
import pandas as pd

from sf_flat_routes.utils import get_logger, step

log = get_logger("sf_flat_routes.webgraph")

#: Quantisation scales. Chosen so that round-trip error is far below the
#: precision at which any metric is reported.
DM = 20.0  # 5 cm units per metre (max edge 1212 m fits uint16)
CM = 100.0  # centimetres per metre
GRADE_Q = 10000.0  # units per unit gradient (0.01% resolution; uint16 holds 655%)
COORD_Q = 1e6  # micro-degrees


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def _u16(values, scale: float) -> np.ndarray:
    return np.clip(np.round(np.asarray(values, dtype="float64") * scale), 0, 65535).astype("<u2")


def _i16(values, scale: float) -> np.ndarray:
    return np.clip(np.round(np.asarray(values, dtype="float64") * scale), -32768, 32767).astype(
        "<i2"
    )


def encode_polyline(coords, precision: int = 5) -> str:
    """Google encoded-polyline format for a sequence of (lon, lat)."""
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lon = 0

    def enc(v: int) -> str:
        v = ~(v << 1) if v < 0 else (v << 1)
        chunks = []
        while v >= 0x20:
            chunks.append(chr((0x20 | (v & 0x1F)) + 63))
            v >>= 5
        chunks.append(chr(v + 63))
        return "".join(chunks)

    for lon, lat in coords:
        ilat = int(round(lat * factor))
        ilon = int(round(lon * factor))
        out.append(enc(ilat - prev_lat))
        out.append(enc(ilon - prev_lon))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


# --------------------------------------------------------------------------
def _availability(directed: pd.DataFrame, node_index: dict) -> tuple[np.ndarray, np.ndarray]:
    """Per-arc availability: traversable and inside the largest strongly
    connected component, so every routable node can reach every other."""
    import scipy.sparse as sp

    ok = directed["traversable"].to_numpy()
    fi = directed["from_node"].map(node_index).to_numpy()
    ti = directed["to_node"].map(node_index).to_numpy()
    n = len(node_index)
    sub_f, sub_t = fi[ok], ti[ok]
    adj = sp.coo_matrix((np.ones(sub_f.size), (sub_f, sub_t)), shape=(n, n)).tocsr()
    ncomp, labels = sp.csgraph.connected_components(adj, directed=True, connection="strong")
    touched = np.zeros(n, dtype=bool)
    touched[sub_f] = True
    touched[sub_t] = True
    counts = np.bincount(labels[touched], minlength=ncomp)
    in_scc = (labels == int(counts.argmax())) & touched
    avail = ok & in_scc[fi] & in_scc[ti]
    log.info(
        "  %d of %d traversable arcs available (largest SCC has %d nodes)",
        int(avail.sum()),
        int(ok.sum()),
        int(in_scc.sum()),
    )
    return avail, in_scc


def _node_coords(edges, nodes, node_index: dict) -> tuple[np.ndarray, np.ndarray]:
    ll = edges.to_crs("EPSG:4326")
    lon = np.zeros(len(nodes))
    lat = np.zeros(len(nodes))
    seen = np.zeros(len(nodes), dtype=bool)
    for u, v, geom in zip(edges["u"], edges["v"], ll.geometry, strict=True):
        c = geom.coords
        for node, (x, y) in ((u, c[0]), (v, c[-1])):
            i = node_index.get(node)
            if i is not None and not seen[i]:
                lon[i] = x
                lat[i] = y
                seen[i] = True
    return lon, lat


def _geometry(edges) -> tuple[str, np.ndarray, int]:
    """One polyline string for every edge, with per-edge character offsets."""
    ll = edges.to_crs("EPSG:4326")
    parts: list[str] = []
    offs = np.zeros(len(edges) + 1, dtype="<i4")
    pos = 0
    for i, geom in enumerate(ll.geometry):
        s = encode_polyline(list(geom.coords))
        parts.append(s)
        pos += len(s)
        offs[i + 1] = pos
    return "".join(parts), offs, sum(len(g.coords) for g in ll.geometry)


def build_payload(edges, directed: pd.DataFrame) -> dict:
    """Pack nodes, arcs, geometry and display attributes for the browser."""
    with step("packing the routable graph for the browser", log):
        nodes = pd.unique(
            pd.concat([directed["from_node"], directed["to_node"]], ignore_index=True)
        )
        node_index = {n: i for i, n in enumerate(nodes)}
        lon, lat = _node_coords(edges, nodes, node_index)

        # Elevations are reconciled to one value per intersection upstream,
        # so a profile sampled at arc boundaries is exact at every corner.
        za = directed[["from_node", "start_elev"]].rename(
            columns={"from_node": "node", "start_elev": "z"}
        )
        zb = directed[["to_node", "end_elev"]].rename(columns={"to_node": "node", "end_elev": "z"})
        zz = pd.concat([za, zb], ignore_index=True).groupby("node")["z"].median()
        node_z = zz.reindex(nodes).fillna(0.0).to_numpy()

        avail, in_scc = _availability(directed, node_index)
        d = directed[avail].reset_index(drop=True)
        # bit 0: routable; bit 2: a reverse traversal, so geometry is drawn backwards
        flags = np.ones(len(d), dtype="<u1")
        flags |= (d["direction"].to_numpy() == "rev").astype("<u1") << 2

        fi = d["from_node"].map(node_index).to_numpy()
        ti = d["to_node"].map(node_index).to_numpy()
        order = np.argsort(fi, kind="stable")
        fi, ti, d, flags = fi[order], ti[order], d.iloc[order], flags[order]
        indptr = np.zeros(len(nodes) + 1, dtype="<i4")
        np.add.at(indptr, fi + 1, 1)
        indptr = np.cumsum(indptr).astype("<i4")

        classes = sorted(set(edges["cls"].dropna().unique()))
        cls_idx = {c: i for i, c in enumerate(classes)}
        names = edges["name"].fillna("")
        name_values = sorted(set(names) - {""})
        name_idx = {n: i + 1 for i, n in enumerate(name_values)}
        # edge ids are a contiguous 0..n-1 range by construction, so storing
        # them (and a reverse lookup in the browser) would be pure overhead
        if not np.array_equal(edges["edge_id"].to_numpy(), np.arange(len(edges))):
            raise ValueError("edge ids must be the contiguous range 0..n-1")
        geom, offs, n_coords = _geometry(edges)

        arrays: dict[str, np.ndarray] = {
            "node_lon": np.round(lon * COORD_Q).astype("<i4"),
            "node_lat": np.round(lat * COORD_Q).astype("<i4"),
            "node_flags": in_scc.astype("<u1"),
            "node_elev": _i16(node_z, DM),
            "indptr": indptr,
            "geom_off": offs,
            "arc_head": ti.astype("<i4"),
            "arc_edge": d["edge_id"].to_numpy().astype("<i4"),
            "arc_len": _u16(d["length_m"], DM),
            "arc_gain": _u16(d["cum_gain"], CM),
            "arc_loss": _u16(d["cum_loss"], CM),
            "arc_maxup": _u16(d["max_up_grade_15m"], GRADE_Q),
            "arc_flags": flags,
            "edge_name": names.map(lambda n: name_idx.get(n, 0)).to_numpy().astype("<u2"),
            "edge_cls": edges["cls"].map(cls_idx).fillna(0).to_numpy().astype("<u1"),
            "edge_len": _u16(edges["length_m"], DM),
        }
        meta = {
            "n_nodes": int(len(nodes)),
            "n_arcs": int(len(ti)),
            "n_edges": int(len(edges)),
            "classes": classes,
            "names": name_values,
            "scales": {"dm": DM, "cm": CM, "grade": GRADE_Q, "coord": COORD_Q},
        }
        return {"arrays": arrays, "geom": geom, "meta": meta, "n_coords": n_coords}


_DTYPE_TAG = {
    "int32": "i4",
    "uint32": "u4",
    "int16": "i2",
    "uint16": "u2",
    "uint8": "u1",
    "int8": "i1",
    "float32": "f4",
    "float64": "f8",
}


def bundle(graph: dict, strings: dict[str, str]) -> dict:
    """Concatenate arrays and strings, gzip, and base64-encode once.

    Returns the manifest the browser needs to take views onto the inflated
    buffer, plus the encoded bundle itself.
    """
    blobs: list[bytes] = []
    manifest_arrays: dict[str, dict] = {}
    manifest_strings: dict[str, dict] = {}
    off = 0

    for name, arr in graph["arrays"].items():
        raw = np.ascontiguousarray(arr).tobytes()
        tag = _DTYPE_TAG.get(arr.dtype.name)
        if tag is None:
            raise TypeError(f"unsupported dtype {arr.dtype} for {name}")
        manifest_arrays[name] = {"t": tag, "o": off, "n": int(arr.size)}
        blobs.append(raw)
        off += len(raw)

    for name, text in strings.items():
        raw = text.encode("utf-8")
        manifest_strings[name] = {"o": off, "b": len(raw)}
        blobs.append(raw)
        off += len(raw)

    flat = b"".join(blobs)
    # mtime=0 keeps the output byte-reproducible; gzip otherwise stamps the
    # current time into the header and the map churns on every rebuild
    packed = gzip.compress(flat, compresslevel=9, mtime=0)
    log.info(
        "  bundle: %.2f MB raw -> %.2f MB gzipped -> %.2f MB base64",
        len(flat) / 1e6,
        len(packed) / 1e6,
        len(packed) * 4 / 3 / 1e6,
    )
    return {
        "manifest": {"arrays": manifest_arrays, "strings": manifest_strings, "bytes": len(flat)},
        "b64": base64.b64encode(packed).decode("ascii"),
        "gz": packed,
        "meta": graph["meta"],
    }
