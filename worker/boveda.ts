// Bóveda de Diego en Telegram: guarda claves cifradas (AES-GCM) con BOVEDA_KEY, un secret del
// Worker que no vive en D1 ni en el repo. Nunca pasa por Claude ni por la memoria de los agentes:
// /guardar borra el mensaje de Diego y /clave muestra el valor tapado (spoiler) y se borra solo.
import { type Env, escapar, responder, telegram } from "./comun";

const NOMBRE = /^[a-z0-9_.-]{1,40}$/;
const VISIBLE_MS = 60_000;

// Para avisar si Diego pega una clave en la conversación normal (que sí va a la memoria y a Claude).
const PREFIJOS = /\b(cfut_|cfat_|ghp_|gho_|github_pat_|sk-ant-|sk-|xox[abp]-|EAA[A-Za-z0-9]{20}|IGAA[A-Za-z0-9]{20}|AKIA[A-Z0-9]{12})/;
export const pareceClave = (texto: string): boolean => {
  const sinLinks = texto.replace(/https?:\/\/\S+/g, "");
  return PREFIJOS.test(sinLinks) || sinLinks.split(/\s+/).some((p) => p.length >= 32 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p));
};

async function llave(env: Env): Promise<CryptoKey> {
  if (!env.BOVEDA_KEY) throw new Error("Falta el secret BOVEDA_KEY en el Worker");
  const crudo = Uint8Array.from(atob(env.BOVEDA_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", crudo, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const aBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const deBase64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

// El nombre va como dato adicional: un valor cifrado no se puede mover a otro nombre.
async function cifrar(env: Env, nombre: string, valor: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(nombre) }, await llave(env), new TextEncoder().encode(valor));
  return `${aBase64(iv)}.${aBase64(new Uint8Array(datos))}`;
}

async function descifrar(env: Env, nombre: string, cifrado: string): Promise<string> {
  const [iv, datos] = cifrado.split(".");
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deBase64(iv), additionalData: new TextEncoder().encode(nombre) }, await llave(env), deBase64(datos));
  return new TextDecoder().decode(claro);
}

const borrarMensaje = (env: Env, chat_id: number | string, message_id: number) => telegram(env, "deleteMessage", { chat_id, message_id });

const botonVer = (nombre: string) => ({ inline_keyboard: [[{ text: `🔓 Ver ${nombre}`, callback_data: `ver:${nombre}` }]] });

// /guardar <nombre> <valor> · /clave <nombre> · /claves · /olvidar <nombre>
export async function comandoBoveda(env: Env, comando: string, texto: string, chatId: number, mensajeId: number): Promise<void> {
  const [, nombreCrudo = "", ...resto] = texto.split(/\s+/);
  const nombre = nombreCrudo.toLowerCase();
  if (comando === "/claves") return listaClaves(env);
  if (comando === "/guardar") {
    // Primero se borra: aunque el nombre esté mal, la clave no se queda en el chat.
    await borrarMensaje(env, chatId, mensajeId);
    const valor = texto.slice(texto.indexOf(nombreCrudo) + nombreCrudo.length).trim();
    if (!NOMBRE.test(nombre) || !valor || !resto.length)
      return responder(env, "🔐 Así se guarda:\n<code>/guardar cloudflare cfut_xxx</code>\n\nEl nombre va en minúsculas, sin espacios (letras, números, _ . -). Ya borré tu mensaje por si acaso 🧹");
    await env.DB.prepare("INSERT INTO boveda (nombre, cifrado, actualizado) VALUES (?, ?, ?) ON CONFLICT (nombre) DO UPDATE SET cifrado = excluded.cifrado, actualizado = excluded.actualizado")
      .bind(nombre, await cifrar(env, nombre, valor), new Date().toISOString())
      .run();
    return telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🔐 <b>Guardé ${escapar(nombre)} cifrado</b>\nBorré tu mensaje del chat 🧹\n\nPídemelo con /clave ${escapar(nombre)} o desde /claves`,
      parse_mode: "HTML",
      reply_markup: botonVer(nombre),
    });
  }
  if (!NOMBRE.test(nombre)) return responder(env, `🤔 Dime cuál: <code>${comando} nombre</code>\nTus claves: /claves`);
  if (comando === "/olvidar") {
    const { meta } = await env.DB.prepare("DELETE FROM boveda WHERE nombre = ?").bind(nombre).run();
    return responder(env, meta.changes ? `🗑️ Borré <b>${escapar(nombre)}</b> de la bóveda` : `🤷 No tengo ninguna clave llamada <b>${escapar(nombre)}</b>`);
  }
  return mostrarClave(env, nombre);
}

async function listaClaves(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT nombre FROM boveda ORDER BY nombre").all<{ nombre: string }>();
  if (!results.length) return responder(env, "🔐 La bóveda está vacía.\n\nGuarda una así:\n<code>/guardar cloudflare cfut_xxx</code>");
  await telegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: `🔐 <b>Tu bóveda</b> (${results.length})\nToca una para verla 👇🏾`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: results.map((r) => [{ text: `🔓 ${r.nombre}`, callback_data: `ver:${r.nombre}` }]) },
  });
}

// El valor sale tapado (toca para ver, toca otra vez para copiar) y el mensaje se borra al minuto siguiente.
export async function mostrarClave(env: Env, nombre: string): Promise<void> {
  const fila = await env.DB.prepare("SELECT cifrado FROM boveda WHERE nombre = ?").bind(nombre).first<{ cifrado: string }>();
  if (!fila) return responder(env, `🤷 No tengo ninguna clave llamada <b>${escapar(nombre)}</b>\nTus claves: /claves`);
  const valor = await descifrar(env, nombre, fila.cifrado);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🔐 <b>${escapar(nombre)}</b>\n<tg-spoiler><code>${escapar(valor)}</code></tg-spoiler>\n\n<i>Toca para verla y otra vez para copiarla. Este mensaje se borra en un minuto o dos ⏳</i>`,
      parse_mode: "HTML",
    }),
  });
  const { result } = (await res.json()) as { result?: { message_id: number } };
  if (!result) throw new Error(`Telegram no mostró la clave (${res.status})`);
  await env.DB.prepare("INSERT INTO tg_borrar (chat_id, message_id, cuando) VALUES (?, ?, ?)")
    .bind(String(env.TELEGRAM_CHAT_ID), result.message_id, new Date(Date.now() + VISIBLE_MS).toISOString())
    .run();
}

// Cada minuto: borra del chat las claves que ya se mostraron.
export async function borrarVencidos(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT rowid, chat_id, message_id FROM tg_borrar WHERE cuando <= ?").bind(new Date().toISOString()).all<{ rowid: number; chat_id: string; message_id: number }>();
  for (const r of results) {
    await borrarMensaje(env, r.chat_id, r.message_id);
    await env.DB.prepare("DELETE FROM tg_borrar WHERE rowid = ?").bind(r.rowid).run();
  }
}
