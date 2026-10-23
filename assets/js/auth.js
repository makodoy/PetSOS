import { getClient } from "./supabase.js";
import { initHeader, safeNext, showError, CONNECTION_ERROR } from "./ui.js";

const form = document.getElementById("auth-form");
const next = safeNext(new URLSearchParams(location.search).get("next"));
let mode = "signin";
const touched = new Set();

const rules = {
  display_name: () => (mode !== "signup" || form.display_name.value.trim().length >= 2 ? "" : "Informe seu nome; ele aparece nas conversas."),
  email: () => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.value.trim()) ? "" : "Informe um e-mail no formato nome@exemplo.com."),
  password: () => (form.password.value.length >= 8 ? "" : "A senha precisa ter pelo menos 8 caracteres."),
};

function validate(name) {
  const msg = rules[name]();
  document.getElementById(`${name}-error`).textContent = msg;
  if (msg) form[name].setAttribute("aria-invalid", "true");
  else form[name].removeAttribute("aria-invalid");
  return !msg;
}

// Erro some na primeira tecla de correção; a regra roda de novo no próximo blur.
function clearError(name) {
  document.getElementById(`${name}-error`).textContent = "";
  form[name].removeAttribute("aria-invalid");
}

function setMode(m) {
  mode = m;
  const signup = m === "signup";
  document.getElementById("auth-title").textContent = signup ? "Criar conta" : "Entrar";
  document.getElementById("auth-sub").textContent = signup
    ? "Com uma conta você anuncia, conversa pelo chat e acompanha seus anúncios."
    : "Use seu e-mail e senha para anunciar e enviar mensagens.";
  document.getElementById("auth-submit").textContent = signup ? "Criar conta" : "Entrar";
  document.getElementById("switch-text").textContent = signup ? "Já tem conta?" : "Ainda não tem conta?";
  document.getElementById("switch-mode").textContent = signup ? "Entrar" : "Criar conta";
  document.getElementById("password-hint").hidden = !signup;
  document.getElementById("name-field").hidden = !signup;
  form.password.autocomplete = signup ? "new-password" : "current-password";
  document.getElementById("form-error").textContent = "";
}

function friendlyError(error) {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("invalid login")) return "E-mail ou senha não conferem. Confira os dados ou crie uma conta.";
  if (msg.includes("already registered")) return "Este e-mail já tem conta. Use a opção Entrar.";
  if (msg.includes("email not confirmed")) return "Confirme seu e-mail pelo link que enviamos e depois entre.";
  if (msg.includes("rate limit")) return "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.";
  return "Não foi possível concluir agora. Verifique a conexão e tente de novo.";
}

async function main() {
  initHeader();
  let sb;
  try {
    sb = await getClient();
    if ((await sb.auth.getSession()).data.session) location.replace(next);
  } catch (err) {
    showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
    return;
  }

  document.getElementById("switch-mode").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  form.addEventListener("focusout", (e) => {
    if (!rules[e.target.name]) return;
    touched.add(e.target.name);
    validate(e.target.name);
  });
  form.addEventListener("input", (e) => {
    if (rules[e.target.name]) clearError(e.target.name);
    document.getElementById("form-error").textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    ["display_name", "email", "password"].forEach((n) => touched.add(n));
    if (![validate("display_name"), validate("email"), validate("password")].every(Boolean)) return;
    const btn = document.getElementById("auth-submit");
    const formError = document.getElementById("form-error");
    const label = btn.textContent;
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.textContent = mode === "signup" ? "Criando conta…" : "Entrando…";
    formError.textContent = "";
    const credentials = { email: form.email.value.trim(), password: form.password.value };
    const { data, error } = mode === "signup"
      ? await sb.auth.signUp({ ...credentials, options: { emailRedirectTo: `${location.origin}${next}`, data: { display_name: form.display_name.value.trim() } } })
      : await sb.auth.signInWithPassword(credentials);
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.textContent = label;
    if (error) {
      formError.textContent = friendlyError(error);
      return;
    }
    if (mode === "signup" && !data.session) {
      formError.textContent = "";
      form.innerHTML = `<div class="empty" style="padding:0"><h2>Confirme seu e-mail</h2><p class="muted">Enviamos um link para ${credentials.email.replace(/[<>&"]/g, "")}. Abra o link para ativar a conta e voltar ao PetSOS.</p></div>`;
      return;
    }
    location.href = next;
  });
}

main();
