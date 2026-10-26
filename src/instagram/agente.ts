// Piensa las respuestas de Instagram con la suscripción de Diego (Agent SDK). El Worker encola cada
// DM o comentario y dispara este workflow; aquí Claude decide y el Worker aplica la decisión.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PROMPT_COMENTARIO, PROMPT_DM } from "../../worker/prompts.ts";
import { correrAgente, ok, sinApertura } from "../comun/agente.ts";

type Pensamiento = { id: number; tipo: "dm" | "comentario"; contenido: string };
type Decision = Record<string, unknown>;

const URL_COLA = `${process.env.AGENTES_URL}/api/instagram/pensamientos`;
const CABECERAS = { Authorization: `Bearer ${process.env.AGENTES_SECRET}`, "Content-Type": "application/json" };
const nulo = z.string().nullable();

const ESQUEMA_DM = {
  estado: z.enum(["cualificando", "calificado", "no_califica", "diego", "pana", "ruido"]),
  negocio: nulo,
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
    herramientas: [herramienta],
    web: false,
    effort: "low",
    maxTurns: 4,
  });
  return decision;
}

async function devolver(id: number, decision: Decision | null): Promise<void> {
  const res = await fetch(URL_COLA, { method: "POST", headers: CABECERAS, body: JSON.stringify({ id, decision }) });
  if (!res.ok) console.error(`El Worker respondió ${res.status} al aplicar #${id}: ${await res.text()}`);
}

// Sigue mientras lleguen cosas nuevas, con tope de tiempo para no dejar el runner colgado.
const fin = Date.now() + 4 * 60_000;
while (Date.now() < fin) {
  const res = await fetch(URL_COLA, { headers: CABECERAS });
  if (!res.ok) throw new Error(`El Worker respondió ${res.status} al pedir la cola`);
  const { pensamientos } = (await res.json()) as { pensamientos: Pensamiento[] };
  if (!pensamientos.length) break;
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
}
console.log("Cola vacía.");
