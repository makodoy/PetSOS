import { getClient, REPORT_FIELDS } from "./supabase.js";
import { REVIEW_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, relativeDate, statusHtml, thumbHtml, reunitedSealHtml, reunitedMessage, showError, CONNECTION_ERROR } from "./ui.js";

const list = document.getElementById("my-list");

async function main() {
  initHeader();
  let sb, session;
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
  list.innerHTML = data.map((r) => `<li><a class="report-row${r.status === "reunited" ? " is-reunited" : ""}" href="/anuncio?id=${r.id}">
    ${thumbHtml(sb, r)}
    <div class="row-body">${statusHtml(r)}<h3>${escapeHtml(reportTitle(r))}</h3>
    ${r.status === "reunited" ? `<p class="reunited-message">${reunitedMessage(r)}</p>` : ""}
    <p class="row-meta">${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}</p>
    ${r.review_status !== "approved" ? `<p class="row-meta review-${r.review_status}">${REVIEW_LABEL[r.review_status]}${r.review_note ? `: ${escapeHtml(r.review_note)}` : ""}</p>` : ""}</div>
    ${r.status === "reunited" ? reunitedSealHtml() : ""}
  </a></li>`).join("");
}

main();
