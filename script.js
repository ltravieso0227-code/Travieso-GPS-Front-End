(function () {
  const DEFAULT_REFRESH = 10_000; // 10s

  // === MapTiler config (your key) ===
  const MAPTILER_KEY = "fWfNo8f8kAGF4RDFwHmy";
  const STYLE_LIGHT = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;
  const STYLE_SAT   = `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`;

  // === State ===
  let map;
  let markers = new Map();     // device_id -> maplibre Marker
  let devicesCache = new Map(); // device_id -> device info from /devices
  let ws;

  const LINE_ID = "device-history";
  const PTS_ID  = "device-history-pts";

  let deviceList, statusEl, historyBtn, logoutBtn, overlay;
  let popup;
  let apiUrl, apiKey, refreshTimer;

  // === Helpers ===
  const el = id => document.getElementById(id);
  const setStatus = t => { if (statusEl) statusEl.textContent = t; };

  function loadSettings() {
    apiUrl = localStorage.getItem("apiUrl") || "https://travieso-gps-platform.onrender.com";
    apiKey = localStorage.getItem("apiKey") || "";

    const urlInput = el("loginApiUrl");
    const keyInput = el("loginApiKey");
    if (urlInput) urlInput.value = apiUrl;
    if (keyInput) keyInput.value = apiKey;
  }

  function saveSettings(newUrl, newKey) {
    apiUrl = (newUrl || "").trim().replace(/\/$/, "");
    apiKey = (newKey || "").trim();
    localStorage.setItem("apiUrl", apiUrl);
    localStorage.setItem("apiKey", apiKey);
  }

  // === Map setup ===
  function initMap(center = [-80.1918, 25.7617], zoom = 9) {
    map = new maplibregl.Map({
      container: "map",
      style: STYLE_LIGHT,
      center,
      zoom
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "260px"
    });

    // Satellite toggle (checkbox id="satToggle")
    const satToggle = el("satToggle");
    if (satToggle) {
      satToggle.addEventListener("change", () => {
        const c = map.getCenter();
        const z = map.getZoom();
        const styleUrl = satToggle.checked ? STYLE_SAT : STYLE_LIGHT;
        map.setStyle(styleUrl);
        map.once("styledata", () => {
          map.setCenter(c);
          map.setZoom(z);
        });
      });
    }
  }

  // === Popups & markers ===
  function showDevicePopup(device, lngLat) {
    const id        = device.id;
    const name      = device.name || id;
    const status    = device.status || "unknown";
    const battery   = device.battery;
    const lastSeen  = device.last_seen ? new Date(device.last_seen).toLocaleString() : "—";

    const batteryLine = (battery != null)
      ? `<span class="popup-meta">• Battery: ${battery}%</span>`
      : "";

    const html = `
      <div class="popup-card">
        <div class="popup-title">${name}</div>
        <div class="popup-subtitle">ID: ${id}</div>
        <div class="popup-row">
          <span class="popup-label">Status:</span>
          <span class="popup-value">${status}</span>
          ${batteryLine}
        </div>
        <div class="popup-row">
          <span class="popup-label">Last Seen:</span>
          <span class="popup-value">${lastSeen}</span>
        </div>
      </div>
    `;

    new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "260px"
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
  }

  function markerFor(deviceId, lat, lng, status, deviceObj) {
    let m = markers.get(deviceId);

    const pin = document.createElement("div");
    pin.className = "device-pin";
    pin.style.background =
      status === "moving" ? "#22c55e" :
      status === "offline" ? "#ef4444" :
      "#f59e0b";
    pin.title = `${deviceObj.name || deviceId} (${deviceId})`;

    pin.addEventListener("click", () => {
      showDevicePopup(deviceObj, [lng, lat]);
    });

    if (!m) {
      m = new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, m);
    } else {
      const old = m;
      const next = new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, next);
      old.remove();
    }
  }

  function addDeviceToList(d) {
    if (!deviceList) return;

    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <strong>${d.name || d.id}</strong>
        <span class="badge ${d.status || "idle"}">${d.status || "idle"}</span>
      </div>
      <div class="meta">${d.id || ""}</div>
    `;
    li.onclick = () => showHistory(d.id);
    deviceList.appendChild(li);
  }

  // === API helpers ===
  async function fetchJSON(path) {
    const url = apiUrl.replace(/\/$/, "") + path;
    const opts = { headers: {} };
    if (apiKey) opts.headers["X-API-Key"] = apiKey;

    const r = await fetch(url, opts);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  // === Data loading ===
  async function loadDevices() {
    if (!deviceList) return;

    deviceList.innerHTML = "";
    devicesCache.clear();
    markers.forEach(m => m.remove());
    markers.clear();

    const devices = await fetchJSON("/devices");
    for (const d of devices) {
      devicesCache.set(d.id, d);
      addDeviceToList(d);

      const rows = await fetchJSON(`/devices/${encodeURIComponent(d.id)}/positions?limit=1`);
      if (rows.length) {
        const p = rows[0];
        const st = (p.speed || 0) > 2 ? "moving" : "idle";
        markerFor(d.id, p.lat, p.lng, st, d);
      }
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(async () => {
      try {
        await loadDevices();
        setStatus("Auto-refreshed");
      } catch (err) {
        console.error(err);
      }
    }, DEFAULT_REFRESH);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // === History trail ===
  function addHistoryLayers(geoPts, line, withLabels) {
    const old = [LINE_ID, PTS_ID, PTS_ID + "-labels"];
    old.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });

    map.addSource(LINE_ID, { type: "geojson", data: line });
    map.addLayer({
      id: LINE_ID,
      type: "line",
      source: LINE_ID,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-width": 4, "line-color": "#4ade80" }
    });

    map.addSource(PTS_ID, { type: "geojson", data: geoPts });
    map.addLayer({
      id: PTS_ID,
      type: "circle",
      source: PTS_ID,
      paint: {
        "circle-radius": 3.5,
        "circle-color": "#60a5fa",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1
      }
    });

    if (withLabels) {
      map.addLayer({
        id: PTS_ID + "-labels",
        type: "symbol",
        source: PTS_ID,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-allow-overlap": false
        },
        paint: {
          "text-color": "#cbd5e1",
          "text-halo-color": "#0b1020",
          "text-halo-width": 1.2
        }
      });
    }
  }

  const fmtTs = iso => {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso; }
  };

  async function showHistory(deviceId) {
    if (!map) return;
    setStatus("Loading history...");

    const rows = await fetchJSON(`/devices/${encodeURIComponent(deviceId)}/positions?limit=100`);
    if (!rows.length) {
      setStatus("No history");
      return;
    }

    const coords = rows.map(r => [r.lng, r.lat]);
    const pts = rows.map((r, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
      properties: {
        ts: r.ts || "",
        speed: r.speed || 0,
        label: (i % 5 === 0) ? (r.ts ? new Date(r.ts).toLocaleTimeString() : "") : ""
      }
    }));

    const line = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {}
      }]
    };
    const geoPts = { type: "FeatureCollection", features: pts };

    const bounds = new maplibregl.LngLatBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, { padding: 40, duration: 600 });

    const withLabels = !!(el("showLabels") && el("showLabels").checked);
    addHistoryLayers(geoPts, line, withLabels);
    setStatus("History loaded");

    map.on("mousemove", PTS_ID, e => {
      const f = e.features && e.features[0];
      if (!f) return;
      const { ts, speed } = f.properties;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${deviceId}</b><br>` +
          `${ts ? "Time: " + fmtTs(ts) + "<br>" : ""}` +
          `Speed: ${Number(speed || 0).toFixed(1)}`
        )
        .addTo(map);
    });

    map.on("mouseleave", PTS_ID, () => popup.remove());
  }

  // === WebSocket live updates ===
  function connectWS() {
    try {
      const base = apiUrl.trim().replace(/^http/, "ws").replace(/\/$/, "");
      ws = new WebSocket(base + "/ws");

      ws.onopen = () => setStatus("Live stream connected");

      ws.onmessage = evt => {
        try {
          const d = JSON.parse(evt.data);
          if (d && d.type === "position") {
            const st = (d.speed || 0) > 2 ? "moving" : "idle";
            const device = devicesCache.get(d.device_id) || {
              id: d.device_id,
              name: d.device_id,
              status: st,
              last_seen: d.ts
            };
            device.status = st;
            device.last_seen = d.ts;
            devicesCache.set(d.device_id, device);
            markerFor(d.device_id, d.lat, d.lng, st, device);
          }
        } catch (err) {
          console.error(err);
        }
      };

      ws.onclose = () => setStatus("Live stream disconnected");
    } catch (err) {
      console.error(err);
      setStatus("WS error");
    }
  }

  // === Overlay ===
  function showOverlay(show = true) {
    if (!overlay) return;
    overlay.classList.toggle("hidden", !show);
  }

  // === Boot ===
  window.addEventListener("DOMContentLoaded", () => {
    deviceList = el("deviceList");
    statusEl   = el("status");
    historyBtn = el("historyBtn");
    logoutBtn  = el("logoutBtn");
    overlay    = el("loginOverlay");

    loadSettings();
    initMap();

    if (!localStorage.getItem("apiUrl")) {
      showOverlay(true);
    }

    const loginBtn = el("loginBtn");
    if (loginBtn) {
      loginBtn.onclick = () => {
        saveSettings(el("loginApiUrl").value, el("loginApiKey").value);
        showOverlay(false);
        loadDevices().catch(() => setStatus("Failed to load devices"));
        connectWS();
        startAutoRefresh();
      };
    }

    const showLabels = el("showLabels");
    if (showLabels) {
      showLabels.addEventListener("change", () => {
        localStorage.setItem("showLabels", showLabels.checked ? "1" : "0");
      });
      const saved = localStorage.getItem("showLabels");
      if (saved === "1") showLabels.checked = true;
    }

    if (logoutBtn) {
      logoutBtn.onclick = () => {
        loadSettings();
        showOverlay(true);
      };
    }

    if (historyBtn) {
      historyBtn.onclick = () => {
        const first = deviceList && deviceList.querySelector("li strong");
        if (first) showHistory(first.textContent);
      };
    }

    // Initial load
    loadDevices().catch(() => setStatus("Failed to load devices"));
    connectWS();
    startAutoRefresh();
  });
})();
