import { getClient, getProfile, REPORT_FIELDS, PHOTO_BUCKET } from "./supabase.js";
import { COLOR_LABEL, SPECIES_LABEL, SIZE_LABEL, SEX_LABEL, CUSTODY_LABEL } from "./constants.js";
import {
  initHeader, escapeHtml, reportTitle, formatDate, relativeDate, statusHtml, thumbHtml, photoUrl, pawIcon,
  showError, toast, confirmDialog, errorText, CONNECTION_ERROR,
} from "./ui.js";
import { createMap, markerStyle } from "./map.js";

const root = document.getElementById("detail-root");
const errorEl = document.getElementById("page-error");
const params = new URLSearchParams(location.search);
const id = params.get("id");

let sb, me, report;

const isOwner = () => me && report.user_id === me.id;
const isAdmin = () => me?.role === "admin";

function factsHtml(r) {
  const rows = [
    ["Espécie", SPECIES_LABEL[r.species]],
    r.kind === "found" ? ["Situação", CUSTODY_LABEL[r.custody]] : null,
    ["Sexo", SEX_LABEL[r.sex]],
    ["Porte", SIZE_LABEL[r.size]],
    ["Cores", r.colors.map((c) => COLOR_LABEL[c] ?? c).join(", ")],
    ["Raça", r.breed],
    [r.kind === "lost" ? "Sumiu em" : r.custody === "sighted" ? "Visto em" : "Encontrado em", formatDate(r.event_date)],
    ["Bairro", r.neighborhood],
  ].filter((row) => row && row[1]);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
}

function noticesHtml() {
  const out = [];
  if (params.get("novo") === "1" && report.review_status === "pending") {
    out.push(`<p class="notice">Anúncio enviado. Ele aparece para todos assim que um administrador aprovar; enquanto isso, você já vê abaixo os animais parecidos.</p>`);
  } else if (report.review_status === "pending" && (isOwner() || isAdmin())) {
    out.push(`<p class="notice notice-pending">Aguardando aprovação. Só você${isAdmin() ? ", o dono" : ""} e os administradores veem este anúncio.${isAdmin() ? ` <a href="/admin">Abrir moderação</a>` : ""}</p>`);
  }
  if (report.review_status === "rejected" && (isOwner() || isAdmin())) {
    out.push(`<p class="notice notice-danger">Anúncio recusado${report.review_note ? `: ${escapeHtml(report.review_note)}` : "."} Exclua e anuncie de novo com as correções.</p>`);
  }
  if (report.status === "reunited") out.push(`<p class="notice">Este animal foi reencontrado. A entrega foi confirmada pelas duas pessoas.</p>`);
  if (report.status === "closed") out.push(`<p class="notice notice-pending">Anúncio encerrado por quem anunciou.</p>`);
  return out.join("");
}

async function contactHtml() {
  if (isOwner()) {
    const { count } = await sb.from("conversations").select("id", { count: "exact", head: true }).eq("report_id", report.id);
    return `<div class="panel contact-box"><p>${count ? `${count} ${count === 1 ? "conversa" : "conversas"} sobre este anúncio.` : "Ninguém enviou mensagem ainda."}</p>
      ${count ? `<a class="btn btn-secondary" href="/conversas?anuncio=${report.id}">Ver conversas</a>` : ""}</div>`;
  }
  if (report.review_status !== "approved" || report.status !== "open") return "";
  if (!report.user_id) return `<div class="panel contact-box"><p class="muted">Anúncio de demonstração, sem conta vinculada para conversar.</p></div>`;
  if (!me) {
    return `<div class="panel contact-box"><p>Entre na sua conta para enviar uma mensagem a quem anunciou.</p>
      <a class="btn btn-secondary" href="/entrar?next=${encodeURIComponent(location.pathname + location.search)}">Entrar para enviar mensagem</a></div>`;
  }
  const { data: existing } = await sb.from("conversations").select("id").eq("report_id", report.id).eq("asker_id", me.id).maybeSingle();
  if (existing) {
    return `<div class="panel contact-box"><p>Você já conversa com quem anunciou.</p><a class="btn btn-primary" href="/conversa?id=${existing.id}">Abrir conversa</a></div>`;
  }

  const lost = report.kind === "lost";
  const intro = lost
    ? "Viu este animal ou ele está com você? Conte para o tutor."
    : report.custody === "with_finder"
      ? "Acha que é o seu animal? Descreva sinais que só o tutor saberia, como cicatrizes, manias ou a coleira."
      : "Pergunte onde e quando o animal foi visto.";
  return `<form class="panel contact-box" id="start-form" novalidate>
    <h2 style="font-size:22px">Enviar mensagem</h2>
    <p class="muted">${intro}</p>
    ${lost ? `<fieldset class="field"><legend>Qual é a sua situação?</legend>
      <div class="choices">
        <label class="choice"><input type="radio" name="context" value="sighted"> Vi o animal</label>
        <label class="choice"><input type="radio" name="context" value="has_pet"> O animal está comigo</label>
      </div><p class="field-error" id="context-error"></p></fieldset>` : ""}
    <div class="field"><label for="first-message">Mensagem</label>
      <textarea id="first-message" maxlength="1000"></textarea>
      <p class="field-error" id="first-message-error"></p></div>
    <button type="submit" class="btn btn-primary">Enviar mensagem</button>
    <p class="field-error" id="start-error" role="alert"></p>
  </form>`;
}

function bindStartForm() {
  const form = document.getElementById("start-form");
  if (!form) return;
  const text = form.querySelector("#first-message");
  const check = () => {
    let ok = true;
    if (report.kind === "lost") {
      const msg = form.context.value ? "" : "Escolha se você viu o animal ou se ele está com você.";
      form.querySelector("#context-error").textContent = msg;
      ok = !msg;
    }
    const msg = text.value.trim() ? "" : "Escreva a mensagem.";
    form.querySelector("#first-message-error").textContent = msg;
    msg ? text.setAttribute("aria-invalid", "true") : text.removeAttribute("aria-invalid");
    return ok && !msg;
  };
  text.addEventListener("blur", () => text.value && check());
  form.addEventListener("input", () => form.querySelector("#start-error").textContent = "");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!check()) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const context = report.kind === "lost" ? form.context.value : "inquiry";
    const { data, error } = await sb.from("conversations")
      .insert({ report_id: report.id, asker_id: me.id, owner_id: report.user_id, asker_context: context })
      .select("id").single();
    if (!error) {
      const { error: msgError } = await sb.from("messages").insert({ conversation_id: data.id, sender_id: me.id, body: text.value.trim() });
      if (!msgError) {
        location.href = `/conversa?id=${data.id}`;
        return;
      }
    }
    btn.disabled = false;
    form.querySelector("#start-error").textContent = errorText(error, "A mensagem não foi enviada. Verifique a conexão e tente de novo.");
  });
}

function ownerActionsHtml() {
  if (!isOwner() && !isAdmin()) return "";
  const close = report.status === "open" && isOwner()
    ? `<button type="button" class="btn btn-secondary" data-action="close">Encerrar anúncio</button>` : "";
  return `<div class="owner-actions">${close}<button type="button" class="btn btn-danger" data-action="delete">Excluir anúncio</button></div>`;
}

async function renderReport() {
  const url = photoUrl(sb, report.photo_path);
  const photo = url
    ? `<img class="detail-photo" src="${escapeHtml(url)}" alt="Foto de ${escapeHtml(reportTitle(report))}">`
    : `<div class="detail-photo">${pawIcon}</div>`;

  document.title = `${reportTitle(report)} | PetSOS`;
  root.innerHTML = `
    <div class="detail">
      <div style="display:grid;gap:var(--s4)">${photo}<div class="detail-map" id="detail-map" aria-label="Local aproximado"></div></div>
      <div class="detail-info">
        ${noticesHtml()}
        <div style="display:grid;gap:var(--s2)">${statusHtml(report)}<h1>${escapeHtml(reportTitle(report))}</h1>
        <p class="muted">${escapeHtml(report.neighborhood)}, ${relativeDate(report.event_date)}</p></div>
        ${factsHtml(report)}
        ${report.description ? `<p class="description">${escapeHtml(report.description)}</p>` : ""}
        ${await contactHtml()}
        ${ownerActionsHtml()}
      </div>
    </div>`;
  root.removeAttribute("aria-busy");
  bindStartForm();

  const map = createMap(document.getElementById("detail-map"), { center: [report.lat, report.lng], zoom: 15, interactive: false });
  L.circleMarker([report.lat, report.lng], markerStyle(report, true)).addTo(map);
}

async function renderMatches() {
  const section = document.getElementById("matches-section");
  const panel = document.getElementById("matches-panel");
  if (report.status !== "open") return;
  section.hidden = false;
  const other = report.kind === "lost" ? "encontrados ou avistados" : "perdidos";
  document.getElementById("matches-intro").textContent =
    `Anúncios de animais ${other} comparados por espécie, cores, porte, sexo, distância e data. Confira a foto antes de enviar mensagem.`;
  panel.innerHTML = `<ul class="report-list"><li class="skeleton-row" aria-hidden="true"><span></span><span></span></li><li class="skeleton-row" aria-hidden="true"><span></span><span></span></li></ul>`;

  let body;
  try {
    const headers = me ? { Authorization: `Bearer ${me.session.access_token}` } : {};
    const res = await fetch(`/api/matches?id=${encodeURIComponent(report.id)}`, { headers });
    body = await res.json();
    if (!res.ok) throw new Error(body.error);
  } catch {
    panel.innerHTML = `<div class="empty"><p>Não foi possível calcular os animais parecidos agora.</p><button type="button" class="btn btn-secondary" id="retry-matches">Tentar de novo</button></div>`;
    document.getElementById("retry-matches").addEventListener("click", renderMatches);
    return;
  }

  if (!body.matches.length) {
    panel.innerHTML = `<div class="empty"><h3>Nenhum animal parecido por enquanto</h3>
      <p class="muted">Cada novo anúncio aprovado do tipo oposto é comparado com este. Volte aqui nos próximos dias.</p></div>`;
    return;
  }

  panel.innerHTML = `<ul class="report-list">${body.matches.map(({ report: r, score, reasons }) => `
    <li><a class="report-row" href="/anuncio?id=${r.id}">
      ${thumbHtml(sb, r)}
      <div class="row-body">
        ${statusHtml(r)}
        <h3>${escapeHtml(reportTitle(r))}</h3>
        <p class="match-score">${Math.round(score * 100)}% de compatibilidade${r.custody === "sighted" ? ", só avistado" : ""}</p>
        <ul class="match-reasons">${reasons.slice(0, 3).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      </div>
    </a></li>`).join("")}</ul>`;
}

function bindOwnerActions() {
  root.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "close") {
      const ok = await confirmDialog({
        title: `Encerrar anúncio de ${reportTitle(report)}?`,
        body: "Ele sai da lista e do mapa. Use quando o caso foi resolvido fora do PetSOS. Para registrar uma entrega feita por aqui, use a confirmação na conversa.",
        confirmLabel: "Encerrar anúncio",
      });
      if (!ok) return;
      const { error } = await sb.from("reports").update({ status: "closed" }).eq("id", report.id);
      if (error) return toast(errorText(error));
      report.status = "closed";
      toast("Anúncio encerrado.");
      document.getElementById("matches-section").hidden = true;
      await renderReport();
    }
    if (action === "delete") {
      const ok = await confirmDialog({
        title: `Excluir anúncio de ${reportTitle(report)}?`,
        body: "O anúncio, a foto e as conversas ligadas a ele serão apagados. Isso não pode ser desfeito.",
        confirmLabel: "Excluir anúncio",
        danger: true,
      });
      if (!ok) return;
      const { error } = await sb.from("reports").delete().eq("id", report.id);
      if (error) return toast(errorText(error));
      if (report.photo_path) await sb.storage.from(PHOTO_BUCKET).remove([report.photo_path]);
      location.href = isOwner() ? "/meus" : "/admin";
    }
  });
}

async function main() {
  initHeader();
  if (!id) {
    root.innerHTML = `<div class="panel empty"><h3>Anúncio não informado</h3><a class="btn btn-secondary" href="/">Ver todos os animais</a></div>`;
    return;
  }
  try {
    sb = await getClient();
    me = await getProfile();
    const { data, error } = await sb.from("reports").select(REPORT_FIELDS).eq("id", id).maybeSingle();
    if (error) throw error;
    report = data;
  } catch {
    root.innerHTML = "";
    showError(errorEl, CONNECTION_ERROR);
    return;
  }
  if (!report) {
    root.innerHTML = `<div class="panel empty"><h3>Este anúncio não está disponível</h3><p class="muted">Ele pode ter sido excluído ou ainda aguarda aprovação.</p><a class="btn btn-secondary" href="/">Ver todos os animais</a></div>`;
    return;
  }
  await renderReport();
  bindOwnerActions();
  renderMatches();
}

main();
