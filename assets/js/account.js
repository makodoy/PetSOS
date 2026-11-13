import { getClient, getProfile } from "./supabase.js";
import { NEIGHBORHOODS } from "./constants.js";
import { initHeader, escapeHtml, showError, toast, confirmDialog, errorText, CONNECTION_ERROR } from "./ui.js";

const root = document.getElementById("account-root");
const nameForm = document.getElementById("name-form");
const alertForm = document.getElementById("alert-form");
const alertList = document.getElementById("alert-list");
let sb, me;

function renderAlerts(alerts) {
  alertList.innerHTML = alerts.map((a) => `<li data-id="${a.id}"><span>${escapeHtml(a.neighborhood)}</span>
    <button type="button" class="btn btn-secondary btn-small" data-remove>Deixar de acompanhar</button></li>`).join("");
}

async function loadAlerts() {
  const { data } = await sb.from("area_alerts").select("id,neighborhood").eq("user_id", me.id).order("neighborhood");
  renderAlerts(data ?? []);
}

function bindName() {
  const input = nameForm.display_name;
  const errorEl = document.getElementById("display_name-error");
  input.addEventListener("input", () => {
    errorEl.textContent = "";
    input.removeAttribute("aria-invalid");
  });
  nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value.length < 2) {
      errorEl.textContent = "Informe seu nome; ele aparece nas conversas.";
      input.setAttribute("aria-invalid", "true");
      return input.focus();
    }
    const { error } = await sb.from("profiles").update({ display_name: value }).eq("id", me.id);
    toast(error ? errorText(error) : "Nome salvo.");
  });
}

function bindAlerts() {
  const emailBox = document.getElementById("email-alerts");
  emailBox.addEventListener("change", async () => {
    const { error } = await sb.from("profiles").update({ email_alerts: emailBox.checked }).eq("id", me.id);
    if (error) {
      emailBox.checked = !emailBox.checked;
      return toast(errorText(error));
    }
    toast(emailBox.checked ? "Avisos por e-mail ligados." : "Avisos por e-mail desligados.");
  });
  const input = document.getElementById("alert-neighborhood");
  const errorEl = document.getElementById("alert-error");
  input.addEventListener("input", () => (errorEl.textContent = ""));
  alertForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value.length < 2) {
      errorEl.textContent = "Informe o nome do bairro.";
      return input.focus();
    }
    const { error } = await sb.from("area_alerts").insert({ user_id: me.id, neighborhood: value });
    if (error && error.code !== "23505") {
      errorEl.textContent = errorText(error);
      return;
    }
    input.value = "";
    toast(`Você vai receber avisos de ${value}.`);
    loadAlerts();
  });
  alertList.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-remove]")) return;
    const { error } = await sb.from("area_alerts").delete().eq("id", e.target.closest("[data-id]").dataset.id);
    if (error) return toast(errorText(error));
    loadAlerts();
  });
}

async function exportData() {
  const [reports, conversations, messages, alerts] = await Promise.all([
    sb.from("reports").select("*").eq("user_id", me.id),
    sb.from("conversations").select("*").or(`asker_id.eq.${me.id},owner_id.eq.${me.id}`),
    sb.from("messages").select("*").eq("sender_id", me.id),
    sb.from("area_alerts").select("*").eq("user_id", me.id),
  ]);
  const failed = [reports, conversations, messages, alerts].find((r) => r.error);
  if (failed) return toast(errorText(failed.error));
  const dump = {
    gerado_em: new Date().toISOString(),
    conta: { nome: me.display_name, email: me.session.user.email },
    anuncios: reports.data, conversas: conversations.data, mensagens_enviadas: messages.data, bairros_acompanhados: alerts.data,
  };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
  link.download = "meus-dados-petsos.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function deleteAccount() {
  const ok = await confirmDialog({
    title: "Excluir sua conta do PetSOS?",
    body: "Seus anúncios, conversas e fotos serão apagados, inclusive para as outras pessoas. Isso não pode ser desfeito.",
    confirmLabel: "Excluir minha conta",
    danger: true,
  });
  if (!ok) return;
  const { error } = await sb.rpc("delete_my_account");
  if (error) return toast(errorText(error));
  await sb.auth.signOut({ scope: "local" });
  location.href = "/";
}

async function main() {
  initHeader();
  try {
    sb = await getClient();
    me = await getProfile();
  } catch (err) {
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  if (!me) return location.replace("/entrar?next=/conta");
  const { data: profile, error } = await sb.from("profiles").select("display_name,email_alerts").eq("id", me.id).maybeSingle();
  if (error || !profile) return showError(document.getElementById("page-error"), CONNECTION_ERROR, error);
  document.getElementById("account-email").textContent = `Conta de ${me.session.user.email}.`;
  nameForm.display_name.value = profile.display_name;
  document.getElementById("email-alerts").checked = profile.email_alerts;
  NEIGHBORHOODS.forEach((n) => document.getElementById("neighborhood-list").append(new Option(n)));
  bindName();
  bindAlerts();
  document.getElementById("export-data").addEventListener("click", exportData);
  document.getElementById("delete-account").addEventListener("click", deleteAccount);
  root.hidden = false;
  loadAlerts();
}

main();
