// Noticias del día (lo dispara el Worker a las 6 am de Ecuador): Claude busca en la web lo más
// importante de tecnología y negocios, explica cómo pega en Ecuador y lo guarda en fuentes
// (origen 'noticias'). Los agentes de X y LinkedIn lo usan para sus hilos; Diego recibe el resumen.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, error, ok } from "../comun/agente.ts";
import { hoy } from "../comun/contexto.ts";
import { sql } from "../comun/memoria.ts";
import { avisar } from "../comun/telegram.ts";

const DRY_RUN = process.env.DRY_RUN === "1";
const MAX = 6;

const hace7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
const recientes = await sql<{ texto: string }>("SELECT texto FROM fuentes WHERE origen = 'noticias' AND fecha >= ? ORDER BY fecha DESC LIMIT 40", [hace7]);

const guardadas: { titulo: string; medio: string; impacto: string; url: string }[] = [];

const guardar = tool(
  "guardar_noticia",
  `Guarda una noticia verificada (máx. ${MAX}). Solo noticias reales que leíste con WebFetch, de los últimos 3 días.`,
  {
    titulo: z.string().describe("Titular en español, corto y claro"),
    medio: z.string().describe("Medio o fuente, ej. 'Primicias', 'TechCrunch', 'El Universo'"),
    url: z.string().url(),
    fecha: z.string().describe("Fecha de publicación YYYY-MM-DD"),
    tema: z.enum(["ia", "tecnologia", "ecommerce-pagos", "marketing-redes", "negocios-economia", "emprendimiento"]),
    resumen: z.string().describe("2 a 3 líneas: qué pasó, con el dato concreto"),
    impacto_ecuador: z.string().describe("2 a 3 líneas: cómo afecta a los negocios y emprendedores en Ecuador (o LatAm) y qué deberían hacer. Concreto, sin humo"),
    opinion: z.string().describe("Una línea: la postura que Diego podría tomar sobre esto, con filo"),
    imagen: z.string().url().optional().describe("URL de la imagen principal del artículo (og:image) si la viste en la página"),
  },
  async (n) => {
    if (guardadas.length >= MAX) return error(`Ya guardaste ${MAX}. Termina.`);
    if (guardadas.some((g) => g.url === n.url)) return error("Esa ya la guardaste.");
    const texto = `${n.titulo}\n${n.resumen}\nCómo afecta a Ecuador: ${n.impacto_ecuador}\nPostura: ${n.opinion}`;
    if (!DRY_RUN) {
      await sql("INSERT OR IGNORE INTO fuentes (fecha, origen, externo_id, autor, url, texto, metricas) VALUES (?, 'noticias', ?, ?, ?, ?, ?)", [
        new Date().toISOString(),
        n.url,
        n.medio,
        n.url,
        texto,
        JSON.stringify({ tema: n.tema, publicada: n.fecha, imagen: n.imagen ?? null }),
      ]);
    }
    guardadas.push({ titulo: n.titulo, medio: n.medio, impacto: n.impacto_ecuador, url: n.url });
    return ok(`Guardada (${guardadas.length}/${MAX}).`);
  },
);

const prompt = `Hoy es ${hoy()}. Eres el investigador de noticias de Diego Reyes (@yeyodev), CTO de Bakano, una agencia de marketing y tecnología en Guayaquil, Ecuador. Él les arma a negocios tiendas en línea, pasarelas de pago, automatizaciones e IA, y escribe en X y LinkedIn para dueños de negocio de Ecuador y LatAm.

Busca con WebSearch las noticias más importantes de los últimos 1 a 3 días y guarda de 4 a ${MAX} con guardar_noticia. La mezcla ideal:
- 1 o 2 de Ecuador: economía, negocios, comercio electrónico, pagos (bancos, Payphone, Kushki, De Una, Deuna), regulación digital, facturación electrónica del SRI, conectividad, apagones que afecten a negocios, emprendimiento. Busca en Primicias, El Universo, Expreso, El Comercio, Revista Gestión y Ekos.
- 1 o 2 de LatAm: e-commerce, fintech, Mercado Libre, pagos, startups.
- 1 o 2 globales de tecnología e IA que cambien cómo trabaja o vende un negocio (lanzamientos de OpenAI, Anthropic, Google, Meta, WhatsApp, Instagram, Shopify, Stripe…).

Reglas:
- Abre cada noticia con WebFetch antes de guardarla: nada de titulares que no leíste ni datos que no estén en la nota.
- Que le sirva a un dueño de negocio, no a un programador. Nada de política partidaria, crónica roja ni farándula.
- El impacto en Ecuador es lo más valioso: concreto (qué cambia para la tienda, la cafetería, la pyme) y honesto (si no afecta, no la guardes).
- No repitas lo ya guardado esta semana:
${recientes.map((r) => `  - ${r.texto.split("\n")[0]}`).join("\n") || "  (nada todavía)"}

Termina cuando hayas guardado las noticias.`;

await correrAgente({ prompt, herramientas: [guardar], effort: "medium", maxTurns: 40 });

if (!guardadas.length) {
  await avisar("⚠️📰 El agente de noticias no encontró nada que valiera la pena hoy.");
} else {
  const lista = guardadas.map((g) => `🗞️ **${g.titulo}** (${g.medio})\n🇪🇨 ${g.impacto}`).join("\n\n");
  const texto = `📰 **Noticias de hoy** (${guardadas.length})\n\n${lista}\n\n🐦 Los agentes de X y LinkedIn ya las tienen para sus hilos`;
  if (DRY_RUN) console.log(texto);
  else await avisar(texto);
}
