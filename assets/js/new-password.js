import { getClient } from "./supabase.js";
import { initHeader, showError, errorText, CONNECTION_ERROR } from "./ui.js";

const form = document.getElementById("reset-form");
const password = document.getElementById("password");
const errorEl = document.getElementById("password-error");

function validate() {
  const msg = password.value.length >= 8 ? "" : "A senha precisa ter pelo menos 8 caracteres.";
  errorEl.textContent = msg;
  if (msg) password.setAttribute("aria-invalid", "true");
  else password.removeAttribute("aria-invalid");
  return !msg;
}

async function main() {
  initHeader();
  let sb;
  try {
    sb = await getClient();
    // O link do e-mail traz a sessão de recuperação; o cliente a lê da URL ao iniciar.
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      document.getElementById("reset-expired").hidden = false;
      document.getElementById("reset-intro").hidden = true;
      return;
    }
  } catch (err) {
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  form.hidden = false;
  password.addEventListener("blur", validate);
  password.addEventListener("input", () => {
    errorEl.textContent = "";
    password.removeAttribute("aria-invalid");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return password.focus();
    const btn = document.getElementById("reset-submit");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: password.value });
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    if (error) {
      document.getElementById("form-error").textContent = /different from the old/i.test(error.message)
        ? "A nova senha precisa ser diferente da anterior."
        : errorText(error);
      return;
    }
    location.href = "/";
  });
}

main();
