(function () {
  const DEFAULT_REFRESH = 10_000; // 10s
  let map, markers = new Map(), ws;
  const LINE_ID = 'device-history';
  const PTS_ID  = 'device-history-pts';
  let deviceList, statusEl, historyBtn, logoutBtn, overlay, popup;
  let apiUrl, apiKey, refreshTimer;

  const el = id => document.getElementById(id);
  const setStatus = t => statusEl.textContent = t;

  function loadSettings() {
    apiUrl = localStorage.getItem('apiUrl') || 'https://travieso-gps-platform.onrender.com';
    apiKey = localStorage.getItem('apiKey') || '';
    el('loginApiUrl').value = apiUrl;
    el('loginApiKey').value = apiKey;
    // labels toggle
    const stored = localStorage.getItem('showLabels');
    if (stored && el('showLabels')) {
      el('showLabels').checked = stored === '1';
    }
  }

  function saveSettings(newUrl, newKey) {
    apiUrl = newUrl.trim().replace(/\/$/, '');
    apiKey = (newKey || '').trim();
    localStorage.setItem('apiUrl', apiUrl);
    localStorage.setItem('apiKey', apiKey);
  }

  // --- Basemap toggle control (Map <-> Satellite) ---

  class BasemapToggleControl {
    onAdd(m) {
      this._map = m;
      this._satVisible = false;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'maplibregl-ctrl-icon maplibregl-ctrl-basemap-toggle';
      btn.textContent = 'Sat';
      btn.style.padding = '4px 8px';
      btn.style.fontSize = '12px';
      btn.style.background = '#0f172a';
      btn.style.color = '#e5e7eb';
      btn.style.borderRadius = '4px';
      btn.style.cursor = 'pointer';
      btn.style.border = '1px solid #475569';

      btn.onclick = () => {
        this._satVisible = !this._satVisible;
        const vis = this._satVisible ? 'visible' : 'none';
        if (this._map.getLayer('satellite-layer')) {
          this._map.setLayoutProperty('satellite-layer', 'visibility', vis);
        }
        btn.textContent = this._satVisible ? 'Map' : 'Sat';
      };

      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      container.appendChild(btn);
      this._container = container;
      return container;
    }

    onRemove() {
      this._container.parentNode.removeChild(this._container);
      this._map = undefined;
    }
  }

  // --- Map init with satellite layer & toggle ---

  function initMap(center = [-80.1918, 25.7617], zoom = 9) {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center,
      zoom
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: '240px'
    });

    map.on('load', () => {
      // Satellite raster source (Esri World Imagery)
      if (!map.getSource('satellite')) {
        map.addSource('satellite', {
          type: 'raster',
          tiles: [
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          attribution:
            'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, ' +
            'Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        });
      }

      // Find first label layer so satellite goes below labels but above base
      const layers = map.getStyle().layers;
      let labelLayerId = null;
      for (const layer of layers) {
        if (layer.type === 'symbol') {
          labelLayerId = layer.id;
          break;
        }
      }

      // Satellite layer, hidden by default
      if (!map.getLayer('satellite-layer')) {
        map.addLayer(
          {
            id: 'satellite-layer',
            type: 'raster',
            source: 'satellite',
            layout: { visibility: 'none' }
          },
          labelLayerId || undefined
        );
      }

      // Sat/Map toggle button
      map.addControl(new BasemapToggleControl(), 'top-right');
    });
  }

  // --- Markers & device list ---

  function markerFor(deviceId, lat, lng, status = 'idle', name = 'Device') {
    let m = markers.get(deviceId);

    const pin = document.createElement('div');
    pin.style.cssText =
      'width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.3)';
    pin.style.background =
      status === 'moving' ? '#22c55e' : status === 'offline' ? '#ef4444' : '#f59e0b';
    pin.title = `${name} (${deviceId})`;

    if (!m) {
      m = new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, m);
    } else {
      m.setLngLat([lng, lat]);
      const old = m;
      const next = new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, next);
      old.remove();
    }
  }

  function addDeviceToList(d) {
    const li = document.createElement('li');
    li.innerHTML =
      `<div><strong>${d.name || d.id}</strong>
         <span class="badge ${d.status || 'idle'}">${d.status || 'idle'}</span></div>
       <div class="meta">${d.id || ''}</div>`;
    li.onclick = () => showHistory(d.id);
    deviceList.appendChild(li);
  }

  // --- API helpers ---

  async function fetchJSON(path) {
    const url = apiUrl.replace(/\/$/, '') + path;
    const opts = { headers: {} };
    if (apiKey) opts.headers['X-API-Key'] = apiKey;
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  async function loadDevices() {
    deviceList.innerHTML = '';
    const devices = await fetchJSON('/devices');
    for (const d of devices) {
      addDeviceToList(d);
      const rows = await fetchJSON(`/devices/${encodeURIComponent(d.id)}/positions?limit=1`);
      if (rows.length) {
        const p = rows[0];
        const st = (p.speed || 0) > 2 ? 'moving' : 'idle';
        markerFor(d.id, p.lat, p.lng, st, d.id);
      }
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(async () => {
      try {
        await loadDevices();
        setStatus('Auto-refreshed');
      } catch {
        // ignore
      }
    }, DEFAULT_REFRESH);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // --- History trail ---

  function addHistoryLayers(geoPts, line, withLabels) {
    // remove old
    const old = [LINE_ID, PTS_ID, PTS_ID + '-labels'];
    old.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });

    // line
    map.addSource(LINE_ID, { type: 'geojson', data: line });
    map.addLayer({
      id: LINE_ID,
      type: 'line',
      source: LINE_ID,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-width': 4, 'line-color': '#4ade80' }
    });

    // points
    map.addSource(PTS_ID, { type: 'geojson', data: geoPts });
    map.addLayer({
      id: PTS_ID,
      type: 'circle',
      source: PTS_ID,
      paint: {
        'circle-radius': 3.5,
        'circle-color': '#60a5fa',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1
      }
    });

    // labels (optional)
    if (withLabels) {
      map.addLayer({
        id: PTS_ID + '-labels',
        type: 'symbol',
        source: PTS_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-allow-overlap': false
        },
        paint: {
          'text-color': '#cbd5e1',
          'text-halo-color': '#0b1020',
          'text-halo-width': 1.2
        }
      });
    }
  }

  const fmtTs = iso => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  async function showHistory(deviceId) {
    setStatus('Loading history...');
    const rows = await fetchJSON(
      `/devices/${encodeURIComponent(deviceId)}/positions?limit=100`
    );
    if (!rows.length) {
      setStatus('No history');
      return;
    }

    const coords = rows.map(r => [r.lng, r.lat]);
    const pts = rows.map((r, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        ts: r.ts || '',
        speed: r.speed || 0,
        label:
          i % 5 === 0
            ? r.ts
              ? new Date(r.ts).toLocaleTimeString()
              : ''
            : ''
      }
    }));

    const line = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {}
        }
      ]
    };
    const geoPts = { type: 'FeatureCollection', features: pts };

    // fit bounds
    const bounds = new maplibregl.LngLatBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, { padding: 40, duration: 600 });

    const withLabels = el('showLabels').checked;
    addHistoryLayers(geoPts, line, withLabels);
    setStatus('History loaded');

    // hover popup on points
    map.on('mousemove', PTS_ID, e => {
      const f = e.features && e.features[0];
      if (!f) return;
      const { ts, speed } = f.properties;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${deviceId}</b><br>${
            ts ? 'Time: ' + fmtTs(ts) + '<br>' : ''
          }Speed: ${Number(speed || 0).toFixed(1)}`
        )
        .addTo(map);
    });
    map.on('mouseleave', PTS_ID, () => popup.remove());
  }

  // --- Live WebSocket stream ---

  function connectWS() {
    try {
      const base = apiUrl.trim().replace(/^http/, 'ws').replace(/\/$/, '');
      ws = new WebSocket(base + '/ws');
      ws.onopen = () => setStatus('Live stream connected');
      ws.onmessage = evt => {
        try {
          const d = JSON.parse(evt.data);
          if (d && d.type === 'position') {
            const st = (d.speed || 0) > 2 ? 'moving' : 'idle';
            markerFor(d.device_id, d.lat, d.lng, st, d.device_id);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => setStatus('Live stream disconnected');
    } catch {
      setStatus('WS error');
    }
  }

  // --- UI overlay ---

  function showOverlay(show = true) {
    overlay.classList.toggle('hidden', !show);
  }

  // --- Boot ---

  window.addEventListener('DOMContentLoaded', () => {
    deviceList = el('deviceList');
    statusEl   = el('status');
    historyBtn = el('historyBtn');
    logoutBtn  = el('logoutBtn');
    overlay    = el('loginOverlay');

    loadSettings();
    initMap();

    if (!localStorage.getItem('apiUrl')) showOverlay(true);

    el('loginBtn').onclick = () => {
      saveSettings(el('loginApiUrl').value, el('loginApiKey').value);
      showOverlay(false);
      loadDevices().catch(() => setStatus('Failed to load devices'));
      connectWS();
      startAutoRefresh();
    };

    if (el('showLabels')) {
      el('showLabels').addEventListener('change', () => {
        localStorage.setItem('showLabels', el('showLabels').checked ? '1' : '0');
      });
    }

    logoutBtn.onclick = () => {
      loadSettings();
      showOverlay(true);
    };

    historyBtn.onclick = () => {
      const first = deviceList.querySelector('li strong');
      if (first) showHistory(first.textContent);
    };

    loadDevices().catch(() => setStatus('Failed to load devices'));
    connectWS();
    startAutoRefresh();
  });
})();
