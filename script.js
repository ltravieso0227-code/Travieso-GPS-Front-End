// Travieso GPS Frontend
// Uses your FastAPI backend + MapLibre + MapTiler

const MAPTILER_KEY = "fWfNo8f8kAGF4RDFwHmy";

let map = null;
let apiUrl = "";
let apiKey = "";

const state = {
  devices: [],
  markers: {},          // deviceId -> maplibre marker
  selectedId: null,
  historyCache: {}      // deviceId -> positions[]
};

// Playback state
const playback = {
  timerId: null,
  index: 0,
  positions: [],
  marker: null,
  lineSourceId: "history-line-source",
  lineLayerId: "history-line-layer"
};

// ---------- DOM references ----------
const els = {
  // Header / global
  status: document.getElementById("status"),
  deviceList: document.getElementById("deviceList"),
  historyBtnHeader: document.getElementById("historyBtn"),
  showLabels: document.getElementById("showLabels"),
  satToggle: document.getElementById("satToggle"),

  // Map / panel container
  mapPanel: document.querySelector(".map-panel"),
  panel: document.getElementById("deviceInfoPanel"),

  // Panel header
  panelAssetIcon: document.getElementById("panelAssetIcon"),
  panelDeviceName: document.getElementById("panelDeviceName"),
  panelDeviceId: document.getElementById("panelDeviceId"),
  panelStatusBadge: document.getElementById("panelStatusBadge"),
  panelSubBadge: document.getElementById("panelSubBadge"),

  // Overview tab
  panelOwner: document.getElementById("panelOwner"),
  panelAssetType: document.getElementById("panelAssetType"),
  panelLastUpdated: document.getElementById("panelLastUpdated"),
  panelLastLocation: document.getElementById("panelLastLocation"),
  btnLocate: document.getElementById("btnLocate"),
  btnHistoryFromOverview: document.getElementById("btnHistoryFromOverview"),
  btnRecovery: document.getElementById("btnRecovery"),
  btnEdit: document.getElementById("btnEdit"),
  btnGoogleMaps: document.getElementById("btnGoogleMaps"),

  // Tabs
  tabButtons: document.querySelectorAll(".panel-tabs .tab"),
  tabOverview: document.getElementById("tab-overview"),
  tabHistory: document.getElementById("tab-history"),
  tabDiagnostics: document.getElementById("tab-diagnostics"),

  // History tab
  btnPlayHistory: document.getElementById("btnPlayHistory"),
  btnStopHistory: document.getElementById("btnStopHistory"),
  historyList: document.getElementById("historyList"),

  // Diagnostics
  batteryBar: document.getElementById("batteryBar"),
  batteryLabel: document.getElementById("batteryLabel"),
  signalBar: document.getElementById("signalBar"),
  signalLabel: document.getElementById("signalLabel"),
  wifiBar: document.getElementById("wifiBar"),
  wifiLabel: document.getElementById("wifiLabel"),
  speedLabel: document.getElementById("speedLabel"),
  ignitionLabel: document.getElementById("ignitionLabel"),
  headingArrow: document.getElementById("headingArrow"),
  headingText: document.getElementById("headingText"),

  // Settings overlay
  loginOverlay: document.getElementById("loginOverlay"),
  loginApiUrl: document.getElementById("loginApiUrl"),
  loginApiKey: document.getElementById("loginApiKey"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn")
};

// ---------- Helpers ----------
function setStatus(text, good = false) {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.style.borderColor = good ? "#22c55e" : "#1f2937";
  els.status.style.color = good ? "#bbf7d0" : "#e5e7eb";
}

function buildHeaders() {
  const headers = {};
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

function fmtTime(iso) {
  if (!iso) return "–";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtLatLng(lat, lng) {
  if (lat == null || lng == null) return "–";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function normalizeUrl(u) {
  if (!u) return "";
  return u.replace(/\/+$/, "");
}

/**
 * Try to infer HOW the device got its location:
 * - "gps" (satellite)
 * - "wifi" (Wi-Fi positioning)
 * - "cell" (cell tower)
 * - "unknown"
 */
function deriveLocationSource(p) {
  if (!p || typeof p !== "object") return "unknown";

  const raw =
    p.location_source ??
    p.position_source ??
    p.loc_source ??
    p.source ??
    p.fix_type ??
    p.provider ??
    null;

  let v = raw ? String(raw).toLowerCase() : "";

  if (v.includes("gps") || v.includes("gnss") || v.includes("sat")) {
    return "gps";
  }
  if (v.includes("wifi") || v.includes("wi-fi") || v.includes("wi fi")) {
    return "wifi";
  }
  if (
    v.includes("cell") ||
    v.includes("gsm") ||
    v.includes("lte") ||
    v.includes("network")
  ) {
    return "cell";
  }

  // Heuristics from fields
  if (
    p.wifi_ssid ||
    p.wifi_bssid ||
    (typeof p.wifi_count === "number" && p.wifi_count > 0)
  ) {
    return "wifi";
  }

  if (
    p.cell_id ||
    p.ci ||
    p.enb_id ||
    (typeof p.mcc === "number" && typeof p.mnc === "number")
  ) {
    return "cell";
  }

  // If satellites count exists, favor GPS
  if (typeof p.satellites === "number" && p.satellites > 0) {
    return "gps";
  }

  return "unknown";
}

// ---------- Map ----------
let currentBaseStyle = "streets"; // "streets" | "satellite"

function getStyleUrl(kind) {
  if (kind === "satellite") {
    // MapTiler satellite (with labels)
    return `https://api.maptiler.com/maps/satellite/style.json?key=${MAPTILER_KEY}`;
  }
  // Default streets
  return `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: getStyleUrl("streets"),
    center: [-80.19, 25.76], // Miami-ish
    zoom: 10
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  // When map style is ready, sync label visibility with the checkbox
  map.on("styledata", () => {
    const show = els.showLabels ? els.showLabels.checked : true;
    applyLabelVisibility(show);
  });
}

function applyLabelVisibility(show) {
  if (!map || !map.getStyle) return;
  const style = map.getStyle();
  if (!style || !style.layers) return;

  style.layers.forEach((layer) => {
    // Hide/show all symbol layers (labels & POI icons)
    if (layer.type === "symbol") {
      try {
        map.setLayoutProperty(
          layer.id,
          "visibility",
          show ? "visible" : "none"
        );
      } catch (e) {
        // ignore layers that can't be changed
      }
    }
  });
}

function setMapBaseStyle(isSatellite) {
  if (!map) return;
  const kind = isSatellite ? "satellite" : "streets";
  if (kind === currentBaseStyle) return;

  currentBaseStyle = kind;
  const styleUrl = getStyleUrl(kind);
  map.setStyle(styleUrl);

  // label visibility is reapplied automatically in "styledata" listener
}

function upsertMarker(deviceId, lat, lng, status = "idle") {
  if (lat == null || lng == null || !map) return;

  const color =
    status === "moving" ? "#22c55e" :
    status === "idle"   ? "#fbbf24" :
                          "#6b7280";

  if (state.markers[deviceId]) {
    state.markers[deviceId].setLngLat([lng, lat]);
  } else {
    const marker = new maplibregl.Marker({ color })
      .setLngLat([lng, lat])
      .addTo(map);
    state.markers[deviceId] = marker;
  }
}

function focusOnDevice(deviceId) {
  const positions = state.historyCache[deviceId];
  if (positions && positions.length && map) {
    const p = positions[0]; // newest
    map.easeTo({
      center: [p.lng, p.lat],
      zoom: 15,
      duration: 600
    });
  }
}

function findDeviceStatus(deviceId) {
  const d = state.devices.find((x) => x.id === deviceId);
  return d ? d.status || "offline" : "offline";
}

// ---------- API calls ----------
async function fetchDevices() {
  if (!apiUrl) return;

  try {
    const res = await fetch(`${apiUrl}/devices`, { headers: buildHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.devices = data || [];
    renderDeviceList();
    setStatus("Connected", true);

    // Refresh marker positions (1 per device) WITHOUT nuking full history
    for (const d of state.devices) {
      const positions = await fetchDevicePositions(d.id, 1);
      if (positions && positions.length) {
        const p = positions[0];

        // Only set cache if we don't already have a longer history
        if (!state.historyCache[d.id] || state.historyCache[d.id].length <= 1) {
          state.historyCache[d.id] = positions;
        }

        upsertMarker(d.id, p.lat, p.lng, d.status);
      }
    }
  } catch (err) {
    console.error("Error loading devices", err);
    setStatus("Error");
  }
}

async function fetchDeviceDetail(deviceId) {
  try {
    const res = await fetch(
      `${apiUrl}/devices/${encodeURIComponent(deviceId)}/detail`,
      { headers: buildHeaders() }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("detail error", e);
    return null;
  }
}

async function fetchDevicePositions(deviceId, limit = 50) {
  try {
    const res = await fetch(
      `${apiUrl}/devices/${encodeURIComponent(deviceId)}/positions?limit=${limit}`,
      { headers: buildHeaders() }
    );
    if (!res.ok) return [];
    const data = await res.json();
    // backend returns newest first
    return data;
  } catch (e) {
    console.error("positions error", e);
    return [];
  }
}

async function createRecoveryLink(deviceId) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const body = {
    recovery_company: null,
    recovery_agent_email: null,
    recovery_agent_phone: null,
    expires_at: expiresAt,
    notes: null
  };

  try {
    const res = await fetch(
      `${apiUrl}/devices/${encodeURIComponent(deviceId)}/recovery-link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildHeaders()
        },
        body: JSON.stringify(body)
      }
    );
    if (!res.ok) {
      alert("Error creating recovery link (HTTP " + res.status + ")");
      return null;
    }
    const data = await res.json();
    return `${apiUrl}/public/recovery/${data.token}/map`;
  } catch (e) {
    console.error("recovery link error", e);
    alert("Network error creating recovery link");
    return null;
  }
}

// ---------- Playback helpers ----------
function stopPlayback() {
  if (playback.timerId) {
    clearInterval(playback.timerId);
    playback.timerId = null;
  }
  if (playback.marker) {
    playback.marker.remove();
    playback.marker = null;
  }
}

async function startPlaybackForSelected() {
  const deviceId = state.selectedId;
  if (!deviceId) {
    alert("Select a device first.");
    return;
  }

  // Ensure we have a reasonably full history in cache
  let positions = state.historyCache[deviceId] || [];
  if (positions.length < 2) {
    const fresh = await fetchDevicePositions(deviceId, 50);
    state.historyCache[deviceId] = fresh;
    positions = fresh;
  }

  if (!positions || positions.length < 2) {
    alert("Not enough points for playback (need at least 2).");
    return;
  }

  // Oldest → newest for playback
  const ordered = [...positions].reverse();

  stopPlayback(); // clear previous run

  playback.positions = ordered;
  playback.index = 0;

  // Draw path line
  if (map) {
    const coords = ordered.map((p) => [p.lng, p.lat]);

    if (map.getLayer(playback.lineLayerId)) {
      map.removeLayer(playback.lineLayerId);
    }
    if (map.getSource(playback.lineSourceId)) {
      map.removeSource(playback.lineSourceId);
    }

    map.addSource(playback.lineSourceId, {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords
        }
      }
    });

    map.addLayer({
      id: playback.lineLayerId,
      type: "line",
      source: playback.lineSourceId,
      paint: {
        "line-color": "#22c55e",
        "line-width": 3
      }
    });
  }

  // Create playback marker at first point
  if (map) {
    const first = ordered[0];
    playback.marker = new maplibregl.Marker({ color: "#22c55e" })
      .setLngLat([first.lng, first.lat])
      .addTo(map);

    map.easeTo({
      center: [first.lng, first.lat],
      zoom: 15,
      duration: 700
    });
  }

  // Animate along the path
  playback.timerId = setInterval(() => {
    playback.index++;
    if (playback.index >= ordered.length) {
      stopPlayback();
      return;
    }

    const p = ordered[playback.index];
    if (!map || !playback.marker) return;

    playback.marker.setLngLat([p.lng, p.lat]);
    map.easeTo({
      center: [p.lng, p.lat],
      duration: 400
    });
  }, 1000); // 1 second per point
}

// ---------- Device list rendering ----------
function renderDeviceList() {
  if (!els.deviceList) return;

  els.deviceList.innerHTML = "";

  if (!state.devices.length) {
    const li = document.createElement("li");
    li.textContent = "No devices yet.";
    li.style.fontSize = "0.8rem";
    li.style.color = "#9ca3b8";
    els.deviceList.appendChild(li);
    return;
  }

  state.devices.forEach((d) => {
    const li = document.createElement("li");
    li.dataset.id = d.id;

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.alignItems = "center";

    const name = document.createElement("strong");
    name.textContent = d.name || d.id;

    const badge = document.createElement("span");
    badge.className = "badge " + (d.status || "offline");
    badge.textContent = (d.status || "offline").toUpperCase();

    top.appendChild(name);
    top.appendChild(badge);

    const bottom = document.createElement("div");
    bottom.className = "meta";
    bottom.style.fontSize = "0.75rem";
    bottom.style.color = "#94a3b8";
    bottom.textContent = d.last_seen
      ? `Last seen: ${fmtTime(d.last_seen)}`
      : "Never seen";

    li.appendChild(top);
    li.appendChild(bottom);

    li.addEventListener("click", () => handleDeviceClick(d.id));
    els.deviceList.appendChild(li);
  });
}

// ---------- Panel logic ----------
function showDevicePanel() {
  if (!els.panel) return;
  els.panel.style.display = "flex";
  els.panel.classList.remove("hidden");
}

function hideDevicePanel() {
  if (!els.panel) return;
  els.panel.style.display = "none";
  els.panel.classList.add("hidden");
  state.selectedId = null;
  stopPlayback();
}
window.hideDevicePanel = hideDevicePanel; // used by onclick in HTML

function setActiveTab(tabName) {
  if (!els.tabButtons) return;

  els.tabButtons.forEach((btn) => {
    const name = btn.dataset.tab;
    btn.classList.toggle("active", name === tabName);
  });

  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.remove("active");
  });

  const pane = document.getElementById(`tab-${tabName}`);
  if (pane) pane.classList.add("active");
}

async function handleDeviceClick(deviceId) {
  state.selectedId = deviceId;
  showDevicePanel();
  setActiveTab("overview");
  stopPlayback(); // reset playback when switching devices

  const meta = state.devices.find((d) => d.id === deviceId) || {};

  // Quick header fields
  if (els.panelDeviceName) {
    els.panelDeviceName.textContent = meta.name || deviceId;
  }
  if (els.panelDeviceId) {
    els.panelDeviceId.textContent = `ID: ${deviceId}`;
  }
  if (els.panelStatusBadge) {
    const status = meta.status || "offline";
    els.panelStatusBadge.textContent =
      status.charAt(0).toUpperCase() + status.slice(1);
    let color = "#fca5a5";
    if (status === "moving") color = "#22c55e";
    else if (status === "idle") color = "#facc15";
    els.panelStatusBadge.style.color = color;
    els.panelStatusBadge.style.borderColor = color;
  }

  // Subscription badge – placeholder, always "Active"
  if (els.panelSubBadge) {
    els.panelSubBadge.textContent = "Active";
  }

  // Fetch detail + history
  const [detail, positions] = await Promise.all([
    fetchDeviceDetail(deviceId),
    fetchDevicePositions(deviceId, 50)
  ]);

  state.historyCache[deviceId] = positions || [];

  // Overview from detail
  if (detail) {
    if (els.panelAssetType) {
      els.panelAssetType.textContent = detail.asset_type || "N/A";
    }
    if (els.panelLastUpdated) {
      els.panelLastUpdated.textContent = fmtTime(detail.last_seen);
    }
    if (els.panelOwner) {
      // Right now we don't have "owner" separate, so reusing description
      els.panelOwner.textContent = detail.description || "N/A";
    }
    // Battery for diagnostics
    if (els.batteryBar && els.batteryLabel) {
      const b = detail.battery ?? null;
      if (b == null) {
        els.batteryBar.style.width = "0%";
        els.batteryLabel.textContent = "–%";
      } else {
        const pct = Math.max(0, Math.min(100, Number(b)));
        els.batteryBar.style.width = pct + "%";
        els.batteryLabel.textContent = pct + "%";
      }
    }
  } else {
    if (els.panelAssetType) els.panelAssetType.textContent = "N/A";
    if (els.panelLastUpdated) els.panelLastUpdated.textContent = "–";
    if (els.panelOwner) els.panelOwner.textContent = "N/A";
    if (els.batteryBar) els.batteryBar.style.width = "0%";
    if (els.batteryLabel) els.batteryLabel.textContent = "–%";
  }

  // History tab + last location + speed / heading
  renderHistory(deviceId);

  // Diagnostics extras from newest position if present
  const newest = (state.historyCache[deviceId] || [])[0];
  if (newest) {
    // Speed
    if (els.speedLabel) {
      const spd = newest.speed != null ? Number(newest.speed).toFixed(1) : "0.0";
      els.speedLabel.textContent = `${spd} mph`;
    }

    // Heading (simple arrow + degrees)
    if (els.headingArrow && els.headingText) {
      const heading = newest.heading ?? null;
      if (heading == null) {
        els.headingArrow.textContent = "↑";
        els.headingText.textContent = "N/A";
      } else {
        const hNum = Number(heading);
        let arrow = "↑";
        if (hNum > 45 && hNum <= 135) arrow = "→";
        else if (hNum > 135 && hNum <= 225) arrow = "↓";
        else if (hNum > 225 && hNum <= 315) arrow = "←";
        els.headingArrow.textContent = arrow;
        els.headingText.textContent = `${hNum.toFixed(0)}°`;
      }
    }

    // Ignition – placeholder until you wire a real field
    if (els.ignitionLabel) {
      els.ignitionLabel.textContent = "Unknown";
    }

    // Location method (GPS / Wi-Fi / Cell) using the "Wi-Fi" row
    if (els.wifiLabel && els.wifiBar) {
      const kind = deriveLocationSource(newest); // "gps" | "wifi" | "cell" | "unknown"
      let label = "Location method unknown";
      let pct = 0;

      if (kind === "gps") {
        label = "📡 GPS (Satellite)";
        pct = 100;
      } else if (kind === "wifi") {
        label = "🛜 Wi-Fi Positioning";
        pct = 70;
      } else if (kind === "cell") {
        label = "📶 Cell Tower";
        pct = 40;
      }

      els.wifiLabel.textContent = label;
      els.wifiBar.style.width = pct + "%";
    }

  } else {
    // No newest position – reset some diagnostics
    if (els.speedLabel) els.speedLabel.textContent = "0 mph";
    if (els.headingArrow && els.headingText) {
      els.headingArrow.textContent = "↑";
      els.headingText.textContent = "N/A";
    }
    if (els.ignitionLabel) els.ignitionLabel.textContent = "Unknown";
    if (els.wifiLabel && els.wifiBar) {
      els.wifiLabel.textContent = "Location method unknown";
      els.wifiBar.style.width = "0%";
    }
  }

  // Focus map on this device
  focusOnDevice(deviceId);
}

function renderHistory(deviceId) {
  const positions = state.historyCache[deviceId] || [];
  if (!els.historyList) return;

  els.historyList.innerHTML = "";

  if (!positions.length) {
    const empty = document.createElement("div");
    empty.textContent = "No recent positions.";
    empty.style.fontSize = "0.8rem";
    empty.style.color = "#9ca3b8";
    els.historyList.appendChild(empty);
    if (els.panelLastLocation) els.panelLastLocation.textContent = "–";
    if (els.speedLabel) els.speedLabel.textContent = "0 mph";
    return;
  }

  const newest = positions[0];

  if (els.panelLastLocation) {
    els.panelLastLocation.textContent = fmtLatLng(newest.lat, newest.lng);
  }
  if (els.speedLabel) {
    const spd = newest.speed != null ? Number(newest.speed).toFixed(1) : "0.0";
    els.speedLabel.textContent = `${spd} mph`;
  }

  positions.forEach((p) => {
    const row = document.createElement("div");
    row.className = "history-list-item";

    const left = document.createElement("span");
    left.textContent = fmtTime(p.ts);

    const right = document.createElement("span");
    const spd = p.speed != null ? Number(p.speed).toFixed(1) : "0.0";
    right.textContent = `${spd} mph`;

    row.appendChild(left);
    row.appendChild(right);
    els.historyList.appendChild(row);
  });

  // Update marker for newest coord
  upsertMarker(deviceId, newest.lat, newest.lng, findDeviceStatus(deviceId));
}

// ---------- Button wiring ----------
function wirePanelButtons() {
  // Locate
  if (els.btnLocate) {
    els.btnLocate.addEventListener("click", () => {
      if (!state.selectedId) return;
      focusOnDevice(state.selectedId);
    });
  }

  // Overview -> History tab
  if (els.btnHistoryFromOverview) {
    els.btnHistoryFromOverview.addEventListener("click", () => {
      if (!state.selectedId) return;
      setActiveTab("history");
    });
  }

  // Recovery link
  if (els.btnRecovery) {
    els.btnRecovery.addEventListener("click", async () => {
      if (!state.selectedId) return;
      const url = await createRecoveryLink(state.selectedId);
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        alert("Recovery link copied to clipboard:\n" + url);
      } catch {
        alert("Recovery link:\n" + url);
      }
    });
  }

  // Edit – placeholder
  if (els.btnEdit) {
    els.btnEdit.addEventListener("click", () => {
      alert("Edit page coming soon — backend already supports update_device.");
    });
  }

  // Google Maps
  if (els.btnGoogleMaps) {
    els.btnGoogleMaps.addEventListener("click", () => {
      const positions = state.historyCache[state.selectedId] || [];
      if (!positions.length) {
        alert("No position available for Google Maps.");
        return;
      }
      const p = positions[0];
      const url = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
      window.open(url, "_blank");
    });
  }

  // History playback
  if (els.btnPlayHistory) {
    els.btnPlayHistory.addEventListener("click", () => {
      startPlaybackForSelected();
    });
  }

  if (els.btnStopHistory) {
    els.btnStopHistory.addEventListener("click", () => {
      stopPlayback();
    });
  }

  // Header "Show History" button
  if (els.historyBtnHeader) {
    els.historyBtnHeader.addEventListener("click", () => {
      if (!state.selectedId) {
        alert("Select a device first to view history.");
        return;
      }
      showDevicePanel();
      setActiveTab("history");
    });
  }

  // Tabs
  els.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      setActiveTab(name);
    });
  });

  // Map controls toggles
  if (els.showLabels) {
    els.showLabels.addEventListener("change", () => {
      const show = els.showLabels.checked;
      applyLabelVisibility(show);
    });
  }

  if (els.satToggle) {
    els.satToggle.addEventListener("change", () => {
      const isSat = els.satToggle.checked;
      setMapBaseStyle(isSat);
    });
  }
}

// ---------- Settings overlay ----------
function initSettings() {
  apiUrl = normalizeUrl(
    localStorage.getItem("travieso_api_url") ||
      "https://travieso-gps-platform.onrender.com"
  );
  apiKey = localStorage.getItem("travieso_api_key") || "";

  if (els.loginApiUrl) els.loginApiUrl.value = apiUrl;
  if (els.loginApiKey) els.loginApiKey.value = apiKey;

  if (els.loginBtn) {
    els.loginBtn.addEventListener("click", () => {
      apiUrl = normalizeUrl(els.loginApiUrl.value.trim());
      apiKey = els.loginApiKey.value.trim();

      localStorage.setItem("travieso_api_url", apiUrl);
      localStorage.setItem("travieso_api_key", apiKey);

      if (els.loginOverlay) els.loginOverlay.classList.add("hidden");
      setStatus("Connecting…");
      fetchDevices();
    });
  }

  if (els.logoutBtn) {
    els.logoutBtn.addEventListener("click", () => {
      if (els.loginOverlay) els.loginOverlay.classList.add("hidden");
    });
  }

  // Open overlay automatically if API URL missing
  if (!apiUrl && els.loginOverlay) {
    els.loginOverlay.classList.remove("hidden");
  }
}

// ---------- Boot ----------
function boot() {
  initSettings();
  initMap();
  wirePanelButtons();

  // Initial load
  fetchDevices();

  // Poll every 10 seconds (matches "Auto-refresh: 10s" label)
  setInterval(fetchDevices, 10000);
}

// Run immediately (script is at end of <body>, DOM is ready)
boot();
