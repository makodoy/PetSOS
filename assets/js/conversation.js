import { getClient, getProfile } from "./supabase.js";
import { CONVERSATION_SELECT, one, contextLine } from "./inbox.js";
import { initHeader, escapeHtml, reportTitle, thumbHtml, formatDateTime, formatDate, showError, toast, confirmDialog, errorText, CONNECTION_ERROR } from "./ui.js";

const id = new URLSearchParams(location.search).get("id");
const log = document.getElementById("chat-log");
const compose = document.getElementById("compose");
const panel = document.getElementById("handover");

let sb, me, conv, report, handover;
const seen = new Set();

const participant = () => me && (me.id === conv.asker_id || me.id === conv.owner_id);
const eligible = () => (report.kind === "found" ? report.custody === "with_finder" : conv.asker_context === "has_pet");
const finderId = () => (report.kind === "found" ? conv.owner_id : conv.asker_id);
const claimantId = () => (report.kind === "found" ? conv.asker_id : conv.owner_id);
const nameOf = (uid) => (uid === conv.asker_id ? conv.asker?.display_name : conv.owner?.display_name) || "usuário";

function renderHead() {
  const other = me.id === conv.asker_id ? conv.owner_id : conv.asker_id;
  document.getElementById("chat-head").innerHTML = `
    ${thumbHtml(sb, report)}
    <div class="row-body">
      <h1 id="chat-title" class="chat-title"><a href="/anuncio?id=${report.id}">${escapeHtml(reportTitle(report))}</a></h1>
      <p class="row-meta">${participant() ? `Conversa com ${escapeHtml(nameOf(other))}` : `Entre ${escapeHtml(nameOf(conv.asker_id))} e ${escapeHtml(nameOf(conv.owner_id))}`}. ${escapeHtml(contextLine(conv, me.id))}.</p>
    </div>`;
}

function appendMessage(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  const mine = m.sender_id === me.id;
  const li = document.createElement("li");
  li.className = `bubble ${mine ? "bubble-mine" : ""}`;
  li.innerHTML = `<p class="bubble-meta">${mine ? "Você" : escapeHtml(nameOf(m.sender_id))}, ${formatDateTime(m.created_at)}</p><p class="bubble-body"></p>`;
  li.querySelector(".bubble-body").textContent = m.body;
  log.querySelector(".chat-empty")?.remove();
  log.append(li);
  log.scrollTop = log.scrollHeight;
}

function step(label, state, detail = "") {
  return `<li class="step step-${state}"><span class="step-label">${label}</span>${detail ? `<span class="step-detail">${detail}</span>` : ""}</li>`;
}

function renderHandover() {
  const h = handover;
  const finder = escapeHtml(nameOf(finderId()));
  const claimant = escapeHtml(nameOf(claimantId()));
  let html = `<h2 id="handover-title">Entrega do animal</h2>`;

  if (!eligible()) {
    html += `<p class="muted">${report.kind === "found"
      ? "Neste anúncio o animal só foi avistado, então não há entrega para confirmar. Use a conversa para combinar onde procurar."
      : "Nesta conversa a pessoa viu o animal, mas ele não está com ela. Use a conversa para combinar onde procurar."}</p>`;
    panel.innerHTML = html;
    return;
  }

  const reviewState = !h || h.status === "under_review" || h.status === "rejected" ? "current" : "done";
  // Cada etapa mostra quando aconteceu (enquanto em análise, updated_at é o horário do envio).
  const reviewDetail = !h ? "Ainda não enviada"
    : h.status === "under_review" ? `Enviada em ${formatDateTime(h.updated_at)}; em análise`
    : `${h.status === "rejected" ? "Recusada" : "Aprovada"}${h.reviewed_at ? ` em ${formatDateTime(h.reviewed_at)}` : ""}`;
  const finderState = h?.finder_confirmed_at ? "done" : h?.status === "approved" ? "current" : "todo";
  const claimantState = h?.claimant_confirmed_at ? "done" : h?.status === "approved" ? "current" : "todo";
  html += `<ol class="steps">
    ${step("Um administrador revisa a conversa", reviewState, reviewDetail)}
    ${step(`${finder} confirma a entrega`, finderState, h?.finder_confirmed_at ? formatDateTime(h.finder_confirmed_at) : "")}
    ${step(`${claimant} confirma o recebimento`, claimantState, h?.claimant_confirmed_at ? formatDateTime(h.claimant_confirmed_at) : "")}
  </ol>`;

  const isFinder = me.id === finderId();
  const isClaimant = me.id === claimantId();
  const open = report.status === "open";
  let note = "";
  let actions = "";

  if (!h) {
    if (isFinder && open) {
      note = `Quando ${claimant} descrever sinais que só o tutor saberia, envie a conversa para revisão.`;
      actions = `<button type="button" class="btn btn-primary btn-block" data-act="request">Enviar conversa para revisão</button>`;
    } else if (isClaimant) {
      note = `Descreva sinais que só o tutor saberia: cicatrizes, manias, coleira. Depois, ${finder} envia a conversa para revisão.`;
    }
  } else if (h.status === "under_review") {
    note = "Um administrador está lendo a conversa. A resposta aparece aqui.";
  } else if (h.status === "rejected") {
    note = `Revisão recusada: ${escapeHtml((h.admin_note || "sem motivo informado").replace(/[.!]+$/, ""))}.`;
    if (isFinder && open) actions = `<button type="button" class="btn btn-primary btn-block" data-act="request">Enviar conversa novamente</button>`;
  } else if (h.status === "approved") {
    note = `Entrega liberada${h.admin_note ? `: ${escapeHtml(h.admin_note.replace(/[.!]+$/, ""))}` : ""}. Combinem um lugar público e movimentado.`;
    if (isFinder && !h.finder_confirmed_at) actions = `<button type="button" class="btn btn-primary btn-block" data-act="confirm">Confirmar que entreguei</button>`;
    else if (isClaimant && !h.claimant_confirmed_at) actions = `<button type="button" class="btn btn-primary btn-block" data-act="confirm">Confirmar que recebi</button>`;
    else if (isFinder || isClaimant) note += ` Você já confirmou; falta ${isFinder ? claimant : finder} confirmar.`;
  } else if (h.status === "completed") {
    note = `Entrega confirmada pelas duas pessoas em ${formatDate(h.updated_at)}. O anúncio foi marcado como reencontrado.`;
  }
  if (!participant()) actions = "";
  panel.innerHTML = html + (note ? `<p class="handover-note">${note}</p>` : "") + actions + `<p class="field-error" id="handover-error" role="alert"></p>`;
}

panel.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const claimant = nameOf(claimantId());
  const finder = nameOf(finderId());
  let ok;
  if (act === "request") {
    ok = await confirmDialog({
      title: "Enviar conversa para revisão?",
      body: `Um administrador vai ler a conversa até agora para conferir se ${claimant} é o tutor. Mensagens enviadas depois não entram na revisão.`,
      confirmLabel: "Enviar para revisão",
    });
  } else {
    const isFinder = me.id === finderId();
    ok = await confirmDialog({
      title: isFinder ? `Você entregou o animal para ${claimant}?` : `Você recebeu o animal de ${finder}?`,
      body: "Confirme só depois da entrega. Quando as duas pessoas confirmarem, o anúncio vira reencontrado e não pode ser desfeito.",
      confirmLabel: isFinder ? "Confirmar que entreguei" : "Confirmar que recebi",
    });
  }
  if (!ok) return;
  const { data, error } = act === "request"
    ? await sb.rpc("request_handover", { p_conversation_id: conv.id })
    : await sb.rpc("confirm_handover", { p_handover_id: handover.id });
  if (error) {
    document.getElementById("handover-error").textContent = errorText(error);
    return;
  }
  handover = Array.isArray(data) ? data[0] : data;
  if (handover.status === "completed") report.status = "reunited";
  toast(act === "request" ? "Conversa enviada para revisão." : "Confirmação registrada.");
  renderHandover();
});

compose.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = compose.message.value.trim();
  const err = document.getElementById("compose-error");
  if (!text) {
    err.textContent = "Escreva a mensagem antes de enviar.";
    compose.message.focus();
    return;
  }
  const btn = document.getElementById("send-btn");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  btn.textContent = "Enviando…";
  const { data, error } = await sb.from("messages").insert({ conversation_id: conv.id, sender_id: me.id, body: text }).select().single();
  btn.removeAttribute("aria-busy");
  btn.disabled = false;
  btn.textContent = "Enviar";
  if (error) {
    err.textContent = "A mensagem não foi enviada, mas o texto continua no campo. Verifique a conexão e tente de novo.";
    return;
  }
  err.textContent = "";
  compose.message.value = "";
  appendMessage(data);
  compose.message.focus();
});
compose.message.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    compose.requestSubmit();
  }
});
compose.message.addEventListener("input", () => (document.getElementById("compose-error").textContent = ""));

async function main() {
  initHeader();
  try {
    sb = await getClient();
    me = await getProfile();
  } catch (err) {
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  if (!me) return location.replace(`/entrar?next=${encodeURIComponent(location.pathname + location.search)}`);

  const { data, error } = await sb.from("conversations").select(CONVERSATION_SELECT).eq("id", id).maybeSingle();
  if (error || !data || !data.report) {
    return showError(document.getElementById("page-error"), error ? CONNECTION_ERROR : "Esta conversa não existe ou você não participa dela.", error);
  }
  conv = data;
  report = data.report;
  const [{ data: msgs }, { data: h }] = await Promise.all([
    sb.from("messages").select("id,sender_id,body,created_at").eq("conversation_id", id).order("created_at"),
    sb.from("handovers").select("*").eq("conversation_id", id).maybeSingle(),
  ]);
  handover = h;

  document.getElementById("chat-root").hidden = false;
  renderHead();
  if (!msgs?.length) log.innerHTML = `<li class="chat-empty muted">Nenhuma mensagem ainda.${participant() ? " Escreva no campo abaixo para começar a conversa." : ""}</li>`;
  (msgs || []).forEach(appendMessage);
  compose.hidden = !participant();
  renderHandover();

  sb.channel(`conversa-${id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, (p) => appendMessage(p.new))
    .on("postgres_changes", { event: "*", schema: "public", table: "handovers", filter: `conversation_id=eq.${id}` }, (p) => {
      handover = p.new;
      if (handover.status === "completed") report.status = "reunited";
      renderHandover();
    })
    .subscribe();
}

main();
