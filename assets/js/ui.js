import { getClient, getProfile, PHOTO_BUCKET } from "./supabase.js";
import { SPECIES_LABEL, KIND_LABEL, COLOR_LABEL } from "./constants.js";

export const pawIcon = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="6" cy="10" rx="2.2" ry="2.8"/><ellipse cx="10" cy="6" rx="2.2" ry="2.8"/><ellipse cx="14.5" cy="6" rx="2.2" ry="2.8"/><ellipse cx="18.5" cy="10" rx="2.2" ry="2.8"/><path d="M12.2 11.5c-3 0-6.2 4.3-6.2 6.6 0 1.7 1.4 2.4 3 2.4 1.3 0 2-.6 3.2-.6s1.9.6 3.2.6c1.6 0 3-.7 3-2.4 0-2.3-3.2-6.6-6.2-6.6z"/></svg>`;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function reportTitle(r) {
  if (r.pet_name) return r.pet_name;
  const species = SPECIES_LABEL[r.species] ?? "Animal";
  const kind = r.kind === "lost" ? "perdido" : "encontrado";
  return `${species} ${kind}`;
}

// Palavra grande do cartaz: a situação do animal, como num cartaz de poste.
export function posterWord(r) {
  if (r.status === "reunited") return ["Reencontrado", "found"];
  if (r.status === "closed") return ["Encerrado", "closed"];
  if (r.kind === "lost") return ["Perdido", "lost"];
  return [r.custody === "sighted" ? "Avistado" : "Encontrado", "found"];
}

// Título da página do anúncio: abaixo da palavra grande do cartaz, repetir "encontrado" não ajuda a reconhecer o animal.
export function posterTitle(r) {
  if (r.pet_name) return r.pet_name;
  const colors = (r.colors ?? []).map((c) => (COLOR_LABEL[c] ?? c).toLowerCase());
  const listed = colors.length > 1 ? `${colors.slice(0, -1).join(", ")} e ${colors.at(-1)}` : colors[0] ?? "";
  return `${SPECIES_LABEL[r.species] ?? "Animal"} ${listed}`.trim();
}

// Faixa em vez de percentual: a nota compara atributos, não confirma que é o mesmo animal.
export function matchTier(score) {
  if (score >= 0.75) return "Muito parecido";
  if (score >= 0.6) return "Parecido";
  return "Pode ser";
}

export function relativeDate(isoDate) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  return d.toLocaleDateString("pt-BR");
}

export function formatDate(isoDate) {
  return new Date(`${String(isoDate).slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
}

export function statusHtml(r) {
  if (r.status === "reunited") return `<span class="status status-found">Reencontrado</span>`;
  if (r.status === "closed") return `<span class="status status-closed">Encerrado</span>`;
  return `<span class="status status-${r.kind}">${KIND_LABEL[r.kind]}</span>`;
}

// Selo e frase dos anúncios concluídos pela entrega com dupla confirmação.
export function reunitedSealHtml() {
  return `<span class="seal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Finalizado!</span>`;
}

export function reunitedMessage(r) {
  return r.kind === "found" ? "Dono encontrado e pet seguro!" : "Pet encontrado e de volta para casa!";
}

export function photoUrl(sb, path) {
  return path ? sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl : null;
}

export function thumbHtml(sb, r, className = "thumb") {
  const url = photoUrl(sb, r.thumb_path || r.photo_path);
  if (url) return `<img class="${className}" src="${escapeHtml(url)}" alt="" loading="lazy" width="480" height="360">`;
  return `<div class="${className}">${pawIcon}</div>`;
}

export function toast(message) {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  region.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (region.innerHTML = ""), 4000);
}

// Erro de página: texto sem jargão + saída (tentar de novo). Detalhes técnicos só no botão de copiar.
export function showError(container, message, error = null) {
  const details = error ? String(error.message || error) : "";
  const retry = Boolean(error) || message === CONNECTION_ERROR;
  container.innerHTML = `<div class="banner-error" role="alert"><p>${escapeHtml(message)}</p>
    ${retry ? `<div class="banner-actions">
      <button type="button" class="btn btn-secondary" data-error-retry>Tentar de novo</button>
      ${details ? `<button type="button" class="btn btn-secondary" data-error-copy>Copiar detalhes do erro</button>` : ""}
    </div>` : ""}</div>`;
  container.querySelector("[data-error-retry]")?.addEventListener("click", () => location.reload());
  container.querySelector("[data-error-copy]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${details}\n${location.href}`);
      toast("Detalhes copiados.");
    } catch {
      toast("Não foi possível copiar. Selecione o texto da mensagem e copie manualmente.");
    }
  });
}

export function safeNext(value, fallback = "/") {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// P0001 é o código do "raise exception" das regras do banco, escritas em português. O resto vira texto genérico.
export function errorText(error, fallback = "Não foi possível concluir agora. Verifique a conexão e tente de novo.") {
  return error?.code === "P0001" && error.message ? error.message : fallback;
}

// Denúncia de anúncio ou conversa. O banco aceita uma por pessoa e por item.
export async function flagDialog(sb, target) {
  const res = await confirmDialog({
    title: "Denunciar para a moderação?",
    body: "Um administrador vai analisar. A outra pessoa não fica sabendo quem denunciou.",
    confirmLabel: "Enviar denúncia",
    reasonLabel: "O que aconteceu?",
    reasonRequired: true,
  });
  if (!res.ok) return;
  const { error } = await sb.from("flags").insert({ ...target, reason: res.reason });
  if (error?.code === "23505") return toast("Você já denunciou este item. A moderação vai analisar.");
  toast(error ? errorText(error) : "Denúncia enviada para a moderação.");
}

// Diálogo de confirmação reutilizável. Retorna true/false (e o texto, quando há campo de motivo).
export function confirmDialog({ title, body, confirmLabel, danger = false, reasonLabel = null, reasonRequired = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-labelledby", "confirm-title");
    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2 id="confirm-title">${escapeHtml(title)}</h2>
      ${body ? `<p class="muted">${escapeHtml(body)}</p>` : ""}
      ${reasonLabel ? `<div class="field" style="margin-top:var(--s4)"><label for="confirm-reason">${escapeHtml(reasonLabel)}</label>
        <textarea id="confirm-reason" maxlength="500"></textarea><p class="field-error" id="confirm-reason-error"></p></div>` : ""}
      <div class="dialog-actions">
        <button class="btn btn-secondary" value="cancel" type="submit"${danger ? " autofocus" : ""}>Voltar</button>
        <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" value="confirm" type="submit">${escapeHtml(confirmLabel)}</button>
      </div></form>`;
    document.body.append(dialog);
    const reason = dialog.querySelector("#confirm-reason");
    dialog.querySelector("form").addEventListener("submit", (e) => {
      if (e.submitter?.value === "confirm" && reasonRequired && !reason.value.trim()) {
        e.preventDefault();
        dialog.querySelector("#confirm-reason-error").textContent = "Escreva o motivo para continuar.";
        reason.setAttribute("aria-invalid", "true");
        reason.focus();
      }
    });
    reason?.addEventListener("input", () => {
      reason.removeAttribute("aria-invalid");
      dialog.querySelector("#confirm-reason-error").textContent = "";
    });
    dialog.addEventListener("close", () => {
      const ok = dialog.returnValue === "confirm";
      const text = reason?.value.trim() ?? "";
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      resolve(reasonLabel ? { ok, reason: text } : ok);
    });
    dialog.showModal();
  });
}

const THEME_KEY = "petsos:theme";
const THEME_COLOR = { light: "#F4F5F2", dark: "#161B19" };

// O <head> de cada página já aplica o tema salvo antes de desenhar (evita piscar); aqui só o botão.
function initThemeToggle() {
  const button = document.querySelector(".theme-toggle");
  if (!button) return;
  // Tooltip real (hover e foco); o nome acessível continua no aria-label.
  const tip = document.createElement("span");
  tip.className = "tooltip";
  tip.setAttribute("aria-hidden", "true");
  button.append(tip);
  const sync = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    const label = dark ? "Usar tema claro" : "Usar tema escuro";
    button.setAttribute("aria-label", label);
    tip.textContent = label;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[dark ? "dark" : "light"]);
  };
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    if (next === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* navegação privada: vale só nesta página */ }
    sync();
    window.dispatchEvent(new Event("petsos:themechange"));
  });
  sync();
}

const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="6" cy="10" rx="2.2" ry="2.8"/><ellipse cx="10" cy="6" rx="2.2" ry="2.8"/><ellipse cx="14.5" cy="6" rx="2.2" ry="2.8"/><ellipse cx="18.5" cy="10" rx="2.2" ry="2.8"/><path d="M12.2 11.5c-3 0-6.2 4.3-6.2 6.6 0 1.7 1.4 2.4 3 2.4 1.3 0 2-.6 3.2-.6s1.9.6 3.2.6c1.6 0 3-.7 3-2.4 0-2.3-3.2-6.6-6.2-6.6z"/></svg>`;

// Cabeçalho comum: os HTML só trazem <header class="site-header"></header>, com a altura já reservada no CSS.
function renderHeader() {
  const header = document.querySelector(".site-header");
  if (!header) return;
  header.innerHTML = `<div class="wrap header-inner">
    <a class="brand" href="/">${BRAND_MARK}PetSOS</a>
    <nav class="nav" id="site-nav" aria-label="Principal">
      <a href="/" data-nav>Animais</a>
      <a href="/conversas" data-nav data-auth="in" hidden>Mensagens<span class="nav-count" data-count="message"></span></a>
      <a href="/meus" data-nav data-auth="in" hidden>Meus anúncios<span class="nav-count" data-count="other"></span></a>
      <a href="/conta" data-nav data-auth="in" hidden>Minha conta</a>
      <a href="/admin" data-nav data-admin hidden>Moderação</a>
      <a href="/entrar" data-nav data-auth="out">Entrar</a>
    </nav>
    <button type="button" class="theme-toggle" aria-label="Usar tema escuro">
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>
    <a class="btn btn-primary btn-header" href="/anunciar">Anunciar</a>
    <button type="button" class="btn btn-secondary menu-toggle" aria-expanded="false" aria-controls="site-nav">Menu</button>
  </div>`;
  const skip = document.createElement("a");
  skip.className = "skip-link";
  skip.href = "#conteudo";
  skip.textContent = "Pular para o conteúdo";
  document.body.prepend(skip);
}

// Rodapé comum, montado aqui para não repetir em cada HTML.
function initFooter() {
  if (document.querySelector(".site-footer")) return;
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `<div class="wrap footer-inner">
    <p class="footer-brand">PetSOS</p>
    <p>Para reunir animais perdidos e encontrados em Itapetininga e região. Projeto criado na Fatec Itapetininga.</p>
    <p>O contato acontece só pelo chat do site, e o local publicado é aproximado, com cerca de 100 m de margem.</p>
    <p class="footer-links"><a href="/privacidade">Privacidade</a> <a href="/termos">Termos de uso</a></p>
  </div>`;
  document.body.append(footer);
}

// Erros de JavaScript vão para os logs da Vercel: só a mensagem e a página, sem dados da pessoa.
function initErrorReporting() {
  let sent = 0;
  const report = (message) => {
    if (sent++ >= 5) return;
    const body = JSON.stringify({ message: String(message).slice(0, 300), page: location.pathname });
    try { navigator.sendBeacon?.("/api/log", new Blob([body], { type: "application/json" })); } catch { /* sem envio */ }
  };
  window.addEventListener("error", (e) => report(e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason?.message ?? e.reason));
}

async function renderCounts(sb, profile) {
  const { data, error } = await sb.from("notifications").select("kind").eq("user_id", profile.id).is("read_at", null).neq("kind", "moderation").limit(200);
  if (error) return;
  const messages = data.filter((n) => n.kind === "message").length;
  const others = data.length - messages;
  const fill = (key, n, label) => {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.innerHTML = n ? ` <span aria-hidden="true">(${n})</span><span class="visually-hidden">, ${n} ${label}</span>` : "";
  };
  fill("message", messages, messages === 1 ? "conversa com novidade" : "conversas com novidade");
  fill("other", others, others === 1 ? "aviso novo" : "avisos novos");
}

export async function initHeader() {
  renderHeader();
  initErrorReporting();
  initThemeToggle();
  initFooter();
  const path = location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.getAttribute("href") === path) a.setAttribute("aria-current", "page");
  });

  const toggle = document.querySelector(".menu-toggle");
  const nav = document.getElementById("site-nav");
  const setOpen = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle?.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav?.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });

  try {
    const sb = await getClient();
    const profile = await getProfile();
    document.querySelectorAll("[data-auth]").forEach((el) => {
      el.hidden = (el.dataset.auth === "in") !== Boolean(profile);
    });
    document.querySelectorAll("[data-admin]").forEach((el) => (el.hidden = profile?.role !== "admin"));
    if (profile) renderCounts(sb, profile);
    sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        if (Boolean(profile) !== (event === "SIGNED_IN")) location.reload();
      }
    });
    document.querySelector('[data-action="signout"]')?.addEventListener("click", async () => {
      await sb.auth.signOut();
      location.href = "/";
    });
  } catch {
    /* página mostra o próprio erro de conexão */
  }
}

// Texto para quem usa o site; a causa técnica (ex.: variáveis da Vercel) vai em "Copiar detalhes do erro".
export const CONNECTION_ERROR =
  "Não foi possível carregar os dados agora. Seus anúncios e mensagens continuam salvos; verifique a conexão e tente de novo.";
