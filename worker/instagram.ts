// Motor de Instagram: los DMs llegan por el webhook de la app de Meta y los comentarios se
// revisan cada minuto (su webhook pide Advanced Access). Lo que hay que pensar se encola en
// pensamientos_ig y lo resuelve Claude en GitHub Actions con la suscripción de Diego (el Worker
// no puede correr el Agent SDK); el Worker aplica la decisión y responde por la API de Instagram.
import { type Env, type Lead, avisarInstagram, config, guardarConfig, igualSeguro, leadAGhl, telefonoE164 } from "./comun";

const GRAPH = "https://graph.instagram.com/v23.0";
// Los textos del flujo de comentario→DM de Buzzfy llegan como eco sin ser de Diego.
const TEXTOS_AUTOMATICOS = ["¡Buenas! 🎉 Vi tu comentario", "¡Qué más! 🙌 Aquí está la info"];
const NO_SE_LE_ESCRIBE = ["diego", "ruido", "no_califica"];

type LeadIg = Lead & { ig_id: string | null; mensajes_bot: number; ultimo_envio: string | null; notas: string | null };
type Perfil = { username?: string; name?: string; follower_count?: number; is_user_follow_business?: boolean };
type Evento = {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean; app_id?: number; attachments?: { type: string }[] };
};
type Comentario = { id: string; text?: string; timestamp?: string; from?: { id: string; username?: string }; username?: string };
type Media = { id: string; caption?: string; permalink?: string; media_type?: string; timestamp?: string };

type Decision = {
  estado: string;
  negocio: string | null;
  negocio_ig?: string | null;
  necesidad: string | null;
  presupuesto: string | null;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  respuesta: string | null;
  aviso: string | null;
};
type DecisionComentario = { accion: "ignorar" | "responder"; publica: string | null; dm: string | null; aviso: string | null };

const ahora = () => new Date().toISOString();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Meta firma cada POST con el app secret: sin firma válida, el cuerpo no se toca.
// Una app con login de Instagram tiene dos claves (la de la app y la de Instagram) y la doc no
// es clara sobre cuál firma los webhooks: vale cualquiera de las dos.
export async function verificarFirmaMeta(env: Env, cuerpo: string, firma: string): Promise<boolean> {
  for (const secreto of [env.META_APP_SECRET, env.IG_APP_SECRET]) {
    if (!secreto) continue;
    const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (igualSeguro(firma, `sha256=${hex}`)) return true;
  }
  return false;
}

// El token largo dura 60 días: se renueva solo cada día y el vigente vive en config.
async function token(env: Env): Promise<string | null> {
  const guardado = await config(env, "ig_token");
  if (guardado) return guardado;
  if (!env.IG_TOKEN) return null;
  await guardarConfig(env, "ig_token", env.IG_TOKEN);
  return env.IG_TOKEN;
}

export async function refrescarTokenIg(env: Env): Promise<void> {
  const actual = await token(env);
  if (!actual) return;
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(actual)}`);
  if (!res.ok) throw new Error(`refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  await guardarConfig(env, "ig_token", access_token);
  await guardarConfig(env, "ig_token_expira", new Date(Date.now() + expires_in * 1000).toISOString());
}

async function ig<T>(env: Env, ruta: string, init: RequestInit = {}): Promise<T> {
  const t = await token(env);
  if (!t) throw new Error("falta el token de Instagram (IG_TOKEN)");
  const res = await fetch(`${GRAPH}${ruta}`, { ...init, headers: { Authorization: `Bearer ${t}`, ...(init.headers ?? {}) } });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Instagram ${res.status} en ${ruta.split("?")[0]}: ${texto.slice(0, 200)}`);
  return JSON.parse(texto) as T;
}

async function miCuenta(env: Env): Promise<{ id: string; username: string }> {
  const [id, username] = await Promise.all([config(env, "ig_user_id"), config(env, "ig_username")]);
  if (id && username) return { id, username };
  const yo = await ig<{ user_id: string | number; username: string }>(env, "/me?fields=user_id,username");
  await guardarConfig(env, "ig_user_id", String(yo.user_id));
  await guardarConfig(env, "ig_username", yo.username);
  return { id: String(yo.user_id), username: yo.username };
}

// Si Instagram rechaza la acción no pasa nada: es solo un detalle visual.
async function accionChat(env: Env, igId: string, accion: "mark_seen" | "typing_on"): Promise<void> {
  await ig(env, "/me/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: igId }, sender_action: accion }),
  }).catch(() => {});
}

async function enviarDm(env: Env, destino: { id: string } | { comment_id: string }, texto: string): Promise<{ mid: string; igId: string | null }> {
  const r = await ig<{ message_id: string; recipient_id?: string }>(env, "/me/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: destino, message: { text: texto } }),
  });
  return { mid: r.message_id, igId: r.recipient_id ?? ("id" in destino ? destino.id : null) };
}

const pausado = async (env: Env) => (await config(env, "pausa_ig_bot")) === "1";

// Los fallos van a Telegram en una línea: dentro de waitUntil nadie más los vería.
const fallo = (env: Env, donde: string) => (e: unknown) => avisarInstagram(env, `⚠️ **Instagram (${donde})**: ${String(e).slice(0, 300)}`).catch(() => {});

export async function procesarWebhookInstagram(env: Env, cuerpo: unknown): Promise<void> {
  const { object, entry = [] } = cuerpo as { object?: string; entry?: { messaging?: Evento[]; changes?: { field: string; value: unknown }[] }[] };
  if (object !== "instagram") return;
  const tareas: Promise<unknown>[] = [];
  for (const e of entry) {
    for (const ev of e.messaging ?? []) {
      if (!ev.message?.mid) continue; // reacciones, vistos y botones de otras apps no se contestan
      tareas.push((ev.message.is_echo ? manejarEco(env, ev) : manejarDm(env, ev)).catch(fallo(env, "DM")));
    }
    for (const c of e.changes ?? []) {
      if (c.field !== "comments") continue;
      const v = c.value as Comentario & { media?: { id: string } };
      if (!v.media?.id) continue;
      tareas.push(
        ig<Media>(env, `/${v.media.id}?fields=id,caption,permalink,media_type,timestamp`)
          .then((m) => manejarComentario(env, m, { ...v, username: v.from?.username }))
          .catch(fallo(env, "comentario")),
      );
    }
  }
  await Promise.all(tareas);
}

// Eco = algo que salió de la cuenta. Si no lo mandó el bot ni una automatización, escribió Diego
// a mano y el bot se hace a un lado con ese lead.
async function manejarEco(env: Env, ev: Evento): Promise<void> {
  const m = ev.message!;
  await dormir(3000); // el eco puede llegar antes de que guardemos el mid de lo que mandó el bot
  const nuestro = await env.DB.prepare("SELECT 1 FROM mensajes_ig WHERE mid = ?").bind(m.mid).first();
  if (nuestro) return;
  const texto = m.text ?? "";
  const automatico = !!m.app_id || TEXTOS_AUTOMATICOS.some((t) => texto.startsWith(t));
  const igId = ev.recipient.id;
  const lead = await env.DB.prepare("SELECT usuario FROM leads_ig WHERE ig_id = ?").bind(igId).first<{ usuario: string }>();
  await env.DB.prepare("INSERT OR IGNORE INTO mensajes_ig (ig_id, usuario, rol, texto, mid, fecha) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(igId, lead?.usuario ?? null, automatico ? "auto" : "diego", texto, m.mid, new Date(ev.timestamp).toISOString())
    .run();
  if (!automatico && lead) await env.DB.prepare("UPDATE leads_ig SET estado = 'diego', actualizado = ? WHERE ig_id = ?").bind(ahora(), igId).run();
}

async function manejarDm(env: Env, ev: Evento): Promise<void> {
  const m = ev.message!;
  const igId = ev.sender.id;
  const texto = m.text ?? (m.attachments?.length ? `[mandó ${m.attachments.map((a) => a.type).join(", ")}]` : "");
  // Meta reintenta los webhooks: el mid único evita contestar dos veces lo mismo.
  const guardado = await env.DB.prepare("INSERT OR IGNORE INTO mensajes_ig (ig_id, rol, texto, mid, fecha) VALUES (?, 'lead', ?, ?, ?)")
    .bind(igId, texto, m.mid, new Date(ev.timestamp).toISOString())
    .run();
  if (!guardado.meta.changes) return;
  const miId = Number(guardado.meta.last_row_id);

  const { lead } = await leadDe(env, igId);
  await env.DB.prepare("UPDATE mensajes_ig SET usuario = ? WHERE id = ?").bind(lead.usuario, miId).run();
  if (await pausado(env)) return;

  // La gente manda varios mensajes seguidos: se espera un poco y se atiende solo el último.
  await dormir(3000);
  const masNuevo = await env.DB.prepare("SELECT 1 FROM mensajes_ig WHERE ig_id = ? AND rol = 'lead' AND id > ?").bind(igId, miId).first();
  if (masNuevo) return;
  await atenderLead(env, igId);
}

// Candado por lead mientras Claude piensa en Actions: si escribe de nuevo en ese rato, al aplicar
// la decisión se vuelve a encolar con todo. Caduca a los 5 min por si un run de Actions se cae.
async function tomarCandado(env: Env, igId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE leads_ig SET procesando = ? WHERE ig_id = ? AND (procesando IS NULL OR procesando < ?)")
    .bind(ahora(), igId, new Date(Date.now() - 5 * 60_000).toISOString())
    .run();
  return !!r.meta.changes;
}

const soltarCandado = (env: Env, igId: string) => env.DB.prepare("UPDATE leads_ig SET procesando = NULL WHERE ig_id = ?").bind(igId).run();

async function atenderLead(env: Env, igId: string): Promise<void> {
  if (!(await tomarCandado(env, igId))) return;
  try {
    const encolado = await encolarDm(env, igId);
    if (!encolado) await soltarCandado(env, igId);
  } catch (e) {
    await soltarCandado(env, igId);
    throw e;
  }
}

// Arma lo que Claude necesita saber del lead y lo deja en cola. Devuelve false si no hay nada que pensar.
async function encolarDm(env: Env, igId: string): Promise<boolean> {
  const lead = await env.DB.prepare("SELECT * FROM leads_ig WHERE ig_id = ?").bind(igId).first<LeadIg>();
  if (!lead || NO_SE_LE_ESCRIBE.includes(lead.estado)) return false;
  if (lead.estado === "calificado" && lead.telefono) return false; // ya lo tiene Diego
  if (lead.estado === "pana") {
    await avisarPana(env, lead, igId);
    return false;
  }
  // "Visto" y "escribiendo…" mientras Claude piensa: la persona sabe que ya la están atendiendo.
  await accionChat(env, igId, "mark_seen");
  await accionChat(env, igId, "typing_on");
  const perfil = await ig<Perfil>(env, `/${igId}?fields=username,name,follower_count,is_user_follow_business`).catch(() => ({}) as Perfil);
  const { results } = await env.DB.prepare("SELECT id, rol, texto, fecha FROM mensajes_ig WHERE ig_id = ? ORDER BY id DESC LIMIT 20")
    .bind(igId)
    .all<{ id: number; rol: string; texto: string; fecha: string }>();
  // Lo que pasó antes de que existiera el bot solo está en Instagram: en el primer contacto se trae.
  const previos = lead.mensajes_bot === 0 && results.length <= 2 ? await historialPrevio(env, igId) : "";
  const quien: Record<string, string> = { lead: "Lead", bot: "Tú", diego: "Diego (a mano)", auto: "Automático" };
  const ultimoLead = Math.max(0, ...results.filter((r) => r.rol === "lead").map((r) => r.id));
  const conversacion = [...results]
    .reverse()
    .map((r) => `[${r.fecha.slice(0, 16)}] ${quien[r.rol] ?? r.rol}: ${r.texto}`)
    .join("\n");
  const { procesando: _, ...guardado } = lead as LeadIg & { procesando?: unknown };
  const contenido = `<lead>\n${JSON.stringify(guardado)}\n</lead>\n<perfil>\n${JSON.stringify(perfil)}\n</perfil>\n${previos ? `<historial_en_instagram>\n${previos}\n</historial_en_instagram>\n` : ""}<conversacion>\n${conversacion}\n</conversacion>`;
  await encolar(env, "dm", igId, contenido, { ultimoLead });
  return true;
}

async function aplicarDm(env: Env, igId: string, d: Decision, datos: { ultimoLead?: number }): Promise<void> {
  const lead = await env.DB.prepare("SELECT * FROM leads_ig WHERE ig_id = ?").bind(igId).first<LeadIg>();
  if (!lead) return;
  // Si mientras pensaba Diego tomó el chat, no se manda nada.
  const respuesta = lead.estado === "diego" || (await pausado(env)) ? null : d.respuesta?.trim() || null;

  let enviado: string | null = null;
  if (respuesta) {
    const { mid } = await enviarDm(env, { id: igId }, respuesta);
    enviado = respuesta;
    await env.DB.prepare("INSERT OR IGNORE INTO mensajes_ig (ig_id, usuario, rol, texto, mid, fecha) VALUES (?, ?, 'bot', ?, ?, ?)")
      .bind(igId, lead.usuario, enviado, mid, ahora())
      .run();
  }
  const ultimo = await env.DB.prepare("SELECT MAX(fecha) AS fecha FROM mensajes_ig WHERE ig_id = ? AND rol = 'lead'").bind(igId).first<{ fecha: string }>();
  await env.DB.prepare(
    `UPDATE leads_ig SET estado = CASE WHEN estado = 'diego' THEN 'diego' ELSE ? END, negocio = COALESCE(?, negocio), negocio_ig = COALESCE(?, negocio_ig), necesidad = COALESCE(?, necesidad),
       presupuesto = COALESCE(?, presupuesto), nombre = COALESCE(?, nombre), telefono = COALESCE(?, telefono), email = COALESCE(?, email),
       mensajes_bot = mensajes_bot + ?, ultimo_envio = COALESCE(?, ultimo_envio), ultimo_visto = ?, actualizado = ? WHERE ig_id = ?`,
  )
    .bind(
      d.estado,
      d.negocio,
      d.negocio_ig?.replace(/^@/, "").trim() || null,
      d.necesidad,
      d.presupuesto,
      d.nombre,
      d.telefono ? telefonoE164(d.telefono) || null : null,
      d.email,
      enviado ? 1 : 0,
      enviado,
      ultimo?.fecha ?? ahora(),
      ahora(),
      igId,
    )
    .run();

  let aviso = d.aviso?.trim() ?? "";
  const actualizado = await env.DB.prepare("SELECT * FROM leads_ig WHERE ig_id = ?").bind(igId).first<LeadIg>();
  if (actualizado) {
    const ghl = await leadAGhl(actualizado, env);
    if (ghl === "enviado") aviso = `${aviso}\n\n📇 Ya está en GHL`.trim();
    else if (ghl) aviso = `${aviso}\n\n⚠️ No entró a GHL: ${ghl}`.trim();
  }
  if (aviso) await avisarInstagram(env, aviso);

  // Escribió mientras Claude pensaba: se vuelve a pensar con todo lo nuevo.
  await soltarCandado(env, igId);
  const nuevo = await env.DB.prepare("SELECT 1 FROM mensajes_ig WHERE ig_id = ? AND rol = 'lead' AND id > ?").bind(igId, datos.ultimoLead ?? 0).first();
  if (nuevo) await atenderLead(env, igId);
}

// Busca o crea el lead por su id de Instagram; el username sale del perfil (solo se puede leer
// de quien ya nos escribió, que es justo el caso).
async function leadDe(env: Env, igId: string): Promise<{ lead: LeadIg; perfil: Perfil }> {
  const perfil = await ig<Perfil>(env, `/${igId}?fields=username,name,follower_count,is_user_follow_business`).catch(() => ({}) as Perfil);
  let lead = await env.DB.prepare("SELECT * FROM leads_ig WHERE ig_id = ?").bind(igId).first<LeadIg>();
  if (!lead) {
    const usuario = perfil.username ?? `ig_${igId}`;
    await env.DB.prepare(
      `INSERT INTO leads_ig (usuario, ig_id, estado, creado, actualizado) VALUES (?, ?, 'cualificando', ?, ?)
       ON CONFLICT (usuario) DO UPDATE SET ig_id = excluded.ig_id, actualizado = excluded.actualizado`,
    )
      .bind(usuario, igId, ahora(), ahora())
      .run();
    lead = (await env.DB.prepare("SELECT * FROM leads_ig WHERE ig_id = ?").bind(igId).first<LeadIg>())!;
  }
  return { lead, perfil };
}

// A un pana no se le contesta: se le avisa a Diego una vez por tanda de mensajes.
async function avisarPana(env: Env, lead: LeadIg, igId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT texto, fecha FROM mensajes_ig WHERE ig_id = ? AND rol = 'lead' ORDER BY id DESC LIMIT 2")
    .bind(igId)
    .all<{ texto: string; fecha: string }>();
  const [ultimo, anterior] = results;
  if (!ultimo || (anterior && Date.parse(ultimo.fecha) - Date.parse(anterior.fecha) < 3_600_000)) return;
  await avisarInstagram(env, `👋 **Un pana te escribió** — @${lead.usuario}\n💬 Dijo: "${ultimo.texto.slice(0, 200)}"`);
}

async function historialPrevio(env: Env, igId: string): Promise<string> {
  try {
    const yo = await miCuenta(env);
    const { data } = await ig<{ data: { messages?: { data: { message?: string; from?: { id: string }; created_time: string }[] } }[] }>(
      env,
      `/me/conversations?user_id=${igId}&fields=messages.limit(20){message,from,created_time}`,
    );
    const mensajes = data[0]?.messages?.data ?? [];
    return mensajes
      .reverse()
      .map((x) => {
        const deLaCuenta = x.from?.id === yo.id;
        const automatico = TEXTOS_AUTOMATICOS.some((t) => (x.message ?? "").startsWith(t));
        return `[${x.created_time.slice(0, 16)}] ${deLaCuenta ? (automatico ? "Automático" : "Diego") : "Lead"}: ${x.message ?? "(adjunto)"}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// Cada minuto: comentarios nuevos de las últimas 10 publicaciones (los trial reels también cuentan). Sin Advanced Access Meta no
// manda el webhook de comentarios, así que se leen por la API (lectura de la propia cuenta).
const MAX_COMENTARIOS_POR_MINUTO = 5; // los Workers tienen tope de subrequests por ejecución

export async function revisarComentarios(env: Env): Promise<void> {
  if (!(await token(env))) return; // la app de Meta todavía no está conectada
  const yo = await miCuenta(env);
  const media = await mediaReciente(env);
  // La marca va en config y no en "tabla vacía": si los posts recientes no tienen comentarios,
  // el primero que llegue después igual se contesta.
  const primeraVez = !(await config(env, "ig_comentarios_desde"));
  const enPausa = await pausado(env);
  let atendidos = 0;
  for (const m of media) {
    const { data = [] } = await ig<{ data?: Comentario[] }>(env, `/${m.id}/comments?fields=id,text,timestamp,from,username&limit=50`);
    const ajenos = data.filter((c) => (c.from?.username ?? c.username) !== yo.username);
    if (!ajenos.length) continue;
    const vistos = new Set(
      (await env.DB.prepare(`SELECT id FROM comentarios_ig WHERE id IN (${ajenos.map(() => "?").join(",")})`).bind(...ajenos.map((c) => c.id)).all<{ id: string }>()).results.map((r) => r.id),
    );
    for (const c of ajenos.filter((c) => !vistos.has(c.id))) {
      // La primera vez solo se marcan: no se contesta lo que la gente escribió antes del bot.
      // Los privados a comentarios caducan a los 7 días, así que lo viejo tampoco se toca.
      const viejo = c.timestamp && Date.now() - Date.parse(c.timestamp) > 7 * 86_400_000;
      if (primeraVez || enPausa || viejo) {
        await marcarComentario(env, m, c, primeraVez ? "previo" : enPausa ? "pausa" : "viejo");
        continue;
      }
      if (atendidos >= MAX_COMENTARIOS_POR_MINUTO) continue; // quedan para el próximo minuto
      atendidos++;
      await manejarComentario(env, m, c).catch(fallo(env, "comentario"));
    }
  }
  if (primeraVez) await guardarConfig(env, "ig_comentarios_desde", ahora());
}

async function mediaReciente(env: Env): Promise<Media[]> {
  const cache = await config(env, "ig_media_cache");
  if (cache) {
    const { fecha, media } = JSON.parse(cache) as { fecha: number; media: Media[] };
    if (Date.now() - fecha < 10 * 60_000) return media;
  }
  const { data = [] } = await ig<{ data?: Media[] }>(env, "/me/media?fields=id,caption,permalink,media_type,timestamp&limit=10");
  await guardarConfig(env, "ig_media_cache", JSON.stringify({ fecha: Date.now(), media: data }));
  return data;
}

async function marcarComentario(env: Env, m: Media, c: Comentario, accion: string): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO comentarios_ig (id, media_id, usuario, texto, accion, fecha) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(c.id, m.id, c.from?.username ?? c.username ?? null, c.text ?? "", accion, ahora())
    .run();
  return !!r.meta.changes;
}

async function manejarComentario(env: Env, m: Media, c: Comentario): Promise<void> {
  // Se marca antes de pensar: el webhook y el cron no pueden contestar el mismo comentario.
  if (!(await marcarComentario(env, m, c, "procesando"))) return;
  if (await pausado(env)) {
    await env.DB.prepare("UPDATE comentarios_ig SET accion = 'pausa' WHERE id = ?").bind(c.id).run();
    return;
  }
  const usuario = c.from?.username ?? c.username ?? null;
  const contenido = `<publicacion>\nTipo: ${m.media_type ?? "—"}\nLink: ${m.permalink ?? "—"}\nCaption:\n${m.caption ?? "(sin caption)"}\n</publicacion>\n<comentario>\n@${usuario ?? "alguien"}: ${c.text ?? ""}\n</comentario>`;
  await encolar(env, "comentario", c.id, contenido, { media: m, comentario: c });
}

async function aplicarComentario(env: Env, d: DecisionComentario, datos: { media: Media; comentario: Comentario }): Promise<void> {
  const { media: m, comentario: c } = datos;
  const usuario = c.from?.username ?? c.username ?? null;
  if (await pausado(env)) {
    await env.DB.prepare("UPDATE comentarios_ig SET accion = 'pausa' WHERE id = ?").bind(c.id).run();
    return;
  }
  const hecho: string[] = [d.accion];
  if (d.accion === "responder" && d.publica?.trim()) {
    await ig(env, `/${c.id}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: d.publica.trim() }).toString(),
    });
    hecho.push("publica");
  }
  if (d.accion === "responder" && d.dm?.trim() && usuario) {
    // Si ya está en conversación o en manos de Diego, no se le abre otro DM.
    const lead = await env.DB.prepare("SELECT estado, mensajes_bot FROM leads_ig WHERE usuario = ?").bind(usuario).first<{ estado: string; mensajes_bot: number }>();
    if (!lead || (lead.estado === "cualificando" && lead.mensajes_bot === 0)) {
      const { mid, igId } = await enviarDm(env, { comment_id: c.id }, d.dm.trim());
      await env.DB.prepare(
        `INSERT INTO leads_ig (usuario, ig_id, estado, mensajes_bot, ultimo_envio, notas, creado, actualizado) VALUES (?, ?, 'cualificando', 1, ?, ?, ?, ?)
         ON CONFLICT (usuario) DO UPDATE SET ig_id = COALESCE(excluded.ig_id, leads_ig.ig_id), mensajes_bot = leads_ig.mensajes_bot + 1,
           ultimo_envio = excluded.ultimo_envio, actualizado = excluded.actualizado`,
      )
        .bind(usuario, igId, d.dm.trim(), `llegó por un comentario en ${m.permalink ?? m.id}`, ahora(), ahora())
        .run();
      await env.DB.prepare("INSERT OR IGNORE INTO mensajes_ig (ig_id, usuario, rol, texto, mid, fecha) VALUES (?, ?, 'bot', ?, ?, ?)")
        .bind(igId, usuario, d.dm.trim(), mid, ahora())
        .run();
      hecho.push("dm");
    }
  }
  await env.DB.prepare("UPDATE comentarios_ig SET accion = ? WHERE id = ?").bind(hecho.join("+"), c.id).run();
  if (d.aviso?.trim()) await avisarInstagram(env, d.aviso.trim());
}

// --- Cola de pensamientos: Claude piensa en GitHub Actions con la suscripción de Diego ---

type Pensamiento = { id: number; tipo: "dm" | "comentario"; ref: string; contenido: string; datos: string };

async function encolar(env: Env, tipo: Pensamiento["tipo"], ref: string, contenido: string, datos: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO pensamientos_ig (tipo, ref, contenido, datos, creado) VALUES (?, ?, ?, ?, ?)")
    .bind(tipo, ref, contenido, JSON.stringify(datos), ahora())
    .run();
  await dispararPensador(env);
}

// Un run procesa todo lo pendiente; si ya hay uno corriendo, GitHub deja uno en espera y ese lo
// recoge al terminar. Por eso basta con disparar en cada encolado.
async function dispararPensador(env: Env): Promise<void> {
  // Si un run ya está escuchando la cola (latido de hace menos de 60 s), lo toma en ~1 s.
  const latido = await config(env, "ig_pensador_latido");
  if (latido && Date.now() - Date.parse(latido) < 60_000) return;
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/instagram.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_TOKEN_DISPARO}`, Accept: "application/vnd.github+json", "User-Agent": "cerebro-yeyo" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error(`GitHub respondió ${res.status} al disparar instagram.yml`);
}

// GET: el script toma lo pendiente (y lo que un run caído dejó tomado hace más de 5 min).
// POST {id, decision}: el Worker aplica la decisión; decision null = Claude no pudo decidir.
export async function pensamientosInstagram(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!env.AGENTES_SECRET || !igualSeguro(auth, `Bearer ${env.AGENTES_SECRET}`)) return new Response("no", { status: 401 });
  if (req.method === "GET") {
    await guardarConfig(env, "ig_pensador_latido", ahora());
    const corte = new Date(Date.now() - 5 * 60_000).toISOString();
    const { results } = await env.DB.prepare(
      "SELECT id, tipo, contenido FROM pensamientos_ig WHERE estado = 'pendiente' AND (tomado IS NULL OR tomado < ?) ORDER BY id LIMIT 10",
    )
      .bind(corte)
      .all<Pick<Pensamiento, "id" | "tipo" | "contenido">>();
    if (results.length) {
      await env.DB.prepare(`UPDATE pensamientos_ig SET tomado = ? WHERE id IN (${results.map(() => "?").join(",")})`)
        .bind(ahora(), ...results.map((r) => r.id))
        .run();
    }
    return Response.json({ pensamientos: results });
  }
  if (req.method !== "POST") return new Response("no", { status: 405 });
  const cuerpo = (await req.json()) as { id?: number; decision?: Decision | DecisionComentario | null; adios?: boolean };
  // El run se va a apagar: desde ahora cada encolado vuelve a disparar el workflow.
  if (cuerpo.adios) {
    await env.DB.prepare("DELETE FROM config WHERE clave = 'ig_pensador_latido'").run();
    return Response.json({ ok: true });
  }
  const { id, decision } = cuerpo;
  // Se marca primero: si Actions reintenta el POST, la decisión no se aplica dos veces.
  const tomado = await env.DB.prepare("UPDATE pensamientos_ig SET estado = ? WHERE id = ? AND estado = 'pendiente'")
    .bind(decision ? "hecho" : "fallido", id ?? 0)
    .run();
  if (!tomado.meta.changes) return Response.json({ ok: true, repetido: true });
  const p = await env.DB.prepare("SELECT * FROM pensamientos_ig WHERE id = ?").bind(id).first<Pensamiento>();
  if (!p) return Response.json({ error: "no existe" }, { status: 404 });
  const datos = JSON.parse(p.datos || "{}");
  try {
    if (!decision) {
      if (p.tipo === "dm") await soltarCandado(env, p.ref);
      await avisarInstagram(env, `⚠️ **Instagram**: Claude no pudo decidir qué responder (${p.tipo} ${p.tipo === "dm" ? "de un lead" : "en un comentario"}). Revísalo a mano.`);
    } else if (p.tipo === "dm") await aplicarDm(env, p.ref, decision as Decision, datos);
    else await aplicarComentario(env, decision as DecisionComentario, datos);
    return Response.json({ ok: true });
  } catch (e) {
    if (p.tipo === "dm") await soltarCandado(env, p.ref);
    await env.DB.prepare("UPDATE pensamientos_ig SET estado = 'fallido' WHERE id = ?").bind(p.id).run();
    await fallo(env, p.tipo)(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Cada minuto: si algo lleva más de 45 s en cola sin que nadie lo tome, se vuelve a disparar
// (un run que se cayó o un encolado justo cuando el pensador se apagaba).
export async function rescatarPensamientos(env: Env): Promise<void> {
  const corte = new Date(Date.now() - 45_000).toISOString();
  const atascado = await env.DB.prepare(
    "SELECT 1 FROM pensamientos_ig WHERE estado = 'pendiente' AND creado < ? AND (tomado IS NULL OR tomado < ?) LIMIT 1",
  )
    .bind(corte, new Date(Date.now() - 5 * 60_000).toISOString())
    .first();
  if (!atascado) return;
  await env.DB.prepare("DELETE FROM config WHERE clave = 'ig_pensador_latido'").run();
  await dispararPensador(env);
}
