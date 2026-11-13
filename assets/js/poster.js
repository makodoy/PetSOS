import { getClient, PUBLIC_REPORT_FIELDS } from "./supabase.js";
import { COLOR_LABEL, SIZE_LABEL, SPECIES_LABEL } from "./constants.js";
import { initHeader, escapeHtml, posterTitle, posterWord, photoUrl, relativeDate, formatDate, showError, CONNECTION_ERROR } from "./ui.js";

const root = document.getElementById("poster-root");
const id = new URLSearchParams(location.search).get("id");

function qrSvg(text) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

async function main() {
  initHeader();
  document.getElementById("poster-back").href = `/anuncio?id=${encodeURIComponent(id ?? "")}`;
  let sb, r;
  try {
    sb = await getClient();
    const { data, error } = await sb.from("reports").select(PUBLIC_REPORT_FIELDS).eq("id", id).maybeSingle();
    if (error) throw error;
    r = data;
  } catch (err) {
    root.innerHTML = "";
    return showError(document.getElementById("page-error"), CONNECTION_ERROR, err);
  }
  if (!r) {
    root.innerHTML = `<div class="panel empty"><h3>Este anúncio não está disponível</h3><a class="btn btn-secondary" href="/">Ver todos os animais</a></div>`;
    return;
  }
  const url = photoUrl(sb, r.photo_path);
  const [word, tone] = posterWord(r);
  const details = [SPECIES_LABEL[r.species], SIZE_LABEL[r.size], r.colors.map((c) => COLOR_LABEL[c] ?? c).join(" e ")].filter(Boolean).join(", ");
  const link = `${location.origin}/a/${r.id}`;
  document.title = `Cartaz: ${posterTitle(r)} | PetSOS`;
  root.innerHTML = `<article class="poster panel">
      <p class="poster-word poster-${tone}">${word}</p>
      <h1>${escapeHtml(posterTitle(r))}</h1>
      ${url ? `<img class="poster-photo" src="${escapeHtml(url)}" alt="Foto de ${escapeHtml(posterTitle(r))}">` : ""}
      <p style="font-size:20px"><strong>${escapeHtml(r.neighborhood)}</strong>, ${formatDate(r.event_date)} (${relativeDate(r.event_date)})</p>
      <p>${escapeHtml(details)}.${r.description ? ` ${escapeHtml(r.description)}` : ""}</p>
      <div class="poster-foot">
        <div><p style="font-size:20px"><strong>Viu este animal? Avise pelo PetSOS.</strong></p><p class="muted">Aponte a câmera para o código ou acesse ${escapeHtml(link)}</p></div>
        <div class="poster-qr" role="img" aria-label="Código QR para o anúncio">${qrSvg(link)}</div>
      </div>
    </article>
    <div class="poster-actions"><button type="button" class="btn btn-primary" id="print">Imprimir cartaz</button></div>`;
  root.removeAttribute("aria-busy");
  document.getElementById("print").addEventListener("click", () => window.print());
}

main();
