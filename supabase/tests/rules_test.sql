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
  perform t.ok(r.review_status = 'pending' and r.status = 'open', 'anúncio de e-mail não confirmado nasce pendente e aberto, mesmo se o navegador pedir outra coisa');
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
               'sem e-mail confirmado, editar conteúdo depois de aprovado volta para moderação');
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
  perform t.ok(true, 'entrega exige mensagens dos dois lados');
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
  perform t.ok(true, 'tutora não inicia a entrega no lugar de quem está com o animal');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare h public.handovers;
begin
  h := public.request_handover((select id from t.ids where name = 'conv_bob'));
  insert into t.ids values ('h_bob', h.id);
  perform t.ok(h.status = 'approved' and jsonb_array_length(h.transcript) = 2, 'entrega iniciada sem aprovação prévia, com cópia congelada da conversa');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format('select public.request_handover(%L)', (select id from t.ids where name = 'conv_carol')),
                         'Já existe uma entrega em andamento');
  perform t.ok(true, 'só uma entrega em andamento por anúncio');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$ begin
  perform t.expect_error(format($q$select public.cancel_handover(%L, 'motivo')$q$, (select id from t.ids where name = 'h_bob')),
                         'Somente administradores');
  perform t.ok(true, 'usuário comum não cancela entrega');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
do $$
declare v_h uuid := (select id from t.ids where name = 'h_bob');
begin
  perform t.expect_error(format('select public.cancel_handover(%L, null)', v_h), 'motivo do cancelamento');
  perform t.ok(true, 'cancelamento exige motivo');
  perform t.ok((public.cancel_handover(v_h, 'Denúncia em análise')).status = 'rejected', 'admin cancela a entrega após denúncia');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare v_h uuid := (select id from t.ids where name = 'h_bob');
begin
  perform t.expect_error(format('select public.confirm_handover(%L)', v_h), 'foi cancelada');
  perform t.ok(true, 'entrega cancelada não é confirmada');
  perform t.ok((public.request_handover((select id from t.ids where name = 'conv_bob'))).status = 'approved', 'entrega cancelada pode ser iniciada de novo');
end $$;

-- Bob também anunciou o cão como encontrado (o par) e um gato, que não tem nada a ver com esta entrega.
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$
declare v_id uuid;
begin
  insert into public.reports (kind, custody, species, colors, neighborhood, lat, lng, event_date)
  values ('found', 'with_finder', 'dog', '{caramelo}', 'Centro', -23.588, -48.042, current_date) returning id into v_id;
  insert into t.ids values ('found_bob_dog', v_id);
  insert into public.reports (kind, custody, species, colors, neighborhood, lat, lng, event_date)
  values ('found', 'with_finder', 'cat', '{preto}', 'Centro', -23.588, -48.042, current_date) returning id into v_id;
  insert into t.ids values ('found_bob_cat', v_id);
end $$;

select t.ok((public.confirm_handover((select id from t.ids where name = 'h_bob'))).finder_confirmed_at is not null,
            'quem está com o animal confirma a entrega');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
select t.ok((public.confirm_handover((select id from t.ids where name = 'h_bob'))).status = 'completed',
            'tutora confirma o recebimento e a entrega é concluída');
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'lost1')) = 'reunited',
            'anúncio vira reencontrado só com as duas confirmações');
call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a'); -- o par do Bob ainda está pendente
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'found_bob_dog')) = 'reunited'
            and (select linked_report_id from public.handovers where id = (select id from t.ids where name = 'h_bob'))
                = (select id from t.ids where name = 'found_bob_dog'),
            'anúncio par de quem estava com o animal também vira reencontrado');
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'found_bob_cat')) = 'open',
            'anúncio de outra espécie não é fechado junto');

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format('select public.request_handover(%L)', (select id from t.ids where name = 'conv_carol')),
                         'já foi encerrado');
  perform t.ok(true, 'anúncio reencontrado não aceita nova entrega');
end $$;

-- ---------------------------------------------------------------------------
-- Entrega iniciada, mas o dono encerra o anúncio antes das confirmações
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
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000001');
update public.reports set status = 'closed' where id = (select id from t.ids where name = 'lost2');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000002');
do $$ begin
  perform t.expect_error(format('select public.confirm_handover(%L)', (select id from t.ids where name = 'h2')),
                         'já foi encerrado');
  perform t.ok(true, 'entrega não é confirmada em anúncio encerrado');
end $$;

-- ---------------------------------------------------------------------------
-- Publicação imediata, datas de controle, fotos e limites
-- ---------------------------------------------------------------------------
reset role;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000004', 'dave@x.com', now()),
  ('00000000-0000-0000-0000-000000000005', 'erin@x.com', now());

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000004');
do $$
declare
  r public.reports;
  v_me text := auth.uid()::text;
begin
  insert into public.reports (kind, species, colors, neighborhood, lat, lng, event_date, created_at, photo_path)
  values ('lost', 'dog', '{preto}', 'Centro', -23.5, -48.0, current_date, now() + interval '10 years', v_me || '/a.webp')
  returning * into r;
  insert into t.ids values ('dave1', r.id);
  perform t.ok(r.review_status = 'approved' and r.reviewed_at is null, 'e-mail confirmado publica na hora e entra na revisão posterior');
  perform t.ok(r.created_at <= now(), 'navegador não escolhe a data de criação');
  update public.reports set created_at = now() + interval '5 years', expires_at = now() + interval '5 years' where id = r.id;
  perform t.ok((select created_at <= now() and expires_at < now() + interval '61 days' from public.reports where id = r.id),
               'navegador não altera datas de controle');
  perform t.expect_error($q$insert into public.reports (kind, species, colors, neighborhood, lat, lng, event_date)
                            values ('lost', 'dog', '{preto}', 'Centro', -23.5, -48.0, current_date + 2)$q$, 'futuro');
  perform t.ok(true, 'data no futuro é recusada');
  perform t.expect_error(format($q$update public.reports set photo_path = 'outra-pessoa/a.webp' where id = %L$q$, r.id), 'própria conta');
  perform t.ok(true, 'foto de outra pasta é recusada');
  perform t.expect_error(format($q$update public.reports set reviewed_at = now() where id = %L$q$, r.id), 'Somente administradores');
  perform t.ok(true, 'dono não marca o próprio anúncio como revisado');
  perform public.renew_report(r.id);
  update public.reports set description = 'Novo texto' where id = r.id;
  perform t.ok((select review_status = 'approved' and reviewed_at is null and matched_at is null from public.reports where id = r.id),
               'com e-mail confirmado, editar mantém publicado e devolve à revisão posterior');
end $$;

-- Limite de anúncios por conta
do $$
declare i int;
begin
  for i in 1..9 loop
    insert into public.reports (kind, species, colors, neighborhood, lat, lng, event_date)
    values ('lost', 'dog', '{preto}', 'Centro', -23.5, -48.0, current_date);
  end loop;
  perform t.expect_error($q$insert into public.reports (kind, species, colors, neighborhood, lat, lng, event_date)
                            values ('lost', 'dog', '{preto}', 'Centro', -23.5, -48.0, current_date)$q$, 'Limite de 10');
  perform t.ok(true, 'máximo de 10 anúncios em 24 horas');
end $$;

-- Recusado que é corrigido volta para a fila humana
call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
update public.reports set review_status = 'rejected', review_note = 'Foto inadequada' where id = (select id from t.ids where name = 'dave1');
select t.ok((select reviewed_by is not null and reviewed_at is not null from public.reports where id = (select id from t.ids where name = 'dave1')),
            'moderação registra quem revisou e quando');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000004');
select t.ok((select count(*) = 1 from public.notifications where kind = 'report_rejected'), 'dono é avisado da recusa');
update public.reports set description = 'Corrigido' where id = (select id from t.ids where name = 'dave1');
select t.ok((select review_status = 'pending' and review_note is null from public.reports where id = (select id from t.ids where name = 'dave1')),
            'anúncio recusado corrigido volta para pendente, mesmo com e-mail confirmado');
call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
update public.reports set review_status = 'approved', review_note = null where id = (select id from t.ids where name = 'dave1');
select t.ok((select count(*) >= 1 from public.notifications where kind = 'moderation'), 'admin recebe aviso de fila de moderação');

call t.as_user('anon');
do $$ begin
  perform t.expect_error('select user_id from public.reports limit 1', 'permission denied');
  perform t.ok(true, 'visitante não lê quem anunciou');
  perform t.ok((select count(*) > 0 and bool_or(not has_owner) from public.reports), 'visitante ainda sabe se o anúncio aceita conversa');
end $$;

-- ---------------------------------------------------------------------------
-- Conversa atômica, avisos, bloqueio, limite de mensagens e denúncia
-- ---------------------------------------------------------------------------
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000005');
do $$
declare
  v_report uuid := (select id from t.ids where name = 'dave1');
  v_conv uuid;
begin
  begin
    perform public.start_conversation(v_report, 'has_pet', '   ');
    raise exception 'FALHOU: mensagem vazia foi aceita';
  exception when check_violation then null;
  end;
  perform t.ok((select count(*) = 0 from public.conversations where report_id = v_report), 'mensagem inválida não deixa conversa vazia');
  v_conv := public.start_conversation(v_report, 'has_pet', 'Está comigo.');
  insert into t.ids values ('conv_erin', v_conv);
  perform t.ok(public.start_conversation(v_report, 'has_pet', 'Mais um detalhe.') = v_conv, 'segunda chamada reaproveita a conversa');
  perform t.ok((select count(*) = 2 from public.messages where conversation_id = v_conv), 'duas mensagens gravadas');
  perform t.expect_error(format('update public.notifications set body = %L', 'x'), 'permission denied');
  perform t.ok(true, 'navegador só marca aviso como lido');
  insert into public.flags (conversation_id, reason) values (v_conv, 'Pediu dinheiro');
  perform t.expect_error(format($q$insert into public.flags (conversation_id, reason) values (%L, 'De novo')$q$, v_conv), 'duplicate key');
  perform t.ok(true, 'uma denúncia por pessoa e por item');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000004');
do $$
declare v_conv uuid := (select id from t.ids where name = 'conv_erin');
begin
  perform t.ok((select count(*) = 1 from public.notifications where conversation_id = v_conv and kind = 'message'),
               'dono recebe um aviso por conversa até ler, não um por mensagem');
  update public.notifications set read_at = now() where conversation_id = v_conv;
  insert into public.blocks (blocked_id) values ('00000000-0000-0000-0000-000000000005');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000005');
do $$
declare v_conv uuid := (select id from t.ids where name = 'conv_erin');
begin
  perform t.expect_error(format($q$insert into public.messages (conversation_id, body) values (%L, 'Oi')$q$, v_conv), 'bloqueada');
  perform t.ok(true, 'pessoa bloqueada não envia mensagem');
  perform t.ok((select count(*) = 0 from public.blocks), 'pessoa bloqueada não vê quem a bloqueou');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000004');
delete from public.blocks;
do $$
declare
  v_conv uuid := (select id from t.ids where name = 'conv_erin');
  i int;
begin
  for i in 1..30 loop
    insert into public.messages (conversation_id, body) values (v_conv, 'Mensagem ' || i);
  end loop;
  perform t.expect_error(format($q$insert into public.messages (conversation_id, body) values (%L, 'Excesso')$q$, v_conv), 'Muitas mensagens');
  perform t.ok(true, 'limite de mensagens por minuto');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format($q$insert into public.flags (conversation_id, reason) values (%L, 'Curiosa')$q$, (select id from t.ids where name = 'conv_erin')),
                         'row-level security');
  perform t.ok(true, 'só participante denuncia a conversa');
  perform t.expect_error('select public.admin_metrics()', 'Somente administradores');
  perform t.ok(true, 'indicadores só para admin');
end $$;

call t.as_user('authenticated', '00000000-0000-0000-0000-00000000000a');
select t.ok((public.admin_metrics() ->> 'reunions_30d')::int >= 1, 'indicadores contam os reencontros');

-- ---------------------------------------------------------------------------
-- Expiração e exclusão de conta
-- ---------------------------------------------------------------------------
reset role;
update public.reports set expires_at = now() - interval '1 day', photo_path = '00000000-0000-0000-0000-000000000004/a.webp'
 where id = (select id from t.ids where name = 'dave1');
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000003');
do $$ begin
  perform t.expect_error(format($q$select public.start_conversation(%L, 'sighted', 'Vi')$q$, (select id from t.ids where name = 'dave1')), 'não está disponível');
  perform t.ok(true, 'anúncio vencido não recebe conversa nova');
  perform t.expect_error(format('select public.renew_report(%L)', (select id from t.ids where name = 'dave1')), 'não pode ser renovado');
  perform t.ok(true, 'só o dono renova');
end $$;
call t.as_user('authenticated', '00000000-0000-0000-0000-000000000004');
select t.ok((public.renew_report((select id from t.ids where name = 'dave1'))).expires_at > now() + interval '59 days', 'dono renova por 60 dias');
select public.delete_my_account();
reset role;
select t.ok((select count(*) = 0 from public.reports where user_id = '00000000-0000-0000-0000-000000000004')
            and (select count(*) = 0 from public.conversations where id = (select id from t.ids where name = 'conv_erin')),
            'excluir conta apaga anúncios e conversas');
select t.ok((select count(*) >= 1 from public.photo_deletions where path like '00000000-0000-0000-0000-000000000004/%'),
            'fotos da conta excluída entram na fila de remoção');

reset role;
select t.ok((select status from public.reports where id = (select id from t.ids where name = 'lost2')) = 'closed',
            'anúncio encerrado continua encerrado (não vira reencontrado)');
do $$ begin raise notice 'TODOS OS TESTES DO BANCO PASSARAM'; end $$;
