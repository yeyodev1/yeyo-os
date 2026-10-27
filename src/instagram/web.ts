// Abre la web de un lead con Chrome de verdad (también carga las hechas con JavaScript) y devuelve
// lo que se ve más señales de venta, para que el bot diga qué tiene y qué le falta.
import { chromium } from "playwright-core";

// En GitHub Actions Chrome ya viene instalado; en la Mac de Diego se usa su Chrome Dev.
const CHROME = process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" : "/usr/bin/google-chrome");

export async function verWeb(url: string): Promise<string> {
  const destino = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const navegador = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // Como celular: así la ven sus clientes que llegan desde Instagram.
    const pagina = await navegador.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    const res = await pagina.goto(destino, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await pagina.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const datos = await pagina.evaluate(() => {
      const html = document.documentElement.outerHTML.toLowerCase();
      const enlaces = [...document.querySelectorAll("a")].map((a) => (a.getAttribute("href") ?? "").toLowerCase());
      const texto = document.body.innerText.toLowerCase();
      return {
        titulo: document.title,
        texto: document.body.innerText.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, 5000),
        whatsapp: enlaces.some((h) => h.includes("wa.me") || h.includes("whatsapp")),
        carrito: /carrito|cart|añadir al|agregar al|add to cart/.test(texto),
        pago: /payphone|stripe|paypal|kushki|datafast|pagar con tarjeta|checkout|pago en línea|pago online/.test(html + texto),
        tienda: /shopify|woocommerce|tiendanube|wix|jumpseller/.exec(html)?.[0] ?? null,
        celular: !!document.querySelector('meta[name="viewport"]'),
        reservas: /reserva|agenda tu|agendar|booking|calendly/.test(texto),
        precios: /\$\s?\d/.test(document.body.innerText),
      };
    });
    const senales = [
      `Título: ${datos.titulo || "—"}`,
      `Botón o link a WhatsApp: ${datos.whatsapp ? "sí" : "no"}`,
      `Carrito: ${datos.carrito ? "sí" : "no"}`,
      `Pago en línea: ${datos.pago ? "sí" : "no se ve"}`,
      `Plataforma: ${datos.tienda ?? "a medida o no detectada"}`,
      `Adaptada a celular: ${datos.celular ? "sí" : "no"}`,
      `Reservas o agenda: ${datos.reservas ? "sí" : "no"}`,
      `Muestra precios: ${datos.precios ? "sí" : "no"}`,
    ].join("\n");
    return `Abrí ${pagina.url()} (respuesta ${res?.status() ?? "?"}).\n<señales>\n${senales}\n</señales>\n<lo_que_se_ve>\n${datos.texto}\n</lo_que_se_ve>`;
  } finally {
    await navegador.close();
  }
}
