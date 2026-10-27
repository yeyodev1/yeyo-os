// Piensa las respuestas de Instagram con la suscripción de Diego (Agent SDK). El Worker encola cada
// DM o comentario y dispara este workflow; aquí Claude decide y el Worker aplica la decisión.
import { execFileSync } from "node:child_process";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PROMPT_COMENTARIO, PROMPT_DM } from "../../worker/prompts.ts";
import { correrAgente, ok, sinApertura } from "../comun/agente.ts";
import { verWeb } from "./web.ts";

type Pensamiento = { id: number; tipo: "dm" | "comentario"; contenido: string };
type Decision = Record<string, unknown>;

const URL_COLA = `${process.env.AGENTES_URL}/api/instagram/pensamientos`;
const CABECERAS = { Authorization: `Bearer ${process.env.AGENTES_SECRET}`, "Content-Type": "application/json" };
const nulo = z.string().nullable();

const ESQUEMA_DM = {
  estado: z.enum(["cualificando", "calificado", "no_califica", "diego", "pana", "ruido"]),
  negocio: nulo,
  negocio_ig: nulo.describe("usuario de Instagram del negocio, si lo dio (sin @)"),
  necesidad: nulo.describe("'tienda' | 'pasarela' | 'automatizacion' | 'otro: …'"),
  presupuesto: nulo.describe("lo que dijo, tal cual"),
  nombre: nulo,
  telefono: nulo.describe("WhatsApp tal como lo dio"),
  email: nulo,
  respuesta: nulo.describe("el DM exacto a enviar; null = no responder"),
  aviso: nulo.describe("texto para Diego por Telegram; null = no avisar"),
};

const ESQUEMA_COMENTARIO = {
  accion: z.enum(["ignorar", "responder"]),
  publica: nulo.describe("respuesta pública corta bajo el comentario"),
  dm: nulo.describe("primer DM privado; null = no escribirle"),
  aviso: nulo.describe("texto para Diego por Telegram; null = no avisar"),
};

// Diego no usa ¿ ni ¡: se quitan de lo que sale publicado aunque el modelo los ponga.
const limpiar = (d: Decision): Decision =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" && ["respuesta", "publica", "dm"].includes(k) ? sinApertura(v) : v]));

// Para la web o tienda que comparta un lead: Chrome de verdad, así también se leen las hechas con JavaScript.
const herramientaWeb = tool(
  "ver_web",
  "Abre la web o tienda de un lead con un navegador real (también las hechas con JavaScript) y devuelve lo que se ve más señales de venta: WhatsApp, carrito, pago en línea, plataforma, si se ve bien en celular, reservas y precios.",
  { url: z.string().describe("la web tal como la pasó, por ejemplo mitienda.com") },
  async ({ url }) => {
    try {
      return ok(await verWeb(url));
    } catch (e) {
      return ok(`No pude abrir ${url}: ${String(e).slice(0, 200)}`);
    }
  },
);

async function pensar(p: Pensamiento): Promise<Decision | null> {
  let decision: Decision | null = null;
  const guardar = async (d: Decision) => {
    decision = limpiar(d);
    return ok("Listo, decisión guardada. Termina.");
  };
  const herramienta =
    p.tipo === "dm"
      ? tool("decidir", "Lo que haces con este DM: el estado del lead, los datos que ya se saben, el DM exacto a enviar y el aviso para Diego.", ESQUEMA_DM, guardar)
      : tool("comentario", "Cómo responder este comentario según la publicación.", ESQUEMA_COMENTARIO, guardar);
  await correrAgente({
    prompt: `${p.tipo === "dm" ? PROMPT_DM : PROMPT_COMENTARIO}\n\n${p.contenido}\n\nLlama la herramienta ${p.tipo === "dm" ? "decidir" : "comentario"} UNA sola vez con tu decisión y termina.`,
    // Si el lead pasa el link de su web, la abre (ver_web) para decirle qué tiene y qué le falta.
    herramientas: p.tipo === "dm" && /https?:\/\/|www\.|\.(com|ec|net|org|store|shop|co)\b/i.test(p.contenido) ? [herramienta, herramientaWeb] : [herramienta],
    web: false,
    effort: "low",
    maxTurns: 8,
  });
  return decision;
}

async function devolver(id: number, decision: Decision | null): Promise<void> {
  const res = await fetch(URL_COLA, { method: "POST", headers: CABECERAS, body: JSON.stringify({ id, decision }) });
  if (!res.ok) console.error(`El Worker respondió ${res.status} al aplicar #${id}: ${await res.text()}`);
}

// Se queda escuchando la cola mientras haya conversación: así solo el primer mensaje de cada tanda
// paga el arranque de Actions (~18 s). Se apaga tras 20 min sin nada y antes del tope de 6 h.
const INACTIVO_MAX = 20 * 60_000;
const VIDA_MAX = 5.5 * 3_600_000;
const inicio = Date.now();
let ultimoTrabajo = Date.now();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Un run que se queda escuchando no ve los cambios que se suban después: si main avanzó, se apaga
// para que el próximo mensaje arranque uno nuevo con las instrucciones al día.
let ultimaRevision = Date.now();
function hayVersionNueva(): boolean {
  const actual = process.env.GITHUB_SHA;
  if (!actual || Date.now() - ultimaRevision < 60_000) return false;
  ultimaRevision = Date.now();
  try {
    const remoto = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], { encoding: "utf8", timeout: 10_000 }).split("\t")[0];
    return !!remoto && remoto !== actual;
  } catch {
    return false;
  }
}

async function pedirCola(): Promise<Pensamiento[]> {
  const res = await fetch(URL_COLA, { headers: CABECERAS });
  if (!res.ok) throw new Error(`El Worker respondió ${res.status} al pedir la cola`);
  return ((await res.json()) as { pensamientos: Pensamiento[] }).pensamientos;
}

async function atender(pensamientos: Pensamiento[]): Promise<void> {
  console.log(`Pensando ${pensamientos.length}: ${pensamientos.map((p) => `#${p.id} ${p.tipo}`).join(", ")}`);
  await Promise.all(
    pensamientos.map(async (p) => {
      const decision = await pensar(p).catch((e) => {
        console.error(`#${p.id}:`, e);
        return null;
      });
      await devolver(p.id, decision);
    }),
  );
  ultimoTrabajo = Date.now();
}

while (Date.now() - ultimoTrabajo < INACTIVO_MAX && Date.now() - inicio < VIDA_MAX) {
  if (hayVersionNueva()) {
    console.log("Hay una versión nueva en main: me apago para que arranque otro run con ella.");
    break;
  }
  const pensamientos = await pedirCola().catch((e) => {
    console.error(e);
    return [];
  });
  if (pensamientos.length) await atender(pensamientos);
  else await dormir(1500);
}

// Antes de irse avisa al Worker: lo que llegue desde ahora vuelve a disparar el workflow (que
// arranca con lo último de main y recoge lo que haya quedado en la cola).
await fetch(URL_COLA, { method: "POST", headers: CABECERAS, body: JSON.stringify({ adios: true }) });
console.log("Me apago.");
