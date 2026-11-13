import { getClient, getProfile, REPORT_FIELDS, PUBLIC_REPORT_FIELDS, PHOTO_BUCKET } from "./supabase.js";
import { COLOR_LABEL, SPECIES_LABEL, SIZE_LABEL, SEX_LABEL, CUSTODY_LABEL } from "./constants.js";
import {
  initHeader, escapeHtml, reportTitle, posterTitle, posterWord, matchTier, formatDate, relativeDate, statusHtml, thumbHtml, photoUrl, reunitedSealHtml, reunitedMessage,
  showError, toast, confirmDialog, flagDialog, errorText, CONNECTION_ERROR,
} from "./ui.js";
import { createMap, markerStyle } from "./map.js";

const root = document.getElementById("detail-root");
const errorEl = document.getElementById("page-error");
const params = new URLSearchParams(location.search);
const id = params.get("id");

let sb, me, report;

const isOwner = () => me && report.user_id === me.id;
const isAdmin = () => me?.role === "admin";
const isExpired = () => report.status === "open" && new Date(report.expires_at) < new Date();

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
  return `<dl class="facts">${rows.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>`;
}

function noticesHtml() {
  const out = [];
  if (params.get("novo") === "1" && (isOwner() || isAdmin())) {
    out.push(report.review_status === "approved"
      ? `<p class="notice">Anúncio publicado. Avisaremos você por e-mail quando aparecer um animal parecido. Compartilhe o link abaixo para alcançar mais gente.</p>`
      : `<p class="notice">Anúncio enviado. Ele aparece para todos depois que você confirmar o e-mail e a moderação revisar; enquanto isso, você já vê abaixo os animais parecidos.</p>`);
  } else if (params.get("editado") === "1" && isOwner()) {
    out.push(`<p class="notice">Alterações salvas.</p>`);
  } else if (report.review_status === "pending" && (isOwner() || isAdmin())) {
    out.push(`<p class="notice notice-pending">Aguardando aprovação. Só você${isAdmin() ? ", o dono" : ""} e os administradores veem este anúncio.${isAdmin() ? ` <a href="/admin">Abrir moderação</a>` : ""}</p>`);
  }
  if (report.review_status === "rejected" && (isOwner() || isAdmin())) {
    out.push(`<p class="notice notice-danger">Anúncio recusado${report.review_note ? `: ${escapeHtml(report.review_note)}` : "."} ${isOwner() ? `<a href="/anunciar?editar=${report.id}">Corrigir anúncio</a>` : ""}</p>`);
  }
  if (report.status === "reunited") {
    out.push(`<div class="notice notice-reunited">${reunitedSealHtml()}<div><p class="reunited-message">${reunitedMessage(report)}</p>
      <p>A entrega foi confirmada pelas duas pessoas. Este anúncio fica só como registro.</p></div></div>`);
  }
  if (report.status === "closed") out.push(`<p class="notice notice-pending">Anúncio encerrado por quem anunciou.</p>`);
  if (isExpired()) {
    out.push(`<p class="notice notice-pending">Este anúncio venceu e saiu da lista.${isOwner() ? " Renove se o caso continua aberto." : ""}</p>`);
  }
  return out.join("");
}

async function contactHtml() {
  if (isOwner()) {
    const { count } = await sb.from("conversations").select("id", { count: "exact", head: true }).eq("report_id", report.id);
    return `<div class="panel contact-box"><p>${count ? `${count} ${count === 1 ? "conversa" : "conversas"} sobre este anúncio.` : "Ninguém enviou mensagem ainda."}</p>
      ${count ? `<a class="btn btn-secondary" href="/conversas?anuncio=${report.id}">Ver conversas</a>` : ""}</div>`;
  }
  if (report.review_status !== "approved" || report.status !== "open" || isExpired()) return "";
  if (!report.has_owner) return `<div class="panel contact-box"><p class="muted">Anúncio de demonstração, sem conta vinculada para conversar.</p></div>`;
  if (!me) {
    return `<div class="panel contact-box" id="contato"><p>Entre na sua conta para enviar uma mensagem a quem anunciou.</p>
      <a class="btn btn-primary" href="/entrar?next=${encodeURIComponent(location.pathname + location.search)}">Entrar para enviar mensagem</a></div>`;
  }
  const { data: existing } = await sb.from("conversations").select("id").eq("report_id", report.id).eq("asker_id", me.id).maybeSingle();
  if (existing) {
    return `<div class="panel contact-box" id="contato"><p>Você já conversa com quem anunciou.</p><a class="btn btn-primary" href="/conversa?id=${existing.id}">Abrir conversa</a></div>`;
  }

  const lost = report.kind === "lost";
  const intro = lost
    ? "Viu este animal ou ele está com você? Conte para o tutor."
    : report.custody === "with_finder"
      ? "Acha que é o seu animal? Descreva sinais que só o tutor saberia, como cicatrizes, manias ou a coleira."
      : "Pergunte onde e quando o animal foi visto.";
  return `<form class="panel contact-box" id="start-form" novalidate>
    <h2 id="contato" style="font-size:22px" tabindex="-1">Enviar mensagem</h2>
    <p class="muted">${intro}</p>
    ${lost ? `<fieldset class="field"><legend>Qual é a sua situação?</legend>
      <div class="choices">
        <label class="choice"><input type="radio" name="context" value="sighted"> Vi o animal</label>
        <label class="choice"><input type="radio" name="context" value="has_pet"> O animal está comigo</label>
      </div><p class="field-error" id="context-error" role="alert"></p></fieldset>` : ""}
    <div class="field"><label for="first-message">Mensagem</label>
      <textarea id="first-message" maxlength="1000"></textarea>
      <p class="field-error" id="first-message-error" role="alert"></p></div>
    <button type="submit" class="btn btn-primary">Enviar mensagem</button>
    <p class="field-error" id="start-error" role="alert"></p>
  </form>`;
}

function bindStartForm() {
  const form = document.getElementById("start-form");
  if (!form) return;
  const text = form.querySelector("#first-message");
  const checkContext = () => {
    if (report.kind !== "lost") return true;
    const msg = form.context.value ? "" : "Escolha se você viu o animal ou se ele está com você.";
    form.querySelector("#context-error").textContent = msg;
    return !msg;
  };
  const checkText = () => {
    const msg = text.value.trim() ? "" : "Escreva a mensagem; ela é o primeiro contato com quem anunciou.";
    form.querySelector("#first-message-error").textContent = msg;
    msg ? text.setAttribute("aria-invalid", "true") : text.removeAttribute("aria-invalid");
    return !msg;
  };
  text.addEventListener("blur", checkText);
  text.addEventListener("input", () => {
    form.querySelector("#first-message-error").textContent = "";
    text.removeAttribute("aria-invalid");
  });
  form.addEventListener("change", (e) => e.target.name === "context" && checkContext());
  form.addEventListener("input", () => form.querySelector("#start-error").textContent = "");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const contextOk = checkContext();
    const textOk = checkText();
    if (!contextOk) return form.querySelector('input[name="context"]').focus();
    if (!textOk) return text.focus();
    const btn = form.querySelector("button[type=submit]");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    const context = report.kind === "lost" ? form.context.value : "inquiry";
    const { data, error } = await sb.rpc("start_conversation", { p_report_id: report.id, p_context: context, p_body: text.value.trim() });
    if (!error) {
      location.href = `/conversa?id=${data}`;
      return;
    }
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.textContent = "Enviar mensagem";
    form.querySelector("#start-error").textContent = errorText(error, "A mensagem não foi enviada. Verifique a conexão e tente de novo.");
  });
}

function shareHtml() {
  if (report.review_status !== "approved" || report.status !== "open" || isExpired()) return "";
  return `<div class="detail-actions">
    <button type="button" class="btn btn-secondary" data-action="share">Compartilhar anúncio</button>
    <a class="btn btn-secondary" href="/cartaz?id=${report.id}">Imprimir cartaz</a>
  </div>`;
}

function ownerActionsHtml() {
  const buttons = [];
  if (isOwner() && report.status === "open") {
    buttons.push(`<a class="btn btn-secondary" href="/anunciar?editar=${report.id}">Editar anúncio</a>`);
    const soon = new Date(report.expires_at) < new Date(Date.now() + 7 * 86400000);
    if (soon) buttons.push(`<button type="button" class="btn btn-secondary" data-action="renew">Renovar por 60 dias</button>`);
    buttons.push(`<button type="button" class="btn btn-secondary" data-action="close">Encerrar anúncio</button>`);
  } else if (me && !isOwner() && report.review_status === "approved") {
    buttons.push(`<button type="button" class="btn btn-secondary" data-action="flag">Denunciar anúncio</button>`);
  }
  if (isOwner() || isAdmin()) buttons.push(`<button type="button" class="btn btn-danger" data-action="delete">Excluir anúncio</button>`);
  return buttons.length ? `<div class="owner-actions">${buttons.join("")}</div>` : "";
}

async function renderReport() {
  const url = photoUrl(sb, report.photo_path);
  // Sem foto, o mapa do local ocupa o lugar dela (em vez de um quadro vazio).
  const media = url
    ? `<img class="detail-photo" src="${escapeHtml(url)}" alt="Foto de ${escapeHtml(reportTitle(report))}">
       <div class="detail-map" id="detail-map" aria-label="Local aproximado"></div>`
    : `<div class="detail-map detail-map-large" id="detail-map" aria-label="Local aproximado"></div>
       <p class="muted small">Este anúncio não tem foto. O ponto no mapa é aproximado, com cerca de 100 m de margem.</p>`;
  const [word, tone] = posterWord(report);

  document.title = `${reportTitle(report)} | PetSOS`;
  const contact = await contactHtml();
  const cta = contact.includes('id="contato"')
    ? `<div class="detail-cta"><a class="btn btn-primary btn-block" href="#contato">Enviar mensagem</a></div>` : "";
  root.innerHTML = `
    <div class="detail">
      <div class="detail-head">
        ${noticesHtml()}
        <div class="poster-head">
          <p class="poster-word poster-${tone}">${word}</p>
          <h1>${escapeHtml(posterTitle(report))}</h1>
          <p class="poster-where">${escapeHtml(report.neighborhood)}, ${relativeDate(report.event_date)}</p>
        </div>
        ${shareHtml()}
      </div>
      <div class="detail-media">${media}</div>
      <div class="detail-info">
        ${factsHtml(report)}
        ${report.description ? `<p class="description">${escapeHtml(report.description)}</p>` : ""}
        ${contact}
        ${ownerActionsHtml()}
      </div>
    </div>${cta}`;
  root.removeAttribute("aria-busy");
  bindStartForm();

  const map = createMap(document.getElementById("detail-map"), { center: [report.lat, report.lng], zoom: 15, interactive: false });
  L.circleMarker([report.lat, report.lng], markerStyle(report, true)).addTo(map);
  // O conteúdo chega depois do carregamento: o navegador não acha sozinho a âncora vinda de /comparar.
  if (location.hash === "#contato") document.getElementById("contato")?.scrollIntoView({ block: "center" });
}

async function refusedMatches() {
  if (!isOwner()) return new Set();
  const { data } = await sb.from("match_feedback").select("other_report_id").eq("report_id", report.id).eq("same_animal", false);
  return new Set((data ?? []).map((f) => f.other_report_id));
}

async function renderMatches() {
  const section = document.getElementById("matches-section");
  const panel = document.getElementById("matches-panel");
  if (report.status !== "open") return;
  section.hidden = false;
  const other = report.kind === "lost" ? "encontrados ou avistados" : "perdidos";
  document.getElementById("matches-intro").textContent =
    `Comparamos com animais ${other} por espécie, cores, porte, sexo, distância e data. A sugestão não confirma que é o mesmo animal: abra e compare.`;
  panel.innerHTML = `<ul class="report-list"><li class="skeleton-row" aria-hidden="true"><span></span><span></span></li><li class="skeleton-row" aria-hidden="true"><span></span><span></span></li></ul>`;

  let body, refused;
  try {
    const headers = me ? { Authorization: `Bearer ${me.session.access_token}` } : {};
    const res = await fetch(`/api/matches?id=${encodeURIComponent(report.id)}`, { headers });
    body = await res.json();
    if (!res.ok) throw new Error(body.error);
    refused = await refusedMatches();
  } catch {
    panel.innerHTML = `<div class="empty"><p>Não foi possível calcular os animais parecidos agora.</p><button type="button" class="btn btn-secondary" id="retry-matches">Tentar de novo</button></div>`;
    document.getElementById("retry-matches").addEventListener("click", renderMatches);
    return;
  }

  const matches = body.matches.filter(({ report: r }) => !refused.has(r.id));
  if (!matches.length) {
    const opposite = report.kind === "lost" ? "found" : "lost";
    panel.innerHTML = `<div class="empty"><h3>Nenhum animal parecido por enquanto</h3>
      <p class="muted">Cada novo anúncio do tipo oposto é comparado com este${isOwner() ? ", e você recebe um aviso quando surgir um parecido" : ""}. Enquanto isso, confira a lista completa.</p>
      <a class="btn btn-secondary" href="/?tipo=${opposite}&especie=${report.species}">Ver animais ${opposite === "found" ? "encontrados" : "perdidos"}</a></div>`;
    return;
  }

  panel.innerHTML = `<ul class="match-grid">${matches.map(({ report: r, score, reasons }) => `
    <li><a class="match-card" href="/comparar?a=${report.id}&b=${r.id}">
      ${thumbHtml(sb, r)}
      <div class="row-body">
        ${statusHtml(r)}
        <p class="match-tier">${matchTier(score)}</p>
        <p class="row-meta">${escapeHtml(reportTitle(r))}${r.custody === "sighted" ? ", só avistado" : ""}</p>
        <ul class="match-reasons">${reasons.slice(0, 2).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
        <p class="match-open">Comparar com este anúncio</p>
      </div>
    </a></li>`).join("")}</ul>`;
  if (params.get("novo") === "1") section.scrollIntoView({ block: "start", behavior: "auto" });
}

async function share() {
  const url = `${location.origin}/a/${report.id}`;
  const title = `${posterWord(report)[0]}: ${posterTitle(report)}, ${report.neighborhood}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text: "Ajude a reunir este animal com a família.", url });
    } catch { /* a pessoa desistiu de compartilhar */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copiado. Cole no grupo do bairro ou nas redes.");
  } catch {
    toast(`Copie o link: ${url}`);
  }
}

function bindOwnerActions() {
  root.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "share") return share();
    if (action === "flag") return flagDialog(sb, { report_id: report.id });
    if (action === "renew") {
      const { data, error } = await sb.rpc("renew_report", { p_report_id: report.id });
      if (error) return toast(errorText(error));
      report.expires_at = (Array.isArray(data) ? data[0] : data).expires_at;
      toast("Anúncio renovado por 60 dias.");
      return renderReport();
    }
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
      const paths = [report.photo_path, report.thumb_path].filter(Boolean);
      if (paths.length) await sb.storage.from(PHOTO_BUCKET).remove(paths);
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
    const { data, error } = await sb.from("reports").select(me ? REPORT_FIELDS : PUBLIC_REPORT_FIELDS).eq("id", id).maybeSingle();
    if (error) throw error;
    report = data;
  } catch (err) {
    root.innerHTML = "";
    showError(errorEl, CONNECTION_ERROR, err);
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
