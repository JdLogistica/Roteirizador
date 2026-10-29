/* =====================================================================
   Roteirizador - lógica do app
   - Login: Supabase Auth (e-mail/usuário + senha)
   - Provedor "osm" (gratuito): mapa OpenStreetMap (Leaflet) + busca, rota e
     otimização pelo OpenRouteService
   - Provedor "google": Google Maps + Places API (New) + Routes API
   - Persistência: Supabase (tabela routes, protegida por RLS)
   ===================================================================== */
(() => {
  'use strict';

  const C = window.APP_CONFIG || {};
  const PROVIDER = String(C.PROVIDER || 'osm').toLowerCase() === 'google' ? 'google' : 'osm';
  const ORS = 'https://api.openrouteservice.org';
  const GOOGLE_FIELD_MASK = [
    'routes.duration',
    'routes.distanceMeters',
    'routes.polyline.encodedPolyline',
    'routes.legs.duration',
    'routes.legs.distanceMeters',
    'routes.optimizedIntermediateWaypointIndex'
  ].join(',');

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  // Cria elementos sem innerHTML (evita XSS com dados vindos de buscas/banco)
  function el(tag, props = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function toast(msg, type = '', ms = 4500) {
    const t = el('div', { class: `toast ${type}`, text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtKm = (m) => `${(m / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
  function fmtDur(sec) {
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${pad(min % 60)} min`;
  }
  function fmtDay(dateStr) {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
  }
  const parseSec = (d) => (d ? parseFloat(String(d).replace('s', '')) || 0 : 0);

  // <codec>
  // Polyline codificada (algoritmo do Google, precisão 5). Formato único para
  // guardar o traçado no banco, independente do provedor.
  function encodePolyline(points) {
    let lastLat = 0, lastLng = 0, out = '';
    const enc = (num) => {
      let v = num < 0 ? ~(num << 1) : (num << 1);
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const [lat, lng] of points) {
      const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
      out += enc(la - lastLat) + enc(ln - lastLng);
      lastLat = la; lastLng = ln;
    }
    return out;
  }

  function decodePolyline(str) {
    let i = 0, lat = 0, lng = 0;
    const out = [];
    while (i < str.length) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (res & 1) ? ~(res >> 1) : (res >> 1);
      shift = 0; res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (res & 1) ? ~(res >> 1) : (res >> 1);
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  // </codec>

  // ------------------------------------------------------------------
  // Estado e configuração
  // ------------------------------------------------------------------
  const state = {
    user: null,
    origin: null,            // {name, address, lat, lng}
    stops: [],               // [{id, name, address, lat, lng, serviceMin, visitedAt}]
    returnToOrigin: true,
    result: null,            // {legs:[{seconds,meters}], polyline, totalSeconds, totalMeters}
    currentId: null,         // id da rota salva em edição
    routes: [],              // cache do histórico
    dragFrom: null,
    busy: false
  };

  const supabaseConfigured = !!(
    C.SUPABASE_URL && !C.SUPABASE_URL.includes('SEU-PROJETO') &&
    C.SUPABASE_ANON_KEY && !C.SUPABASE_ANON_KEY.startsWith('COLE_'));
  const googleConfigured = !!(C.GOOGLE_MAPS_API_KEY && !C.GOOGLE_MAPS_API_KEY.startsWith('COLE_'));
  const orsConfigured = !!(C.ORS_API_KEY && !C.ORS_API_KEY.startsWith('COLE_'));
  const providerReady = PROVIDER === 'google' ? googleConfigured : orsConfigured;
  const providerKeyMsg = PROVIDER === 'google'
    ? 'falta colocar a chave do Google (GOOGLE_MAPS_API_KEY) no config.js.'
    : 'falta colocar a chave do OpenRouteService (ORS_API_KEY) no config.js.';

  let sb = null;
  if (supabaseConfigured && window.supabase) {
    sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }

  // ------------------------------------------------------------------
  // Mapas: adaptadores (Leaflet/OpenStreetMap e Google Maps)
  //   init(container) | ready() | center() | render(origin, stops, path, fit)
  // ------------------------------------------------------------------
  const LeafletMaps = (() => {
    let map = null, layer = null;
    return {
      async init(container) {
        if (!window.L) throw new Error('a biblioteca do mapa (Leaflet) não carregou. Verifique sua conexão.');
        const c = C.DEFAULT_CENTER || { lat: -14.235, lng: -51.925 };
        map = window.L.map(container).setView([c.lat, c.lng], C.DEFAULT_ZOOM || 4);
        window.L.tileLayer(C.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          referrerPolicy: 'origin', // o servidor de mapas exige saber de qual site vem o pedido
          attribution: C.TILE_ATTRIBUTION ||
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> | Rotas &copy; <a href="https://openrouteservice.org/" target="_blank" rel="noopener">openrouteservice</a>'
        }).addTo(map);
        layer = window.L.layerGroup().addTo(map);
      },
      ready: () => !!map,
      center() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      render(origin, stops, path, fit) {
        const L = window.L;
        layer.clearLayers();
        const pts = [];
        let markers = 0;
        const add = (p, label, cls, title) => {
          const icon = L.divIcon({ className: `pin ${cls}`, html: `<span>${label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
          L.marker([p.lat, p.lng], { icon, title }).addTo(layer);
          pts.push([p.lat, p.lng]);
          markers++;
        };
        if (origin) add(origin, 'P', 'origin', `Partida: ${origin.name}`);
        stops.forEach((s, i) => add(s, String(i + 1), s.visitedAt ? 'done' : '', `${i + 1}. ${s.name}`));
        if (path && path.length) {
          L.polyline(path, { color: '#1a73e8', weight: 5, opacity: 0.85 }).addTo(layer);
          for (const p of path) pts.push(p);
        }
        if (fit && markers > 0) {
          if (markers === 1) map.setView(pts[0], 15);
          else map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
        }
      }
    };
  })();

  let gLib = null;
  const getGoogleLib = () => gLib;

  let gPromise = null;
  function loadGoogle() {
    if (gPromise) return gPromise;
    if (!googleConfigured) return Promise.reject(new Error(providerKeyMsg));
    gPromise = new Promise((resolve, reject) => {
      window.gm_authFailure = () =>
        toast('Chave do Google recusada. Verifique a chave, as APIs ativadas e a restrição de domínio.', 'error', 10000);
      window.__gmReady = async () => {
        try {
          const [maps, places, marker] = await Promise.all([
            google.maps.importLibrary('maps'),
            google.maps.importLibrary('places'),
            google.maps.importLibrary('marker')
          ]);
          resolve({ maps, places, marker });
        } catch (e) { reject(e); }
      };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js' +
        `?key=${encodeURIComponent(C.GOOGLE_MAPS_API_KEY)}&v=weekly&loading=async` +
        `&language=${encodeURIComponent(C.LANGUAGE || 'pt-BR')}&region=${encodeURIComponent(C.REGION || 'BR')}` +
        '&callback=__gmReady';
      s.async = true;
      s.onerror = () => reject(new Error('Falha ao carregar o Google Maps'));
      document.head.append(s);
    });
    return gPromise;
  }

  const GoogleMaps = (() => {
    let map = null, markers = [], poly = null;
    return {
      async init(container) {
        gLib = await loadGoogle();
        map = new gLib.maps.Map(container, {
          center: C.DEFAULT_CENTER || { lat: -14.235, lng: -51.925 },
          zoom: C.DEFAULT_ZOOM || 4,
          mapId: C.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true
        });
      },
      ready: () => !!map,
      center: () => map.getCenter().toJSON(),
      render(origin, stops, path, fit) {
        const { AdvancedMarkerElement, PinElement } = gLib.marker;
        markers.forEach((m) => { m.map = null; });
        markers = [];
        if (poly) { poly.setMap(null); poly = null; }
        const bounds = new google.maps.LatLngBounds();
        let count = 0;
        const add = (p, label, color, title) => {
          const pin = new PinElement({ glyphText: label, background: color, borderColor: '#ffffff', glyphColor: '#ffffff' });
          markers.push(new AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content: pin.element, title }));
          bounds.extend({ lat: p.lat, lng: p.lng });
          count++;
        };
        if (origin) add(origin, 'P', '#0f9d58', `Partida: ${origin.name}`);
        stops.forEach((s, i) => add(s, String(i + 1), s.visitedAt ? '#5f6b7a' : '#1a73e8', `${i + 1}. ${s.name}`));
        if (path && path.length) {
          const gpath = path.map(([lat, lng]) => ({ lat, lng }));
          poly = new google.maps.Polyline({ path: gpath, map, strokeColor: '#1a73e8', strokeOpacity: 0.85, strokeWeight: 5 });
          gpath.forEach((p) => bounds.extend(p));
        }
        if (fit && count > 0) {
          if (count === 1) { map.setCenter(bounds.getCenter()); map.setZoom(15); }
          else map.fitBounds(bounds, 60);
        }
      }
    };
  })();

  const Maps = PROVIDER === 'google' ? GoogleMaps : LeafletMaps;

  // <providers>
  // ------------------------------------------------------------------
  // Busca de locais e cálculo de rota
  //   Search.suggest(texto) -> [{main, secondary, resolve(): Promise<{name,address,lat,lng}>}]
  //   Router.compute({origin, dest, inter, optimize, departure})
  //        -> {order: [índices de inter] | null, legs:[{seconds,meters}], polyline}
  // ------------------------------------------------------------------
  async function orsFetch(path, { method = 'GET', body = null, params = null } = {}) {
    const url = new URL(ORS + path);
    const headers = {};
    if (method === 'GET') {
      url.searchParams.set('api_key', C.ORS_API_KEY);
      if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    } else {
      headers.Authorization = C.ORS_API_KEY;
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { /* sem corpo */ }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('chave do OpenRouteService inválida ou sem permissão.');
      if (res.status === 429) throw new Error('limite de uso do OpenRouteService atingido. Tente novamente mais tarde.');
      const e = data && data.error;
      throw new Error((e && (typeof e === 'string' ? e : e.message)) || `HTTP ${res.status}`);
    }
    return data;
  }

  const OsmSearch = {
    async suggest(q) {
      const c = Maps.center();
      const params = { text: q, size: '6' };
      if (c) { params['focus.point.lon'] = String(c.lng); params['focus.point.lat'] = String(c.lat); }
      if (Array.isArray(C.COUNTRIES) && C.COUNTRIES.length) {
        params['boundary.country'] = C.COUNTRIES.map((x) => String(x).toUpperCase()).join(',');
      }
      const data = await orsFetch('/geocode/autocomplete', { params });
      return (data.features || [])
        .filter((f) => f.geometry && Array.isArray(f.geometry.coordinates))
        .map((f) => {
          const p = f.properties || {};
          const name = p.name || p.label || 'Local';
          const place = { name, address: p.label || name, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
          return { main: name, secondary: p.label && p.label !== name ? p.label : '', resolve: async () => place };
        });
    }
  };

  const OsmRouter = {
    async compute({ origin, dest, inter, optimize }) {
      let order = null;
      let ordered = inter;
      if (optimize && inter.length > 1) {
        const data = await orsFetch('/optimization', {
          method: 'POST',
          body: {
            jobs: inter.map((p, i) => ({ id: i, location: [p.lng, p.lat] })),
            vehicles: [{ id: 1, profile: 'driving-car', start: [origin.lng, origin.lat], end: [dest.lng, dest.lat] }]
          }
        });
        if ((data.unassigned && data.unassigned.length) || !data.routes || !data.routes[0]) {
          throw new Error('não foi possível encaixar todos os pontos na otimização.');
        }
        order = data.routes[0].steps.filter((s) => s.type === 'job').map((s) => s.id);
        if (order.length !== inter.length) throw new Error('a otimização devolveu uma ordem incompleta.');
        ordered = order.map((i) => inter[i]);
      }
      const coords = [origin, ...ordered, dest].map((p) => [p.lng, p.lat]);
      const d = await orsFetch('/v2/directions/driving-car/geojson', {
        method: 'POST',
        body: { coordinates: coords, instructions: false, language: 'pt' }
      });
      const f = d.features && d.features[0];
      if (!f) throw new Error('nenhuma rota encontrada entre esses pontos.');
      const legs = (f.properties.segments || []).map((s) => ({ seconds: s.duration || 0, meters: s.distance || 0 }));
      const polyline = encodePolyline(f.geometry.coordinates.map(([lng, lat]) => [lat, lng]));
      return { order, legs, polyline };
    }
  };

  const GoogleSearch = (() => {
    let token = null;
    return {
      async suggest(q) {
        const lib = getGoogleLib();
        const { AutocompleteSuggestion, AutocompleteSessionToken } = lib.places;
        if (!token) token = new AutocompleteSessionToken();
        const req = {
          input: q,
          sessionToken: token,
          language: C.LANGUAGE || 'pt-BR',
          region: C.REGION || 'BR',
          locationBias: { center: Maps.center(), radius: 50000 }
        };
        if (Array.isArray(C.COUNTRIES) && C.COUNTRIES.length) req.includedRegionCodes = C.COUNTRIES;
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
        return suggestions.filter((s) => s.placePrediction).map((s) => {
          const p = s.placePrediction;
          return {
            main: (p.mainText && p.mainText.text) || p.text.text,
            secondary: (p.secondaryText && p.secondaryText.text) || '',
            resolve: async () => {
              const place = p.toPlace();
              await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
              token = null; // encerra a sessão de cobrança do autocomplete
              return {
                name: place.displayName || p.text.text,
                address: place.formattedAddress || '',
                lat: place.location.lat(),
                lng: place.location.lng()
              };
            }
          };
        });
      }
    };
  })();

  const GoogleRouter = {
    async compute({ origin, dest, inter, optimize, departure }) {
      const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
      const body = {
        origin: wp(origin),
        destination: wp(dest),
        intermediates: inter.map(wp),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        languageCode: C.LANGUAGE || 'pt-BR',
        units: 'METRIC'
      };
      if (optimize) body.optimizeWaypointOrder = true;
      if (departure) body.departureTime = departure.toISOString();
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': C.GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': GOOGLE_FIELD_MASK
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      const route = data.routes && data.routes[0];
      if (!route) throw new Error('nenhuma rota encontrada entre esses pontos.');
      const legs = (route.legs || []).map((l) => ({ seconds: parseSec(l.duration), meters: l.distanceMeters || 0 }));
      const order = optimize && Array.isArray(route.optimizedIntermediateWaypointIndex)
        ? route.optimizedIntermediateWaypointIndex : null;
      return { order, legs, polyline: (route.polyline && route.polyline.encodedPolyline) || '' };
    }
  };

  const Search = PROVIDER === 'google' ? GoogleSearch : OsmSearch;
  const Router = PROVIDER === 'google' ? GoogleRouter : OsmRouter;
  // </providers>

  // ------------------------------------------------------------------
  // Autenticação
  // ------------------------------------------------------------------
  const toEmail = (u) => {
    const v = u.trim().toLowerCase();
    return v.includes('@') ? v : `${v}@${C.USERNAME_DOMAIN || 'roteirizador.app'}`;
  };

  function showLogin() {
    $('#view-app').hidden = true;
    $('#view-login').hidden = false;
    state.user = null;
  }

  async function showApp(user) {
    if (state.user && state.user.id === user.id) return; // evita inicializar duas vezes
    state.user = user;
    $('#view-login').hidden = true;
    $('#view-app').hidden = false;
    $('#user-label').textContent = user.email ? user.email.split('@')[0] : '';
    try {
      await Maps.init($('#map'));
    } catch (e) {
      console.error(e);
      toast(`Mapa indisponível: ${e.message}`, 'error', 10000);
    }
    initPlanner();
    await loadHistory();
  }

  function initLogin() {
    if (!supabaseConfigured || !sb) {
      const w = $('#config-warning');
      w.hidden = false;
      w.textContent = 'App ainda não configurado: preencha a URL e a chave do Supabase no arquivo config.js.';
    }

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error');
      err.hidden = true;
      if (!sb) { err.textContent = 'Configure o config.js antes de entrar.'; err.hidden = false; return; }
      const user = $('#login-user').value;
      const pass = $('#login-pass').value;
      if (!user.trim() || !pass) { err.textContent = 'Informe usuário e senha.'; err.hidden = false; return; }

      const btn = $('#login-btn');
      btn.disabled = true; btn.textContent = 'Entrando…';
      const { error } = await sb.auth.signInWithPassword({ email: toEmail(user), password: pass });
      btn.disabled = false; btn.textContent = 'Entrar';
      if (error) {
        err.textContent = /invalid login|credentials/i.test(error.message)
          ? 'Usuário ou senha inválidos.'
          : `Não foi possível entrar: ${error.message}`;
        err.hidden = false;
      } else {
        $('#login-pass').value = '';
      }
    });

    $('#logout-btn').addEventListener('click', async () => {
      await sb.auth.signOut();
    });

    if (!sb) return;
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        if (state.user) location.reload(); // limpa mapa/estado em memória
        else showLogin();
      } else if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        // defer: não chamar o supabase de dentro do callback
        setTimeout(() => showApp(session.user), 0);
      }
    });
  }

  // ------------------------------------------------------------------
  // Autocomplete (provedor escolhido no config.js)
  // ------------------------------------------------------------------
  let warnedKey = false;

  function attachAutocomplete(input, list, onPick) {
    let timer = null, items = [], active = -1, reqId = 0;

    const close = () => { list.hidden = true; list.replaceChildren(); items = []; active = -1; };

    function render() {
      list.replaceChildren(...items.map((s, i) => el('li', {
        class: i === active ? 'active' : '',
        role: 'option',
        onmousedown: (e) => { e.preventDefault(); pick(i); }
      },
      el('strong', { text: s.main }),
      el('span', { text: s.secondary }))));
      list.hidden = items.length === 0;
    }

    async function search() {
      const q = input.value.trim();
      if (q.length < 3) return close();
      if (!providerReady) {
        if (!warnedKey) { warnedKey = true; toast(`Busca indisponível: ${providerKeyMsg}`, 'warn', 8000); }
        return close();
      }
      if (!Maps.ready()) {
        toast('Busca indisponível: o mapa não carregou.', 'warn', 6000);
        return close();
      }
      const my = ++reqId;
      try {
        const res = await Search.suggest(q);
        if (my !== reqId) return; // resposta antiga
        items = res;
        active = -1;
        render();
      } catch (e) {
        console.error(e);
        toast(`Erro na busca de locais: ${e.message}`, 'error', 8000);
        close();
      }
    }

    async function pick(i) {
      const s = items[i];
      if (!s) return;
      close();
      input.value = '';
      try {
        onPick(await s.resolve());
      } catch (e) {
        console.error(e);
        toast('Não foi possível obter os dados do local.', 'error');
      }
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  // ------------------------------------------------------------------
  // Planejador
  // ------------------------------------------------------------------
  const originKey = () => `rot_origin_${state.user ? state.user.id : ''}`;

  function renderMap(fit = true) {
    if (!Maps.ready()) return;
    const path = state.result && state.result.polyline ? decodePolyline(state.result.polyline) : null;
    Maps.render(state.origin, state.stops, path, fit);
  }

  function startDate() {
    const d = $('#route-date').value || todayStr();
    const t = $('#route-time').value || C.DEFAULT_DEPARTURE_TIME || '08:00';
    return new Date(`${d}T${t}`);
  }

  // Calcula chegada/saída de cada ponto a partir da saída e do tempo de parada
  function buildSchedule() {
    if (!state.result) return null;
    let t = startDate();
    return state.result.legs.map((leg, i) => {
      const arrive = new Date(t.getTime() + leg.seconds * 1000);
      if (i < state.stops.length) {
        const depart = new Date(arrive.getTime() + (state.stops[i].serviceMin || 0) * 60000);
        t = depart;
        return { leg, arrive, depart };
      }
      return { leg, arrive, depart: null, isReturn: true };
    });
  }

  function invalidateResult() {
    state.result = null;
    renderAll();
  }

  function setOrigin(o) {
    state.origin = o;
    try { localStorage.setItem(originKey(), JSON.stringify(o)); } catch (_) { /* ignora */ }
    invalidateResult();
    renderMap(true);
  }

  function addStop(p) {
    if (state.stops.length >= (C.MAX_STOPS || 25)) {
      return toast(`Limite de ${C.MAX_STOPS || 25} pontos por rota.`, 'warn');
    }
    state.stops.push({ id: uid(), ...p, serviceMin: C.DEFAULT_STOP_MINUTES ?? 15, visitedAt: null });
    invalidateResult();
    renderMap(true);
  }

  function moveStop(from, to) {
    if (to < 0 || to >= state.stops.length || from === to) return;
    const [s] = state.stops.splice(from, 1);
    state.stops.splice(to, 0, s);
    invalidateResult();
    renderMap(false);
  }

  function removeStop(i) {
    state.stops.splice(i, 1);
    invalidateResult();
    renderMap(true);
  }

  async function toggleVisited(i, checked) {
    state.stops[i].visitedAt = checked ? new Date().toISOString() : null;
    renderAll();
    renderMap(false);
    if (state.currentId) {
      const { error } = await sb.from('routes').update({ stops: state.stops }).eq('id', state.currentId);
      if (error) toast(`Não foi possível gravar a visita: ${error.message}`, 'error');
      else loadHistory(true);
    }
  }

  function renderStops() {
    const list = $('#stops');
    const sched = buildSchedule();
    $('#stops-empty').hidden = state.stops.length > 0;

    list.replaceChildren(...state.stops.map((s, i) => {
      const row = sched ? sched[i] : null;

      let doneInfo = null;
      if (s.visitedAt) {
        const real = new Date(s.visitedAt);
        let diff = '';
        if (row) {
          const d = Math.round((real - row.arrive) / 60000);
          diff = ` (previsto ${fmtTime(row.arrive)}, ${d >= 0 ? '+' : ''}${d} min)`;
        }
        doneInfo = el('div', { class: 'meta ok', text: `✔ Visitado às ${fmtTime(real)}${diff}` });
      }

      const li = el('li', {
        class: `stop${s.visitedAt ? ' done' : ''}`,
        draggable: 'true',
        ondragstart: (e) => { state.dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
        ondragend: () => { li.classList.remove('dragging'); state.dragFrom = null; },
        ondragover: (e) => { e.preventDefault(); li.classList.add('over'); },
        ondragleave: () => li.classList.remove('over'),
        ondrop: (e) => { e.preventDefault(); li.classList.remove('over'); if (state.dragFrom != null) moveStop(state.dragFrom, i); }
      },
      el('div', { class: 'num', text: i + 1 }),
      el('div', { class: 'info' },
        el('div', { class: 'name', text: s.name }),
        el('div', { class: 'addr', text: s.address || '' }),
        row ? el('div', { class: 'meta', text: `🚗 ${fmtDur(row.leg.seconds)} · ${fmtKm(row.leg.meters)} desde o ponto anterior` }) : null,
        row ? el('div', { class: 'meta eta', text: `Chegada ${fmtTime(row.arrive)} → Saída ${fmtTime(row.depart)}` }) : null,
        doneInfo,
        el('div', { class: 'stop-ctrl' },
          el('label', { class: 'mins' }, 'Parada',
            el('input', {
              type: 'number', min: '0', max: '600', step: '5', value: String(s.serviceMin ?? 0),
              onchange: (e) => {
                s.serviceMin = Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0));
                renderAll();
              }
            }), 'min'),
          el('label', { class: 'visit' },
            el('input', { type: 'checkbox', checked: !!s.visitedAt, onchange: (e) => toggleVisited(i, e.target.checked) }),
            'Visitado'))),
      el('div', { class: 'stop-btns' },
        el('button', { type: 'button', class: 'icon-btn', title: 'Subir', disabled: i === 0, onclick: () => moveStop(i, i - 1), text: '▲' }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Descer', disabled: i === state.stops.length - 1, onclick: () => moveStop(i, i + 1), text: '▼' }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Remover', onclick: () => removeStop(i), text: '✕' })));
      return li;
    }));
  }

  function renderOrigin() {
    const card = $('#origin-card');
    card.hidden = !state.origin;
    if (state.origin) {
      $('#origin-name').textContent = state.origin.name;
      $('#origin-addr').textContent = state.origin.address || '';
    }
  }

  function renderSummary() {
    const box = $('#summary');
    const sched = buildSchedule();
    if (!sched) { box.hidden = true; box.replaceChildren(); return; }

    const drive = state.result.totalSeconds;
    const service = state.stops.reduce((a, s) => a + (s.serviceMin || 0), 0) * 60;
    const last = sched[sched.length - 1];
    const end = last.isReturn ? last.arrive : last.depart;
    const card = (k, v, wide) => el('div', { class: `card${wide ? ' wide' : ''}` }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));

    const nodes = [
      card('Distância total', fmtKm(state.result.totalMeters)),
      card('Tempo dirigindo', fmtDur(drive)),
      card('Tempo em paradas', fmtDur(service)),
      card('Duração total', fmtDur(drive + service)),
      card(`Término previsto (saída ${fmtTime(startDate())})`, fmtTime(end), true)
    ];
    if (PROVIDER === 'osm') {
      nodes.push(el('p', { class: 'muted small note', text: 'Tempos estimados sem trânsito em tempo real.' }));
    }
    box.replaceChildren(...nodes);
    box.hidden = false;
  }

  function mapsUrl() {
    if (!state.origin || !state.stops.length) return null;
    const ll = (p) => `${p.lat},${p.lng}`;
    const dest = state.returnToOrigin ? state.origin : state.stops[state.stops.length - 1];
    const way = state.returnToOrigin ? state.stops : state.stops.slice(0, -1);
    const q = new URLSearchParams({ api: '1', origin: ll(state.origin), destination: ll(dest), travelmode: 'driving' });
    if (way.length) q.set('waypoints', way.map(ll).join('|'));
    return `https://www.google.com/maps/dir/?${q.toString()}`;
  }

  function renderLinks() {
    const a = $('#gmaps-link');
    const url = mapsUrl();
    a.hidden = !url;
    if (url) a.href = url;
  }

  function renderAll() {
    renderOrigin();
    renderStops();
    renderSummary();
    renderLinks();
    $('#return-hint').hidden = state.returnToOrigin;
  }

  async function calculate(optimize) {
    if (state.busy) return;
    if (!providerReady) return toast(`Rota indisponível: ${providerKeyMsg}`, 'warn', 8000);
    if (!state.origin) return toast('Defina o ponto de partida.', 'warn');
    if (!state.stops.length) return toast('Adicione ao menos um ponto.', 'warn');

    const ret = state.returnToOrigin;
    const dest = ret ? state.origin : state.stops[state.stops.length - 1];
    const inter = ret ? [...state.stops] : state.stops.slice(0, -1);
    const dep = startDate();

    state.busy = true;
    $('#calc-btn').disabled = true; $('#opt-btn').disabled = true;
    try {
      const willOptimize = !!optimize && inter.length > 1;
      const out = await Router.compute({
        origin: state.origin,
        dest,
        inter,
        optimize: willOptimize,
        departure: dep.getTime() > Date.now() + 60000 ? dep : null // só datas futuras
      });

      if (willOptimize && out.order) {
        const ordered = out.order.map((i) => inter[i]);
        state.stops = ret ? ordered : [...ordered, dest];
      }

      const expectedLegs = state.stops.length + (ret ? 1 : 0);
      if (out.legs.length !== expectedLegs) throw new Error('a resposta da rota veio incompleta. Tente novamente.');

      state.result = {
        legs: out.legs,
        polyline: out.polyline,
        totalSeconds: out.legs.reduce((a, l) => a + l.seconds, 0),
        totalMeters: out.legs.reduce((a, l) => a + l.meters, 0)
      };
      renderAll();
      renderMap(true);
      toast(willOptimize ? 'Ordem otimizada e rota calculada.' : 'Rota calculada.', 'success', 2500);
    } catch (e) {
      console.error(e);
      toast(`Erro ao calcular a rota: ${e.message}`, 'error', 9000);
    } finally {
      state.busy = false;
      $('#calc-btn').disabled = false; $('#opt-btn').disabled = false;
    }
  }

  function defaultName() {
    const first = state.stops[0] ? state.stops[0].name : 'Rota';
    return `${first}${state.stops.length > 1 ? ` +${state.stops.length - 1}` : ''}`;
  }

  async function saveRoute() {
    if (!state.result) return toast('Calcule a rota antes de salvar.', 'warn');
    const payload = {
      name: $('#route-name').value.trim() || defaultName(),
      route_date: $('#route-date').value || todayStr(),
      origin: state.origin,
      stops: state.stops,
      settings: { returnToOrigin: state.returnToOrigin, departureTime: $('#route-time').value },
      result: state.result
    };
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      let q;
      if (state.currentId) q = sb.from('routes').update(payload).eq('id', state.currentId).select().single();
      else q = sb.from('routes').insert(payload).select().single();
      const { data, error } = await q;
      if (error) throw error;
      state.currentId = data.id;
      $('#route-name').value = data.name;
      toast('Rota salva.', 'success', 2500);
      await loadHistory(true);
    } catch (e) {
      console.error(e);
      toast(`Não foi possível salvar: ${e.message}`, 'error', 8000);
    } finally {
      btn.disabled = false;
    }
  }

  function resetPlanner(keepOrigin = true) {
    state.stops = [];
    state.result = null;
    state.currentId = null;
    $('#route-name').value = '';
    $('#route-date').value = todayStr();
    if (!keepOrigin) state.origin = null;
    renderAll();
    renderMap(true);
    renderHistory();
  }

  function initPlanner() {
    $('#route-date').value = todayStr();
    $('#route-time').value = C.DEFAULT_DEPARTURE_TIME || '08:00';
    $('#hist-date').value = '';

    const warns = [];
    if (location.protocol === 'file:' && PROVIDER === 'osm') {
      warns.push('O arquivo foi aberto direto do computador (file://). O mapa do OpenStreetMap bloqueia esse acesso: publique no GitHub Pages ou abra por http://localhost.');
    }
    if (!providerReady) warns.push(`Busca de locais e rotas indisponíveis: ${providerKeyMsg}`);
    if (warns.length) {
      const pw = $('#provider-warning');
      pw.hidden = false;
      pw.textContent = warns.join(' ');
    }

    try {
      const saved = JSON.parse(localStorage.getItem(originKey()) || 'null');
      if (saved && typeof saved.lat === 'number') state.origin = saved;
    } catch (_) { /* ignora */ }

    attachAutocomplete($('#origin-input'), $('#origin-list'), setOrigin);
    attachAutocomplete($('#stop-input'), $('#stop-list'), addStop);

    $('#geo-btn').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Geolocalização indisponível neste navegador.', 'warn');
      navigator.geolocation.getCurrentPosition(
        (pos) => setOrigin({ name: 'Minha localização', address: 'Localização atual do dispositivo', lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => toast('Não foi possível obter sua localização (permissão negada?).', 'warn'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    $('#origin-clear').addEventListener('click', () => {
      state.origin = null;
      try { localStorage.removeItem(originKey()); } catch (_) { /* ignora */ }
      invalidateResult();
      renderMap(true);
    });

    $('#return-chk').addEventListener('change', (e) => { state.returnToOrigin = e.target.checked; invalidateResult(); });
    $('#route-time').addEventListener('change', () => renderAll());
    $('#route-date').addEventListener('change', () => renderAll());
    $('#calc-btn').addEventListener('click', () => calculate(false));
    $('#opt-btn').addEventListener('click', () => calculate(true));
    $('#save-btn').addEventListener('click', saveRoute);
    $('#clear-btn').addEventListener('click', () => resetPlanner(true));

    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#hist-date').addEventListener('change', renderHistory);
    $('#hist-all').addEventListener('click', () => { $('#hist-date').value = ''; renderHistory(); });

    renderAll();
    renderMap(true);
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('#tab-plan').hidden = name !== 'plan';
    $('#tab-history').hidden = name !== 'history';
  }

  // ------------------------------------------------------------------
  // Histórico
  // ------------------------------------------------------------------
  async function loadHistory(silent = false) {
    const { data, error } = await sb
      .from('routes')
      .select('id,name,route_date,origin,stops,settings,result,created_at')
      .order('route_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) {
      console.error(error);
      if (!silent) toast(`Erro ao carregar o histórico: ${error.message}`, 'error', 8000);
      return;
    }
    state.routes = data || [];
    renderHistory();
  }

  function openRoute(r, { duplicate = false } = {}) {
    state.origin = r.origin;
    state.stops = (r.stops || []).map((s) => ({ ...s, id: duplicate ? uid() : s.id, visitedAt: duplicate ? null : s.visitedAt }));
    state.returnToOrigin = r.settings && r.settings.returnToOrigin !== false;
    state.result = r.result || null;
    state.currentId = duplicate ? null : r.id;
    $('#return-chk').checked = state.returnToOrigin;
    $('#route-name').value = duplicate ? `${r.name} (cópia)` : r.name;
    $('#route-date').value = duplicate ? todayStr() : r.route_date;
    if (r.settings && r.settings.departureTime) $('#route-time').value = r.settings.departureTime;
    switchTab('plan');
    renderAll();
    renderMap(true);
    renderHistory();
    if (duplicate) toast('Rota duplicada para hoje. Ajuste o que precisar e salve.', '', 3500);
  }

  async function deleteRoute(r) {
    if (!confirm(`Excluir a rota "${r.name}" de ${new Date(`${r.route_date}T00:00:00`).toLocaleDateString('pt-BR')}?`)) return;
    const { error } = await sb.from('routes').delete().eq('id', r.id);
    if (error) return toast(`Não foi possível excluir: ${error.message}`, 'error');
    if (state.currentId === r.id) state.currentId = null;
    toast('Rota excluída.', 'success', 2500);
    await loadHistory(true);
  }

  function renderHistory() {
    const box = $('#hist-list');
    const filter = $('#hist-date').value;
    const rows = filter ? state.routes.filter((r) => r.route_date === filter) : state.routes;

    if (!rows.length) {
      box.replaceChildren(el('p', {
        class: 'muted center',
        text: filter ? 'Nenhuma rota salva neste dia.' : 'Você ainda não salvou nenhuma rota.'
      }));
      return;
    }

    const nodes = [];
    let lastDay = null;
    for (const r of rows) {
      if (r.route_date !== lastDay) {
        lastDay = r.route_date;
        nodes.push(el('div', { class: 'hist-day', text: fmtDay(r.route_date) }));
      }
      const stops = r.stops || [];
      const done = stops.filter((s) => s.visitedAt).length;
      const bits = [`${stops.length} ponto${stops.length === 1 ? '' : 's'}`];
      if (r.result) {
        const service = stops.reduce((a, s) => a + (s.serviceMin || 0), 0) * 60;
        bits.push(fmtKm(r.result.totalMeters), fmtDur(r.result.totalSeconds + service));
      }
      bits.push(`${done}/${stops.length} visitados`);

      nodes.push(el('div', { class: `hist-item${r.id === state.currentId ? ' current' : ''}` },
        el('div', { class: 'title', text: r.name }),
        el('div', { class: 'sub', text: bits.join(' · ') }),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn small primary', onclick: () => openRoute(r), text: 'Abrir' }),
          el('button', { type: 'button', class: 'btn small', onclick: () => openRoute(r, { duplicate: true }), text: 'Duplicar p/ hoje' }),
          el('button', { type: 'button', class: 'btn small danger', onclick: () => deleteRoute(r), text: 'Excluir' }))));
    }
    box.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------------
  // Início
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    if (!sb) showLogin();
  });
})();
