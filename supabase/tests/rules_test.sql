-- Testes das regras do banco (RLS, gatilhos e funções de entrega), papel por papel.
-- Cada bloco troca de usuário com t.as_user() e falha com exceção se a regra não valer.

create schema t;
grant usage on schema t to anon, authenticated;

-- Troca o papel (anon/authenticated) e o usuário do JWT simulado.
create procedure t.as_user(p_role text, p_uid uuid default null) language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), false);
  execute format('set role %I', p_role);
end $$;

-- Executa o SQL e exige um erro cuja mensagem contenha p_expected.
create function t.expect_error(p_sql text, p_expected text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FALHOU: era esperado erro "%" em: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'FALHOU:%' then raise; end if;
  if position(p_expected in sqlerrm) = 0 then
    raise exception 'FALHOU: erro diferente em "%": % (esperado "%")', p_sql, sqlerrm, p_expected;
  end if;
end $$;

create function t.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FALHOU: %', p_what; end if;
  raise notice 'ok: %', p_what;
end $$;
grant execute on all functions in schema t to anon, authenticated;
grant execute on all procedures in schema t to anon, authenticated;

-- IDs fixos para os testes guardados em tabela (DO blocks não compartilham variáveis).
create table t.ids (name text primary key, id uuid not null);
grant select, insert on t.ids to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pessoas: admin, Alice (tutora), Bob e Carol (dizem estar com o animal)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@x.com', '{"display_name":"Admin"}'),
  ('00000000-0000-0000-0000-000000000001', 'alice@x.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000002', 'bob@x.com',   '{}'),
  ('00000000-0000-0000-0000-000000000003', 'carol@x.com', '{"display_name":"Carol"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000a';

select t.ok((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000002') = 'bob',
            'perfil criado no cadastro, nome padrão vem do e-mail');
select t.ok((select count(*) = 8 and bool_and(lat = round(lat::numeric, 3)) from public.reports),
            'seed carregado com localização arredondada');

-- ---------------------------------------------------------------------------
-- Anúncio: criação, moderação, edição
-- ---------------------------------------------------------------------------
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
do $$
declare r public.reports;
begin
  insert into public.reports (kind, species, sex, size, colors, neighborhood, lat, lng, event_date, review_status, status)
  values ('lost', 'dog', 'male', 'medium', '{caramelo}', 'Centro', -23.587234, -48.041891, current_date, 'approved', 'reunited')
  returning * into r;
  insert into t.ids values ('lost1', r.id);
  perform t.ok(r.review_status = 'pending' and r.status = 'open', 'anúncio novo nasce pendente e aberto, mesmo se o navegador pedir outra coisa');
  perform t.ok(r.lat = -23.587 and r.lng = -48.042, 'ponto exato não é gravado (arredondado para 3 casas)');
  perform t.expect_error(format($q$update public.reports set review_status = 'approved' where id = %L$q$, r.id),
                         'Somente administradores');
  perform t.ok(true, 'dono não aprova o próprio anúncio');
end $$;

call t.as_user('anon');
select t.ok((select count(*) from public.reports where id = (select id from t.ids where name = 'lost1')) = 0,
            'visitante não vê anúncio pendente');

call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
update public.reports set review_status = 'approved' where id = (select id from t.ids where name = 'lost1');

call t.as_user('anon');
select t.ok((select count(*) from public.reports where id = (select id from t.ids where name = 'lost1')) = 1,
            'visitante vê anúncio aprovado');

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
do $$
declare v_id uuid := (select id from t.ids where name = 'lost1');
begin
  update public.reports set description = 'Agora com texto ofensivo' where id = v_id;
  perform t.ok((select review_status from public.reports where id = v_id) = 'pending',
               'editar conteúdo depois de aprovado volta para moderação');
  perform t.expect_error(format($q$update public.reports set species = 'cat' where id = %L$q$, v_id), 'não podem ser alterados');
  perform t.expect_error(format($q$update public.reports set kind = 'found', custody = 'with_finder' where id = %L$q$, v_id), 'não podem ser alterados');
  perform t.ok(true, 'dono não muda tipo, espécie ou situação');
  perform t.expect_error(format($q$update public.reports set status = 'reunited' where id = %L$q$, v_id), 'reencontrado');
  perform t.ok(true, 'dono não marca reencontrado direto');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
update public.reports set review_status = 'approved' where id = (select id from t.ids where name = 'lost1');

-- ---------------------------------------------------------------------------
-- Perfis e escrita direta em handovers
-- ---------------------------------------------------------------------------
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
begin
  perform t.expect_error($q$update public.profiles set role = 'admin' where id = auth.uid()$q$, 'permission denied');
  perform t.ok(true, 'usuário não se promove a admin');
  perform t.expect_error(format($q$insert into public.handovers (conversation_id, report_id, finder_id, claimant_id, transcript)
                                  values (gen_random_uuid(), %L, auth.uid(), auth.uid(), '[]')$q$,
                                (select id from t.ids where name = 'lost1')), 'row-level security');
  perform t.ok(true, 'navegador não grava em handovers');
end $$;

-- ---------------------------------------------------------------------------
-- Entrega: duas pessoas dizem estar com o mesmo animal
-- ---------------------------------------------------------------------------
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare c public.conversations;
begin
  insert into public.conversations (report_id, owner_id, asker_context)
  values ((select id from t.ids where name = 'lost1'), auth.uid(), 'has_pet') returning * into c;
  insert into t.ids values ('conv_bob', c.id);
  perform t.ok(c.owner_id = '00000000-0000-0000-0000-000000000001', 'owner_id vem do anúncio, não do navegador');
  insert into public.messages (conversation_id, body) values (c.id, 'Está comigo, coleira vermelha.');
  perform t.expect_error(format('select public.request_handover(%L)', c.id), 'mensagens das duas pessoas');
  perform t.ok(true, 'revisão exige mensagens dos dois lados');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$
declare c public.conversations;
begin
  insert into public.conversations (report_id, owner_id, asker_context)
  values ((select id from t.ids where name = 'lost1'), auth.uid(), 'has_pet') returning * into c;
  insert into t.ids values ('conv_carol', c.id);
  insert into public.messages (conversation_id, body) values (c.id, 'Acho que está comigo também.');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
insert into public.messages (conversation_id, body)
  select id, 'Tem uma cicatriz na orelha?' from t.ids where name in ('conv_bob', 'conv_carol');
do $$ begin
  perform t.expect_error(format('select public.request_handover(%L)', (select id from t.ids where name = 'conv_bob')),
                         'Somente quem está com o animal');
  perform t.ok(true, 'tutora não envia a revisão no lugar de quem está com o animal');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare h public.handovers;
begin
  h := public.request_handover((select id from t.ids where name = 'conv_bob'));
  insert into t.ids values ('h_bob', h.id);
  perform t.ok(h.status = 'under_review' and jsonb_array_length(h.transcript) = 2, 'conversa enviada com cópia congelada');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format('select public.request_handover(%L)', (select id from t.ids where name = 'conv_carol')),
                         'Já existe uma entrega em andamento');
  perform t.ok(true, 'só uma entrega em andamento por anúncio');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$ begin
  perform t.expect_error(format('select public.confirm_handover(%L)', (select id from t.ids where name = 'h_bob')),
                         'ainda não foi liberada');
  perform t.ok(true, 'não confirma antes do admin liberar');
  perform t.expect_error(format('select public.review_handover(%L, true)', (select id from t.ids where name = 'h_bob')),
                         'Somente administradores');
  perform t.ok(true, 'usuário comum não libera entrega');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
do $$
declare v_h uuid := (select id from t.ids where name = 'h_bob');
begin
  perform t.expect_error(format('select public.review_handover(%L, false)', v_h), 'motivo da recusa');
  perform t.ok(true, 'recusa exige motivo');
  perform t.ok((public.review_handover(v_h, true)).status = 'approved', 'admin libera a entrega');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
select t.ok((public.confirm_handover((select id from t.ids where name = 'h_bob'))).finder_confirmed_at is not null,
            'quem está com o animal confirma a entrega');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
select t.ok((public.confirm_handover((select id from t.ids where name = 'h_bob'))).status = 'completed',
            'tutora confirma o recebimento e a entrega é concluída');
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'lost1')) = 'reunited',
            'anúncio vira reencontrado só com as duas confirmações');

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format('select public.request_handover(%L)', (select id from t.ids where name = 'conv_carol')),
                         'já foi encerrado');
  perform t.ok(true, 'anúncio reencontrado não aceita nova entrega');
end $$;

-- ---------------------------------------------------------------------------
-- Entrega liberada, mas o dono encerra o anúncio antes das confirmações
-- ---------------------------------------------------------------------------
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
do $$
declare r public.reports;
begin
  insert into public.reports (kind, species, size, colors, neighborhood, lat, lng, event_date)
  values ('lost', 'cat', 'small', '{preto}', 'Centro', -23.59, -48.05, current_date) returning * into r;
  insert into t.ids values ('lost2', r.id);
end $$;
call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
update public.reports set review_status = 'approved' where id = (select id from t.ids where name = 'lost2');

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare c public.conversations;
begin
  insert into public.conversations (report_id, owner_id, asker_context)
  values ((select id from t.ids where name = 'lost2'), auth.uid(), 'has_pet') returning * into c;
  insert into t.ids values ('conv2', c.id);
  insert into public.messages (conversation_id, body) values (c.id, 'Gato preto aqui em casa.');
end $$;
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
insert into public.messages (conversation_id, body) select id, 'Pode ser ele!' from t.ids where name = 'conv2';
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
insert into t.ids select 'h2', (public.request_handover((select id from t.ids where name = 'conv2'))).id;
call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
select public.review_handover((select id from t.ids where name = 'h2'), true);

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
update public.reports set status = 'closed' where id = (select id from t.ids where name = 'lost2');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$ begin
  perform t.expect_error(format('select public.confirm_handover(%L)', (select id from t.ids where name = 'h2')),
                         'já foi encerrado');
  perform t.ok(true, 'entrega não é confirmada em anúncio encerrado');
end $$;

reset role;
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'lost2')) = 'closed',
            'anúncio encerrado continua encerrado (não vira reencontrado)');
do $$ begin raise notice 'TODOS OS TESTES DO BANCO PASSARAM'; end $$;
