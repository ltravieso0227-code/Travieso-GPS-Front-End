(function(){
  let map, markers = new Map(), apiUrlInput, deviceList, statusEl, ws;

  function qs(id){ return document.getElementById(id); }
  function status(txt){ statusEl.textContent = txt; }

  function initMap(center=[-80.1918,25.7617], zoom=9){
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center, zoom, attributionControl:true
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
      // replace element to update color
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
    li.onclick = ()=> fetchPositions(d.id, 1, true);
    deviceList.appendChild(li);
  }

  async function fetchDevices(){
    deviceList.innerHTML = '';
    const base = apiUrlInput.value.trim().replace(/\/$/,''); // no trailing slash
    const r = await fetch(base + '/devices');
    if(!r.ok){ throw new Error('Failed to load devices'); }
    const devices = await r.json();
    devices.forEach(d=>{
      addDeviceToList(d);
      // initial marker from last point
      fetchPositions(d.id, 1, false);
    });
    if(devices.length){
      status('Connected');
    }
  }

  async function fetchPositions(deviceId, limit=1, fly=true){
    const base = apiUrlInput.value.trim().replace(/\/$/,''); // no trailing slash
    const r = await fetch(base + '/devices/' + encodeURIComponent(deviceId) + '/positions?limit=' + limit);
    if(!r.ok) return;
    const rows = await r.json();
    if(rows.length){
      const p = rows[0];
      const st = (p.speed||0) > 2 ? 'moving' : 'idle';
      setMarker(deviceId, p.lat, p.lng, st, deviceId);
      if(fly && map) map.flyTo({center:[p.lng,p.lat], zoom:13, essential:true});
    }
  }

  function connectWS(){
    try{
      const base = apiUrlInput.value.trim().replace(/^http/,'ws').replace(/\/$/,''); // http->ws, https->wss
      ws = new WebSocket(base + '/ws');
      ws.onopen = ()=> status('Live stream connected');
      ws.onmessage = (evt)=>{
        try{
          const data = JSON.parse(evt.data);
          if(data && data.type==='position'){
            const st = (data.speed||0) > 2 ? 'moving' : 'idle';
            setMarker(data.device_id, data.lat, data.lng, st, data.device_id);
          }
        }catch(e){ console.warn('Bad WS data', e); }
      };
      ws.onclose = ()=> status('Live stream disconnected');
      ws.onerror = ()=> status('Live stream error');
    }catch(e){
      console.error(e);
      status('WS error');
    }
  }

  function connectAll(){
    status('Connecting...');
    fetchDevices().catch(e=>{
      console.error(e);
      status('Failed to load devices');
    });
    connectWS();
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    apiUrlInput = qs('apiUrl');
    deviceList = qs('deviceList');
    statusEl = qs('status');
    initMap();
    qs('connectBtn').addEventListener('click', connectAll);
    // auto-connect
    connectAll();
  });
})();