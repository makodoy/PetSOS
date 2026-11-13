import { getClient, getProfile } from "./supabase.js";
import { CONVERSATION_SELECT, contextLine } from "./inbox.js";
import { HANDOVER_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, thumbHtml, formatDateTime, formatDate, showError, toast, confirmDialog, flagDialog, errorText, CONNECTION_ERROR } from "./ui.js";

const id = new URLSearchParams(location.search).get("id");
const log = document.getElementById("chat-log");
const compose = document.getElementById("compose");
const panel = document.getElementById("handover");
const panelBox = document.getElementById("handover-box");
const statusLine = document.getElementById("handover-status");
const safety = document.getElementById("safety");

let sb, me, conv, report, handover, blockedByMe = false;
const seen = new Set();
let lastMessageId = 0;

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
  lastMessageId = Math.max(lastMessageId, m.id);
  const mine = m.sender_id === me.id;
  const li = document.createElement("li");
  li.className = `bubble ${mine ? "bubble-mine" : ""}`;
  li.innerHTML = `<p class="bubble-meta">${mine ? "Você" : escapeHtml(nameOf(m.sender_id))}, ${formatDateTime(m.created_at)}</p><p class="bubble-body"></p>`;
  li.querySelector(".bubble-body").textContent = m.body;
  log.querySelector(".chat-empty")?.remove();
  log.append(li);
  log.scrollTop = log.scrollHeight;
  if (!mine) markRead();
}

function markRead() {
  if (!participant() || document.visibilityState !== "visible") return;
  sb.from("notifications").update({ read_at: new Date().toISOString() })
    .eq("user_id", me.id).eq("conversation_id", conv.id).is("read_at", null).then(() => {});
}

// O Realtime não reenvia o que passou enquanto a conexão caiu (celular em espera, troca de rede).
async function syncAfterGap() {
  const { data: msgs } = await sb.from("messages").select("id,sender_id,body,created_at")
    .eq("conversation_id", id).gt("id", lastMessageId).order("id");
  (msgs || []).forEach(appendMessage);
  const { data: h } = await sb.from("handovers").select("*").eq("conversation_id", id).maybeSingle();
  if (h) applyHandover(h);
}

function applyHandover(h) {
  handover = h;
  if (handover.status === "completed") report.status = "reunited";
  renderHandover();
}

function step(label, state, detail = "") {
  return `<li class="step step-${state}"><span class="step-label">${label}</span>${detail ? `<span class="step-detail">${detail}</span>` : ""}</li>`;
}

function renderHandover() {
  const h = handover;
  const finder = escapeHtml(nameOf(finderId()));
  const claimant = escapeHtml(nameOf(claimantId()));
  let html = "";

  if (!eligible()) {
    html += `<p class="muted">${report.kind === "found"
      ? "Neste anúncio o animal só foi avistado, então não há entrega para confirmar. Use a conversa para combinar onde procurar."
      : "Nesta conversa a pessoa viu o animal, mas ele não está com ela. Use a conversa para combinar onde procurar."}</p>`;
    panel.innerHTML = html;
    statusLine.textContent = "Sem entrega nesta conversa";
    return;
  }

  const active = h && h.status !== "rejected";
  const startState = active ? "done" : "current";
  const startDetail = !h ? "Ainda não iniciada"
    : h.status === "rejected" ? `Cancelada pela moderação${h.reviewed_at ? ` em ${formatDateTime(h.reviewed_at)}` : ""}`
    : `Iniciada em ${formatDateTime(h.created_at)}`;
  const finderState = h?.finder_confirmed_at && active ? "done" : active ? "current" : "todo";
  const claimantState = h?.claimant_confirmed_at && active ? "done" : active ? "current" : "todo";
  html += `<ol class="steps">
    ${step(`${finder} inicia a entrega`, startState, startDetail)}
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
      note = `Peça a ${claimant} sinais que só o tutor saberia. Quando tiver certeza, inicie a entrega e combinem um lugar público e movimentado.`;
      actions = `<button type="button" class="btn btn-primary btn-block" data-act="request">Iniciar entrega</button>`;
    } else if (isClaimant) {
      note = `Descreva sinais que só o tutor saberia: cicatrizes, manias, coleira. Depois, ${finder} inicia a entrega.`;
    }
  } else if (h.status === "rejected") {
    note = `Entrega cancelada pela moderação: ${escapeHtml((h.admin_note || "sem motivo informado").replace(/[.!]+$/, ""))}.`;
    if (isFinder && open) actions = `<button type="button" class="btn btn-primary btn-block" data-act="request">Iniciar entrega de novo</button>`;
  } else if (h.status === "under_review" || h.status === "approved") {
    note = "Combinem um lugar público e movimentado e, se puderem, vão acompanhados. Não paguem nem peçam dinheiro pela devolução.";
    if (!open) note = "Este anúncio foi encerrado, então a entrega não pode mais ser confirmada.";
    else if (isFinder && !h.finder_confirmed_at) actions = `<button type="button" class="btn btn-primary btn-block" data-act="confirm">Confirmar que entreguei</button>`;
    else if (isClaimant && !h.claimant_confirmed_at) actions = `<button type="button" class="btn btn-primary btn-block" data-act="confirm">Confirmar que recebi</button>`;
    else if (isFinder || isClaimant) note += ` Você já confirmou; falta ${isFinder ? claimant : finder} confirmar.`;
  } else if (h.status === "completed") {
    note = `Entrega confirmada pelas duas pessoas em ${formatDate(h.updated_at)}. O anúncio foi marcado como reencontrado.`;
  }
  if (!participant()) actions = "";
  statusLine.textContent = !h ? "Não iniciada" : HANDOVER_LABEL[h.status];
  panel.innerHTML = html + (note ? `<p class="handover-note">${note}</p>` : "") + actions + `<p class="field-error" id="handover-error" role="alert"></p>`;
}

function otherId() {
  return me.id === conv.asker_id ? conv.owner_id : conv.asker_id;
}

function renderSafety() {
  if (!participant()) {
    safety.hidden = true;
    return;
  }
  const other = escapeHtml(nameOf(otherId()));
  safety.innerHTML = `<p class="small muted">Algo estranho na conversa? Pedido de dinheiro ou de dados é sinal de golpe.</p>
    <div class="safety-actions">
      <button type="button" class="btn btn-secondary btn-small" data-safety="flag">Denunciar conversa</button>
      <button type="button" class="btn btn-secondary btn-small" data-safety="${blockedByMe ? "unblock" : "block"}">${blockedByMe ? `Desbloquear ${other}` : `Bloquear ${other}`}</button>
    </div>`;
}

safety.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-safety]")?.dataset.safety;
  if (act === "flag") return flagDialog(sb, { conversation_id: conv.id });
  if (act === "block") {
    const ok = await confirmDialog({
      title: `Bloquear ${nameOf(otherId())}?`,
      body: "Vocês não poderão mais trocar mensagens no PetSOS, e essa pessoa não poderá abrir novas conversas com você. Ela não é avisada.",
      confirmLabel: "Bloquear pessoa",
      danger: true,
    });
    if (!ok) return;
    const { error } = await sb.from("blocks").insert({ blocker_id: me.id, blocked_id: otherId() });
    if (error) return toast(errorText(error));
    blockedByMe = true;
    toast("Pessoa bloqueada.");
  }
  if (act === "unblock") {
    const { error } = await sb.from("blocks").delete().eq("blocker_id", me.id).eq("blocked_id", otherId());
    if (error) return toast(errorText(error));
    blockedByMe = false;
    toast("Pessoa desbloqueada.");
  }
  renderSafety();
});

panel.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const claimant = nameOf(claimantId());
  const finder = nameOf(finderId());
  let ok;
  if (act === "request") {
    ok = await confirmDialog({
      title: `Iniciar a entrega para ${claimant}?`,
      body: "Use quando estiver convencido de que é o tutor. Guardamos uma cópia da conversa até agora, consultada só em caso de denúncia.",
      confirmLabel: "Iniciar entrega",
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
  toast(act === "request" ? "Entrega iniciada." : "Confirmação registrada.");
  applyHandover(Array.isArray(data) ? data[0] : data);
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
    err.textContent = errorText(error, "A mensagem não foi enviada, mas o texto continua no campo. Verifique a conexão e tente de novo.");
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
  if (participant()) {
    const { data: block } = await sb.from("blocks").select("blocked_id").eq("blocker_id", me.id).eq("blocked_id", otherId()).maybeSingle();
    blockedByMe = Boolean(block);
  }
  // Na tela larga, o painel de entrega fica aberto ao lado; no celular, recolhido para a conversa caber na tela.
  panelBox.open = matchMedia("(min-width: 881px)").matches;

  document.getElementById("chat-root").hidden = false;
  renderHead();
  if (!msgs?.length) log.innerHTML = `<li class="chat-empty muted">Nenhuma mensagem ainda.${participant() ? " Escreva no campo abaixo para começar a conversa." : ""}</li>`;
  (msgs || []).forEach(appendMessage);
  compose.hidden = !participant();
  renderHandover();
  renderSafety();
  markRead();

  let everSubscribed = false;
  sb.channel(`conversa-${id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, (p) => appendMessage(p.new))
    .on("postgres_changes", { event: "*", schema: "public", table: "handovers", filter: `conversation_id=eq.${id}` }, (p) => applyHandover(p.new))
    .subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      if (everSubscribed) syncAfterGap();
      everSubscribed = true;
    });
  window.addEventListener("online", syncAfterGap);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    syncAfterGap();
    markRead();
  });
}

main();
