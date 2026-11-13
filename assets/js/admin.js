import { getClient, getProfile, REPORT_FIELDS } from "./supabase.js";
import { COLOR_LABEL, SPECIES_LABEL, SIZE_LABEL, SEX_LABEL, CUSTODY_LABEL, KIND_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, thumbHtml, relativeDate, formatDateTime, statusHtml, showError, toast, confirmDialog, errorText, CONNECTION_ERROR } from "./ui.js";

const root = document.getElementById("admin-root");
const reportsList = document.getElementById("pending-reports");
const flagsList = document.getElementById("open-flags");
let sb, me;
let reports = [];
let flags = [];

function kindLine(r) {
  return [KIND_LABEL[r.kind], SPECIES_LABEL[r.species], r.kind === "found" ? CUSTODY_LABEL[r.custody] : null].filter(Boolean).join(", ");
}

function animalLine(r) {
  return [SIZE_LABEL[r.size], SEX_LABEL[r.sex], r.colors.map((c) => COLOR_LABEL[c] ?? c).join(" e "), r.breed].filter(Boolean).join(", ");
}

function renderCounts() {
  document.getElementById("count-reports").textContent = `(${reports.length})`;
  document.getElementById("count-flags").textContent = `(${flags.length})`;
}

function renderReports() {
  renderCounts();
  if (!reports.length) {
    reportsList.innerHTML = `<li class="empty"><h3>Nenhum anúncio para revisar</h3><p class="muted">Anúncios novos e editados aparecem aqui assim que são enviados.</p></li>`;
    return;
  }
  reportsList.innerHTML = reports.map((r) => {
    const live = r.review_status === "approved";
    return `<li class="mod-item" data-id="${r.id}">
    <div class="mod-media">
      ${thumbHtml(sb, r)}
      <div class="row-body">
        ${statusHtml(r)}
        <h3><a href="/anuncio?id=${r.id}">${escapeHtml(reportTitle(r))}</a></h3>
        <p class="small"><strong>${live ? "Já publicado, falta revisar" : "Aguardando aprovação"}</strong></p>
        <p class="small muted">${escapeHtml(kindLine(r))}. ${escapeHtml(animalLine(r))}.</p>
        <p class="small muted">${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}. Enviado por ${escapeHtml(r.owner?.display_name || "usuário")} em ${formatDateTime(r.created_at)}.</p>
        ${r.description ? `<p class="mod-text">${escapeHtml(r.description)}</p>` : ""}
      </div>
    </div>
    <div class="owner-actions">
      <button type="button" class="btn btn-primary" data-act="approve-report">${live ? "Manter publicado" : "Aprovar anúncio"}</button>
      <button type="button" class="btn btn-danger" data-act="reject-report">${live ? "Retirar do ar" : "Recusar"}</button>
    </div>
  </li>`;
  }).join("");
}

function flagTarget(f) {
  if (f.report) return { title: reportTitle(f.report), href: `/anuncio?id=${f.report.id}`, label: "Anúncio" };
  const c = f.conversation;
  return {
    title: `${c?.asker?.display_name || "usuário"} e ${c?.owner?.display_name || "usuário"}`,
    href: `/conversa?id=${f.conversation_id}`,
    label: "Conversa",
  };
}

function activeHandover(f) {
  const h = Array.isArray(f.conversation?.handovers) ? f.conversation.handovers[0] : f.conversation?.handovers;
  return h && (h.status === "approved" || h.status === "under_review") ? h : null;
}

function renderFlags() {
  renderCounts();
  if (!flags.length) {
    flagsList.innerHTML = `<li class="empty"><h3>Nenhuma denúncia aberta</h3><p class="muted">Denúncias de anúncios e de conversas aparecem aqui.</p></li>`;
    return;
  }
  flagsList.innerHTML = flags.map((f) => {
    const target = flagTarget(f);
    return `<li class="mod-item" data-id="${f.id}">
      <div class="row-body">
        <p class="small muted">${target.label}, denúncia de ${escapeHtml(f.reporter?.display_name || "conta excluída")} em ${formatDateTime(f.created_at)}</p>
        <h3><a href="${target.href}">${escapeHtml(target.title)}</a></h3>
        <p class="mod-text">${escapeHtml(f.reason)}</p>
      </div>
      <div class="owner-actions">
        <a class="btn btn-secondary" href="${target.href}">Abrir ${target.label.toLowerCase()}</a>
        ${f.report_id ? `<button type="button" class="btn btn-danger" data-act="takedown">Retirar anúncio do ar</button>` : ""}
        ${activeHandover(f) ? `<button type="button" class="btn btn-danger" data-act="cancel-handover">Cancelar entrega</button>` : ""}
        <button type="button" class="btn btn-secondary" data-act="resolve">Concluir denúncia</button>
      </div>
    </li>`;
  }).join("");
}

async function resolveFlag(id) {
  const { error } = await sb.from("flags").update({ status: "resolved", resolved_by: me.id, resolved_at: new Date().toISOString() }).eq("id", id);
  if (error) {
    toast(errorText(error));
    return false;
  }
  flags = flags.filter((x) => x.id !== id);
  renderFlags();
  return true;
}

root.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]").dataset.id;
  const act = btn.dataset.act;

  if (act === "approve-report" || act === "reject-report") {
    const r = reports.find((x) => x.id === id);
    const live = r.review_status === "approved";
    let patch = { review_status: "approved", review_note: null, reviewed_at: new Date().toISOString() };
    if (act === "reject-report") {
      const res = await confirmDialog({
        title: `${live ? "Retirar do ar" : "Recusar"} o anúncio de ${reportTitle(r)}?`,
        body: "Quem anunciou vê o motivo e pode corrigir o anúncio.",
        confirmLabel: live ? "Retirar do ar" : "Recusar anúncio",
        danger: true,
        reasonLabel: "Motivo",
        reasonRequired: true,
      });
      if (!res.ok) return;
      patch = { review_status: "rejected", review_note: res.reason };
    }
    btn.disabled = true;
    const { error } = await sb.from("reports").update(patch).eq("id", id);
    if (error) {
      btn.disabled = false;
      return toast(errorText(error));
    }
    reports = reports.filter((x) => x.id !== id);
    renderReports();
    toast(act === "approve-report" ? "Anúncio revisado e publicado." : "Anúncio fora do ar. Quem anunciou vê o motivo.");
  }

  if (act === "takedown") {
    const f = flags.find((x) => x.id === id);
    const res = await confirmDialog({
      title: `Retirar do ar o anúncio de ${reportTitle(f.report)}?`,
      body: "Quem anunciou vê o motivo e pode corrigir o anúncio. A denúncia é concluída junto.",
      confirmLabel: "Retirar do ar",
      danger: true,
      reasonLabel: "Motivo",
      reasonRequired: true,
    });
    if (!res.ok) return;
    const { error } = await sb.from("reports").update({ review_status: "rejected", review_note: res.reason }).eq("id", f.report_id);
    if (error) return toast(errorText(error));
    if (await resolveFlag(id)) toast("Anúncio retirado do ar.");
  }

  if (act === "cancel-handover") {
    const f = flags.find((x) => x.id === id);
    const res = await confirmDialog({
      title: "Cancelar esta entrega?",
      body: "As duas pessoas veem o motivo. Quem está com o animal pode iniciar a entrega de novo depois.",
      confirmLabel: "Cancelar entrega",
      danger: true,
      reasonLabel: "Motivo",
      reasonRequired: true,
    });
    if (!res.ok) return;
    const { error } = await sb.rpc("cancel_handover", { p_handover_id: activeHandover(f).id, p_note: res.reason });
    if (error) return toast(errorText(error));
    if (await resolveFlag(id)) toast("Entrega cancelada.");
  }

  if (act === "resolve" && await resolveFlag(id)) toast("Denúncia concluída.");
});

// Abas com setas do teclado
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = true) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  });
  if (focus) tab.focus();
  history.replaceState(null, "", tab.id === "tab-flags" ? "?fila=denuncias" : location.pathname);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      selectTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]);
    }
  });
});

function renderMetrics(m) {
  const rows = [
    ["Anúncios abertos", m.open_reports],
    ["Reencontros em 30 dias", m.reunions_30d],
    ["Dias até o reencontro (mediana)", m.median_days ?? "Sem dados"],
  ];
  document.getElementById("metrics").innerHTML = rows.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
}

async function main() {
  initHeader();
  try {
    sb = await getClient();
    me = await getProfile();
  } catch (err) {
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  if (!me) return location.replace("/entrar?next=/admin");
  if (me.role !== "admin") {
    return showError(document.getElementById("page-error"), "Esta área é só para administradores. Se você deveria ter acesso, peça para um administrador atual liberar sua conta.");
  }
  const [r, f, m] = await Promise.all([
    sb.from("reports").select(`${REPORT_FIELDS}, owner:profiles!reports_user_id_fkey(display_name)`)
      .or("review_status.eq.pending,and(review_status.eq.approved,reviewed_at.is.null)").neq("status", "closed").order("created_at"),
    sb.from("flags").select(`id, reason, created_at, report_id, conversation_id,
        reporter:profiles!flags_reporter_id_fkey(display_name),
        report:reports(id, kind, species, pet_name),
        conversation:conversations(id, handovers(id, status),
          asker:profiles!conversations_asker_id_fkey(display_name),
          owner:profiles!conversations_owner_id_fkey(display_name))`)
      .eq("status", "open").order("created_at"),
    sb.rpc("admin_metrics"),
  ]);
  if (r.error || f.error) return showError(document.getElementById("page-error"), CONNECTION_ERROR, r.error || f.error);
  reports = r.data;
  flags = f.data;
  if (m.data) renderMetrics(m.data);
  root.hidden = false;
  renderReports();
  renderFlags();
  if (new URLSearchParams(location.search).get("fila") === "denuncias") selectTab(document.getElementById("tab-flags"), false);
  // Ao abrir a fila, o próximo item novo volta a gerar aviso por e-mail.
  sb.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", me.id).eq("kind", "moderation").is("read_at", null).then(() => {});
}

main();
