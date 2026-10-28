// Imágenes para los hilos de X: tarjetas con la marca de Diego (una frase, una lista o un antes y
// después) y capturas de páginas en vivo, hechas con Chrome de verdad. Devuelve "archivo:<ruta>",
// que subirImagen() sabe leer.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

// En GitHub Actions Chrome ya viene instalado; en la Mac de Diego se usa su Chrome Dev.
const CHROME = process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" : "/usr/bin/google-chrome");

export type Tarjeta =
  | { tipo: "frase"; texto: string; firma?: string }
  | { tipo: "lista"; titulo: string; puntos: string[] }
  | { tipo: "antes_despues"; titulo: string; antes: string[]; despues: string[] };

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Colores del logo de YEYO OS. Sin emojis: Chrome en Linux no trae la fuente de color.
const ESTILO = `
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 675px; background: radial-gradient(circle at 85% 0%, #111C38 0%, #070B16 60%); color: #F4F7FF;
    font-family: "Sora", system-ui, sans-serif; padding: 72px 84px; display: flex; flex-direction: column; justify-content: space-between; }
  .acento { color: #3DDCC8; }
  .pie { display: flex; justify-content: space-between; align-items: center; font-size: 24px; color: #9FB3D9; }
  .pie b { color: #F4F7FF; font-weight: 600; }
  .barra { width: 72px; height: 6px; border-radius: 3px; background: #3DDCC8; margin-bottom: 28px; }
  h1 { font-size: 46px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; }
  .frase { font-size: 58px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; }
  ul { list-style: none; margin-top: 30px; display: grid; gap: 18px; }
  li { font-size: 32px; line-height: 1.3; padding-left: 40px; position: relative; color: #E3EAF8; }
  li::before { content: ""; position: absolute; left: 0; top: 14px; width: 16px; height: 16px; border-radius: 50%; background: #3DDCC8; }
  .columnas { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 30px; }
  .col { border-radius: 20px; padding: 28px 30px; background: rgba(159, 179, 217, 0.08); }
  .col.bien { background: rgba(61, 220, 200, 0.12); }
  .col h2 { font-size: 22px; letter-spacing: 0.12em; text-transform: uppercase; color: #9FB3D9; margin-bottom: 16px; }
  .col.bien h2 { color: #3DDCC8; }
  .col li { font-size: 27px; }
  .col li::before { top: 12px; width: 13px; height: 13px; }
  .col:not(.bien) li::before { background: #9FB3D9; }
`;

const PIE = `<div class="pie"><span><b>Diego Reyes</b> · @yeyodev</span><span class="acento">yeyo.dev</span></div>`;

function html(t: Tarjeta): string {
  const lista = (p: string[]) => `<ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const cuerpo =
    t.tipo === "frase"
      ? `<div><div class="barra"></div><p class="frase">${esc(t.texto)}</p>${t.firma ? `<p style="margin-top:24px;font-size:28px;color:#9FB3D9">${esc(t.firma)}</p>` : ""}</div>`
      : t.tipo === "lista"
        ? `<div><div class="barra"></div><h1>${esc(t.titulo)}</h1>${lista(t.puntos)}</div>`
        : `<div><h1>${esc(t.titulo)}</h1><div class="columnas"><div class="col"><h2>Antes</h2>${lista(t.antes)}</div><div class="col bien"><h2>Después</h2>${lista(t.despues)}</div></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
<style>${ESTILO}</style></head><body>${cuerpo}${PIE}</body></html>`;
}

async function conChrome<T>(fn: (b: Awaited<ReturnType<typeof chromium.launch>>) => Promise<T>): Promise<T> {
  const navegador = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    return await fn(navegador);
  } finally {
    await navegador.close();
  }
}

const destino = async (nombre: string) => join(await mkdtemp(join(tmpdir(), "x-img-")), nombre);

export async function crearTarjeta(t: Tarjeta): Promise<string> {
  const ruta = await destino("tarjeta.png");
  await conChrome(async (b) => {
    const pagina = await b.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1.5 });
    await pagina.setContent(html(t), { waitUntil: "networkidle" });
    await pagina.evaluate(() => document.fonts.ready);
    // Si el texto no cabe, la tarjeta sale cortada: mejor fallar y que el agente lo acorte.
    const desborda = await pagina.evaluate(() => document.body.scrollHeight > 675);
    if (desborda) throw new Error("El texto no cabe en la tarjeta: acórtalo (frase de máx ~120 caracteres, 3 a 4 puntos cortos).");
    await pagina.screenshot({ path: ruta });
  });
  return `archivo:${ruta}`;
}

// Captura de una página en vivo, como se ve en una laptop (la parte de arriba, sin scroll).
export async function capturarPagina(url: string): Promise<string> {
  const ruta = await destino("captura.jpg");
  await conChrome(async (b) => {
    const pagina = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
    await pagina.goto(/^https?:\/\//.test(url) ? url : `https://${url}`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await pagina.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await pagina.waitForTimeout(1_500); // animaciones de entrada
    await pagina.screenshot({ path: ruta, type: "jpeg", quality: 85 });
  });
  return `archivo:${ruta}`;
}
