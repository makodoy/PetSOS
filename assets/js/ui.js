import { getClient, getProfile, PHOTO_BUCKET } from "./supabase.js";
import { SPECIES_LABEL, KIND_LABEL } from "./constants.js";

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

export function kindVerb(r) {
  return r.kind === "lost" ? "Sumiu" : "Encontrado";
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
  if (r.status === "reunited") return `<span class="status status-closed">Reencontrado</span>`;
  if (r.status === "closed") return `<span class="status status-closed">Encerrado</span>`;
  return `<span class="status status-${r.kind}">${KIND_LABEL[r.kind]}</span>`;
}

export function photoUrl(sb, path) {
  return path ? sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl : null;
}

export function thumbHtml(sb, r, className = "thumb") {
  const url = photoUrl(sb, r.photo_path);
  if (url) return `<img class="${className}" src="${escapeHtml(url)}" alt="" loading="lazy" width="76" height="76">`;
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

export function showError(container, message) {
  container.innerHTML = `<div class="banner-error" role="alert">${escapeHtml(message)}</div>`;
}

export function safeNext(value, fallback = "/") {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Mensagens de erro vindas das funções do banco já estão em português; o resto vira texto genérico.
export function errorText(error, fallback = "Não foi possível concluir agora. Verifique a conexão e tente de novo.") {
  const msg = error?.message || "";
  return /[ãçéíóúâêô]/i.test(msg) && msg.length < 200 ? msg : fallback;
}

// Diálogo de confirmação reutilizável. Retorna true/false (e o texto, quando há campo de motivo).
export function confirmDialog({ title, body, confirmLabel, danger = false, reasonLabel = null, reasonRequired = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-labelledby", "confirm-title");
    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2 id="confirm-title">${escapeHtml(title)}</h2>
      ${body ? `<p class="muted">${escapeHtml(body)}</p>` : ""}
      ${reasonLabel ? `<div class="field" style="margin-top:var(--s4)"><label for="confirm-reason">${escapeHtml(reasonLabel)}</label>
        <textarea id="confirm-reason" maxlength="500"></textarea><p class="field-error" id="confirm-reason-error"></p></div>` : ""}
      <div class="dialog-actions">
        <button class="btn btn-secondary" value="cancel" type="submit">Voltar</button>
        <button class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" value="confirm" type="submit">${escapeHtml(confirmLabel)}</button>
      </div></form>`;
    document.body.append(dialog);
    const reason = dialog.querySelector("#confirm-reason");
    dialog.querySelector("form").addEventListener("submit", (e) => {
      if (e.submitter?.value === "confirm" && reasonRequired && !reason.value.trim()) {
        e.preventDefault();
        dialog.querySelector("#confirm-reason-error").textContent = "Escreva o motivo; ele aparece para quem anunciou.";
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
      resolve(reasonLabel ? { ok, reason: text } : ok);
    });
    dialog.showModal();
  });
}

export async function initHeader() {
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

export const CONNECTION_ERROR =
  "Não foi possível conectar ao banco de dados. Recarregue a página; se continuar, confira as variáveis SUPABASE_URL e SUPABASE_ANON_KEY na Vercel.";
