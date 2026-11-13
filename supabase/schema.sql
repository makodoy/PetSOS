-- PetSOS: schema do banco (Supabase / PostgreSQL) — v3 com publicação imediata para e-mail confirmado, conversas,
-- entrega com dupla confirmação, denúncias, bloqueios, avisos e expiração de anúncios.
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
create type public.handover_status as enum ('under_review', 'approved', 'rejected', 'completed'); -- under_review: só em entregas antigas
create type public.flag_status     as enum ('open', 'resolved');
create type public.notification_kind as enum ('message', 'match', 'area_alert', 'report_rejected', 'expiring', 'moderation', 'handover');

-- ===========================================================================
-- Perfis e papéis
-- ===========================================================================
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  role         public.user_role not null default 'user',
  email_alerts boolean not null default true,
  created_at   timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- E-mail confirmado libera a publicação imediata. Sem confirmação, o anúncio espera a moderação.
create or replace function public.email_confirmed()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null);
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
  thumb_path    text,
  neighborhood  text not null check (char_length(neighborhood) between 2 and 80),
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  event_date    date not null,
  status        public.report_status not null default 'open',
  review_status public.review_status not null default 'pending',
  review_note   text check (char_length(review_note) <= 500),
  reviewed_at   timestamptz,                                 -- nulo em anúncio publicado: ainda na fila de revisão posterior
  reviewed_by   uuid references public.profiles (id) on delete set null,
  has_owner     boolean generated always as (user_id is not null) stored, -- visitantes não leem user_id
  expires_at    timestamptz not null default now() + interval '60 days',
  matched_at    timestamptz,                                 -- nulo: api/notify ainda não comparou este anúncio
  expiry_warned_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((kind = 'found') = (custody is not null))
);

create index reports_match_idx   on public.reports (species, kind, status, review_status, event_date);
create index reports_created_idx on public.reports (created_at desc);
create index reports_user_idx    on public.reports (user_id);
create index reports_review_idx  on public.reports (review_status) where review_status = 'pending';
create index reports_public_idx  on public.reports (created_at desc) where review_status = 'approved' and status = 'open';
create index reports_unreviewed_idx on public.reports (created_at) where review_status = 'approved' and reviewed_at is null;
create index reports_unmatched_idx  on public.reports (created_at) where review_status = 'approved' and status = 'open' and matched_at is null;
create index reports_expiry_idx  on public.reports (expires_at) where status = 'open';

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
--  * a data do acontecimento não pode estar no futuro e as fotos só podem vir da pasta de quem anunciou;
--  * no máximo 10 anúncios por conta em 24 horas;
--  * anúncio novo é publicado na hora com e-mail confirmado (e entra na revisão posterior); sem confirmação, fica pendente;
--  * usuário comum não altera moderação e só pode mudar status de "aberto" para "encerrado";
--  * ninguém altera datas de controle (criação, validade), para não fixar um anúncio no topo da lista;
--  * tipo, espécie e situação (está comigo / só vi) não mudam depois de criado: decidem quem pode pedir entrega;
--  * outra mudança de conteúdo volta para a revisão; anúncio recusado ou de e-mail não confirmado volta para "pendente";
--  * "reencontrado" só é gravado pela função confirm_handover (dupla confirmação).
-- Funções security definer e o SQL Editor rodam como owner (não anon/authenticated) e passam direto.
create or replace function public.reports_guard()
returns trigger language plpgsql as $$
declare
  v_admin boolean;
  v_folder text;
begin
  new.lat := round(new.lat::numeric, 3);
  new.lng := round(new.lng::numeric, 3);
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if (tg_op = 'INSERT' or new.event_date is distinct from old.event_date)
     and new.event_date > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'A data não pode estar no futuro.';
  end if;
  v_folder := new.user_id::text || '/';
  if (new.photo_path is not null and left(new.photo_path, length(v_folder)) <> v_folder)
     or (new.thumb_path is not null and left(new.thumb_path, length(v_folder)) <> v_folder) then
    raise exception 'A foto precisa ser enviada pela própria conta.';
  end if;

  if tg_op = 'INSERT' then
    if (select count(*) from public.reports where user_id = new.user_id and created_at > now() - interval '24 hours') >= 10 then
      raise exception 'Limite de 10 anúncios em 24 horas atingido. Tente de novo amanhã.';
    end if;
    new.review_status    := case when public.email_confirmed() then 'approved'::public.review_status else 'pending' end;
    new.review_note      := null;
    new.reviewed_at      := null;
    new.reviewed_by      := null;
    new.status           := 'open';
    new.created_at       := now();
    new.expires_at       := now() + interval '60 days';
    new.matched_at       := null;
    new.expiry_warned_at := null;
    return new;
  end if;

  v_admin := public.is_admin();
  new.created_at       := old.created_at;
  new.expires_at       := old.expires_at;
  new.matched_at       := old.matched_at;
  new.expiry_warned_at := old.expiry_warned_at;
  if new.status is distinct from old.status and not (old.status = 'open' and new.status = 'closed') then
    raise exception 'O anúncio só é marcado como reencontrado após a confirmação de entrega das duas pessoas.';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'Não é possível transferir o anúncio.';
  end if;
  if (new.kind, new.species, new.custody) is distinct from (old.kind, old.species, old.custody) then
    raise exception 'Tipo, espécie e situação do animal não podem ser alterados. Exclua e anuncie de novo.';
  end if;
  if v_admin then
    if (new.review_status, new.review_note, new.reviewed_at) is distinct from (old.review_status, old.review_note, old.reviewed_at) then
      new.reviewed_at := now();
      new.reviewed_by := auth.uid();
    end if;
    return new;
  end if;
  if (new.review_status, new.review_note, new.reviewed_at, new.reviewed_by)
     is distinct from (old.review_status, old.review_note, old.reviewed_at, old.reviewed_by) then
    raise exception 'Somente administradores aprovam ou recusam anúncios.';
  end if;
  if (new.pet_name, new.sex, new.size, new.colors, new.breed, new.description, new.photo_path, new.thumb_path,
      new.neighborhood, new.lat, new.lng, new.event_date)
     is distinct from
     (old.pet_name, old.sex, old.size, old.colors, old.breed, old.description, old.photo_path, old.thumb_path,
      old.neighborhood, old.lat, old.lng, old.event_date) then
    new.matched_at  := null;
    new.reviewed_at := null;
    new.reviewed_by := null;
    if old.review_status = 'rejected' or not public.email_confirmed() then
      new.review_status := 'pending';
      new.review_note   := null;
    end if;
  end if;
  return new;
end $$;

create trigger reports_guard before insert or update on public.reports
for each row execute function public.reports_guard();

-- Dono renova o anúncio por mais 60 dias. Anúncio vencido sai da lista até ser renovado.
create or replace function public.renew_report(p_report_id uuid)
returns public.reports language plpgsql security definer set search_path = public as $$
declare
  r public.reports;
begin
  update public.reports
     set expires_at = now() + interval '60 days', expiry_warned_at = null
   where id = p_report_id and user_id = auth.uid() and status = 'open'
  returning * into r;
  if r.id is null then raise exception 'Este anúncio não pode ser renovado.'; end if;
  return r;
end $$;

-- Fotos saem do Storage por api/notify: o banco não apaga arquivos, mas registra o que ficou sem anúncio,
-- inclusive na exclusão em cascata de uma conta.
create table public.photo_deletions (
  path      text primary key,
  queued_at timestamptz not null default now()
);

create or replace function public.reports_queue_photos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.photo_deletions (path)
  select p from unnest(array[old.photo_path, old.thumb_path]) as p
   where p is not null
     and (tg_op = 'DELETE' or p is distinct from new.photo_path and p is distinct from new.thumb_path)
  on conflict do nothing;
  return null;
end $$;

create trigger reports_queue_photos after delete or update of photo_path, thumb_path on public.reports
for each row execute function public.reports_queue_photos();

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

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

create or replace function public.is_blocked(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks
                  where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a));
$$;

-- owner_id vem do anúncio (não do navegador) e o contexto precisa combinar com o tipo do anúncio.
create or replace function public.conversations_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r public.reports;
begin
  select * into r from public.reports where id = new.report_id;
  if not found or r.review_status <> 'approved' or r.status <> 'open' or r.user_id is null or r.expires_at < now() then
    raise exception 'Este anúncio não está disponível para conversa.';
  end if;
  new.owner_id := r.user_id;
  if public.is_blocked(new.asker_id, new.owner_id) then
    raise exception 'Não é possível iniciar esta conversa.';
  end if;
  if (select count(*) from public.conversations where asker_id = new.asker_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Limite de 20 conversas novas em 24 horas atingido. Tente de novo amanhã.';
  end if;
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
create index messages_sender_idx on public.messages (sender_id, created_at);

create or replace function public.is_participant(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations
    where id = p_conversation_id and auth.uid() in (asker_id, owner_id)
  );
$$;

create or replace function public.messages_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.conversations;
begin
  select * into c from public.conversations where id = new.conversation_id;
  if public.is_blocked(c.asker_id, c.owner_id) then
    raise exception 'Esta conversa foi bloqueada.';
  end if;
  if (select count(*) from public.messages where sender_id = new.sender_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um minuto e tente de novo.';
  end if;
  return new;
end $$;

create trigger messages_before_insert before insert on public.messages
for each row execute function public.messages_before_insert();

-- Avisos: dentro do site e na fila de e-mail de api/notify. O texto da mensagem não vai no aviso.
create table public.notifications (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            public.notification_kind not null,
  report_id       uuid references public.reports (id) on delete cascade,
  other_report_id uuid references public.reports (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  body            text not null check (char_length(body) <= 300),
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  emailed_at      timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index notifications_outbox_idx on public.notifications (created_at) where emailed_at is null;

create or replace function public.report_label(r public.reports)
returns text language sql stable as $$
  select coalesce(r.pet_name, case r.kind when 'lost' then 'animal perdido' else 'animal encontrado' end) || ' (' || r.neighborhood || ')';
$$;

-- Administradores recebem um aviso até abrirem a moderação (não um por item da fila).
create or replace function public.notify_admins(p_body text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, body)
  select p.id, 'moderation', p_body from public.profiles p
   where p.role = 'admin'
     and not exists (select 1 from public.notifications n where n.user_id = p.id and n.kind = 'moderation' and n.read_at is null);
$$;
revoke execute on function public.notify_admins(text) from public, anon, authenticated;

create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.conversations;
  r public.reports;
  v_to uuid;
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id returning * into c;
  select * into r from public.reports where id = c.report_id;
  v_to := case when new.sender_id = c.asker_id then c.owner_id else c.asker_id end;
  insert into public.notifications (user_id, kind, report_id, conversation_id, body)
  select v_to, 'message', r.id, c.id, 'Nova mensagem sobre ' || public.report_label(r)
   where new.sender_id in (c.asker_id, c.owner_id)
     and not exists (select 1 from public.notifications n
                      where n.user_id = v_to and n.conversation_id = c.id and n.kind = 'message' and n.read_at is null);
  return new;
end $$;

create trigger messages_after_insert after insert on public.messages
for each row execute function public.messages_after_insert();

-- Conversa e primeira mensagem na mesma transação: se a mensagem falhar, não sobra conversa vazia.
create or replace function public.start_conversation(p_report_id uuid, p_context public.asker_context, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Entre na sua conta para enviar mensagem.'; end if;
  if (select user_id from public.reports where id = p_report_id) = auth.uid() then
    raise exception 'Este anúncio é seu.';
  end if;
  select id into v_id from public.conversations where report_id = p_report_id and asker_id = auth.uid();
  if v_id is null then
    insert into public.conversations (report_id, asker_id, asker_context)
    values (p_report_id, auth.uid(), p_context) returning id into v_id;
  end if;
  insert into public.messages (conversation_id, sender_id, body) values (v_id, auth.uid(), p_body);
  return v_id;
end $$;

-- ===========================================================================
-- Entrega: quem está com o animal inicia, os dois lados confirmam; admin só intervém se houver denúncia
-- ===========================================================================
create table public.handovers (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null unique references public.conversations (id) on delete cascade,
  report_id             uuid not null references public.reports (id) on delete cascade,
  finder_id             uuid not null references public.profiles (id) on delete cascade, -- está com o animal
  claimant_id           uuid not null references public.profiles (id) on delete cascade, -- tutor
  status                public.handover_status not null default 'approved',
  transcript            jsonb not null,            -- cópia congelada da conversa, para eventual denúncia
  admin_note            text check (char_length(admin_note) <= 500),
  reviewed_by           uuid references public.profiles (id) on delete set null,
  reviewed_at           timestamptz,
  finder_confirmed_at   timestamptz,
  claimant_confirmed_at timestamptz,
  linked_report_id      uuid references public.reports (id) on delete set null, -- anúncio par, fechado junto
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index handovers_status_idx on public.handovers (status);
create index handovers_finder_idx on public.handovers (finder_id);
create index handovers_claimant_idx on public.handovers (claimant_id);
-- No máximo uma entrega em andamento por anúncio (o animal só pode ir para um tutor).
create unique index handovers_one_active_per_report on public.handovers (report_id)
  where status in ('under_review', 'approved');

create trigger handovers_touch_updated_at before update on public.handovers
for each row execute function public.touch_updated_at();

-- 1) Quem está com o animal inicia a entrega.
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
    raise exception 'Somente quem está com o animal inicia a entrega.';
  end if;
  if (select count(distinct sender_id) from public.messages where conversation_id = c.id) < 2 then
    raise exception 'A conversa precisa ter mensagens das duas pessoas antes da entrega.';
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
    set transcript = excluded.transcript, status = 'approved', admin_note = null, reviewed_by = null, reviewed_at = null,
        finder_confirmed_at = null, claimant_confirmed_at = null
    where public.handovers.status = 'rejected'
  returning * into h;

  if h.id is null then
    raise exception 'Esta conversa já tem uma entrega em andamento.';
  end if;
  return h;
end $$;

-- 2) Se houver denúncia, o admin cancela a entrega. Quem está com o animal pode iniciar de novo depois.
create or replace function public.cancel_handover(p_handover_id uuid, p_note text)
returns public.handovers language plpgsql security definer set search_path = public as $$
declare
  h public.handovers;
begin
  if not public.is_admin() then raise exception 'Somente administradores cancelam entregas.'; end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'Explique o motivo do cancelamento para as duas pessoas.';
  end if;
  update public.handovers
     set status = 'rejected', admin_note = trim(p_note), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_handover_id and status in ('under_review', 'approved')
  returning * into h;
  if h.id is null then raise exception 'Esta entrega não está mais em andamento.'; end if;
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
    raise exception 'Esta entrega foi cancelada e não pode ser confirmada.';
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

create or replace function public.handovers_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_label text;
begin
  select public.report_label(r) into v_label from public.reports r where r.id = new.report_id;
  if tg_op = 'INSERT' or (new.status = 'approved' and old.status = 'rejected') then
    insert into public.notifications (user_id, kind, report_id, conversation_id, body)
    values (new.claimant_id, 'handover', new.report_id, new.conversation_id, 'Entrega iniciada: ' || v_label);
  elsif new.status = 'completed' and old.status <> 'completed' then
    insert into public.notifications (user_id, kind, report_id, conversation_id, body)
    select u, 'handover', new.report_id, new.conversation_id, 'Entrega concluída: ' || v_label
      from unnest(array[new.finder_id, new.claimant_id]) as u;
  elsif new.status = 'rejected' and old.status <> 'rejected' then
    insert into public.notifications (user_id, kind, report_id, conversation_id, body)
    select u, 'handover', new.report_id, new.conversation_id, 'Entrega cancelada pela moderação: ' || v_label
      from unnest(array[new.finder_id, new.claimant_id]) as u;
  elsif new.finder_confirmed_at is not null and old.finder_confirmed_at is null and new.status = 'approved' then
    insert into public.notifications (user_id, kind, report_id, conversation_id, body)
    values (new.claimant_id, 'handover', new.report_id, new.conversation_id, 'A outra pessoa confirmou a entrega: ' || v_label);
  elsif new.claimant_confirmed_at is not null and old.claimant_confirmed_at is null and new.status = 'approved' then
    insert into public.notifications (user_id, kind, report_id, conversation_id, body)
    values (new.finder_id, 'handover', new.report_id, new.conversation_id, 'A outra pessoa confirmou o recebimento: ' || v_label);
  end if;
  return null;
end $$;

create trigger handovers_notify after insert or update on public.handovers
for each row execute function public.handovers_notify();

create or replace function public.reports_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.review_status = 'rejected' and new.user_id is not null
     and (tg_op = 'INSERT' or old.review_status <> 'rejected') then
    insert into public.notifications (user_id, kind, report_id, body)
    values (new.user_id, 'report_rejected', new.id, 'Anúncio recusado: ' || public.report_label(new));
  end if;
  if new.status = 'open' and (new.review_status = 'pending' or (new.review_status = 'approved' and new.reviewed_at is null))
     and (tg_op = 'INSERT' or old.reviewed_at is not null or old.review_status is distinct from new.review_status) then
    perform public.notify_admins('Há anúncios aguardando revisão.');
  end if;
  return null;
end $$;

-- Sem lista de colunas: o reports_guard muda reviewed_at numa edição comum, e "update of" só olha o que o cliente enviou.
create trigger reports_notify after insert or update on public.reports
for each row execute function public.reports_notify();

-- Denúncias de anúncio ou de conversa: vão para a fila do admin. Uma por pessoa e por item.
create table public.flags (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid references public.profiles (id) on delete set null default auth.uid(),
  report_id       uuid references public.reports (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  reason          text not null check (char_length(trim(reason)) between 3 and 500),
  status          public.flag_status not null default 'open',
  resolved_by     uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (num_nonnulls(report_id, conversation_id) = 1),
  unique (reporter_id, report_id),
  unique (reporter_id, conversation_id)
);
create index flags_open_idx on public.flags (created_at) where status = 'open';

create or replace function public.flags_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_admins('Há denúncias aguardando análise.');
  return null;
end $$;

create trigger flags_notify after insert on public.flags
for each row execute function public.flags_notify();

-- Comparação de anúncios feita por api/notify e resposta do dono ("Não é este").
create table public.matches (
  report_id       uuid not null references public.reports (id) on delete cascade,
  other_report_id uuid not null references public.reports (id) on delete cascade,
  score           numeric(4, 3) not null,
  created_at      timestamptz not null default now(),
  primary key (report_id, other_report_id)
);
create index matches_other_idx on public.matches (other_report_id);

create table public.match_feedback (
  user_id         uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  report_id       uuid not null references public.reports (id) on delete cascade,
  other_report_id uuid not null references public.reports (id) on delete cascade,
  same_animal     boolean not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, report_id, other_report_id)
);
create index match_feedback_report_idx on public.match_feedback (report_id);
create index match_feedback_other_idx on public.match_feedback (other_report_id);

-- Alerta opcional: avisa quando sair anúncio no bairro escolhido.
create table public.area_alerts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  neighborhood text not null check (char_length(trim(neighborhood)) between 2 and 80),
  created_at   timestamptz not null default now(),
  unique (user_id, neighborhood)
);

-- Exclui a conta e, em cascata, anúncios, conversas e mensagens; as fotos vão para photo_deletions.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Entre na sua conta para excluí-la.'; end if;
  delete from auth.users where id = auth.uid();
end $$;

create or replace function public.admin_metrics()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Somente administradores veem os indicadores.'; end if;
  return jsonb_build_object(
    'open_reports', (select count(*) from public.reports where status = 'open' and review_status = 'approved' and expires_at > now()),
    'reunions_30d', (select count(*) from public.handovers where status = 'completed' and updated_at > now() - interval '30 days'),
    'median_days', (select round(percentile_cont(0.5) within group (order by extract(epoch from h.updated_at - r.created_at) / 86400)::numeric, 1)
                      from public.handovers h join public.reports r on r.id = h.report_id where h.status = 'completed')
  );
end $$;

revoke execute on function public.request_handover(uuid)                 from public, anon;
revoke execute on function public.cancel_handover(uuid, text)            from public, anon;
revoke execute on function public.confirm_handover(uuid)                 from public, anon;
revoke execute on function public.renew_report(uuid)                     from public, anon;
revoke execute on function public.start_conversation(uuid, public.asker_context, text) from public, anon;
revoke execute on function public.delete_my_account()                    from public, anon;
revoke execute on function public.admin_metrics()                        from public, anon;
grant  execute on function public.request_handover(uuid)                 to authenticated;
grant  execute on function public.cancel_handover(uuid, text)            to authenticated;
grant  execute on function public.confirm_handover(uuid)                 to authenticated;
grant  execute on function public.renew_report(uuid)                     to authenticated;
grant  execute on function public.start_conversation(uuid, public.asker_context, text) to authenticated;
grant  execute on function public.delete_my_account()                    to authenticated;
grant  execute on function public.admin_metrics()                        to authenticated;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.profiles      enable row level security;
alter table public.reports       enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.handovers     enable row level security;
alter table public.blocks        enable row level security;
alter table public.notifications enable row level security;
alter table public.flags         enable row level security;
alter table public.matches       enable row level security;
alter table public.match_feedback enable row level security;
alter table public.area_alerts   enable row level security;
alter table public.photo_deletions enable row level security; -- só api/notify (service role)

-- (select ...) em volta de auth.uid() e is_admin(): calcula uma vez por consulta, não uma vez por linha.

-- Perfis: nomes visíveis para quem tem conta; cada um edita só o próprio nome e preferência (papel nunca).
create policy "profiles: autenticado lê" on public.profiles for select to authenticated using (true);
create policy "profiles: edita o próprio" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (display_name, email_alerts) on public.profiles to authenticated;

-- Anúncios: público vê só aprovados; dono vê os seus; admin vê tudo. Visitante não lê quem anunciou (user_id).
create policy "reports: leitura" on public.reports for select to anon, authenticated
  using (review_status = 'approved' or user_id = (select auth.uid()) or (select public.is_admin()));
create policy "reports: dono cria" on public.reports for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "reports: dono ou admin edita" on public.reports for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "reports: dono ou admin exclui" on public.reports for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.reports from anon;
grant select (id, kind, species, custody, pet_name, sex, size, colors, breed, description, photo_path, thumb_path, neighborhood,
              lat, lng, event_date, status, review_status, has_owner, expires_at, created_at, updated_at) on public.reports to anon;

-- Conversas e mensagens: só as duas pessoas (e admin, para moderação).
create policy "conversations: participantes leem" on public.conversations for select to authenticated
  using ((select auth.uid()) in (asker_id, owner_id) or (select public.is_admin()));
create policy "conversations: autenticado inicia" on public.conversations for insert to authenticated
  with check (asker_id = (select auth.uid()));

create policy "messages: participantes leem" on public.messages for select to authenticated
  using (public.is_participant(conversation_id) or (select public.is_admin()));
create policy "messages: participante envia" on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.is_participant(conversation_id));

-- Entregas: leitura pelos envolvidos e admin; escrita só pelas funções acima.
create policy "handovers: envolvidos leem" on public.handovers for select to authenticated
  using ((select auth.uid()) in (finder_id, claimant_id) or (select public.is_admin()));

-- Bloqueios: cada pessoa vê e muda só os próprios.
create policy "blocks: dono lê" on public.blocks for select to authenticated using (blocker_id = (select auth.uid()));
create policy "blocks: dono cria" on public.blocks for insert to authenticated with check (blocker_id = (select auth.uid()));
create policy "blocks: dono remove" on public.blocks for delete to authenticated using (blocker_id = (select auth.uid()));

-- Avisos: cada pessoa lê os seus e só marca como lido.
create policy "notifications: dono lê" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "notifications: dono marca lido" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Denúncias: quem denuncia só vê as próprias; conversa só pode ser denunciada por quem participa dela.
create policy "flags: autor ou admin lê" on public.flags for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.is_admin()));
create policy "flags: autenticado denuncia" on public.flags for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open'
              and (conversation_id is null or public.is_participant(conversation_id)));
create policy "flags: admin resolve" on public.flags for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Parecidos: só o dono do anúncio lê (a escrita é de api/notify) e responde.
create policy "matches: dono lê" on public.matches for select to authenticated
  using (exists (select 1 from public.reports r where r.id = report_id and r.user_id = (select auth.uid())));
create policy "match_feedback: dono lê" on public.match_feedback for select to authenticated using (user_id = (select auth.uid()));
create policy "match_feedback: dono responde" on public.match_feedback for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.reports r where r.id = report_id and r.user_id = (select auth.uid())));
create policy "match_feedback: dono muda resposta" on public.match_feedback for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "area_alerts: dono lê" on public.area_alerts for select to authenticated using (user_id = (select auth.uid()));
create policy "area_alerts: dono cria" on public.area_alerts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "area_alerts: dono remove" on public.area_alerts for delete to authenticated using (user_id = (select auth.uid()));

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
-- drop table if exists public.area_alerts, public.match_feedback, public.matches, public.flags, public.notifications, public.blocks, public.photo_deletions, public.report_contacts, public.handovers, public.messages, public.conversations, public.reports, public.profiles cascade;
-- drop function if exists public.touch_updated_at, public.is_admin, public.handle_new_user, public.reports_guard,
--   public.conversations_before_insert, public.is_participant, public.messages_after_insert,
--   public.request_handover, public.review_handover, public.cancel_handover, public.close_linked_report, public.confirm_handover,
--   public.email_confirmed, public.renew_report, public.reports_queue_photos, public.is_blocked, public.messages_before_insert,
--   public.report_label, public.notify_admins, public.start_conversation, public.handovers_notify, public.reports_notify,
--   public.flags_notify, public.delete_my_account, public.admin_metrics cascade;
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop type if exists public.user_role, public.report_kind, public.species, public.pet_size, public.pet_sex,
--   public.report_status, public.review_status, public.custody, public.asker_context, public.handover_status,
--   public.flag_status, public.notification_kind cascade;
-- drop policy if exists "pet-photos: upload na própria pasta" on storage.objects;
-- drop policy if exists "pet-photos: dono exclui" on storage.objects;
-- drop policy if exists "pet-photos: dono ou admin exclui" on storage.objects;
