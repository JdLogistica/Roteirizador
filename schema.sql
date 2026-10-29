-- =====================================================================
-- Roteirizador - schema do banco (Supabase / PostgreSQL)
-- Execute no Supabase: SQL Editor > New query > colar > Run
-- =====================================================================

create table if not exists public.routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  name        text not null,
  route_date  date not null,
  origin      jsonb not null,                    -- {name, address, lat, lng}
  stops       jsonb not null default '[]',       -- [{id, name, address, lat, lng, serviceMin, visitedAt}]
  settings    jsonb not null default '{}',       -- {returnToOrigin, departureTime}
  result      jsonb,                             -- {legs:[{seconds,meters}], polyline, totalSeconds, totalMeters}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_user_date_idx
  on public.routes (user_id, route_date desc);

-- Atualiza updated_at automaticamente
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists routes_set_updated_at on public.routes;
create trigger routes_set_updated_at
before update on public.routes
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Segurança: cada usuário enxerga e altera SOMENTE as próprias rotas
-- ---------------------------------------------------------------------
alter table public.routes enable row level security;

drop policy if exists "routes_select_own" on public.routes;
create policy "routes_select_own" on public.routes
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "routes_insert_own" on public.routes;
create policy "routes_insert_own" on public.routes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "routes_update_own" on public.routes;
create policy "routes_update_own" on public.routes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "routes_delete_own" on public.routes;
create policy "routes_delete_own" on public.routes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Usuários anônimos não têm acesso algum
revoke all on public.routes from anon;
grant select, insert, update, delete on public.routes to authenticated;
