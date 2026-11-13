import { getClient, PUBLIC_REPORT_FIELDS } from "./supabase.js";
import { COLORS, COLOR_LABEL, SPECIES_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, relativeDate, statusHtml, thumbHtml, reunitedSealHtml, reunitedMessage, showError, CONNECTION_ERROR } from "./ui.js";
import { createMap, markerStyle } from "./map.js";

const PAGE_SIZE = 24;
const REUNITED_LIMIT = 12;

const listEl = document.getElementById("report-list");
const countEl = document.getElementById("result-count");
const filtersEl = document.getElementById("filters");
const colorSelect = document.getElementById("color-filter");
const clearBtn = document.getElementById("clear-filters");
const browse = document.getElementById("browse");
const moreBox = document.getElementById("load-more");
const moreBtn = document.getElementById("load-more-btn");
const filtersToggle = document.getElementById("filters-toggle");
const filterMore = document.getElementById("filter-more");

const state = { sb: null, reports: [], markers: new Map(), selected: null, map: null, openTotal: 0, reunitedTotal: 0, loadId: 0 };
const filters = readFilters();

COLORS.forEach((c) => colorSelect.add(new Option(c.label, c.id)));
syncFilterControls();

function readFilters() {
  const p = new URLSearchParams(location.search);
  return { kind: p.get("tipo") || "all", species: p.get("especie") || "", size: p.get("porte") || "", color: p.get("cor") || "" };
}

function writeFilters() {
  const p = new URLSearchParams();
  if (filters.kind !== "all") p.set("tipo", filters.kind);
  if (filters.species) p.set("especie", filters.species);
  if (filters.size) p.set("porte", filters.size);
  if (filters.color) p.set("cor", filters.color);
  history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
}

function syncFilterControls() {
  filtersEl.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === filters.kind)));
  filtersEl.species.value = filters.species;
  filtersEl.size.value = filters.size;
  filtersEl.color.value = filters.color;
  // Filtro vindo do link fica visível, senão o resultado parece incompleto sem explicação.
  if (filters.species || filters.size || filters.color) setFiltersOpen(true);
}

function setFiltersOpen(open) {
  filterMore.classList.toggle("is-open", open);
  filtersToggle.setAttribute("aria-expanded", String(open));
}

function hasFilters() {
  return filters.kind !== "all" || filters.species || filters.size || filters.color;
}

function baseQuery() {
  let q = state.sb.from("reports").select(PUBLIC_REPORT_FIELDS, { count: "exact" }).eq("review_status", "approved");
  if (filters.kind !== "all") q = q.eq("kind", filters.kind);
  if (filters.species) q = q.eq("species", filters.species);
  if (filters.size) q = q.eq("size", filters.size);
  if (filters.color) q = q.contains("colors", [filters.color]);
  return q;
}

// Abertos primeiro, em páginas. Quando acabam, os reencontrados do último mês, com selo, para ninguém achar que ainda esperam o dono.
async function loadOpenPage(offset) {
  const { data, count, error } = await baseQuery()
    .eq("status", "open")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;
  return { data, count: count ?? data.length };
}

async function loadReunited() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data, count, error } = await baseQuery()
    .eq("status", "reunited")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(REUNITED_LIMIT);
  if (error) throw error;
  return { data, count: count ?? data.length };
}

async function load({ append = false } = {}) {
  const id = ++state.loadId;
  const offset = append ? state.reports.filter((r) => r.status === "open").length : 0;
  if (!append) {
    countEl.textContent = "Carregando anúncios…";
    moreBox.hidden = true;
  }
  const open = await loadOpenPage(offset);
  const reachedEnd = offset + open.data.length >= open.count;
  const reunited = reachedEnd ? await loadReunited() : { data: [], count: append ? state.reunitedTotal : 0 };
  if (id !== state.loadId) return; // uma troca de filtro mais recente venceu
  state.reports = [...(append ? state.reports : []), ...open.data, ...reunited.data];
  state.openTotal = open.count;
  state.reunitedTotal = reunited.count;
  moreBox.hidden = reachedEnd;
  buildMarkers();
  render();
}

function cardHtml(r) {
  const meta = [SPECIES_LABEL[r.species], r.colors.map((c) => COLOR_LABEL[c] ?? c).join(" e ")].filter(Boolean).join(", ");
  const reunited = r.status === "reunited";
  return `<li><a class="report-card" href="/anuncio?id=${r.id}" data-id="${r.id}">
    ${thumbHtml(state.sb, r, "card-photo")}
    ${reunited ? reunitedSealHtml() : ""}
    <div class="card-body">
      ${statusHtml(r)}
      <h3>${escapeHtml(reportTitle(r))}</h3>
      ${reunited ? `<p class="reunited-message">${reunitedMessage(r)}</p>` : `<p class="card-meta">${escapeHtml(meta)}</p>`}
      <p class="card-meta">${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}</p>
    </div>
  </a></li>`;
}

function render() {
  const { openTotal: open, reunitedTotal: reunited } = state;
  countEl.textContent = `${open} ${open === 1 ? "anúncio aberto" : "anúncios abertos"}`
    + (reunited ? ` e ${reunited} ${reunited === 1 ? "reencontro" : "reencontros"} no último mês` : "")
    + (hasFilters() ? " com estes filtros" : "");
  clearBtn.hidden = !hasFilters();

  if (!state.reports.length) {
    listEl.innerHTML = hasFilters()
      ? `<li class="empty"><h3>Nenhum animal com esses filtros</h3><p class="muted">Tente outra cor ou porte. Pelagem pode parecer diferente em fotos.</p><button type="button" class="btn btn-secondary" data-clear>Limpar filtros</button></li>`
      : `<li class="empty"><h3>Nenhum anúncio aberto</h3><p class="muted">Se você perdeu ou encontrou um animal, o primeiro anúncio pode ser o seu.</p><a class="btn btn-primary" href="/anunciar">Anunciar animal</a></li>`;
  } else {
    listEl.innerHTML = state.reports.map(cardHtml).join("");
  }
  state.selected = null;
}

function select(id, { scroll = false } = {}) {
  if (state.selected) {
    const prev = state.reports.find((r) => r.id === state.selected);
    if (prev) state.markers.get(state.selected)?.setStyle(markerStyle(prev));
    listEl.querySelector(`[data-id="${state.selected}"]`)?.classList.remove("is-selected");
  }
  state.selected = id;
  if (!id) return;
  const r = state.reports.find((x) => x.id === id);
  const marker = state.markers.get(id);
  marker?.setStyle(markerStyle(r, true)).bringToFront();
  const row = listEl.querySelector(`[data-id="${id}"]`);
  row?.classList.add("is-selected");
  if (scroll) row?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function buildMarkers() {
  const ids = new Set(state.reports.map((r) => r.id));
  state.markers.forEach((m, id) => {
    if (!ids.has(id)) {
      m.remove();
      state.markers.delete(id);
    }
  });
  state.reports.forEach((r) => {
    if (state.markers.has(r.id)) return;
    const marker = L.circleMarker([r.lat, r.lng], markerStyle(r))
      .bindPopup(`<strong>${escapeHtml(reportTitle(r))}</strong><br>${escapeHtml(r.neighborhood)}<br><a href="/anuncio?id=${r.id}">Ver anúncio</a>`)
      .on("click", () => select(r.id, { scroll: browse.dataset.view !== "map" }))
      .addTo(state.map);
    state.markers.set(r.id, marker);
  });
}

function reload() {
  writeFilters();
  load().catch(showLoadError);
}

function showLoadError(err) {
  listEl.innerHTML = "";
  countEl.textContent = "";
  moreBox.hidden = true;
  showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
}

filtersEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-kind]");
  if (!btn) return;
  filters.kind = btn.dataset.kind;
  syncFilterControls();
  reload();
});
filtersEl.addEventListener("change", (e) => {
  if (!["species", "size", "color"].includes(e.target.name)) return;
  filters[e.target.name] = e.target.value;
  reload();
});
filtersEl.addEventListener("submit", (e) => e.preventDefault());
filtersToggle.addEventListener("click", () => setFiltersOpen(!filterMore.classList.contains("is-open")));
function clearFilters() {
  Object.assign(filters, { kind: "all", species: "", size: "", color: "" });
  syncFilterControls();
  reload();
}
clearBtn.addEventListener("click", () => {
  clearFilters();
  filtersEl.querySelector('[data-kind="all"]').focus();
});
listEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-clear]")) clearFilters();
});
listEl.addEventListener("mouseover", (e) => {
  const row = e.target.closest(".report-card");
  if (row && row.dataset.id !== state.selected) select(row.dataset.id);
});
listEl.addEventListener("focusin", (e) => {
  const row = e.target.closest(".report-card");
  if (row) select(row.dataset.id);
});
moreBtn.addEventListener("click", async () => {
  const firstNew = state.reports.length;
  moreBtn.setAttribute("aria-busy", "true");
  moreBtn.disabled = true;
  try {
    await load({ append: true });
    // O botão pode sumir na última página: o foco segue para o primeiro animal novo.
    listEl.querySelectorAll(".report-card")[firstNew]?.focus();
  } catch (err) {
    showLoadError(err);
  }
  moreBtn.removeAttribute("aria-busy");
  moreBtn.disabled = false;
});
document.querySelector(".view-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  browse.dataset.view = btn.dataset.view;
  document.querySelectorAll(".view-toggle [data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  if (btn.dataset.view === "map") state.map.invalidateSize();
});

async function main() {
  initHeader();
  state.map = createMap(document.getElementById("map"), { wheelZoom: false });
  try {
    state.sb = await getClient();
    await load();
  } catch (err) {
    showLoadError(err);
  }
}

main();
