-- PetSOS: schema do banco (Supabase / PostgreSQL) — v2 com moderação, conversas e entrega com dupla confirmação.
-- Rode no Supabase: Dashboard > SQL Editor > New query > cole e execute (projeto novo).
-- Já rodou a v1? Execute antes o bloco "RESET" no fim deste arquivo.

-- ===========================================================================
-- Tipos
-- ===========================================================================
create type public.user_role       as enum ('user', 'admin');
create type public.report_kind     as enum ('lost', 'found');
create type public.species         as enum ('dog', 'cat', 'other');
create type public.pet_size        as enum ('small', 'medium', 'large');
create type public.pet_sex         as enum ('male', 'female', 'unknown');
create type public.report_status   as enum ('open', 'reunited', 'closed');
create type public.review_status   as enum ('pending', 'approved', 'rejected');
create type public.custody         as enum ('with_finder', 'sighted');        -- anúncio "encontrado": está comigo / só vi
create type public.asker_context   as enum ('inquiry', 'sighted', 'has_pet'); -- quem inicia a conversa
create type public.handover_status as enum ('under_review', 'approved', 'rejected', 'completed');

-- ===========================================================================
-- Perfis e papéis
-- ===========================================================================
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  role         public.user_role not null default 'user',
  created_at   timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 60));
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ===========================================================================
-- Anúncios
-- ===========================================================================
create table public.reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles (id) on delete cascade default auth.uid(),
  kind          public.report_kind   not null,
  species       public.species       not null,
  custody       public.custody,
  pet_name      text check (char_length(pet_name) <= 60),
  sex           public.pet_sex       not null default 'unknown',
  size          public.pet_size,
  colors        text[] not null check (cardinality(colors) between 1 and 4),
  breed         text check (char_length(breed) <= 60),
  description   text check (char_length(description) <= 1000),
  photo_path    text,
  neighborhood  text not null check (char_length(neighborhood) between 2 and 80),
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  event_date    date not null,
  status        public.report_status not null default 'open',
  review_status public.review_status not null default 'pending',
  review_note   text check (char_length(review_note) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((kind = 'found') = (custody is not null))
);

create index reports_match_idx   on public.reports (species, kind, status, review_status, event_date);
create index reports_created_idx on public.reports (created_at desc);
create index reports_user_idx    on public.reports (user_id);
create index reports_review_idx  on public.reports (review_status) where review_status = 'pending';

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger reports_touch_updated_at before update on public.reports
for each row execute function public.touch_updated_at();

-- Regras que o navegador não pode burlar:
--  * a localização é sempre arredondada (~100 m): o ponto exato, que pode ser a casa de alguém, nunca é gravado;
--  * usuário comum sempre cria anúncio "pendente" e aberto;
--  * usuário comum não altera moderação e só pode mudar status de "aberto" para "encerrado";
--  * tipo, espécie e situação (está comigo / só vi) não mudam depois de criado: decidem quem pode pedir entrega;
--  * qualquer outra mudança de conteúdo volta o anúncio para "pendente" (nova moderação);
--  * "reencontrado" só é gravado pela função confirm_handover (dupla confirmação).
-- Funções security definer e o SQL Editor rodam como owner (não anon/authenticated) e passam direto.
create or replace function public.reports_guard()
returns trigger language plpgsql as $$
begin
  new.lat := round(new.lat::numeric, 3);
  new.lng := round(new.lng::numeric, 3);
  if current_user not in ('anon', 'authenticated') or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.review_status := 'pending';
    new.review_note   := null;
    new.status        := 'open';
    return new;
  end if;
  if new.review_status is distinct from old.review_status or new.review_note is distinct from old.review_note then
    raise exception 'Somente administradores aprovam ou recusam anúncios.';
  end if;
  if new.status is distinct from old.status and not (old.status = 'open' and new.status = 'closed') then
    raise exception 'O anúncio só é marcado como reencontrado após a confirmação de entrega das duas pessoas.';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'Não é possível transferir o anúncio.';
  end if;
  if (new.kind, new.species, new.custody) is distinct from (old.kind, old.species, old.custody) then
    raise exception 'Tipo, espécie e situação do animal não podem ser alterados. Exclua e anuncie de novo.';
  end if;
  if (new.pet_name, new.sex, new.size, new.colors, new.breed, new.description, new.photo_path,
      new.neighborhood, new.lat, new.lng, new.event_date)
     is distinct from
     (old.pet_name, old.sex, old.size, old.colors, old.breed, old.description, old.photo_path,
      old.neighborhood, old.lat, old.lng, old.event_date) then
    new.review_status := 'pending';
    new.review_note   := null;
  end if;
  return new;
end $$;

create trigger reports_guard before insert or update on public.reports
for each row execute function public.reports_guard();

-- ===========================================================================
-- Conversas (perguntas a quem viu ou está com o animal) e mensagens
-- ===========================================================================
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  report_id       uuid not null references public.reports (id) on delete cascade,
  asker_id        uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  asker_context   public.asker_context not null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (report_id, asker_id),
  check (asker_id <> owner_id)
);
create index conversations_asker_idx on public.conversations (asker_id, last_message_at desc);
create index conversations_owner_idx on public.conversations (owner_id, last_message_at desc);

-- owner_id vem do anúncio (não do navegador) e o contexto precisa combinar com o tipo do anúncio.
create or replace function public.conversations_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r public.reports;
begin
  select * into r from public.reports where id = new.report_id;
  if not found or r.review_status <> 'approved' or r.status <> 'open' or r.user_id is null then
    raise exception 'Este anúncio não está disponível para conversa.';
  end if;
  new.owner_id := r.user_id;
  if r.kind = 'lost' and new.asker_context not in ('sighted', 'has_pet') then
    raise exception 'Informe se você viu o animal ou se ele está com você.';
  end if;
  if r.kind = 'found' and new.asker_context <> 'inquiry' then
    new.asker_context := 'inquiry';
  end if;
  return new;
end $$;

create trigger conversations_before_insert before insert on public.conversations
for each row execute function public.conversations_before_insert();

create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  body            text not null check (char_length(trim(body)) between 1 and 1000),
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create or replace function public.is_participant(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations
    where id = p_conversation_id and auth.uid() in (asker_id, owner_id)
  );
$$;

create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;

create trigger messages_after_insert after insert on public.messages
for each row execute function public.messages_after_insert();

-- ===========================================================================
-- Entrega: revisão da conversa pelo admin + confirmação dos dois lados
-- ===========================================================================
create table public.handovers (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null unique references public.conversations (id) on delete cascade,
  report_id             uuid not null references public.reports (id) on delete cascade,
  finder_id             uuid not null references public.profiles (id) on delete cascade, -- está com o animal
  claimant_id           uuid not null references public.profiles (id) on delete cascade, -- tutor
  status                public.handover_status not null default 'under_review',
  transcript            jsonb not null,            -- cópia congelada da conversa no envio
  admin_note            text check (char_length(admin_note) <= 500),
  reviewed_by           uuid references public.profiles (id),
  reviewed_at           timestamptz,
  finder_confirmed_at   timestamptz,
  claimant_confirmed_at timestamptz,
  linked_report_id      uuid references public.reports (id) on delete set null, -- anúncio par, fechado junto
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index handovers_status_idx on public.handovers (status);
-- No máximo uma entrega em andamento por anúncio (o animal só pode ir para um tutor).
create unique index handovers_one_active_per_report on public.handovers (report_id)
  where status in ('under_review', 'approved');

create trigger handovers_touch_updated_at before update on public.handovers
for each row execute function public.touch_updated_at();

-- 1) Quem está com o animal envia a conversa para revisão.
create or replace function public.request_handover(p_conversation_id uuid)
returns public.handovers language plpgsql security definer set search_path = public as $$
declare
  c public.conversations;
  r public.reports;
  v_finder uuid;
  v_claimant uuid;
  v_transcript jsonb;
  h public.handovers;
begin
  select * into c from public.conversations where id = p_conversation_id;
  if not found then raise exception 'Conversa não encontrada.'; end if;
  select * into r from public.reports where id = c.report_id;
  if r.status <> 'open' then raise exception 'Este anúncio já foi encerrado.'; end if;

  if r.kind = 'found' then
    if r.custody <> 'with_finder' then
      raise exception 'Neste anúncio o animal só foi avistado; não há entrega para confirmar.';
    end if;
    v_finder := c.owner_id; v_claimant := c.asker_id;
  else
    if c.asker_context <> 'has_pet' then
      raise exception 'A entrega só existe quando quem respondeu está com o animal.';
    end if;
    v_finder := c.asker_id; v_claimant := c.owner_id;
  end if;

  if auth.uid() is distinct from v_finder then
    raise exception 'Somente quem está com o animal envia a conversa para revisão.';
  end if;
  if (select count(distinct sender_id) from public.messages where conversation_id = c.id) < 2 then
    raise exception 'A conversa precisa ter mensagens das duas pessoas antes da revisão.';
  end if;
  if exists (select 1 from public.handovers
             where report_id = r.id and conversation_id <> c.id and status in ('under_review', 'approved')) then
    raise exception 'Já existe uma entrega em andamento para este anúncio em outra conversa.';
  end if;

  select jsonb_agg(jsonb_build_object(
           'from', case when m.sender_id = v_finder then 'finder' else 'claimant' end,
           'body', m.body,
           'at',   m.created_at) order by m.created_at)
    into v_transcript
    from public.messages m where m.conversation_id = c.id;

  insert into public.handovers (conversation_id, report_id, finder_id, claimant_id, transcript)
  values (c.id, r.id, v_finder, v_claimant, v_transcript)
  on conflict (conversation_id) do update
    set transcript = excluded.transcript, status = 'under_review',
        admin_note = null, reviewed_by = null, reviewed_at = null
    where public.handovers.status = 'rejected'
  returning * into h;

  if h.id is null then
    raise exception 'Esta conversa já está em revisão ou com a entrega liberada.';
  end if;
  return h;
end $$;

-- 2) Admin aprova ou recusa a revisão.
create or replace function public.review_handover(p_handover_id uuid, p_approve boolean, p_note text default null)
returns public.handovers language plpgsql security definer set search_path = public as $$
declare
  h public.handovers;
begin
  if not public.is_admin() then raise exception 'Somente administradores revisam entregas.'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then
    raise exception 'Explique o motivo da recusa para as duas pessoas.';
  end if;
  if p_approve and exists (select 1 from public.handovers h2 join public.reports r on r.id = h2.report_id
                           where h2.id = p_handover_id and r.status <> 'open') then
    raise exception 'Este anúncio já foi encerrado; não há entrega para liberar.';
  end if;
  update public.handovers
     set status = case when p_approve then 'approved'::public.handover_status else 'rejected' end,
         admin_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_handover_id and status = 'under_review'
  returning * into h;
  if h.id is null then raise exception 'Esta revisão não está mais pendente.'; end if;
  return h;
end $$;

-- O mesmo animal costuma ter dois anúncios: o "perdido" do tutor e o "encontrado" de quem está com ele.
-- A entrega acontece na conversa de um deles; ao concluir, o par da outra pessoa também vira "reencontrado"
-- (senão continuaria aparecendo como animal à espera do dono). Par = anúncio aberto da outra pessoa, tipo
-- oposto, mesma espécie (e, se for "encontrado", com o animal com ela). Só fecha quando há exatamente um
-- candidato: com dois ou mais não dá para saber qual é o animal, e a pessoa encerra o certo à mão.
create or replace function public.close_linked_report(p_handover_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  h public.handovers;
  r public.reports;
  v_ids uuid[];
begin
  select * into h from public.handovers where id = p_handover_id;
  select * into r from public.reports where id = h.report_id;
  select array_agg(o.id) into v_ids
    from public.reports o
   where o.user_id = case when r.kind = 'lost' then h.finder_id else h.claimant_id end
     and o.kind <> r.kind and o.species = r.species and o.status = 'open'
     and (o.kind = 'lost' or o.custody = 'with_finder');
  if cardinality(v_ids) is distinct from 1 then return null; end if;
  update public.reports set status = 'reunited' where id = v_ids[1];
  update public.handovers set linked_report_id = v_ids[1] where id = p_handover_id;
  return v_ids[1];
end $$;
revoke execute on function public.close_linked_report(uuid) from public, anon, authenticated;

-- 3) Cada lado confirma; com as duas confirmações o anúncio (e o par, se houver) vira "reencontrado".
create or replace function public.confirm_handover(p_handover_id uuid)
returns public.handovers language plpgsql security definer set search_path = public as $$
declare
  h public.handovers;
begin
  select * into h from public.handovers where id = p_handover_id for update;
  if not found or auth.uid() not in (h.finder_id, h.claimant_id) then
    raise exception 'Entrega não encontrada.';
  end if;
  if h.status = 'completed' then return h; end if;
  if h.status <> 'approved' then
    raise exception 'A entrega ainda não foi liberada por um administrador.';
  end if;
  perform 1 from public.reports where id = h.report_id and status = 'open' for update;
  if not found then
    raise exception 'Este anúncio já foi encerrado; a entrega não pode mais ser confirmada.';
  end if;

  update public.handovers
     set finder_confirmed_at   = case when auth.uid() = finder_id   then coalesce(finder_confirmed_at, now())   else finder_confirmed_at end,
         claimant_confirmed_at = case when auth.uid() = claimant_id then coalesce(claimant_confirmed_at, now()) else claimant_confirmed_at end
   where id = p_handover_id
  returning * into h;

  if h.finder_confirmed_at is not null and h.claimant_confirmed_at is not null then
    update public.handovers set status = 'completed' where id = p_handover_id returning * into h;
    update public.reports set status = 'reunited' where id = h.report_id;
    perform public.close_linked_report(h.id);
    select * into h from public.handovers where id = p_handover_id;
  end if;
  return h;
end $$;

revoke execute on function public.request_handover(uuid)                 from public, anon;
revoke execute on function public.review_handover(uuid, boolean, text)   from public, anon;
revoke execute on function public.confirm_handover(uuid)                 from public, anon;
grant  execute on function public.request_handover(uuid)                 to authenticated;
grant  execute on function public.review_handover(uuid, boolean, text)   to authenticated;
grant  execute on function public.confirm_handover(uuid)                 to authenticated;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.profiles      enable row level security;
alter table public.reports       enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.handovers     enable row level security;

-- Perfis: nomes visíveis para quem tem conta; cada um edita só o próprio nome (papel nunca).
create policy "profiles: autenticado lê" on public.profiles for select to authenticated using (true);
create policy "profiles: edita o próprio" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Anúncios: público vê só aprovados; dono vê os seus; admin vê tudo.
create policy "reports: leitura" on public.reports for select to anon, authenticated
  using (review_status = 'approved' or user_id = auth.uid() or public.is_admin());
create policy "reports: dono cria" on public.reports for insert to authenticated
  with check (user_id = auth.uid());
create policy "reports: dono ou admin edita" on public.reports for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy "reports: dono ou admin exclui" on public.reports for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Conversas e mensagens: só as duas pessoas (e admin, para moderação).
create policy "conversations: participantes leem" on public.conversations for select to authenticated
  using (auth.uid() in (asker_id, owner_id) or public.is_admin());
create policy "conversations: autenticado inicia" on public.conversations for insert to authenticated
  with check (asker_id = auth.uid());

create policy "messages: participantes leem" on public.messages for select to authenticated
  using (public.is_participant(conversation_id) or public.is_admin());
create policy "messages: participante envia" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_participant(conversation_id));

-- Entregas: leitura pelos envolvidos e admin; escrita só pelas funções acima.
create policy "handovers: envolvidos leem" on public.handovers for select to authenticated
  using (auth.uid() in (finder_id, claimant_id) or public.is_admin());

-- Tempo real para o chat e para o andamento da entrega
alter publication supabase_realtime add table public.messages, public.handovers;

-- ===========================================================================
-- Storage: fotos (leitura pública, upload na pasta do próprio usuário)
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pet-photos', 'pet-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "pet-photos: upload na própria pasta" on storage.objects for insert to authenticated
  with check (bucket_id = 'pet-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "pet-photos: dono ou admin exclui" on storage.objects for delete to authenticated
  using (bucket_id = 'pet-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ===========================================================================
-- Tornar alguém administrador (rode depois que a pessoa criar a conta):
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'seu-email@exemplo.com');
-- ===========================================================================

-- ===========================================================================
-- RESET (só se você já rodou a v1). Descomente, execute, e depois rode o arquivo inteiro.
-- ===========================================================================
-- drop table if exists public.report_contacts, public.handovers, public.messages, public.conversations, public.reports, public.profiles cascade;
-- drop function if exists public.touch_updated_at, public.is_admin, public.handle_new_user, public.reports_guard,
--   public.conversations_before_insert, public.is_participant, public.messages_after_insert,
--   public.request_handover, public.review_handover, public.close_linked_report, public.confirm_handover cascade;
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop type if exists public.user_role, public.report_kind, public.species, public.pet_size, public.pet_sex,
--   public.report_status, public.review_status, public.custody, public.asker_context, public.handover_status cascade;
-- drop policy if exists "pet-photos: upload na própria pasta" on storage.objects;
-- drop policy if exists "pet-photos: dono exclui" on storage.objects;
-- drop policy if exists "pet-photos: dono ou admin exclui" on storage.objects;
