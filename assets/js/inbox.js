import { getClient, getProfile } from "./supabase.js";
import { HANDOVER_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, thumbHtml, formatDateTime, showError, CONNECTION_ERROR } from "./ui.js";

const list = document.getElementById("inbox");
const reportFilter = new URLSearchParams(location.search).get("anuncio");

export const CONVERSATION_SELECT = `id, report_id, asker_id, owner_id, asker_context, last_message_at,
  report:reports(id, kind, species, custody, pet_name, photo_path, status, neighborhood),
  asker:profiles!conversations_asker_id_fkey(display_name),
  owner:profiles!conversations_owner_id_fkey(display_name),
  handovers(id, status)`;

export function one(value) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

// Frase curta descrevendo a conversa do ponto de vista de quem está lendo.
export function contextLine(c, meId) {
  const iAmAsker = c.asker_id === meId;
  const other = iAmAsker ? c.owner?.display_name : c.asker?.display_name;
  const who = iAmAsker ? "Você" : other || "A pessoa";
  if (c.asker_context === "has_pet") return `${who} está com o animal`;
  if (c.asker_context === "sighted") return `${who} viu o animal`;
  return iAmAsker ? "Sua pergunta sobre o animal" : `${who} perguntou sobre o animal`;
}

async function main() {
  initHeader();
  let sb, me;
  try {
    sb = await getClient();
    me = await getProfile();
  } catch (err) {
    list.innerHTML = "";
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  if (!me) return location.replace("/entrar?next=/conversas");

  let query = sb.from("conversations").select(CONVERSATION_SELECT)
    .or(`asker_id.eq.${me.id},owner_id.eq.${me.id}`)
    .order("last_message_at", { ascending: false });
  if (reportFilter) query = query.eq("report_id", reportFilter);
  const { data, error } = await query;
  if (error) {
    list.innerHTML = "";
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, error);
  }
  if (reportFilter) {
    document.getElementById("inbox-sub").innerHTML = `Conversas sobre um anúncio seu. <a href="/conversas">Ver todas</a>`;
  }
  if (!data.length) {
    list.innerHTML = `<li class="empty"><h3>Nenhuma conversa ainda</h3>
      <p class="muted">Abra um anúncio e use "Enviar mensagem" para falar com quem viu, encontrou ou perdeu o animal.</p>
      <a class="btn btn-secondary" href="/">Ver animais</a></li>`;
    return;
  }
  list.innerHTML = data.map((c) => {
    const other = c.asker_id === me.id ? c.owner?.display_name : c.asker?.display_name;
    const h = one(c.handovers);
    return `<li><a class="report-row" href="/conversa?id=${c.id}">
      ${c.report ? thumbHtml(sb, c.report) : ""}
      <div class="row-body">
        <h3>${escapeHtml(c.report ? reportTitle(c.report) : "Anúncio removido")}</h3>
        <p class="row-meta">Com ${escapeHtml(other || "usuário")}. ${escapeHtml(contextLine(c, me.id))}</p>
        <p class="row-meta">${h ? `<strong>${HANDOVER_LABEL[h.status]}</strong>, ` : ""}${formatDateTime(c.last_message_at)}</p>
      </div>
    </a></li>`;
  }).join("");
}

if (document.getElementById("inbox")) main();
