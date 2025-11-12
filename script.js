(function(){
  const DEFAULT_REFRESH = 10_000; // 10s
  let map, markers = new Map(), historyLayerId = 'device-history', ws;
  let deviceList, statusEl, historyBtn, logoutBtn, overlay, apiUrl, apiKey;
  let refreshTimer;

  function el(id){ return document.getElementById(id); }
  function status(txt){ statusEl.textContent = txt; }

  function loadSettings(){
    apiUrl = localStorage.getItem('apiUrl') || 'https://travieso-gps-platform.onrender.com';
    apiKey = localStorage.getItem('apiKey') || '';
    const apiIn = document.getElementById('loginApiUrl');
    const keyIn = document.getElementById('loginApiKey');
    if(apiIn) apiIn.value = apiUrl;
    if(keyIn) keyIn.value = apiKey;
  }
  function saveSettings(newUrl, newKey){
    apiUrl = newUrl.trim().replace(/\/$/,'');
    apiKey = (newKey||'').trim();
    localStorage.setItem('apiUrl', apiUrl);
    localStorage.setItem('apiKey', apiKey);
  }

  function initMap(center=[-80.1918,25.7617], zoom=9){
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center, zoom
    });
    map.addControl(new maplibregl.NavigationControl({visualizePitch:true}), 'top-right');
  }

  function setMarker(deviceId, lat, lng, status='idle', name='Device'){
    let m = markers.get(deviceId);
    const el = document.createElement('div');
    el.className='ml-marker';
    el.style.width='14px'; el.style.height='14px';
    el.style.borderRadius='50%'; el.style.border='2px solid white';
    el.style.boxShadow='0 0 6px rgba(0,0,0,.3)';
    el.style.background = status==='moving' ? '#22c55e' : status==='offline' ? '#ef4444' : '#f59e0b';
    el.title = name + ' (' + deviceId + ')';

    if(!m){
      m = new maplibregl.Marker({element:el}).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, m);
    }else{
      m.setLngLat([lng, lat]);
      const old = m;
      const newMarker = new maplibregl.Marker({element:el}).setLngLat([lng, lat]).addTo(map);
      markers.set(deviceId, newMarker);
      old.remove();
    }
  }

  function addDeviceToList(d){
    const li = document.createElement('li');
    li.innerHTML = '<div><strong>'+ (d.name||d.id) + '</strong>' +
                   '<span class="badge '+(d.status||'idle')+'">'+(d.status||'idle')+'</span></div>' +
                   '<div class="meta">'+ (d.id||'') + '</div>';
    li.onclick = ()=> viewHistory(d.id);
    deviceList.appendChild(li);
  }

  async function fetchJSON(path){
    const url = apiUrl.replace(/\/$/,'') + path;
    const opts = { headers: {} };
    if(apiKey) opts.headers['X-API-Key'] = apiKey;
    const r = await fetch(url, opts);
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  }

  async function loadDevices(){
    deviceList.innerHTML = '';
    const devices = await fetchJSON('/devices');
    devices.forEach(async (d)=>{
      addDeviceToList(d);
      // last position
      const rows = await fetchJSON('/devices/'+encodeURIComponent(d.id)+'/positions?limit=1');
      if(rows.length){
        const p = rows[0];
        const st = (p.speed||0)>2 ? 'moving' : 'idle';
        setMarker(d.id, p.lat, p.lng, st, d.id);
      }
    });
  }

  function startAutoRefresh(){
    stopAutoRefresh();
    refreshTimer = setInterval(async ()=>{
      try{ await loadDevices(); status('Auto-refreshed'); }catch(_){}
    }, DEFAULT_REFRESH);
  }
  function stopAutoRefresh(){
    if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
  }

  async function viewHistory(deviceId){
    status('Loading history...');
    // fetch last 100 points
    const rows = await fetchJSON('/devices/'+encodeURIComponent(deviceId)+'/positions?limit=100');
    const coords = rows.map(r=>[r.lng, r.lat]).filter(a=>Number.isFinite(a[0])&&Number.isFinite(a[1]));
    if(!coords.length){ status('No history'); return; }

    // center & fit
    const bounds = new maplibregl.LngLatBounds();
    coords.forEach(c=>bounds.extend(c));
    map.fitBounds(bounds, {padding:40, duration:600});

    // remove existing layer if any
    if(map.getLayer(historyLayerId)){ map.removeLayer(historyLayerId); }
    if(map.getSource(historyLayerId)){ map.removeSource(historyLayerId); }

    const geo = { type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{} }]};
    map.addSource(historyLayerId, { type:'geojson', data: geo });
    map.addLayer({
      id: historyLayerId,
      type: 'line',
      source: historyLayerId,
      layout: { 'line-join':'round', 'line-cap':'round' },
      paint: { 'line-width': 4, 'line-color': '#4ade80' }
    });

    status('History loaded');
  }

  function connectWS(){
    try{
      const base = apiUrl.trim().replace(/^http/,'ws').replace(/\/$/,'');
      ws = new WebSocket(base + '/ws');
      ws.onopen = ()=> status('Live stream connected');
      ws.onmessage = (evt)=>{
        try{
          const data = JSON.parse(evt.data);
          if(data && data.type==='position'){
            const st = (data.speed||0)>2 ? 'moving' : 'idle';
            setMarker(data.device_id, data.lat, data.lng, st, data.device_id);
          }
        }catch(e){ /* ignore */ }
      };
      ws.onclose = ()=> status('Live stream disconnected');
    }catch(e){ status('WS error'); }
  }

  function showOverlay(show=true){
    overlay.classList.toggle('hidden', !show);
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    deviceList = el('deviceList');
    statusEl = el('status');
    historyBtn = el('historyBtn');
    logoutBtn = el('logoutBtn');
    overlay = document.getElementById('loginOverlay');

    loadSettings();
    initMap();
    // login overlay only if no apiUrl configured
    if(!localStorage.getItem('apiUrl')) showOverlay(true);

    document.getElementById('loginBtn').onclick = ()=>{
      const u = document.getElementById('loginApiUrl').value;
      const k = document.getElementById('loginApiKey').value;
      saveSettings(u, k);
      showOverlay(false);
      // connect after save
      loadDevices().catch(()=>status('Failed to load devices'));
      connectWS();
      startAutoRefresh();
    };

    logoutBtn.onclick = ()=>{
      // reuse overlay as "settings"
      loadSettings();
      showOverlay(true);
    };

    historyBtn.onclick = ()=>{
      const first = deviceList.querySelector('li strong');
      if(first){ viewHistory(first.textContent); }
    };

    // initial connect (uses defaults)
    loadDevices().catch(()=>status('Failed to load devices'));
    connectWS();
    startAutoRefresh();
  });
})();