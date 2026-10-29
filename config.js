// =====================================================================
// CONFIGURAÇÃO DO ROTEIRIZADOR  -  edite apenas este arquivo
// =====================================================================
// Estas chaves ficam visíveis no navegador (é assim em qualquer app web).
// A proteção real vem de:
//   - Google: restringir a chave por "referenciador HTTP" e por APIs (ver README)
//   - OpenRouteService: a cota gratuita é por chave (limite diário de buscas e rotas)
//   - Supabase: Row Level Security (já configurada no schema.sql)
// NUNCA coloque aqui a chave "service_role" do Supabase.
window.APP_CONFIG = {
  // Provedor de mapa, busca e rotas:
  //   'osm'    -> GRATUITO: OpenStreetMap + OpenRouteService (precisa de ORS_API_KEY)
  //   'google' -> Google Maps (precisa de GOOGLE_MAPS_API_KEY e faturamento ativo; considera trânsito)
  PROVIDER: 'osm',

  // OpenRouteService: gere uma chave gratuita em https://openrouteservice.org/dev/#/signup
  ORS_API_KEY: 'COLE_SUA_CHAVE_DO_OPENROUTESERVICE_AQUI',

  // (Só se PROVIDER = 'google') Google Cloud > APIs e serviços > Credenciais
  GOOGLE_MAPS_API_KEY: 'COLE_SUA_CHAVE_DO_GOOGLE_AQUI',

  // (Só Google) Id de mapa para os marcadores. 'DEMO_MAP_ID' funciona para começar.
  GOOGLE_MAP_ID: 'DEMO_MAP_ID',

  // Supabase > Project Settings > API
  SUPABASE_URL: 'https://gucsjrgkrphoemswkzbk.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_bEQrxFBXHhOnAXLm_qsi5A_KJ4EL0bI',

  // (Opcional, só modo 'osm') Outro provedor de imagens do mapa, se o padrão do OpenStreetMap
  // bloquear o seu acesso. Deixe vazio para usar o padrão.
  TILE_URL: '',
  TILE_ATTRIBUTION: '',

  // Permite entrar só com "usuário" (sem @). O app completa com este domínio.
  // Ex.: usuário "joao" -> joao@roteirizador.app (crie o usuário no Supabase com esse e-mail).
  USERNAME_DOMAIN: 'roteirizador.app',

  // Preferências
  LANGUAGE: 'pt-BR',
  REGION: 'BR',
  COUNTRIES: ['br'],              // restringe a busca de locais; use [] para o mundo todo
  DEFAULT_STOP_MINUTES: 15,       // tempo médio de permanência em cada ponto
  DEFAULT_DEPARTURE_TIME: '08:00',
  DEFAULT_CENTER: { lat: -14.235, lng: -51.925 }, // centro do Brasil
  DEFAULT_ZOOM: 4,
  MAX_STOPS: 25                   // limite da Routes API para pontos intermediários
};
