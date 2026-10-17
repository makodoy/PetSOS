import { getClient, PHOTO_BUCKET } from "./supabase.js";
import { COLORS } from "./constants.js";
import { initHeader, escapeHtml, pawIcon, showError, CONNECTION_ERROR } from "./ui.js";
import { createMap, markerStyle } from "./map.js";

const form = document.getElementById("report-form");
const DRAFT_KEY = "petsos:draft-report";
const DRAFT_FIELDS = ["kind", "custody", "species", "sex", "size", "pet_name", "breed", "description", "neighborhood", "event_date"];
const MAX_PHOTO = 5 * 1024 * 1024;

let sb, session, map, pin, point = null;
const touched = new Set();

// ---------- Validação (no blur; erro some ao corrigir) ----------
const rules = {
  kind: () => (form.kind.value ? "" : "Escolha se você perdeu ou encontrou o animal."),
  custody: () => (form.kind.value !== "found" || form.custody.value ? "" : "Diga se o animal está com você ou se você só o viu."),
  species: () => (form.species.value ? "" : "Escolha a espécie."),
  size: () => (form.size.value ? "" : "Escolha o porte aproximado."),
  colors: () => {
    const n = selectedColors().length;
    if (n === 0) return "Escolha pelo menos uma cor.";
    if (n > 4) return "Escolha no máximo 4 cores.";
    return "";
  },
  event_date: () => {
    const v = form.event_date.value;
    if (!v) return "Informe a data.";
    if (v > today()) return "A data não pode estar no futuro.";
    return "";
  },
  neighborhood: () => (form.neighborhood.value.trim().length >= 2 ? "" : "Informe o bairro."),
  location: () => (point ? "" : "Marque o local no mapa ou use sua localização."),
  photo: () => {
    const f = form.photo.files[0];
    if (!f) return "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return "Use uma foto JPG, PNG ou WebP.";
    if (f.size > MAX_PHOTO) return "A foto passa de 5 MB. Escolha uma menor.";
    return "";
  },
};

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const selectedColors = () => [...form.querySelectorAll('input[name="colors"]:checked')].map((i) => i.value);

function fieldInputs(name) {
  if (name === "colors") return [...form.querySelectorAll('input[name="colors"]')];
  if (name === "location") return [];
  const el = form.elements[name];
  return el instanceof RadioNodeList ? [...el] : el ? [el] : [];
}

function validate(name) {
  const message = rules[name]();
  const errorEl = document.getElementById(`${name}-error`);
  if (errorEl) errorEl.textContent = message;
  fieldInputs(name).forEach((el) => {
    if (message) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
    if (errorEl) el.setAttribute("aria-describedby", errorEl.id);
  });
  return !message;
}

function groupOf(target) {
  if (target.name === "colors") return "colors";
  if (target.id === "use-location" || target.id === "use-center") return "location";
  return rules[target.name] ? target.name : null;
}

// ---------- Montagem ----------
function renderColors() {
  document.getElementById("color-choices").innerHTML = COLORS.map(
    (c) => `<label class="choice"><input type="checkbox" name="colors" value="${c.id}"><span class="swatch" style="background:${c.swatch}"></span>${escapeHtml(c.label)}</label>`
  ).join("");
}

function updateKindDependent() {
  const lost = form.kind.value === "lost";
  document.getElementById("name-field").hidden = !lost;
  document.getElementById("custody-field").hidden = form.kind.value !== "found";
  document.getElementById("date-label").textContent = lost ? "Quando sumiu" : form.kind.value === "found" ? "Quando encontrou" : "Data";
}

function setPoint(latlng, label) {
  // Mesmo arredondamento do banco (~100 m): o pino mostra exatamente o que será publicado.
  point = { lat: +latlng.lat.toFixed(3), lng: +latlng.lng.toFixed(3) };
  const kind = form.kind.value || "lost";
  if (!pin) pin = L.circleMarker(point, markerStyle({ kind }, true)).addTo(map);
  else pin.setLatLng(point).setStyle(markerStyle({ kind }, true));
  document.getElementById("location-status").textContent = label;
  if (touched.has("location")) validate("location");
  saveDraft();
}

function initMap() {
  map = createMap(document.getElementById("pick-map"));
  map.on("click", (e) => {
    touched.add("location");
    setPoint(e.latlng, "Ponto marcado no mapa.");
  });
  document.getElementById("use-center").addEventListener("click", () => {
    touched.add("location");
    setPoint(map.getCenter(), "Ponto marcado no centro do mapa. Mova o mapa e marque de novo para ajustar.");
  });
  document.getElementById("use-location").addEventListener("click", () => {
    const status = document.getElementById("location-status");
    if (!navigator.geolocation) {
      status.textContent = "Seu navegador não informa a localização. Marque o ponto no mapa.";
      return;
    }
    status.textContent = "Buscando sua localização…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        touched.add("location");
        const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        map.setView(latlng, 16);
        setPoint(latlng, "Usando sua localização atual. Ajuste tocando no mapa, se precisar.");
      },
      () => (status.textContent = "Não conseguimos sua localização. Permita o acesso no navegador ou marque o ponto no mapa."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ---------- Rascunho ----------
function saveDraft() {
  const draft = { colors: selectedColors(), point };
  DRAFT_FIELDS.forEach((n) => (draft[n] = form.elements[n]?.value ?? ""));
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* sem armazenamento */ }
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { draft = null; }
  if (!draft) return;
  DRAFT_FIELDS.forEach((n) => {
    const el = form.elements[n];
    if (!el || !draft[n]) return;
    if (el instanceof RadioNodeList) [...el].forEach((r) => (r.checked = r.value === draft[n]));
    else el.value = draft[n];
  });
  (draft.colors || []).forEach((c) => {
    const box = form.querySelector(`input[name="colors"][value="${CSS.escape(c)}"]`);
    if (box) box.checked = true;
  });
  if (draft.point) {
    const ll = L.latLng(draft.point.lat, draft.point.lng);
    map.setView(ll, 15);
    setPoint(ll, "Ponto do seu rascunho.");
  }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* sem armazenamento */ }
}

// ---------- Envio ----------
async function uploadPhoto(file) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
  const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

async function submit(e) {
  e.preventDefault();
  const formError = document.getElementById("form-error");
  formError.textContent = "";
  const names = Object.keys(rules);
  names.forEach((n) => touched.add(n));
  const ok = names.map(validate).every(Boolean);
  if (!ok) {
    form.querySelector('[aria-invalid="true"]')?.focus();
    return;
  }

  const btn = document.getElementById("submit-btn");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  btn.textContent = "Publicando…";

  let photoPath = null;
  let reportId = null;
  try {
    const file = form.photo.files[0];
    if (file) photoPath = await uploadPhoto(file);
    const kind = form.kind.value;
    const { data, error } = await sb
      .from("reports")
      .insert({
        user_id: session.user.id,
        kind,
        custody: kind === "found" ? form.custody.value : null,
        species: form.species.value,
        pet_name: kind === "lost" ? form.pet_name.value.trim() || null : null,
        sex: form.sex.value || "unknown",
        size: form.size.value,
        colors: selectedColors(),
        breed: form.breed.value.trim() || null,
        description: form.description.value.trim() || null,
        photo_path: photoPath,
        neighborhood: form.neighborhood.value.trim(),
        lat: point.lat,
        lng: point.lng,
        event_date: form.event_date.value,
      })
      .select("id")
      .single();
    if (error) throw error;
    reportId = data.id;
    clearDraft();
    location.href = `/anuncio?id=${reportId}&novo=1`;
  } catch {
    if (photoPath) await sb.storage.from(PHOTO_BUCKET).remove([photoPath]);
    formError.textContent = "O anúncio não foi enviado por uma falha de conexão. Seus dados continuam aqui; tente enviar de novo.";
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.textContent = "Enviar para aprovação";
  }
}

// ---------- Eventos ----------
form.addEventListener("focusout", (e) => {
  const name = groupOf(e.target);
  if (!name || name === "location") return;
  // grupos (radio/checkbox) validam quando o foco sai do grupo inteiro
  const group = e.target.closest("fieldset");
  if (group && e.relatedTarget && group.contains(e.relatedTarget)) return;
  touched.add(name);
  validate(name);
});
form.addEventListener("input", (e) => {
  const name = groupOf(e.target);
  if (name && touched.has(name)) validate(name);
  saveDraft();
});
form.addEventListener("change", (e) => {
  if (e.target.name === "kind") {
    updateKindDependent();
    if (pin) pin.setStyle(markerStyle({ kind: form.kind.value }, true));
  }
  if (e.target.name === "photo") {
    touched.add("photo");
    const valid = validate("photo");
    const preview = document.getElementById("photo-preview");
    const file = form.photo.files[0];
    preview.innerHTML = file && valid ? `<img class="photo-preview" src="${URL.createObjectURL(file)}" alt="Prévia da foto">` : pawIcon;
  }
  const name = groupOf(e.target);
  if (name && touched.has(name)) validate(name);
  saveDraft();
});
form.addEventListener("submit", submit);

async function main() {
  initHeader();
  try {
    sb = await getClient();
    session = (await sb.auth.getSession()).data.session;
  } catch {
    showError(document.getElementById("page-error"), CONNECTION_ERROR);
    return;
  }
  if (!session) {
    document.getElementById("signin-required").hidden = false;
    return;
  }
  form.hidden = false;
  renderColors();
  document.getElementById("photo-preview").innerHTML = pawIcon;
  form.event_date.max = today();
  form.event_date.value = today();
  initMap();
  restoreDraft();
  updateKindDependent();
}

main();
