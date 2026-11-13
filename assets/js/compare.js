import { getClient, getProfile, REPORT_FIELDS, PUBLIC_REPORT_FIELDS } from "./supabase.js";
import { COLOR_LABEL, SIZE_LABEL, SEX_LABEL } from "./constants.js";
import { initHeader, escapeHtml, posterTitle, photoUrl, pawIcon, formatDate, statusHtml, matchTier, toast, errorText, showError, CONNECTION_ERROR } from "./ui.js";

const root = document.getElementById("compare-root");
const params = new URLSearchParams(location.search);
const [aId, bId] = [params.get("a"), params.get("b")];

function sideHtml(sb, r) {
  const url = photoUrl(sb, r.photo_path);
  const facts = [
    ["Cores", r.colors.map((c) => COLOR_LABEL[c] ?? c).join(", ")],
    ["Porte", SIZE_LABEL[r.size]],
    ["Sexo", SEX_LABEL[r.sex]],
    ["Raça", r.breed],
    ["Bairro", r.neighborhood],
    [r.kind === "lost" ? "Sumiu em" : "Visto em", formatDate(r.event_date)],
  ].filter(([, v]) => v);
  return `<section class="compare-side">
    ${url ? `<img class="detail-photo" src="${escapeHtml(url)}" alt="Foto de ${escapeHtml(posterTitle(r))}">` : `<div class="detail-photo">${pawIcon}</div>`}
    ${statusHtml(r)}
    <h2><a href="/anuncio?id=${r.id}">${escapeHtml(posterTitle(r))}</a></h2>
    <dl class="facts">${facts.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
    ${r.description ? `<p class="description">${escapeHtml(r.description)}</p>` : ""}
  </section>`;
}

async function main() {
  initHeader();
  document.getElementById("compare-back").href = `/anuncio?id=${encodeURIComponent(aId ?? "")}`;
  let sb, me, rows;
  try {
    sb = await getClient();
    me = await getProfile();
    const { data, error } = await sb.from("reports").select(me ? REPORT_FIELDS : PUBLIC_REPORT_FIELDS).in("id", [aId, bId]);
    if (error) throw error;
    rows = data;
  } catch (err) {
    root.innerHTML = "";
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  const a = rows.find((r) => r.id === aId);
  const b = rows.find((r) => r.id === bId);
  if (!a || !b) {
    root.innerHTML = `<div class="panel empty"><h3>Não foi possível comparar</h3><p class="muted">Um dos anúncios pode ter sido excluído ou encerrado.</p><a class="btn btn-secondary" href="/">Ver todos os animais</a></div>`;
    return;
  }
  let tier = "";
  try {
    const headers = me ? { Authorization: `Bearer ${me.session.access_token}` } : {};
    const res = await fetch(`/api/matches?id=${encodeURIComponent(a.id)}`, { headers });
    const found = (await res.json()).matches?.find((m) => m.report.id === b.id);
    if (found) tier = `<p class="match-tier">${matchTier(found.score)}</p><ul class="compare-reasons">${found.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  } catch { /* a comparação lado a lado continua útil sem a nota */ }

  const mine = me && a.user_id === me.id;
  root.innerHTML = `<div class="page-head"><h1>É o mesmo animal?</h1>
      <p>Confira marcas, coleira e formato das manchas. A sugestão compara dados dos anúncios e não confirma que é o mesmo animal.</p>${tier}</div>
    <div class="compare">${sideHtml(sb, a)}${sideHtml(sb, b)}</div>
    <div class="compare-actions">
      ${b.has_owner ? `<a class="btn btn-primary" href="/anuncio?id=${b.id}#contato">Pode ser: enviar mensagem</a>` : ""}
      ${mine ? `<button type="button" class="btn btn-secondary" id="not-same">Não é este animal</button>` : ""}
    </div>`;
  root.removeAttribute("aria-busy");
  document.getElementById("not-same")?.addEventListener("click", async () => {
    const { error } = await sb.from("match_feedback").upsert({ user_id: me.id, report_id: a.id, other_report_id: b.id, same_animal: false });
    if (error) return toast(errorText(error));
    location.href = `/anuncio?id=${a.id}`;
  });
}

main();
