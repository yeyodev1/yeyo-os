// Piezas que comparten el Worker principal y el motor de Instagram.
export interface Env {
  DB: D1Database;
  GH_REPO: string;
  GH_USUARIO: string; // cuya actividad pública se lee como material
  VERCEL_TOKEN?: string; // deploys a producción como material
  VERCEL_TEAM_ID: string;
  GH_TOKEN_DISPARO: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_VINCULO: string; // código del link t.me/<bot>?start=<código> que vincula a Diego
  TELEGRAM_CHAT_ID?: string;
  AGENTES_SECRET: string; // los agentes de GitHub Actions leen y escriben D1 por /api/sql
  AVISOS_SECRET: string; // la rutina cloud de Instagram solo puede avisar y guardar en fuentes
  GHL_WEBHOOK_URL?: string; // webhook del workflow de leads de la landing de Bakano en GHL
  // Motor de Instagram al instante (app de Meta con Instagram Login sobre @yeyo.dev)
  META_APP_SECRET?: string; // firma X-Hub-Signature-256 de los webhooks
  IG_APP_SECRET?: string; // la otra clave de la app (la de Instagram); la firma puede venir con esta
  META_VERIFY_TOKEN?: string; // lo pide Meta al suscribir el webhook
  IG_TOKEN?: string; // token largo inicial; luego se renueva solo y vive en config ig_token
}

export function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export async function config(env: Env, clave: string): Promise<string | null> {
  return env.DB.prepare("SELECT valor FROM config WHERE clave = ?").bind(clave).first<string>("valor");
}

export async function guardarConfig(env: Env, clave: string, valor: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config (clave, valor, actualizado) VALUES (?, ?, datetime('now')) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado",
  )
    .bind(clave, valor)
    .run();
}

export async function telegram(env: Env, metodo: string, cuerpo: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!res.ok) console.error(`Telegram ${metodo} ${res.status}: ${await res.text()}`);
}

// Mensajes fijos del Worker en HTML de Telegram: todo texto variable pasa por escapar().
export const responder = (env: Env, text: string) =>
  telegram(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });

export const escapar = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Avisos de Instagram: le llegan a Diego por Telegram y quedan en fuentes para que Pana los consulte.
export async function avisarInstagram(env: Env, texto: string, avisar = true): Promise<void> {
  await env.DB.prepare("INSERT INTO fuentes (fecha, origen, externo_id, texto) VALUES (?, 'instagram', ?, ?)")
    .bind(new Date().toISOString(), `ig@${Date.now()}@${Math.random().toString(36).slice(2, 6)}`, texto.slice(0, 8000))
    .run();
  env.TELEGRAM_CHAT_ID ||= (await config(env, "telegram_chat_id")) ?? undefined;
  // **negritas** del reporte se vuelven <b> reales; el resto va escapado.
  const cuerpo = escapar(texto.slice(0, 3800)).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  if (avisar && env.TELEGRAM_CHAT_ID) await responder(env, `📸 <b>Instagram</b>\n\n${cuerpo}`);
}

// Un calificado con teléfono entra a GHL una sola vez, por el mismo webhook y con el mismo
// payload que la landing web.bakano.ec. No pasa por su /api/lead para no mandarle a Meta CAPI
// un "Lead" de la web que no existió (ensuciaría la atribución de las campañas).
export type Lead = { usuario: string; estado: string; negocio: string | null; presupuesto: string | null; necesidad: string | null; nombre: string | null; telefono: string | null; email: string | null; ghl_enviado: string | null };

export async function leadAGhl(l: Lead, env: Env): Promise<string | null> {
  if (l.estado !== "calificado" || !l.telefono || l.ghl_enviado) return null;
  if (!env.GHL_WEBHOOK_URL) return "falta GHL_WEBHOOK_URL";
  const [nombre = "", ...resto] = (l.nombre ?? l.usuario).trim().split(/\s+/);
  // Las ramas del workflow solo conocen web y tienda; la pasarela va con la tienda (PayPhone).
  const interes = /tienda|pasarela/i.test(l.necesidad ?? "") ? "tienda" : /web|p[aá]gina/i.test(l.necesidad ?? "") ? "web" : (l.necesidad ?? "");
  const plan = interes === "tienda" ? "Tienda Online + PayPhone" : interes === "web" ? "Pagina Web Pro" : "Solo informacion";
  const event_id = `dm_${Date.now()}`;
  const notas = [
    "🧾 Lead DMs Instagram @yeyo.dev",
    "📝 Entra a GHL por la misma vía que la landing web.bakano.ec, pero NO llenó la landing: lo cualificó el bot en los DMs de @yeyo.dev. No se reportó a Meta CAPI.",
    `📸 Instagram: @${l.usuario} (https://instagram.com/${l.usuario})`,
    `🏪 Negocio: ${l.negocio ?? "—"}`,
    `🛠️ Necesita: ${l.necesidad ?? "—"}`,
    `💰 Presupuesto (lo que dijo): ${l.presupuesto ?? "—"}`,
    `✉️ Email: ${l.email ?? "—"}`,
    `🆔 Event ID: ${event_id}`,
  ].join("\n");
  const res = await fetch(env.GHL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      etapa: "reconstruccion_lead",
      event_id,
      nombre,
      apellido: resto.join(" "),
      full_name: (l.nombre ?? l.usuario).trim(),
      telefono: l.telefono,
      email: l.email ?? "",
      negocio: l.negocio ?? "",
      interes,
      plan_nombre: plan,
      valor: interes === "tienda" ? "600" : interes === "web" ? "500" : "",
      inversion_confirmada: "si",
      origen: "dm-instagram-yeyo.dev",
      origen_url: `https://instagram.com/${l.usuario}`,
      tags: "dm-instagram-yeyo,lead-caliente",
      notas,
    }),
  });
  if (!res.ok) return `GHL respondió ${res.status}`;
  await env.DB.prepare("UPDATE leads_ig SET ghl_enviado = ? WHERE usuario = ?").bind(new Date().toISOString(), l.usuario).run();
  return "enviado";
}

// Ecuador por defecto: 09xxxxxxxx → +5939xxxxxxxx. Lo que ya trae código de país se respeta.
export function telefonoE164(t: string): string {
  const d = t.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(d)) return d;
  if (/^0\d{9}$/.test(d)) return `+593${d.slice(1)}`;
  if (/^593\d{9}$/.test(d)) return `+${d}`;
  return "";
}
