// Testes de tela no Chrome, com back-end falso: `npm i --no-save puppeteer-core@25.16.0 && node tests/e2e/smoke.mjs` (Chrome em CHROME_PATH).
// Conferem o que os testes de banco não veem: CSP, largura, alvos de toque, dobra, formulário e remoção do EXIF.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8765";
const SHOTS = process.env.SHOTS_DIR;
const ME = "11111111-1111-4111-8111-111111111111";
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const R2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONV = "cccccccc-cccc-4ccc-8ccc-000000000001";
const session = {
  access_token: "h.eyJzdWIiOiIxMTExIn0.s", refresh_token: "r", token_type: "bearer", expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  user: { id: ME, aud: "authenticated", role: "authenticated", email: "a@b.co", email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};
const PAGES = [
  ["home", "/", false], ["detalhe", `/anuncio?id=${R2}`, false], ["detalhe-dono", `/anuncio?id=${R1}`, true], ["comparar", `/comparar?a=${R1}&b=${R2}`, true],
  ["cartaz", `/cartaz?id=${R2}`, false], ["entrar", "/entrar", false], ["nova-senha", "/nova-senha", true], ["anunciar", "/anunciar", true],
  ["conversa", `/conversa?id=${CONV}`, true], ["conversas", "/conversas", true], ["meus", "/meus", true], ["conta", "/conta", true], ["admin", "/admin", true],
  ["privacidade", "/privacidade", false], ["termos", "/termos", false],
];
const failures = [];
const check = (cond, what) => {
  if (cond) console.log(`ok: ${what}`);
  else { failures.push(what); console.log(`FALHOU: ${what}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", [join(here, "mock_server.py")], { stdio: "inherit" });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch { await sleep(100); }
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-first-run", "--no-sandbox"],
});

async function open(path, { width = 1280, auth = false, theme = null } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.problems = [];
  page.on("pageerror", (e) => page.problems.push(`erro JS: ${e.message}`));
  page.on("console", (m) => { if (/Content Security Policy|integrity/i.test(m.text())) page.problems.push(`CSP/SRI: ${m.text().slice(0, 200)}`); });
  await page.setViewport({ width, height: width <= 375 ? 812 : 800, isMobile: width <= 375, hasTouch: width <= 375 });
  if (auth) await page.evaluateOnNewDocument((s) => localStorage.setItem("sb-localhost-auth-token", JSON.stringify(s)), session);
  if (theme) await page.evaluateOnNewDocument((t) => localStorage.setItem("petsos:theme", t), theme);
  await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(500);
  page.done = () => ctx.close();
  return page;
}

const measure = (page) => page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.opacity !== "0"; };
  const small = [...document.querySelectorAll("a, button, select, summary, input:not([type=radio]):not([type=checkbox]):not([type=file]), textarea, label.choice")]
    .filter(vis).filter((e) => !e.closest(".leaflet-control-attribution, .leaflet-popup") && !e.closest(".prose p, .prose li, .muted, .notice, .auth-terms, .skip-link"))
    .filter((e) => Math.round(e.getBoundingClientRect().height) < 44).map((e) => `${(e.innerText || e.tagName).trim().slice(0, 24)}=${Math.round(e.getBoundingClientRect().height)}`);
  const over = [...document.querySelectorAll("body *")].filter(vis).filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".leaflet-container, .tabs, .skip-link, .visually-hidden")).map((e) => e.className || e.tagName).slice(0, 4);
  return { docW: document.documentElement.scrollWidth, vw: innerWidth, small, over };
});

try {
  for (const [name, path, auth] of PAGES) {
    for (const width of [375, 900, 1280]) {
      const page = await open(path, { width, auth });
      const m = await measure(page);
      check(m.docW <= m.vw && !m.over.length, `${name} ${width}px sem estouro de largura ${m.over.join(",")}`);
      check(!m.small.length, `${name} ${width}px com alvos de 44 px ${m.small.join(" | ")}`);
      check(!page.problems.length, `${name} ${width}px sem erro de JS, CSP ou integridade ${page.problems.join(" ; ")}`);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
        await page.screenshot({ path: join(SHOTS, `${name}-${width}-inteira.png`), fullPage: true });
      }
      await page.done();
    }
  }

  // Tema escuro
  if (SHOTS) {
    for (const [name, path, auth] of [["home", "/", false], ["detalhe", `/anuncio?id=${R2}`, false], ["conversa", `/conversa?id=${CONV}`, true]]) {
      const page = await open(path, { width: 1280, auth, theme: "dark" });
      await page.screenshot({ path: join(SHOTS, `${name}-escuro.png`) });
      await page.done();
    }
  }

  // Home no celular: primeira tela mostra animais; mapa em alternância
  let page = await open("/", { width: 375 });
  const home = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".report-card")];
    return { total: cards.length, inFold: cards.filter((c) => c.getBoundingClientRect().top < innerHeight - 80).length, firstTop: Math.round(cards[0]?.getBoundingClientRect().top ?? 9999), mapShown: getComputedStyle(document.querySelector(".map-pane")).display !== "none" };
  });
  check(home.total > 0 && home.inFold >= 2, `home no celular mostra animais na primeira tela (primeiro em y=${home.firstTop}, ${home.inFold} visíveis)`);
  check(!home.mapShown, "mapa recolhido por padrão no celular");
  await page.click('.view-toggle [data-view="map"]');
  await sleep(300);
  const mapOk = await page.evaluate(() => ({ shown: document.querySelector(".map-pane").getBoundingClientRect().height > 300, list: getComputedStyle(document.querySelector(".list-panel")).display }));
  check(mapOk.shown && mapOk.list === "none", "alternância mostra o mapa e esconde a lista");
  await page.done();

  // Chat no celular: campo de mensagem cabe na primeira tela
  page = await open(`/conversa?id=${CONV}`, { width: 375, auth: true });
  const chat = await page.evaluate(() => {
    const box = document.getElementById("send-btn").getBoundingClientRect();
    return { bottom: Math.round(box.bottom), vh: innerHeight, open: document.getElementById("handover-box").open };
  });
  check(chat.bottom <= chat.vh, `chat no celular com enviar visível (y=${chat.bottom} de ${chat.vh})`);
  check(!chat.open, "painel de entrega recolhido no celular");
  await fetch(`${BASE}/__add_message`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await sleep(400);
  const texts = await page.$$eval(".bubble-body", (els) => els.map((e) => e.textContent));
  check(texts.length === 4 && texts[3].includes("sem conexão"), "ao reconectar, o chat busca o que chegou e não duplica mensagens");
  await page.done();

  // Cartaz cabe em uma folha
  page = await open(`/cartaz?id=${R2}`, { width: 1280 });
  const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } });
  const pages = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check(pages === 1, `cartaz impresso em uma folha A4 (${pages})`);
  await page.done();

  // EXIF: o arquivo enviado não pode conter os metadados do original
  page = await open("/anunciar", { width: 1280, auth: true });
  const exif = await page.evaluate(async () => {
    const { processPhoto } = await import("/assets/js/photo.js");
    const canvas = document.createElement("canvas");
    canvas.width = 2400; canvas.height = 1800;
    canvas.getContext("2d").fillRect(0, 0, 2400, 1800);
    const jpeg = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/jpeg"))).arrayBuffer());
    const marker = new TextEncoder().encode("Exif\0\0GPSLatitude-23.5872");
    const app1 = new Uint8Array([0xff, 0xe1, 0, marker.length + 2, ...marker]);
    const withExif = new Blob([jpeg.slice(0, 2), app1, jpeg.slice(2)], { type: "image/jpeg" });
    const hasMarker = async (b) => new TextDecoder("latin1").decode(await b.arrayBuffer()).includes("GPSLatitude");
    const out = await processPhoto(new File([withExif], "casa.jpg", { type: "image/jpeg" }));
    const size = async (b) => { const bmp = await createImageBitmap(b); return Math.max(bmp.width, bmp.height); };
    return { before: await hasMarker(withExif), full: await hasMarker(out.full), thumb: await hasMarker(out.thumb), fullSide: await size(out.full), thumbSide: await size(out.thumb), fullType: out.full.type };
  });
  check(exif.before && !exif.full && !exif.thumb, "foto refeita não carrega os metadados de GPS do original");
  check(exif.fullSide === 1600 && exif.thumbSide === 480, `foto reduzida para ${exif.fullSide} e ${exif.thumbSide} px (${exif.fullType})`);
  await page.done();

  // Formulário em etapas, de ponta a ponta
  page = await open("/anunciar?tipo=perdido", { width: 375, auth: true });
  const stepShown = () => page.evaluate(() => document.querySelector("[data-step]:not([hidden])").dataset.step);
  const stepVisibleError = (id) => page.$eval(id, (e) => e.textContent);
  check(await page.$eval('input[name="kind"][value="lost"]', (e) => e.checked), "tipo vem marcado pelo link da home");
  await page.click("#next-btn");
  await sleep(100);
  check((await stepShown()) === "1" && (await stepVisibleError("#species-error")).length > 0, "etapa 1 não avança sem espécie e mostra o erro");
  await page.evaluate(() => document.querySelector('input[name="species"][value="dog"]').click());
  const pngInput = await page.$("#photo");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
    canvas.getContext("2d").fillRect(0, 0, 800, 600);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "cao.jpg", { type: "image/jpeg" }));
    const input = document.getElementById("photo");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.click("#next-btn");
  await sleep(300);
  check((await stepShown()) === "2", "etapa 1 completa avança, mesmo com a foto ainda em processamento");
  check(Boolean(pngInput), "campo de foto presente");
  await page.click("#next-btn");
  await sleep(100);
  check((await stepShown()) === "2" && (await stepVisibleError("#colors-error")).length > 0, "etapa 2 exige cor e porte");
  await page.evaluate(() => {
    document.querySelector('input[name="size"][value="medium"]').click();
    document.querySelector('input[name="colors"][value="preto"]').click();
  });
  await page.click("#next-btn");
  await sleep(400);
  check((await stepShown()) === "3", "etapa 2 completa avança");
  await page.type("#neighborhood", "Centro");
  await page.click("#submit-btn");
  await sleep(200);
  const focused = await page.evaluate(() => document.activeElement?.id);
  check(focused === "pick-map" && (await stepVisibleError("#location-error")).length > 0, "sem local no mapa, o foco vai para o mapa e o erro aparece");
  check(await page.$eval("#location-error", (e) => e.getAttribute("role") === "alert"), "erro de local é anunciado ao leitor de tela");
  await page.click("#use-center");
  await page.click("#submit-btn");
  await sleep(1500);
  const writes = await (await fetch(`${BASE}/__writes`)).json();
  const uploads = writes.filter((w) => w.path.startsWith("/storage/") && w.method === "POST");
  const insert = writes.find((w) => w.path.startsWith("/rest/v1/reports") && w.method === "POST");
  check(uploads.length === 2, "envia foto e miniatura");
  check(insert?.body?.photo_path?.startsWith(`${ME}/`) && insert?.body?.thumb_path?.includes("-thumb."), "anúncio aponta para arquivos na pasta da conta");
  check(insert?.body?.lat === Number(insert?.body?.lat.toFixed(3)), "ponto já sai arredondado do navegador");
  check(page.url().includes("novo=1"), "depois de enviar, abre o anúncio com os parecidos");
  await page.done();

  // Edição: campos que não mudam ficam travados
  page = await open(`/anunciar?editar=${R1}`, { width: 1280, auth: true });
  const edit = await page.evaluate(() => ({
    title: document.getElementById("form-title").textContent,
    locked: [...document.querySelectorAll('input[name="kind"], input[name="species"]')].every((e) => e.disabled),
    name: document.getElementById("pet_name").value,
    label: document.getElementById("submit-btn").textContent,
  }));
  check(edit.title === "Editar anúncio" && edit.locked && edit.name === "Thor" && edit.label === "Salvar alterações", "edição preenche e trava tipo e espécie");
  await page.done();

  // Primeira mensagem vai pela função atômica
  page = await open(`/anuncio?id=${R2}`, { width: 1280, auth: true });
  await page.type("#first-message", "É o meu cachorro, tem cicatriz na orelha.");
  await page.click("#start-form button[type=submit]");
  await sleep(400);
  const after = await (await fetch(`${BASE}/__writes`)).json();
  check(after.some((w) => w.path.includes("/rpc/start_conversation")), "primeira mensagem usa start_conversation");
  check(!after.some((w) => w.path.startsWith("/rest/v1/conversations") && w.method === "POST"), "navegador não cria conversa em duas etapas");
  await page.done();

  // Teclado: o link de pular é o primeiro foco, e o diálogo recebe o foco
  page = await open("/", { width: 1280 });
  await page.keyboard.press("Tab");
  check(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), "primeiro Tab cai em Pular para o conteúdo");
  await page.done();
  page = await open(`/anuncio?id=${R1}`, { width: 1280, auth: true });
  const del = await page.$('[data-action="delete"]');
  await del.click();
  await sleep(100);
  const dlg = await page.evaluate(() => ({ open: document.querySelector("dialog")?.open, text: document.querySelector("dialog")?.innerText ?? "", focusInside: document.querySelector("dialog")?.contains(document.activeElement) }));
  check(dlg.open && dlg.text.includes("Thor") && dlg.focusInside, "excluir pede confirmação com o nome e prende o foco no diálogo");
  await page.keyboard.press("Escape");
  await sleep(100);
  check(await page.evaluate(() => document.activeElement?.dataset?.action === "delete"), "Esc fecha e devolve o foco ao botão");
  await page.done();
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} falha(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nTODOS OS TESTES DE TELA PASSARAM");
