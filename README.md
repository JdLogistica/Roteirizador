# Roteirizador

App web (HTML/CSS/JS puro) para planejar rotas de visitas:

- Busca de locais, mapa e rota, com **dois modos à escolha** (`PROVIDER` no `config.js`):
  - **`osm` (gratuito, padrão):** mapa OpenStreetMap + busca, rota e otimização pelo OpenRouteService
  - **`google`:** Google Maps (considera trânsito; exige conta de faturamento ativa)
- Você escolhe os pontos; o app calcula **distância, tempo até cada ponto, horário de chegada/saída e término previsto**
- **Otimizar ordem** (menor tempo total) ou monte a ordem manualmente (arrastar ou ▲▼)
- Tempo de parada configurável por ponto (padrão 15 min)
- **Login com usuário e senha** (Supabase Auth); cada usuário só vê as próprias rotas (RLS)
- **Rotas salvas por dia** (aba Histórico): filtrar por data, abrir, duplicar para hoje, excluir
- Marcar pontos como **Visitado** (grava o horário real e compara com o previsto)
- Botão **Abrir no Google Maps** para navegar pelo celular

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Telas (login, planejar, histórico) |
| `style.css` | Estilos |
| `app.js` | Lógica |
| `config.js` | **Suas chaves e preferências (único arquivo para editar)** |
| `schema.sql` | Tabela e regras de segurança do banco (já aplicada no projeto Supabase `roteirizador`) |

## Configuração

### 1) Supabase (login + banco)

1. Crie o usuário em **Authentication → Users → Add user** (e-mail + senha, marque *Auto Confirm User*).
2. Em **Authentication → Providers → Email**, desative **Allow new users to sign up**.
3. No login do app, use o e-mail completo. Se digitar só um nome, o app completa com `@roteirizador.app` (`USERNAME_DOMAIN`).

### 2a) Modo gratuito (`PROVIDER: 'osm'`)

1. Crie uma conta gratuita em <https://openrouteservice.org/dev/#/signup> e gere uma chave (token).
2. Cole em `ORS_API_KEY` no `config.js`.
3. Limites do plano gratuito (ver <https://openrouteservice.org/plans/>): por dia, 2.000 rotas, 500 otimizações e 1.000 buscas com autocompletar.

Diferenças em relação ao Google: os tempos **não consideram trânsito em tempo real** e os dados de comércios/pontos de interesse do OpenStreetMap podem ser menos completos. Endereços de rua funcionam bem.

### 2b) Modo Google (`PROVIDER: 'google'`)

1. No Google Cloud, ative o faturamento e as APIs **Maps JavaScript API**, **Places API (New)** e **Routes API**.
2. Crie uma **Chave de API** e restrinja por **referenciador HTTP** (seu site no GitHub Pages) e pelas 3 APIs.
3. Crie um alerta de orçamento e cole a chave em `GOOGLE_MAPS_API_KEY`.

### 3) Publicar (GitHub Pages)

Suba os arquivos para um repositório → **Settings → Pages → Deploy from branch → main / root**.
Teste local: `python3 -m http.server 8080` na pasta e abra `http://localhost:8080`.
(Abrir o arquivo com duplo clique pode bloquear chaves restritas por domínio.)

## Observações

- Máximo de 25 pontos por rota.
- Sem "voltar ao ponto de partida", o último ponto da lista é o destino final e fica fixo na otimização.
- Os horários são recalculados no navegador a partir da saída e dos tempos de parada.
- As chaves do `config.js` ficam visíveis no navegador; a proteção dos dados está no Supabase (RLS).
- Atribuição: mapa © OpenStreetMap contributors; rotas © openrouteservice (exibidas no canto do mapa).
