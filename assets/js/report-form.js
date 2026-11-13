import { getClient, PHOTO_BUCKET, REPORT_FIELDS } from "./supabase.js";
import { COLORS, NEIGHBORHOODS } from "./constants.js";
import { initHeader, escapeHtml, pawIcon, photoUrl, showError, errorText, CONNECTION_ERROR } from "./ui.js";
import { createMap, markerStyle } from "./map.js";
import { processPhoto } from "./photo.js";

const form = document.getElementById("report-form");
const DRAFT_KEY = "petsos:draft-report";
const DRAFT_FIELDS = ["kind", "custody", "species", "sex", "size", "pet_name", "breed", "description", "neighborhood", "event_date"];
const MAX_PHOTO = 25 * 1024 * 1024; // arquivo original: o que vai para o Storage é refeito e bem menor
const STEP_RULES = { 1: ["kind", "custody", "species", "photo"], 2: ["size", "colors"], 3: ["event_date", "neighborhood", "location"] };
const LAST_STEP = 3;

let sb, session, map, pin, point = null;
let step = 1;
let editing = null; // anúncio em edição
let photoBlobs = null; // foto refeita, sem EXIF
let photoFailed = false;
let photoReady = Promise.resolve(); // processamento da foto em andamento
let pendingPoint = null; // ponto vindo do rascunho ou da edição: o mapa só existe a partir da etapa 3
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
    if (!f.type.startsWith("image/")) return "Escolha um arquivo de imagem, como JPG, PNG ou WebP.";
    if (f.size > MAX_PHOTO) return "A foto passa de 25 MB. Escolha uma menor.";
    if (photoFailed) return "Não conseguimos ler esta foto. Tente outra, em JPG ou PNG.";
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
  if (errorEl) {
    errorEl.setAttribute("role", "alert");
    errorEl.textContent = message;
  }
  fieldInputs(name).forEach((el) => {
    if (message) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
    if (errorEl) el.setAttribute("aria-describedby", errorEl.id);
  });
  return !message;
}

// Erro some na primeira tecla de correção; a regra roda de novo no próximo blur.
function clearError(name) {
  const errorEl = document.getElementById(`${name}-error`);
  if (errorEl) errorEl.textContent = "";
  fieldInputs(name).forEach((el) => el.removeAttribute("aria-invalid"));
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

function renderNeighborhoods() {
  const list = document.getElementById("neighborhood-list");
  NEIGHBORHOODS.forEach((n) => list.append(new Option(n)));
}

// ---------- Etapas ----------
function showStep(n, { focus = true } = {}) {
  step = n;
  form.querySelectorAll("[data-step]").forEach((section) => (section.hidden = Number(section.dataset.step) !== n));
  form.querySelectorAll("[data-progress]").forEach((li) => {
    const p = Number(li.dataset.progress);
    li.classList.toggle("is-done", p < n);
    if (p === n) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  document.getElementById("next-btn").hidden = n === LAST_STEP;
  document.getElementById("submit-btn").hidden = n !== LAST_STEP;
  document.getElementById("back-btn").hidden = n === 1;
  if (n === LAST_STEP) {
    if (!map) initMap();
    map.invalidateSize();
    if (pendingPoint) {
      map.setView(pendingPoint.latlng, 15);
      setPoint(pendingPoint.latlng, pendingPoint.label);
      pendingPoint = null;
    }
  }
  if (focus) {
    form.querySelector(`[data-step="${n}"]`).focus({ preventScroll: true });
    form.scrollIntoView({ block: "start", behavior: "auto" });
  }
}

function validateStep(n) {
  const names = STEP_RULES[n];
  names.forEach((name) => touched.add(name));
  const ok = names.map(validate).every(Boolean);
  if (!ok) focusFirstError(n);
  return ok;
}

function focusFirstError(n) {
  const section = form.querySelector(`[data-step="${n}"]`);
  const invalid = section.querySelector('[aria-invalid="true"]');
  if (invalid) return invalid.focus();
  // O mapa não tem campo próprio: sem isto, o erro de local não recebia foco.
  if (n === 3 && rules.location()) document.getElementById("pick-map").focus();
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
  if (!map) initMap();
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
  if (editing) return;
  const draft = { colors: selectedColors(), point };
  DRAFT_FIELDS.forEach((n) => (draft[n] = form.elements[n]?.value ?? ""));
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* sem armazenamento */ }
}

function draftHasContent(draft) {
  return Boolean(draft.point || draft.colors?.length ||
    DRAFT_FIELDS.some((n) => draft[n] && !(n === "sex" && draft[n] === "unknown") && n !== "event_date"));
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { draft = null; }
  if (!draft || !draftHasContent(draft)) return;
  document.getElementById("draft-notice").hidden = false;
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
    point = draft.point;
    pendingPoint = { latlng: L.latLng(draft.point.lat, draft.point.lng), label: "Ponto do seu rascunho." };
  }
}

function clearDraft() {
  if (editing) return;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* sem armazenamento */ }
}

function discardDraft() {
  clearDraft();
  form.reset();
  form.event_date.value = today();
  point = null;
  pin?.remove();
  pin = null;
  touched.clear();
  Object.keys(rules).forEach(clearError);
  document.getElementById("location-status").textContent = "";
  pendingPoint = null;
  photoBlobs = null;
  photoFailed = false;
  document.getElementById("photo-preview").innerHTML = pawIcon;
  document.getElementById("photo-name").textContent = "Nenhuma foto escolhida.";
  document.getElementById("draft-notice").hidden = true;
  updateKindDependent();
  showStep(1, { focus: false });
  form.querySelector('input[name="kind"]').focus();
}

// ---------- Envio ----------
async function uploadPhoto() {
  const ext = (blob) => (blob.type === "image/webp" ? "webp" : "jpg");
  const base = `${session.user.id}/${crypto.randomUUID()}`;
  const photoPath = `${base}.${ext(photoBlobs.full)}`;
  const thumbPath = `${base}-thumb.${ext(photoBlobs.thumb)}`;
  for (const [path, blob] of [[photoPath, photoBlobs.full], [thumbPath, photoBlobs.thumb]]) {
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) {
      await sb.storage.from(PHOTO_BUCKET).remove([photoPath, thumbPath]);
      throw error;
    }
  }
  return { photoPath, thumbPath };
}

function submitLabel() {
  if (editing) return "Salvar alterações";
  return session?.user?.email_confirmed_at ? "Publicar anúncio" : "Enviar para aprovação";
}

function reportFields() {
  return {
    pet_name: form.kind.value === "lost" ? form.pet_name.value.trim() || null : null,
    sex: form.sex.value || "unknown",
    size: form.size.value,
    colors: selectedColors(),
    breed: form.breed.value.trim() || null,
    description: form.description.value.trim() || null,
    neighborhood: form.neighborhood.value.trim(),
    lat: point.lat,
    lng: point.lng,
    event_date: form.event_date.value,
  };
}

async function submit(e) {
  e.preventDefault();
  const formError = document.getElementById("form-error");
  formError.textContent = "";
  if (step !== LAST_STEP) return goNext();
  await photoReady; // sem isto, enviar logo depois de escolher perderia a foto
  for (const n of [1, 2, 3]) {
    if (!STEP_RULES[n].map((name) => { touched.add(name); return validate(name); }).every(Boolean)) {
      showStep(n, { focus: false });
      focusFirstError(n);
      return;
    }
  }

  const btn = document.getElementById("submit-btn");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  btn.textContent = editing ? "Salvando…" : "Enviando…";

  let uploaded = null;
  try {
    if (photoBlobs) uploaded = await uploadPhoto();
    const photo = uploaded ? { photo_path: uploaded.photoPath, thumb_path: uploaded.thumbPath } : {};
    const kind = form.kind.value;
    const { data, error } = editing
      ? await sb.from("reports").update({ ...reportFields(), ...photo }).eq("id", editing.id).select("id").single()
      : await sb.from("reports").insert({
        user_id: session.user.id,
        kind,
        custody: kind === "found" ? form.custody.value : null,
        species: form.species.value,
        ...reportFields(),
        ...photo,
      }).select("id").single();
    if (error) throw error;
    clearDraft();
    location.href = `/anuncio?id=${data.id}${editing ? "&editado=1" : "&novo=1"}`;
  } catch (err) {
    if (uploaded) await sb.storage.from(PHOTO_BUCKET).remove([uploaded.photoPath, uploaded.thumbPath]);
    formError.textContent = errorText(err, "O anúncio não foi enviado. Seus dados continuam aqui; verifique a conexão e tente de novo.");
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.textContent = submitLabel();
  }
}

async function goNext() {
  await photoReady;
  if (validateStep(step)) showStep(step + 1);
}

// ---------- Edição ----------
async function loadForEdit(id) {
  const { data, error } = await sb.from("reports").select(REPORT_FIELDS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || data.user_id !== session.user.id) return null;
  return data;
}

function fillForEdit(r) {
  editing = r;
  document.getElementById("form-title").textContent = "Editar anúncio";
  document.title = "Editar anúncio | PetSOS";
  document.getElementById("form-intro").textContent = r.review_status === "rejected"
    ? `Motivo da recusa: ${r.review_note || "não informado"}. Corrija e salve para a moderação ver de novo.`
    : "Tipo, espécie e situação não mudam depois de criar o anúncio. Para mudá-los, exclua e anuncie de novo.";
  const check = (name, value) => { if (value) form.querySelector(`input[name="${name}"][value="${value}"]`).checked = true; };
  check("kind", r.kind);
  check("custody", r.custody);
  check("species", r.species);
  check("sex", r.sex);
  check("size", r.size);
  form.querySelectorAll('input[name="kind"], input[name="custody"], input[name="species"]').forEach((el) => (el.disabled = true));
  form.pet_name.value = r.pet_name ?? "";
  form.breed.value = r.breed ?? "";
  form.description.value = r.description ?? "";
  form.neighborhood.value = r.neighborhood;
  form.event_date.value = r.event_date;
  r.colors.forEach((c) => {
    const box = form.querySelector(`input[name="colors"][value="${CSS.escape(c)}"]`);
    if (box) box.checked = true;
  });
  point = { lat: r.lat, lng: r.lng };
  pendingPoint = { latlng: L.latLng(r.lat, r.lng), label: "Ponto atual do anúncio." };
  const url = photoUrl(sb, r.thumb_path || r.photo_path);
  if (url) {
    const img = new Image();
    img.className = "photo-preview";
    img.alt = "Foto atual do anúncio";
    img.src = url;
    document.getElementById("photo-preview").replaceChildren(img);
    document.getElementById("photo-name").textContent = "Foto atual mantida, se você não escolher outra.";
  }
  document.getElementById("cancel-link").href = `/anuncio?id=${r.id}`;
}

async function handlePhoto() {
  touched.add("photo");
  photoBlobs = null;
  photoFailed = false;
  const preview = document.getElementById("photo-preview");
  const file = form.photo.files[0];
  document.getElementById("photo-name").textContent = file ? `${file.name}.` : "Nenhuma foto escolhida.";
  if (file && validate("photo")) {
    try {
      photoBlobs = await processPhoto(file);
    } catch {
      photoFailed = true;
    }
  }
  const valid = validate("photo");
  if (file && valid && photoBlobs) {
    const img = new Image();
    img.className = "photo-preview";
    img.alt = "Prévia da foto";
    img.src = URL.createObjectURL(photoBlobs.thumb);
    preview.replaceChildren(img);
  } else {
    preview.innerHTML = pawIcon;
  }
}

// ---------- Eventos ----------
document.getElementById("next-btn").addEventListener("click", goNext);
document.getElementById("back-btn").addEventListener("click", () => showStep(step - 1));
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
  // Campos de texto: só limpam o erro (revalidam no blur). Escolhas (rádio/caixa) são uma ação completa: validam já.
  if (name && ["radio", "checkbox"].includes(e.target.type)) {
    if (touched.has(name)) validate(name);
  } else if (name) {
    clearError(name);
  }
  saveDraft();
});
document.getElementById("discard-draft").addEventListener("click", discardDraft);
form.addEventListener("change", (e) => {
  if (e.target.name === "kind") {
    updateKindDependent();
    if (pin) pin.setStyle(markerStyle({ kind: form.kind.value }, true));
  }
  if (e.target.name === "photo") photoReady = handlePhoto();
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
  } catch (err) {
    showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
    return;
  }
  if (!session) {
    document.getElementById("signin-required").hidden = false;
    return;
  }
  form.hidden = false;
  renderColors();
  renderNeighborhoods();
  document.getElementById("photo-preview").innerHTML = pawIcon;
  form.event_date.max = today();
  form.event_date.value = today();
  const params = new URLSearchParams(location.search);
  if (params.get("editar")) {
    let report = null;
    try {
      report = await loadForEdit(params.get("editar"));
    } catch (err) {
      form.hidden = true;
      return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
    }
    if (!report) {
      form.hidden = true;
      return showError(document.getElementById("page-error"), "Só quem criou o anúncio pode editá-lo. Confira se você entrou com a conta certa.");
    }
    fillForEdit(report);
  } else {
    restoreDraft();
  }
  document.getElementById("submit-btn").textContent = submitLabel();
  const preset = { perdido: "lost", encontrado: "found" }[params.get("tipo")];
  if (preset && !form.kind.value) form.querySelector(`input[name="kind"][value="${preset}"]`).checked = true;
  updateKindDependent();
  showStep(1, { focus: false });
}

main();
