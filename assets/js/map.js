import { CITY_CENTER, CITY_ZOOM } from "./constants.js";

const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function createMap(el, { center = CITY_CENTER, zoom = CITY_ZOOM, interactive = true } = {}) {
  const map = L.map(el, {
    center, zoom, scrollWheelZoom: interactive, dragging: interactive || !L.Browser.mobile, zoomControl: interactive,
  });
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 19, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
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
  };
}
