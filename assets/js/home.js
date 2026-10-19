import { getClient, REPORT_FIELDS } from "./supabase.js";
import { COLORS, COLOR_LABEL, SPECIES_LABEL } from "./constants.js";
import { initHeader, escapeHtml, reportTitle, relativeDate, statusHtml, thumbHtml, reunitedSealHtml, reunitedMessage, showError, CONNECTION_ERROR } from "./ui.js";
import { createMap, markerStyle } from "./map.js";

const listEl = document.getElementById("report-list");
const countEl = document.getElementById("result-count");
const filtersEl = document.getElementById("filters");
const colorSelect = document.getElementById("color-filter");

const state = { sb: null, reports: [], markers: new Map(), selected: null, map: null };
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
}

function hasFilters() {
  return filters.kind !== "all" || filters.species || filters.size || filters.color;
}

function visibleReports() {
  return state.reports.filter((r) =>
    (filters.kind === "all" || r.kind === filters.kind) &&
    (!filters.species || r.species === filters.species) &&
    (!filters.size || r.size === filters.size) &&
    (!filters.color || r.colors.includes(filters.color))
  );
}

function rowHtml(r) {
  const meta = [SPECIES_LABEL[r.species], r.colors.map((c) => COLOR_LABEL[c] ?? c).join(" e ")].filter(Boolean).join(", ");
  const reunited = r.status === "reunited";
  return `<li><a class="report-row${reunited ? " is-reunited" : ""}" href="/anuncio?id=${r.id}" data-id="${r.id}">
    ${thumbHtml(state.sb, r)}
    <div class="row-body">
      ${statusHtml(r)}
      <h3>${escapeHtml(reportTitle(r))}</h3>
      ${reunited ? `<p class="reunited-message">${reunitedMessage(r)}</p>` : `<p class="row-meta">${escapeHtml(meta)}</p>`}
      <p class="row-meta">${escapeHtml(r.neighborhood)}, ${relativeDate(r.event_date)}</p>
    </div>
    ${reunited ? reunitedSealHtml() : ""}
  </a></li>`;
}

function render() {
  const items = visibleReports();
  const open = items.filter((r) => r.status === "open").length;
  const reunited = items.length - open;
  countEl.textContent = `${open} ${open === 1 ? "anúncio aberto" : "anúncios abertos"}`
    + (reunited ? `, ${reunited} ${reunited === 1 ? "reencontrado" : "reencontrados"} no último mês` : "");

  if (!items.length) {
    listEl.innerHTML = hasFilters()
      ? `<li class="empty"><h3>Nenhum animal com esses filtros</h3><p class="muted">Tente outra cor ou porte. Pelagem pode parecer diferente em fotos.</p><button type="button" class="btn btn-secondary" data-clear>Limpar filtros</button></li>`
      : `<li class="empty"><h3>Nenhum anúncio aberto</h3><p class="muted">Se você perdeu ou encontrou um animal, o primeiro anúncio pode ser o seu.</p><a class="btn btn-primary" href="/anunciar">Anunciar animal</a></li>`;
  } else {
    listEl.innerHTML = items.map(rowHtml).join("");
  }

  const visible = new Set(items.map((r) => r.id));
  state.markers.forEach((m, id) => {
    if (visible.has(id)) m.addTo(state.map);
    else m.remove();
  });
}

function select(id, { scroll = false } = {}) {
  if (state.selected) {
    const prev = state.reports.find((r) => r.id === state.selected);
    state.markers.get(state.selected)?.setStyle(markerStyle(prev));
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
  state.reports.forEach((r) => {
    const marker = L.circleMarker([r.lat, r.lng], markerStyle(r))
      .bindPopup(`<strong>${escapeHtml(reportTitle(r))}</strong><br>${escapeHtml(r.neighborhood)}<br><a href="/anuncio?id=${r.id}">Ver anúncio</a>`)
      .on("click", () => select(r.id, { scroll: true }));
    state.markers.set(r.id, marker);
  });
}

filtersEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-kind]");
  if (!btn) return;
  filters.kind = btn.dataset.kind;
  syncFilterControls();
  writeFilters();
  render();
});
filtersEl.addEventListener("change", (e) => {
  if (!["species", "size", "color"].includes(e.target.name)) return;
  filters[e.target.name] = e.target.value;
  writeFilters();
  render();
});
filtersEl.addEventListener("submit", (e) => e.preventDefault());
listEl.addEventListener("click", (e) => {
  if (!e.target.closest("[data-clear]")) return;
  Object.assign(filters, { kind: "all", species: "", size: "", color: "" });
  syncFilterControls();
  writeFilters();
  render();
});
listEl.addEventListener("mouseover", (e) => {
  const row = e.target.closest(".report-row");
  if (row && row.dataset.id !== state.selected) select(row.dataset.id);
});
listEl.addEventListener("focusin", (e) => {
  const row = e.target.closest(".report-row");
  if (row) select(row.dataset.id);
});

async function main() {
  initHeader();
  state.map = createMap(document.getElementById("map"));
  try {
    state.sb = await getClient();
    // Abertos primeiro; depois os reencontrados do último mês, com selo, para ninguém achar que ainda esperam o dono.
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data, error } = await state.sb
      .from("reports")
      .select(REPORT_FIELDS)
      .or(`status.eq.open,and(status.eq.reunited,updated_at.gte.${since})`)
      .eq("review_status", "approved")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    state.reports = [...data.filter((r) => r.status === "open"), ...data.filter((r) => r.status !== "open")];
  } catch {
    listEl.innerHTML = "";
    showError(document.getElementById("page-error"), CONNECTION_ERROR);
    return;
  }
  buildMarkers();
  render();
}

main();
