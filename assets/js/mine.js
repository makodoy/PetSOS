import { getClient, REPORT_FIELDS } from "./supabase.js";
import { REVIEW_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, relativeDate, statusHtml, thumbHtml, reunitedSealHtml, reunitedMessage, showError, toast, errorText, CONNECTION_ERROR } from "./ui.js";

const list = document.getElementById("my-list");
let sb;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function noticeHref(n) {
  if (n.kind === "match" && n.other_report_id) return `/comparar?a=${n.report_id}&b=${n.other_report_id}`;
  if (n.conversation_id) return `/conversa?id=${n.conversation_id}`;
  return n.report_id ? `/anuncio?id=${n.report_id}` : "/meus";
}

// Avisos novos aparecem aqui uma vez e já contam como lidos.
async function renderNotices(userId) {
  const { data } = await sb.from("notifications").select("id,kind,report_id,other_report_id,conversation_id,body")
    .eq("user_id", userId).is("read_at", null).not("kind", "in", "(message,moderation)")
    .order("created_at", { ascending: false }).limit(20);
  if (!data?.length) return;
  document.getElementById("notice-panel").hidden = false;
  document.getElementById("notices").innerHTML = data.map((n) => `<li><a href="${noticeHref(n)}">${escapeHtml(n.body)}</a></li>`).join("");
  await sb.from("notifications").update({ read_at: new Date().toISOString() }).in("id", data.map((n) => n.id));
}

function caseFacts(r, matches, conversations, unread) {
  if (r.status !== "open") return "";
  const parts = [];
  if (matches) parts.push(plural(matches, "animal parecido", "animais parecidos"));
  if (conversations) parts.push(plural(conversations, "conversa", "conversas"));
  if (unread) parts.push(plural(unread, "com mensagem nova", "com mensagem nova"));
  return parts.length ? `<p class="case-facts">${parts.join(", ")}</p>` : "";
}

function expiryHtml(r) {
  if (r.status !== "open") return "";
  const expired = new Date(r.expires_at) < new Date();
  const soon = new Date(r.expires_at) < new Date(Date.now() + 7 * 86400000);
  if (!soon) return "";
  return `<div class="case-actions"><p class="small muted" style="flex:1 1 100%">${expired ? "Venceu e saiu da lista." : "Vence em breve."}</p>
    <button type="button" class="btn btn-secondary btn-small" data-renew="${r.id}">Renovar por 60 dias</button></div>`;
}

function rowHtml(r, counts) {
  const c = counts.get(r.id) ?? {};
  return `<li class="case-row"><a class="report-row${r.status === "reunited" ? " is-reunited" : ""}" href="/anuncio?id=${r.id}">
    ${thumbHtml(sb, r)}
    <div class="row-body">${statusHtml(r)}<h3>${escapeHtml(reportTitle(r))}</h3>
    ${r.status === "reunited" ? `<p class="reunited-message">${reunitedMessage(r)}</p>` : ""}
    <p class="row-meta">${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}</p>
    ${caseFacts(r, c.matches, c.conversations, c.unread)}
    ${r.review_status !== "approved" ? `<p class="row-meta review-${r.review_status}">${REVIEW_LABEL[r.review_status]}${r.review_note ? `: ${escapeHtml(r.review_note)}` : ""}</p>` : ""}</div>
    ${r.status === "reunited" ? reunitedSealHtml() : ""}
  </a>${expiryHtml(r)}</li>`;
}

async function caseCounts(reports, userId) {
  const ids = reports.map((r) => r.id);
  const counts = new Map(ids.map((id) => [id, { matches: 0, conversations: 0, unread: 0 }]));
  if (!ids.length) return counts;
  const [matches, conversations, unread, refused] = await Promise.all([
    sb.from("matches").select("report_id, other_report_id, other:reports!matches_other_report_id_fkey(status)").in("report_id", ids),
    sb.from("conversations").select("report_id").in("report_id", ids),
    sb.from("notifications").select("report_id").eq("user_id", userId).eq("kind", "message").is("read_at", null).in("report_id", ids),
    sb.from("match_feedback").select("report_id, other_report_id").eq("same_animal", false).in("report_id", ids),
  ]);
  const refusedPairs = new Set((refused.data ?? []).map((f) => `${f.report_id}:${f.other_report_id}`));
  (matches.data ?? []).forEach((m) => {
    if (m.other?.status === "open" && !refusedPairs.has(`${m.report_id}:${m.other_report_id}`)) counts.get(m.report_id).matches++;
  });
  (conversations.data ?? []).forEach((c) => counts.get(c.report_id).conversations++);
  (unread.data ?? []).forEach((n) => counts.get(n.report_id).unread++);
  return counts;
}

list.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-renew]");
  if (!btn) return;
  btn.disabled = true;
  const { error } = await sb.rpc("renew_report", { p_report_id: btn.dataset.renew });
  if (error) {
    btn.disabled = false;
    return toast(errorText(error));
  }
  toast("Anúncio renovado por 60 dias.");
  btn.closest(".case-actions").remove();
});

async function main() {
  initHeader();
  let session;
  try {
    sb = await getClient();
    session = (await sb.auth.getSession()).data.session;
  } catch (err) {
    list.innerHTML = "";
    showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
    return;
  }
  if (!session) {
    location.replace("/entrar?next=/meus");
    return;
  }
  renderNotices(session.user.id);
  const { data, error } = await sb.from("reports").select(REPORT_FIELDS).eq("user_id", session.user.id).order("created_at", { ascending: false });
  if (error) {
    list.innerHTML = "";
    showError(document.getElementById("page-error"), CONNECTION_ERROR, error);
    return;
  }
  if (!data.length) {
    list.innerHTML = `<li class="empty"><h3>Você ainda não tem anúncios</h3><p class="muted">Anuncie um animal perdido ou encontrado e veja na hora os mais parecidos.</p><a class="btn btn-primary" href="/anunciar">Anunciar animal</a></li>`;
    return;
  }
  const counts = await caseCounts(data, session.user.id);
  list.innerHTML = data.map((r) => rowHtml(r, counts)).join("");
}

main();
