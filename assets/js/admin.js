import { getClient, getProfile, REPORT_FIELDS } from "./supabase.js";
import { SPECIES_LABEL, CUSTODY_LABEL, KIND_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, thumbHtml, relativeDate, formatDateTime, statusHtml, showError, toast, confirmDialog, errorText, CONNECTION_ERROR } from "./ui.js";

const root = document.getElementById("admin-root");
const reportsList = document.getElementById("pending-reports");
const handoversList = document.getElementById("pending-handovers");
let sb;
let reports = [];
let handovers = [];

function kindLine(r) {
  return [KIND_LABEL[r.kind], SPECIES_LABEL[r.species], r.kind === "found" ? CUSTODY_LABEL[r.custody] : null].filter(Boolean).join(", ");
}

function renderCounts() {
  document.getElementById("count-reports").textContent = `(${reports.length})`;
  document.getElementById("count-handovers").textContent = `(${handovers.length})`;
}

function renderReports() {
  renderCounts();
  if (!reports.length) {
    reportsList.innerHTML = `<li class="empty"><h3>Nenhum anúncio aguardando aprovação</h3><p class="muted">Anúncios novos aparecem aqui assim que são enviados.</p></li>`;
    return;
  }
  reportsList.innerHTML = reports.map((r) => `<li class="mod-item" data-id="${r.id}">
    <div class="report-row" style="padding:0">
      ${thumbHtml(sb, r)}
      <div class="row-body">
        ${statusHtml(r)}
        <h3><a href="/anuncio?id=${r.id}">${escapeHtml(reportTitle(r))}</a></h3>
        <p class="row-meta">${escapeHtml(kindLine(r))}. ${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}</p>
        <p class="row-meta">Enviado por ${escapeHtml(r.owner?.display_name || "usuário")} em ${formatDateTime(r.created_at)}</p>
      </div>
    </div>
    ${r.description ? `<p class="mod-text">${escapeHtml(r.description)}</p>` : ""}
    <div class="owner-actions">
      <button type="button" class="btn btn-primary" data-act="approve-report">Aprovar anúncio</button>
      <button type="button" class="btn btn-danger" data-act="reject-report">Recusar</button>
    </div>
  </li>`).join("");
}

function transcriptHtml(h) {
  const finder = escapeHtml(h.finder?.display_name || "Quem está com o animal");
  const claimant = escapeHtml(h.claimant?.display_name || "Tutor");
  return `<ol class="transcript" aria-label="Conversa enviada para revisão">${(h.transcript || []).map((m) => `
    <li class="bubble ${m.from === "finder" ? "" : "bubble-mine"}">
      <p class="bubble-meta">${m.from === "finder" ? `${finder} (está com o animal)` : `${claimant} (diz ser o tutor)`}, ${formatDateTime(m.at)}</p>
      <p class="bubble-body">${escapeHtml(m.body)}</p>
    </li>`).join("")}</ol>`;
}

function renderHandovers() {
  renderCounts();
  if (!handovers.length) {
    handoversList.innerHTML = `<li class="empty"><h3>Nenhuma entrega aguardando revisão</h3><p class="muted">Quando alguém que está com um animal enviar a conversa, ela aparece aqui.</p></li>`;
    return;
  }
  handoversList.innerHTML = handovers.map((h) => `<li class="mod-item" data-id="${h.id}">
    <div class="report-row" style="padding:0">
      ${h.report ? thumbHtml(sb, h.report) : ""}
      <div class="row-body">
        <h3><a href="/anuncio?id=${h.report?.id}">${escapeHtml(h.report ? reportTitle(h.report) : "Anúncio")}</a></h3>
        <p class="row-meta">Está com o animal: ${escapeHtml(h.finder?.display_name || "usuário")}</p>
        <p class="row-meta">Diz ser o tutor: ${escapeHtml(h.claimant?.display_name || "usuário")}</p>
        <p class="row-meta">Enviado em ${formatDateTime(h.updated_at)}</p>
      </div>
    </div>
    ${h.report?.description ? `<p class="mod-text"><strong>Descrição do anúncio:</strong> ${escapeHtml(h.report.description)}</p>` : ""}
    ${transcriptHtml(h)}
    <div class="owner-actions">
      <button type="button" class="btn btn-primary" data-act="approve-handover">Liberar entrega</button>
      <button type="button" class="btn btn-danger" data-act="reject-handover">Recusar</button>
      <a class="btn btn-secondary" href="/conversa?id=${h.conversation_id}">Abrir conversa completa</a>
    </div>
  </li>`).join("");
}

root.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]").dataset.id;
  const act = btn.dataset.act;

  if (act === "approve-report" || act === "reject-report") {
    const r = reports.find((x) => x.id === id);
    let patch = { review_status: "approved", review_note: null };
    if (act === "reject-report") {
      const res = await confirmDialog({
        title: `Recusar anúncio de ${reportTitle(r)}?`,
        body: "Quem anunciou vê o motivo e pode enviar um novo anúncio corrigido.",
        confirmLabel: "Recusar anúncio",
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
    toast(act === "approve-report" ? "Anúncio aprovado e publicado." : "Anúncio recusado.");
  }

  if (act === "approve-handover" || act === "reject-handover") {
    const approve = act === "approve-handover";
    const res = await confirmDialog({
      title: approve ? "Liberar a entrega?" : "Recusar a revisão?",
      body: approve
        ? "As duas pessoas poderão confirmar a entrega. O anúncio só vira reencontrado quando as duas confirmarem."
        : "As duas pessoas veem o motivo. Quem está com o animal pode enviar a conversa de novo depois.",
      confirmLabel: approve ? "Liberar entrega" : "Recusar revisão",
      danger: !approve,
      reasonLabel: approve ? "Observação para as duas pessoas (opcional)" : "Motivo",
      reasonRequired: !approve,
    });
    if (!res.ok) return;
    btn.disabled = true;
    const { error } = await sb.rpc("review_handover", { p_handover_id: id, p_approve: approve, p_note: res.reason || null });
    if (error) {
      btn.disabled = false;
      return toast(errorText(error));
    }
    handovers = handovers.filter((x) => x.id !== id);
    renderHandovers();
    toast(approve ? "Entrega liberada." : "Revisão recusada.");
  }
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
  history.replaceState(null, "", tab.id === "tab-handovers" ? "?fila=entregas" : location.pathname);
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

async function main() {
  initHeader();
  let me;
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
  const [r, h] = await Promise.all([
    sb.from("reports").select(`${REPORT_FIELDS}, owner:profiles!reports_user_id_fkey(display_name)`)
      .eq("review_status", "pending").order("created_at"),
    sb.from("handovers").select(`id, status, transcript, conversation_id, updated_at,
        report:reports!handovers_report_id_fkey(id, kind, species, custody, pet_name, photo_path, description),
        finder:profiles!handovers_finder_id_fkey(display_name),
        claimant:profiles!handovers_claimant_id_fkey(display_name)`)
      .eq("status", "under_review").order("updated_at"),
  ]);
  if (r.error || h.error) return showError(document.getElementById("page-error"), CONNECTION_ERROR, r.error || h.error);
  reports = r.data;
  handovers = h.data;
  root.hidden = false;
  renderReports();
  renderHandovers();
  if (new URLSearchParams(location.search).get("fila") === "entregas") selectTab(document.getElementById("tab-handovers"), false);
}

main();
