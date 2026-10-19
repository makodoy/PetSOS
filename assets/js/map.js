import { CITY_CENTER, CITY_ZOOM } from "./constants.js";

export function createMap(el, { center = CITY_CENTER, zoom = CITY_ZOOM, interactive = true } = {}) {
  const map = L.map(el, {
    center, zoom, scrollWheelZoom: interactive, dragging: interactive || !L.Browser.mobile, zoomControl: interactive,
  });
  // Tiles padrão do OpenStreetMap: gratuitos e sem chave (a CARTO passou a exigir API key).
  // No modo escuro, styles.css escurece os tiles com um filtro.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Ao trocar o tema, refaz as cores dos marcadores (lidas dos tokens CSS no momento do desenho).
  window.addEventListener("petsos:themechange", () => {
    map.eachLayer((layer) => {
      if (layer.options.petReport) layer.setStyle(markerStyle(layer.options.petReport, layer.options.petSelected));
    });
  });
  return map;
}

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function markerStyle(report, selected = false) {
  const color = report.status && report.status !== "open" ? token("--ink-muted") : token(report.kind === "lost" ? "--lost" : "--found");
  return {
    radius: selected ? 11 : 8,
    color: selected ? token("--accent") : token("--surface"),
    weight: selected ? 3 : 2,
    fillColor: color,
    fillOpacity: 1,
    petReport: { kind: report.kind, status: report.status },
    petSelected: selected,
  };
}
