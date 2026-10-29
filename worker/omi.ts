// Webhooks del Omi (el colgante que graba lo que Diego habla). Cada conversación procesada
// y el resumen del día quedan en fuentes (origen 'omi' y 'omi_dia') para que Pana los consulte.
// Es privado: graba a clientes y a terceros, así que los agentes que publican nunca lo leen.
import { type Env, config, escapar, guardarConfig, responder } from "./comun";

type Segmento = { text: string; speaker?: string; speaker_name?: string; is_user?: boolean };
type Conversacion = {
  id: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  discarded?: boolean;
  transcript_segments?: Segmento[];
  structured?: { title?: string; overview?: string; emoji?: string; category?: string; action_items?: { description: string; completed?: boolean }[] };
};
type Dia = {
  created_at: string;
  summary_json?: {
    date: string;
    headline?: string;
    overview?: string;
    day_emoji?: string;
    stats?: { total_conversations?: number; total_duration_minutes?: number };
    action_items?: { description: string; completed?: boolean }[];
    decisions_made?: { decision: string }[];
    unresolved_questions?: { question: string }[];
    knowledge_nuggets?: { insight: string }[];
  };
};

async function guardar(env: Env, origen: string, externo: string, fecha: string, autor: string | null, texto: string, metricas: unknown): Promise<void> {
  // Omi puede reprocesar una conversación: la última versión pisa a la anterior.
  await env.DB.prepare(
    "INSERT INTO fuentes (fecha, origen, externo_id, autor, texto, metricas) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (origen, externo_id) DO UPDATE SET texto = excluded.texto, autor = excluded.autor, metricas = excluded.metricas",
  )
    .bind(fecha, origen, externo, autor, texto.slice(0, 12_000), JSON.stringify(metricas))
    .run();
}

async function conversacion(env: Env, c: Conversacion): Promise<void> {
  if (c.discarded || !c.id) return;
  const s = c.structured ?? {};
  const pendientes = (s.action_items ?? []).filter((a) => !a.completed).map((a) => `- ${a.description}`);
  const transcripcion = (c.transcript_segments ?? [])
    .map((t) => `${t.is_user ? "Diego" : t.speaker_name || t.speaker || "Otro"}: ${t.text}`)
    .join("\n");
  const minutos = c.started_at && c.finished_at ? Math.round((Date.parse(c.finished_at) - Date.parse(c.started_at)) / 60_000) : null;
  const texto = [`${s.emoji ?? ""} ${s.title ?? "(sin título)"}`.trim(), s.overview, pendientes.length ? `Pendientes:\n${pendientes.join("\n")}` : "", `Transcripción:\n${transcripcion}`]
    .filter(Boolean)
    .join("\n\n");
  await guardar(env, "omi", c.id, c.started_at ?? c.created_at, s.category ?? null, texto, { inicio: c.started_at, fin: c.finished_at, minutos });
}

async function dia(env: Env, d: NonNullable<Dia["summary_json"]>, creado: string): Promise<void> {
  const lista = (titulo: string, items: string[]) => (items.length ? `${titulo}\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  const pendientes = (d.action_items ?? []).filter((a) => !a.completed).map((a) => a.description);
  const decisiones = (d.decisions_made ?? []).map((x) => x.decision);
  const preguntas = (d.unresolved_questions ?? []).map((x) => x.question);
  const ideas = (d.knowledge_nuggets ?? []).map((x) => x.insight);
  const texto = [`${d.day_emoji ?? ""} ${d.headline ?? d.date}`.trim(), d.overview, lista("Pendientes:", pendientes), lista("Decisiones:", decisiones), lista("Sin resolver:", preguntas), lista("Ideas:", ideas)]
    .filter(Boolean)
    .join("\n\n");
  await guardar(env, "omi_dia", d.date, creado, null, texto, d.stats ?? {});

  env.TELEGRAM_CHAT_ID ||= (await config(env, "telegram_chat_id")) ?? undefined;
  if (!env.TELEGRAM_CHAT_ID) return;
  const bloque = (emoji: string, items: string[]) => items.slice(0, 8).map((i) => `${emoji} ${escapar(i)}`).join("\n");
  const partes = [`🎙️ <b>Tu día según el Omi</b>`, `<b>${escapar(`${d.day_emoji ?? ""} ${d.headline ?? d.date}`.trim())}</b>`, d.overview ? escapar(d.overview) : "", bloque("👉", pendientes), bloque("✅", decisiones), bloque("❓", preguntas)];
  await responder(env, partes.filter(Boolean).join("\n\n").slice(0, 3900));
}

export async function webhookOmi(env: Env, cuerpo: unknown, uid: string | null): Promise<void> {
  // El primer webhook fija el uid de Diego; después solo se acepta ese.
  const dueno = await config(env, "omi_uid");
  if (uid && dueno && uid !== dueno) return;
  if (uid && !dueno) await guardarConfig(env, "omi_uid", uid);
  if (Array.isArray(cuerpo)) return; // transcripción en vivo: no se usa, basta la conversación procesada
  const c = cuerpo as Conversacion & Dia;
  if (c.summary_json) return dia(env, c.summary_json, c.created_at ?? new Date().toISOString());
  if (c.structured || c.transcript_segments) return conversacion(env, c);
}
