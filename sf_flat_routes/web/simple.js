/* Roll SF -- the app.
 *
 * A full-screen map and a bottom sheet: start and destination (or a loop
 * length), the maximum uphill grade, and a slider from the shortest route
 * to the one with the least climbing among those that respect the cap.
 * Routing comes from engine.js, text from format.js, search and storage
 * from search.js. Everything runs in the page.
 */
"use strict";

(function () {
  const DATA = window.DATA;
  const CAP = { min: 3, max: 20, def: 8 };
  const LOOP = { min: 0.5, max: 15, def: 3 };
  const SNAP_M = 150; // spec 6.5
  const CAP_THROTTLE_MS = 100; // spec 7.3
  const SLICE_MS = 25; // searches run in slices this long, so the page keeps painting
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ------------------------------------------------- grade colours (7.2) */
  function gradeColour(g, a) {
    const up = g.maxUp(a);
    if (up <= 0) return g.arcLoss[a] > 0 ? css("--g-down") : css("--g0");
    if (up < 0.05) return css("--g0");
    if (up < 0.08) return css("--g1");
    if (up <= 0.12) return css("--g2");
    return css("--g3");
  }

  /* ---------------------------------------- the street canvases (7.2) */
  /* Street coordinates projected once to Web Mercator pixels at zoom 0, so a
   * repaint only scales and shifts them. */
  function projectAll(geom) {
    const n = geom.coords.length,
      out = new Float64Array(n);
    for (let k = 0; k < n; k += 2) {
      const lon = geom.coords[k],
        lat = (geom.coords[k + 1] * Math.PI) / 180;
      out[k] = ((lon + 180) / 360) * 256;
      out[k + 1] = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * 256;
    }
    return out;
  }

  /* One canvas over the map. ``blocked`` false paints every street faintly
   * and repaints only when the map moves; ``blocked`` true paints just the
   * streets steeper than the cap (grey dots) and also repaints when the cap
   * changes, which is what keeps dragging the cap slider smooth. */
  const StreetLayer = L.Layer.extend({
    initialize(app, blocked) {
      this.app = app;
      this.blocked = blocked;
    },
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create(
        "canvas",
        "leaflet-zoom-animated " + (this.blocked ? "streets-blocked" : "streets"),
      );
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on("moveend zoomend resize", this.redraw, this);
      map.on("zoomanim", this._animate, this);
      this.redraw();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off("moveend zoomend resize", this.redraw, this);
      map.off("zoomanim", this._animate, this);
    },
    _animate(e) {
      const scale = this._map.getZoomScale(e.zoom);
      const offset = this._map._latLngToNewLayerPoint(
        this._map.getBounds().getNorthWest(),
        e.zoom,
        e.center,
      );
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },
    /* repaint on the next frame; repeated calls while dragging coalesce */
    schedule() {
      if (this._frame) return;
      this._frame = requestAnimationFrame(() => {
        this._frame = 0;
        this.redraw();
      });
    },
    redraw() {
      const map = this._map;
      if (!map) return;
      // two device pixels per CSS pixel are plenty for hairlines, and a third
      // would more than double what every repaint has to composite
      const size = map.getSize(),
        dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this._canvas.width !== size.x * dpr || this._canvas.height !== size.y * dpr) {
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + "px";
        this._canvas.style.height = size.y + "px";
      }
      const nw = map.getBounds().getNorthWest();
      L.DomUtil.setTransform(this._canvas, map.latLngToLayerPoint(nw), 1);
      const ctx = this._canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      const z = map.getZoom();
      const b = map.getBounds().pad(0.05);
      const west = b.getWest(),
        east = b.getEast(),
        south = b.getSouth(),
        north = b.getNorth();
      const { geom, edgeUp, projected } = this.app;
      const capQ = this.app.state.cap / 100;
      const scale = Math.pow(2, z),
        o = map.project(nw, z);
      const minLen = this.blocked ? 0 : z >= 15 ? 0 : z >= 14 ? 10 : z >= 13 ? 20 : 40;
      const width = z >= 16 ? 1.6 : z >= 14 ? 1.1 : 0.8;
      let count = 0;
      ctx.lineCap = "round";
      if (this.blocked) {
        // grey dots, the same whatever the zoom (the unconstrained route is dashed)
        ctx.strokeStyle = css("--blocked");
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = width + 1.4;
        ctx.setLineDash([0.1, 4]);
      } else {
        ctx.strokeStyle = css("--street");
        ctx.lineWidth = width;
      }
      ctx.beginPath();
      for (let i = 0; i < geom.nEdges; i++) {
        if (this.blocked !== edgeUp[i] > capQ) continue;
        const q = i * 4;
        if (
          geom.bbox[q + 2] < west ||
          geom.bbox[q] > east ||
          geom.bbox[q + 3] < south ||
          geom.bbox[q + 1] > north
        )
          continue;
        if (minLen && geom.len[i] / geom.DM < minLen) continue;
        count++;
        const s = geom.starts[i],
          e = geom.starts[i + 1];
        ctx.moveTo(projected[s] * scale - o.x, projected[s + 1] * scale - o.y);
        for (let k = s + 2; k < e; k += 2)
          ctx.lineTo(projected[k] * scale - o.x, projected[k + 1] * scale - o.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (this.blocked) {
        this._canvas.dataset.overCap = String(count);
        this._canvas.dataset.cap = String(this.app.state.cap);
      }
    },
  });

  /* ----------------------------------------------------------- the app */
  const App = {
    state: {
      cap: CAP.def,
      notch: null,
      from: null,
      to: null,
      loop: null,
      units: loadUnits(),
    },
    gen: 0,
    gps: null, // the latest position fix: { lon, lat, accuracy }
    result: null,

    async start() {
      setStatus("Loading the street network…");
      const buf = await loadBundle(DATA, (got, total) => {
        setStatus(
          "Loading the street network… " +
            (total ? Math.round((100 * got) / total) + "%" : (got / 1e6).toFixed(1) + " MB"),
        );
      });
      // startup phases, readable with performance.getEntriesByType("mark")
      performance.mark("rollsf:downloaded");
      const bundle = new Bundle(buf, DATA.manifest);
      const g = (this.graph = new Graph(bundle, DATA.meta));
      performance.mark("rollsf:graph");
      this.geom = new Geometry(bundle, DATA.meta);
      performance.mark("rollsf:geometry");
      DATA.bundle = null;
      this.buildEdgeGrades();
      this.projected = projectAll(this.geom);
      const routable = [];
      for (let i = 0; i < g.n; i++) if (g.nodeFlags[i]) routable.push(i);
      this.routable = Int32Array.from(routable);
      this.nodeGrid = new Grid(
        Float32Array.from(routable, (i) => g.nodeLon(i)),
        Float32Array.from(routable, (i) => g.nodeLat(i)),
        0.004,
      );
      performance.mark("rollsf:grids");
      this.index = new PlaceIndex(g, this.geom, bundle, DATA.addr);
      performance.mark("rollsf:index");
      this.buildMap();
      performance.mark("rollsf:map");
      // Chrome rasterises a canvas layer from scratch the first time it
      // changes after its first paint, a one-off that would stall the first
      // drag of the cap slider; repainting on the next frame takes it now
      requestAnimationFrame(() => requestAnimationFrame(() => this.streets.redraw()));
      this.buildUI();
      setStatus("");
      const shared = decodeState(location.hash, CAP);
      if (shared) this.applyShared(shared);
      else this.useGps(true);
      this.renderControls();
      this.recompute(true);
      performance.mark("rollsf:ready");
      this.registerWorker();
    },

    /* the service worker caches the app and the graph for offline use (spec 8) */
    registerWorker() {
      if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("offline use is unavailable:", err);
      });
    },

    /* the steeper direction of every edge, for the over-cap overlay, and
     * each direction separately, for the note when a street is tapped */
    buildEdgeGrades() {
      const g = this.graph,
        n = this.geom.nEdges;
      this.edgeUp = new Float32Array(n);
      this.edgeFwd = new Float32Array(n);
      this.edgeRev = new Float32Array(n);
      for (let a = 0; a < g.m; a++) {
        const e = g.arcEdge[a],
          up = g.maxUp(a);
        if (g.arcFlags[a] & 4) this.edgeRev[e] = up;
        else this.edgeFwd[e] = up;
        if (up > this.edgeUp[e]) this.edgeUp[e] = up;
      }
    },

    /* --------------------------------------------------------------- map */
    buildMap() {
      const map = L.map("map", {
        zoomControl: false,
        attributionControl: true,
        center: [37.765, -122.44],
        zoom: 13,
        minZoom: 11,
        maxZoom: 18,
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix("");
      map.attributionControl.addAttribution(
        "Streets © <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> via " +
          "<a href='https://overturemaps.org'>Overture</a> (ODbL) · Elevation USGS 3DEP",
      );
      this.map = map;
      if (DATA.hillshade) {
        L.imageOverlay(DATA.hillshade.url, DATA.hillshade.bounds, {
          interactive: false,
          className: "hillshade",
          alt: "",
        }).addTo(map);
      }
      new StreetLayer(this, false).addTo(map);
      this.streets = new StreetLayer(this, true).addTo(map);
      const labels = L.layerGroup().addTo(map);
      for (const l of DATA.labels || []) {
        L.marker([l.lat, l.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: "nblabel", html: l.n, iconSize: null }),
        }).addTo(labels);
      }
      const zoomClass = () => {
        const z = map.getZoom();
        map.getContainer().classList.toggle("z-low", z < 12);
        map.getContainer().classList.toggle("z-high", z >= 15.5);
      };
      map.on("zoomend", zoomClass);
      zoomClass();
      this.svg = L.svg({ padding: 0.5 });
      this.shortestLayer = L.layerGroup().addTo(map);
      this.routeLayer = L.layerGroup().addTo(map);
      this.markers = L.layerGroup().addTo(map);
      this.gpsLayer = L.layerGroup().addTo(map);
      map.on("click", (e) => this.onMapTap(e.latlng));
    },

    /* A tap offers "Set as start" / "Set as destination", and says so when
     * the street under the finger is steeper than the cap. */
    onMapTap(latlng) {
      const box = document.createElement("div");
      const edge = this.edgeNear(latlng, 14);
      if (edge >= 0 && this.edgeUp[edge] > this.state.cap / 100) {
        const p = document.createElement("p");
        p.className = "popup-note";
        p.textContent = steepNote(this.state.cap, this.edgeFwd[edge], this.edgeRev[edge]);
        box.appendChild(p);
      }
      const actions = document.createElement("div");
      actions.className = "popup-actions";
      const add = (label, which) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          this.map.closePopup();
          const pt = this.pointAt(latlng.lng, latlng.lat);
          if (!pt) return;
          this.setPoint(which, pt);
          this.recompute("auto");
        });
        actions.appendChild(b);
      };
      add("Set as start", "from");
      if (!this.state.loop) add("Set as destination", "to");
      box.appendChild(actions);
      L.popup({ closeButton: true, autoPan: true })
        .setLatLng(latlng)
        .setContent(box)
        .openOn(this.map);
    },

    /* the edge nearest a point, within px screen pixels, or -1 */
    edgeNear(latlng, px) {
      const map = this.map,
        geom = this.geom;
      const p0 = map.latLngToContainerPoint(latlng);
      const pad = map.containerPointToLatLng([p0.x + px, p0.y + px]);
      const dLon = Math.abs(pad.lng - latlng.lng),
        dLat = Math.abs(pad.lat - latlng.lat);
      let best = -1,
        bestD = px * px;
      for (let i = 0; i < geom.nEdges; i++) {
        const o = i * 4;
        if (
          geom.bbox[o + 2] < latlng.lng - dLon ||
          geom.bbox[o] > latlng.lng + dLon ||
          geom.bbox[o + 3] < latlng.lat - dLat ||
          geom.bbox[o + 1] > latlng.lat + dLat
        )
          continue;
        let prev = null;
        for (let k = geom.starts[i]; k < geom.starts[i + 1]; k += 2) {
          const q = map.latLngToContainerPoint([geom.coords[k + 1], geom.coords[k]]);
          if (prev) {
            const d = segDist2(p0, prev, q);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          prev = q;
        }
      }
      return best;
    },

    /* ---------------------------------------------------------- endpoints */
    /* Whatever was searched, tapped or located snaps to the nearest routable
     * corner within 150 m (spec 6.5); null, with a message, if there is none. */
    pointAt(lon, lat, label, gps = false) {
      const k = this.nodeGrid.nearest(lon, lat);
      const node = k >= 0 ? this.routable[k] : -1;
      const g = this.graph;
      if (node < 0 || metres(lon, lat, g.nodeLon(node), g.nodeLat(node)) > SNAP_M) {
        setStatus("No wheelchair-accessible street within 150 m.");
        return null;
      }
      return {
        lon: g.nodeLon(node),
        lat: g.nodeLat(node),
        node,
        gps,
        label: label || "Near " + this.index.describe(node),
      };
    },

    setPoint(which, pt) {
      this.state[which] = pt;
      if (which === "from" || which === "to") this.state.notch = null;
      const input = $(which);
      input.value = pt ? pt.label : "";
      this.updateStar(which);
      this.drawMarkers();
    },

    /* Start from the device's position (spec D16): on first load, and when
     * "My location" is picked. Denied or unavailable says so clearly. */
    useGps(initial) {
      if (!("geolocation" in navigator)) {
        if (!initial)
          setStatus("This browser cannot share its location. Search for a start instead.");
        return;
      }
      if (this.watchId === undefined) {
        this.watchId = navigator.geolocation.watchPosition(
          (pos) => this.onPosition(pos),
          (err) => this.onPositionError(err),
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
        );
      }
      this.wantGpsStart = true;
      if (this.gps) this.onPosition(null);
      else if (!this.state.from) {
        $("from").value = "My location";
        setStatus("Finding your location…");
      }
    },

    onPosition(pos) {
      if (pos) {
        this.gps = {
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
        };
        this.drawGps();
      }
      if (!this.wantGpsStart || !this.gps) return;
      this.wantGpsStart = false;
      const pt = this.pointAt(this.gps.lon, this.gps.lat, "My location", true);
      if (!pt) {
        $("from").value = "";
        return;
      }
      setStatus("");
      this.setPoint("from", pt);
      this.recompute(true);
    },

    onPositionError(err) {
      this.wantGpsStart = false;
      if (this.state.from && this.state.from.gps) this.setPoint("from", null);
      if ($("from").value === "My location") $("from").value = "";
      setStatus(
        err && err.code === 1
          ? "Location access is off. Search for a start, or tap the map."
          : "Your location is unavailable right now. Search for a start, or tap the map.",
      );
    },

    drawGps() {
      const p = this.gps;
      this.gpsLayer.clearLayers();
      if (!p) return;
      L.circle([p.lat, p.lon], {
        radius: p.accuracy,
        color: "#1f6fe5",
        weight: 1,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(this.gpsLayer);
      this.gpsDot = L.marker([p.lat, p.lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "gps-dot", iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(this.gpsLayer);
      $("recenter").hidden = false;
    },

    drawMarkers() {
      this.markers.clearLayers();
      for (const which of ["from", "to"]) {
        const p = this.state[which];
        if (!p || (which === "to" && this.state.loop)) continue;
        const m = L.marker([p.lat, p.lon], {
          draggable: true,
          keyboard: false,
          title: which === "from" ? "Start" : "Destination",
          alt: which === "from" ? "Start" : "Destination",
          icon: L.divIcon({
            className: "pin-icon " + which,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        }).addTo(this.markers);
        m.on("dragend", () => {
          const ll = m.getLatLng();
          const pt = this.pointAt(ll.lng, ll.lat);
          if (pt) this.setPoint(which, pt);
          else this.drawMarkers();
          this.recompute(false);
        });
      }
    },

    /* --------------------------------------------------------- the sheet */
    buildUI() {
      for (const which of ["from", "to"]) this.bindField(which);
      $("swap").addEventListener("click", () => {
        const a = this.state.from,
          b = this.state.to;
        this.setPoint("from", b);
        this.setPoint("to", a);
        this.recompute("auto");
      });
      $("loopbtn").addEventListener("click", () => {
        this.state.loop = this.state.loop ? null : { km: LOOP.def, outBack: false, idx: 0 };
        this.renderControls();
        this.drawMarkers();
        this.recompute(true);
      });
      $("loopkm").addEventListener("input", () => {
        this.state.loop.km = Number($("loopkm").value);
        this.state.loop.idx = 0;
        this.renderControls();
        this.throttle(() => this.recompute("auto"), 350);
      });
      $("loopkm").addEventListener("change", () => this.recompute("auto"));
      $("outback").addEventListener("change", () => {
        this.state.loop.outBack = $("outback").checked;
        this.state.loop.idx = 0;
        this.recompute(true);
      });
      const cap = $("cap");
      cap.addEventListener("input", () => {
        this.state.cap = Number(cap.value);
        this.state.notch = null;
        this.renderControls();
        this.streets.schedule();
        this.throttle(() => this.recompute("auto", true), CAP_THROTTLE_MS);
      });
      cap.addEventListener("change", () => {
        clearTimeout(this._throttle);
        this._throttle = null;
        this.recompute("auto");
      });
      $("notch").addEventListener("input", () => {
        this.state.notch = Number($("notch").value);
        this.showNotch();
        this.writeHash();
      });
      $("usecap").addEventListener("click", () => {
        this.state.cap = Number($("usecap").dataset.cap);
        this.renderControls();
        this.streets.redraw();
        this.recompute("auto");
      });
      $("nextloop").addEventListener("click", () => {
        const r = this.result;
        if (!r || !r.loops) return;
        this.state.loop.idx = (this.state.loop.idx + 1) % r.loops.length;
        this.showLoop();
        this.writeHash();
      });
      $("share").addEventListener("click", () => this.share());
      $("recenter").addEventListener("click", () => {
        if (this.gps)
          this.map.setView([this.gps.lat, this.gps.lon], Math.max(this.map.getZoom(), 16));
      });
      $("settingsbtn").addEventListener("click", () => $("settings").showModal());
      $("aboutbtn").addEventListener("click", () => $("about").showModal());
      for (const r of document.querySelectorAll("input[name=units]")) {
        r.checked = r.value === this.state.units;
        r.addEventListener("change", () => {
          this.state.units = r.value;
          saveUnits(r.value);
          this.renderControls();
          this.renderResult();
        });
      }
      const b = DATA.build || {};
      $("buildinfo").textContent =
        "Street data built " +
        (b.built || "?") +
        " from Overture " +
        (b.overture_release || "?") +
        " and USGS lidar " +
        (b.lidar_project || "?") +
        " (" +
        (b.git_sha || "?") +
        ").";
      window.addEventListener("resize", () => this.drawProfile());
    },

    /* a search field: suggestions as you type, favourites and "My location"
     * when empty, a star to keep the chosen place */
    bindField(which) {
      const input = $(which),
        list = $(which + "_s");
      let items = [],
        sel = -1;
      const render = () => {
        list.innerHTML = "";
        items.forEach((it, i) => {
          const li = document.createElement("li");
          li.id = which + "_opt" + i;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", i === sel ? "true" : "false");
          const n = document.createElement("span"),
            k = document.createElement("span");
          n.textContent = it.name;
          k.className = "k";
          k.textContent = it.kind;
          li.append(n, k);
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            pick(i);
          });
          list.appendChild(li);
        });
        list.hidden = items.length === 0;
        input.setAttribute("aria-expanded", items.length ? "true" : "false");
        if (sel >= 0) input.setAttribute("aria-activedescendant", which + "_opt" + sel);
        else input.removeAttribute("aria-activedescendant");
      };
      const suggestions = () => {
        const q = input.value.trim();
        const favs = loadFavourites().map((f) => ({ ...f, kind: "favourite" }));
        if (!q || q === (this.state[which] && this.state[which].label)) {
          const base =
            which === "from" && "geolocation" in navigator
              ? [{ name: "My location", kind: "GPS", gps: true }]
              : [];
          return base.concat(favs);
        }
        const nq = normName(q);
        const favHits = favs.filter((f) => normName(f.name).includes(nq));
        return favHits.concat(this.index.search(q, 8 - Math.min(favHits.length, 3)));
      };
      const pick = (i) => {
        const it = items[i];
        if (!it) return;
        items = [];
        render();
        if (it.gps) {
          this.state.from = null;
          this.useGps(false);
          input.blur();
          return;
        }
        const pt =
          it.node !== undefined
            ? { lon: it.lon, lat: it.lat, node: it.node, label: it.name, gps: false }
            : this.pointAt(it.lon, it.lat, it.name);
        if (!pt) return;
        this.setPoint(which, pt);
        const other = which === "from" ? "to" : "from";
        if (!this.state.loop && !this.state[other]) $(other).focus();
        else input.blur();
        this.recompute("auto");
      };
      input.addEventListener("focus", () => {
        items = suggestions();
        sel = -1;
        render();
        input.select();
      });
      input.addEventListener("input", () => {
        items = suggestions();
        sel = items.length ? 0 : -1;
        render();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && items.length) {
          sel = (sel + 1) % items.length;
          render();
          e.preventDefault();
        } else if (e.key === "ArrowUp" && items.length) {
          sel = (sel - 1 + items.length) % items.length;
          render();
          e.preventDefault();
        } else if (e.key === "Enter") {
          if (sel >= 0) pick(sel);
          e.preventDefault();
        } else if (e.key === "Escape") {
          items = [];
          render();
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        setTimeout(() => {
          items = [];
          render();
          const p = this.state[which];
          if (p) input.value = p.label;
        }, 150);
      });
      $(which + "_star").addEventListener("click", () => {
        const p = this.state[which];
        if (!p || p.gps) return;
        const res = toggleFavourite({ name: p.label, lon: p.lon, lat: p.lat });
        if (!res.stored)
          setStatus("This browser is not keeping data, so favourites cannot be saved.");
        this.updateStar(which);
      });
    },

    updateStar(which) {
      const p = this.state[which],
        star = $(which + "_star");
      star.hidden = !p || p.gps;
      if (!p) return;
      const on = loadFavourites().some((f) => f.name === p.label);
      star.setAttribute("aria-pressed", on ? "true" : "false");
      const what = which === "from" ? "start" : "destination";
      star.setAttribute(
        "aria-label",
        on ? "Remove " + what + " from favourites" : "Save " + what + " as a favourite",
      );
    },

    /* sliders and labels from the state */
    renderControls() {
      const s = this.state;
      $("cap").value = String(s.cap);
      $("cap_v").textContent = capLabel(s.cap);
      $("cap").setAttribute("aria-valuetext", capValueText(s.cap));
      const looping = !!s.loop;
      $("sheet").classList.toggle("looping", looping);
      $("loopbtn").setAttribute("aria-pressed", looping ? "true" : "false");
      $("loopbtn").setAttribute("aria-label", looping ? "Plan a trip instead" : "Make it a loop");
      $("looprow").hidden = !looping;
      $("traderow").hidden = looping;
      if (looping) {
        $("loopkm").value = String(s.loop.km);
        $("loopkm_v").textContent = fmtLoopLength(s.loop.km, s.units);
        $("loopkm").setAttribute("aria-valuetext", fmtLoopLength(s.loop.km, s.units));
        $("outback").checked = s.loop.outBack;
      }
    },

    throttle(fn, ms) {
      this._pending = fn;
      if (this._throttle) return;
      fn();
      this._pending = null;
      this._throttle = setTimeout(() => {
        this._throttle = null;
        if (this._pending) {
          const f = this._pending;
          this._pending = null;
          f();
        }
      }, ms);
    },

    /* ------------------------------------------------------------ routing */
    /* Route again after any change. The shortest route under the cap (or,
     * when none exists, under the smallest cap that works) shows at once;
     * the trade-off search then runs in slices. ``quick`` (while the cap
     * slider is being dragged) stops after the shortest route, so a drag
     * stays smooth; the full search runs on release. */
    recompute(fit, quick = false) {
      const gen = ++this.gen;
      this.result = null;
      this.writeHash();
      if (this.state.loop) return this.recomputeLoop(gen, fit);
      const { from, to, cap } = this.state;
      if (!from || !to) {
        this.clearRoute();
        if (!$("status").textContent || $("status").dataset.prompt)
          setStatus(!from ? "Where do you start?" : "Where to?", true);
        return;
      }
      if (from.node === to.node) {
        this.clearRoute();
        setStatus("Start and destination are the same corner.");
        return;
      }
      const g = this.graph;
      // the unconstrained shortest route does not depend on the cap
      const key = from.node + ">" + to.node;
      if (!this._plain || this._plain.key !== key) {
        const route = g.route(from.node, to.node, { alpha: 0 });
        this._plain = { key, route, ref: route ? g.summarise(route.arcs) : null };
      }
      let limit = cap / 100,
        need = null;
      let first = g.route(from.node, to.node, { alpha: 0 }, limit);
      if (!first) {
        const cStar = g.minimaxCap(from.node, to.node);
        if (cStar === null || !this._plain.route) {
          this.clearRoute();
          setStatus("These two places are not connected by wheelchair-accessible streets.");
          return;
        }
        need = Math.max(cap + 1, Math.ceil(cStar * 100 - 1e-9));
        this._needExact = Math.round(cStar * 1000) / 10;
        limit = cStar;
        first = g.route(from.node, to.node, { alpha: 0 }, limit);
      }
      const s0 = g.summarise(first.arcs);
      this.result = {
        need,
        ref: this._plain.ref,
        plainArcs: this._plain.route.arcs,
        notches: [{ arcs: first.arcs, length: s0.distance_m, gain: s0.elev_gain_m }],
        partial: true,
      };
      setStatus("");
      this.showNotch();
      // the map holds still while the cap is dragged; it refits on release
      if (quick) return;
      if (fit === true || (fit === "auto" && !this.inView())) this.fit();
      setTimeout(() => {
        if (gen !== this.gen) return;
        const t = g.tradeoff(from.node, to.node, limit);
        const run = () => {
          if (gen !== this.gen) return;
          if (!t.search.step(SLICE_MS)) {
            setTimeout(run, 0);
            return;
          }
          const notches = t.notches();
          this.result.notches = notches;
          this.result.partial = false;
          if (this.state.notch === null || this.state.notch >= notches.length)
            this.state.notch = defaultNotch(notches);
          this.showNotch();
          this.writeHash();
        };
        setTimeout(run, 0);
      }, 0);
    },

    recomputeLoop(gen, fit) {
      const { from, cap, loop } = this.state;
      if (!from) {
        this.clearRoute();
        setStatus("Where do you start?", true);
        return;
      }
      setStatus("Trying loops…");
      const search = this.graph.loops(from.node, {
        targetM: loop.km * 1000,
        cap: cap / 100,
        outBack: loop.outBack,
      });
      const run = () => {
        if (gen !== this.gen) return;
        if (!search.step(SLICE_MS)) {
          setTimeout(run, 0);
          return;
        }
        if (!search.loops.length || search.shortfall) {
          this.clearRoute();
          const near = nearestLoopKm(search, loop.km);
          setStatus(loopMissText(loop.km, cap, near, this.state.units));
          return;
        }
        this.result = { loops: search.loops };
        this.state.loop.idx = Math.min(loop.idx, search.loops.length - 1);
        setStatus("");
        this.showLoop();
        if (fit === true || (fit === "auto" && !this.inView())) this.fit();
        this.writeHash();
      };
      setTimeout(run, 0);
    },

    /* the trade-off notch on show */
    showNotch() {
      const r = this.result;
      if (!r || !r.notches) return;
      const n = r.notches.length;
      const i = r.partial ? 0 : clamp(this.state.notch ?? 0, 0, n - 1);
      const route = r.notches[i];
      const sl = $("notch");
      sl.max = String(Math.max(0, n - 1));
      sl.value = String(i);
      sl.disabled = r.partial || n < 2;
      const label = r.partial
        ? "Finding flatter routes…"
        : n < 2
          ? "Shortest is also the flattest"
          : tradeoffLabel(i, route, r.notches[0], this.state.units);
      $("notch_v").textContent = label;
      sl.setAttribute("aria-valuetext", tradeoffValueText(i, n, label));
      this.shown = route;
      this.renderBanner();
      this.renderResult();
      this.drawRoute(route.arcs, r.plainArcs);
    },

    showLoop() {
      const r = this.result;
      if (!r || !r.loops) return;
      const loop = r.loops[this.state.loop.idx];
      this.shown = { arcs: loop.arcs, length: loop.length, gain: loop.gain };
      $("nextloop").hidden = r.loops.length < 2;
      $("nextloop").textContent =
        "Another loop (" + (this.state.loop.idx + 1) + " of " + r.loops.length + ")";
      $("banner").hidden = true;
      this.renderResult();
      this.drawRoute(loop.arcs, null);
    },

    /* the infeasible banner (spec 6.3), for the route on show */
    renderBanner() {
      const r = this.result;
      if (!r || r.need === null) {
        $("banner").hidden = true;
        return;
      }
      const cap = this.state.cap;
      const blocks = steepBlocks(this.graph, this.index, this.shown.arcs, cap / 100);
      $("banner_t").textContent = infeasibleText(cap, this._needExact, blocks);
      const use = $("usecap");
      use.hidden = r.need > CAP.max;
      use.dataset.cap = String(r.need);
      use.textContent = "Use " + r.need + " %";
      $("banner").hidden = false;
    },

    renderResult() {
      const r = this.result;
      if (!r || !this.shown) return;
      const stats = this.graph.summarise(this.shown.arcs);
      this.shownStats = stats;
      const u = this.state.units;
      if (r.ref) {
        const parts = summaryParts(stats, r.ref, u);
        $("s_dist").textContent = parts.distance;
        $("s_climb").textContent = parts.climb;
        $("s_max").textContent = parts.steepest;
      } else {
        $("s_dist").textContent = fmtDistance(stats.distance_m, u);
        $("s_climb").textContent = fmtClimb(stats.elev_gain_m, u) + " climb";
        $("s_max").textContent = "max " + fmtGrade(stats.steepest);
      }
      $("summary").hidden = false;
      $("share").hidden = false;
      if (this.state.loop) {
        this.renderControls();
      }
      this.drawProfile();
    },

    clearRoute() {
      this.result = null;
      this.shown = null;
      this.routeLayer.clearLayers();
      this.shortestLayer.clearLayers();
      for (const id of ["summary", "prof", "share", "nextloop", "banner", "sharebox"])
        $(id).hidden = true;
      $("notch").disabled = true;
      $("notch_v").textContent = "";
    },

    /* the route coloured per arc by its uphill grade, over a white casing;
     * the unconstrained shortest route faint and dashed beneath */
    drawRoute(arcs, plainArcs) {
      const g = this.graph,
        geom = this.geom;
      this.routeLayer.clearLayers();
      this.shortestLayer.clearLayers();
      if (plainArcs && !sameArcs(plainArcs, arcs)) {
        L.polyline(g.geometry(plainArcs, geom), {
          color: css("--shortest"),
          weight: 3,
          opacity: 0.8,
          dashArray: "6 7",
          interactive: false,
        }).addTo(this.shortestLayer);
      }
      L.polyline(g.geometry(arcs, geom), {
        color: css("--casing"),
        weight: 10,
        opacity: 0.95,
        lineJoin: "round",
        lineCap: "round",
        interactive: false,
        renderer: this.svg,
      }).addTo(this.routeLayer);
      let run = [],
        colour = null;
      const flush = () => {
        if (!run.length) return;
        L.polyline(g.geometry(run, geom), {
          color: colour,
          weight: 6,
          lineJoin: "round",
          lineCap: "round",
          interactive: false,
          renderer: this.svg,
          className: "route-run",
        }).addTo(this.routeLayer);
      };
      for (const a of arcs) {
        const c = gradeColour(g, a);
        if (c !== colour) {
          flush();
          run = [];
          colour = c;
        }
        run.push(a);
      }
      flush();
      $("map").dataset.routeArcs = String(arcs.length);
      $("map").dataset.routeLength = String(Math.round(this.graph.summarise(arcs).distance_m));
    },

    /* elevation along the route, coloured like the map, with a dashed line
     * at the cap's slope for scale */
    drawProfile() {
      const cv = $("prof");
      if (!this.shown) return;
      cv.hidden = false;
      const g = this.graph,
        arcs = this.shown.arcs,
        prof = g.profile(arcs);
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth || 340,
        H = cv.clientHeight || 120;
      cv.width = W * dpr;
      cv.height = H * dpr;
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const d = prof.d,
        z = prof.z;
      if (d.length < 2) return;
      const total = d[d.length - 1] || 1;
      let zmin = Math.min(...z),
        zmax = Math.max(...z);
      const span = Math.max(zmax - zmin, 15);
      zmin -= span * 0.1;
      zmax = zmin + span * 1.25;
      const pad = 8,
        top = 10,
        bottom = 20;
      const X = (v) => pad + ((W - 2 * pad) * v) / total;
      const Y = (v) => top + (H - top - bottom) * (1 - (v - zmin) / (zmax - zmin));
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (let i = 0; i < arcs.length; i++) {
        ctx.strokeStyle = gradeColour(g, arcs[i]);
        ctx.beginPath();
        ctx.moveTo(X(d[i]), Y(z[i]));
        ctx.lineTo(X(d[i + 1]), Y(z[i + 1]));
        ctx.stroke();
      }
      // the cap as a slope, from the lowest point of the chart's left edge
      const cap = this.state.cap / 100;
      const mPerPxX = total / (W - 2 * pad),
        mPerPxY = (zmax - zmin) / (H - top - bottom);
      const slopePx = (cap * mPerPxX) / mPerPxY;
      const x0 = pad,
        y0 = H - bottom,
        run = Math.min(W - 2 * pad, (H - top - bottom) / Math.max(slopePx, 1e-6));
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = css("--muted");
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + run, y0 - run * slopePx);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--muted");
      ctx.font = "500 11px " + css("--mono");
      ctx.textAlign = "left";
      // labelled at the far end of the line, inside the chart
      const capText = this.state.cap + " % slope";
      const lx = Math.min(x0 + run + 6, W - pad - ctx.measureText(capText).width);
      ctx.fillText(capText, lx, Math.max(top + 10, y0 - run * slopePx + 4));
      const u = this.state.units;
      ctx.fillText(fmtClimb(z[0], u), pad, H - 5);
      ctx.textAlign = "right";
      ctx.fillText(fmtClimb(z[z.length - 1], u), W - pad, H - 5);
      ctx.textAlign = "center";
      ctx.fillText(fmtDistance(total, u), W / 2, H - 5);
      cv.setAttribute(
        "aria-label",
        "Elevation profile: " +
          fmtDistance(total, u) +
          ", from " +
          fmtClimb(z[0], u) +
          " to " +
          fmtClimb(z[z.length - 1], u) +
          ", steepest uphill " +
          fmtGrade(this.shownStats ? this.shownStats.steepest : 0),
      );
    },

    /* ---------------------------------------------------------- the view */
    viewBounds() {
      const b = L.latLngBounds([]);
      if (this.shown)
        for (const ll of this.graph.geometry(this.shown.arcs, this.geom)) b.extend(ll);
      for (const p of [this.state.from, this.state.loop ? null : this.state.to])
        if (p) b.extend([p.lat, p.lon]);
      return b;
    },
    padding() {
      const size = this.map.getSize(),
        sheet = $("sheet").getBoundingClientRect();
      return size.x >= 720
        ? { paddingTopLeft: [sheet.right + 24, 48], paddingBottomRight: [48, 48] }
        : { paddingTopLeft: [32, 64], paddingBottomRight: [32, sheet.height + 24] };
    },
    inView() {
      const b = this.viewBounds();
      if (!b.isValid()) return true;
      const pad = this.padding();
      const size = this.map.getSize();
      const sw = this.map.latLngToContainerPoint(b.getSouthWest()),
        ne = this.map.latLngToContainerPoint(b.getNorthEast());
      return (
        sw.x >= pad.paddingTopLeft[0] &&
        ne.y >= pad.paddingTopLeft[1] &&
        ne.x <= size.x - pad.paddingBottomRight[0] &&
        sw.y <= size.y - pad.paddingBottomRight[1]
      );
    },
    fit() {
      const b = this.viewBounds();
      if (!b.isValid()) return;
      this.map.fitBounds(b, { ...this.padding(), maxZoom: 16 });
    },

    /* ------------------------------------------------------------ sharing */
    shareState() {
      const s = this.state;
      const place = (p) => (p ? { lon: p.lon, lat: p.lat, label: p.label } : null);
      return {
        cap: s.cap,
        notch: s.notch,
        from: place(s.from),
        to: place(s.to),
        loop: s.loop ? { ...s.loop } : null,
      };
    },
    writeHash() {
      const token = encodeState(this.shareState());
      try {
        history.replaceState(null, "", token ? "#" + token : location.pathname + location.search);
      } catch {
        /* sandboxed: sharing still works through the Copy link button */
      }
    },
    applyShared(s) {
      this.state.cap = s.cap;
      this.state.notch = s.notch;
      this.state.loop = s.loop;
      const from = this.pointAt(s.from.lon, s.from.lat, s.from.label || undefined);
      if (from) this.setPoint("from", from);
      if (s.to) {
        const to = this.pointAt(s.to.lon, s.to.lat, s.to.label || undefined);
        if (to) this.setPoint("to", to);
      }
      this.state.notch = s.notch;
    },
    share() {
      const token = encodeState(this.shareState());
      const url = location.href.split("#")[0] + "#" + token;
      const btn = $("share"),
        box = $("sharebox");
      const done = () => {
        btn.textContent = "Link copied";
        setTimeout(() => {
          btn.textContent = "Copy link";
        }, 1800);
      };
      const fallback = () => {
        box.value = url;
        box.hidden = false;
        box.focus();
        box.select();
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(url).then(done, fallback);
      else fallback();
    },
  };

  /* ------------------------------------------------------------- helpers */
  function setStatus(text, prompt = false) {
    const el = $("status");
    el.textContent = text;
    if (prompt) el.dataset.prompt = "1";
    else delete el.dataset.prompt;
  }
  function metres(lon1, lat1, lon2, lat2) {
    const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
    return Math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * 110540);
  }
  function segDist2(p, a, b) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t =
      dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
    const x = a.x + t * dx - p.x,
      y = a.y + t * dy - p.y;
    return x * x + y * y;
  }
  function sameArcs(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  /* The route's arcs steeper than the cap, as blocks: consecutive steep
   * arcs along one street count once. Steepest first. */
  function steepBlocks(g, index, arcs, cap) {
    const steep = new Set(g.blockingArcs(arcs, cap));
    const runs = [];
    let run = null;
    for (const a of arcs) {
      if (!steep.has(a)) {
        run = null;
        continue;
      }
      const street = index.streetOf(a);
      if (run && run.street === street) run.arcs.push(a);
      else runs.push((run = { street, arcs: [a] }));
    }
    return runs
      .map((r) => ({
        ...index.blockOf(r.arcs),
        grade: Math.max(...r.arcs.map((a) => g.maxUp(a))),
      }))
      .sort((x, y) => y.grade - x.grade);
  }

  /* the loop length closest to what was asked that the search did find,
   * rounded to the slider's half kilometres, if it differs */
  function nearestLoopKm(search, km) {
    const all = search.all || [];
    if (!all.length) return null;
    const best = all.reduce((b, r) =>
      Math.abs(r.length / 1000 - km) < Math.abs(b.length / 1000 - km) ? r : b,
    );
    const k = clamp(Math.round((best.length / 1000) * 2) / 2, LOOP.min, LOOP.max);
    return k === km ? null : k;
  }

  window.App = App;
  App.start().catch((err) => {
    console.error(err);
    setStatus("Could not start: " + err.message);
  });
})();
