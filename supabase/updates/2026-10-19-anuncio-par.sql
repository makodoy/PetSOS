-- Atualização 2026-10-19: ao concluir a entrega, o anúncio par (perdido do tutor / encontrado de quem
-- estava com o animal) também vira "reencontrado".
-- Para bancos criados com uma versão anterior do schema.sql: rode este arquivo uma vez no SQL Editor.
-- Bancos novos não precisam: o schema.sql já inclui tudo isto.

alter table public.handovers
  add column if not exists linked_report_id uuid references public.reports (id) on delete set null;

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

-- Entregas já concluídas antes desta atualização: fecha o par agora.
select public.close_linked_report(h.id)
  from public.handovers h
 where h.status = 'completed' and h.linked_report_id is null;
