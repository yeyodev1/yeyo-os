// Agente de X: lo dispara el Worker cada N horas (N lo decide él mismo dentro de un rango).
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, error, ok, sinApertura } from "../comun/agente.ts";
import { contexto, hoy } from "../comun/contexto.ts";
import { guardarConfig, guardarPost, leerConfig, postsDeHoy, sql } from "../comun/memoria.ts";
import { avisar } from "../comun/telegram.ts";
import { publicarHilo, urlTweet, yo } from "./api.ts";
import { catalogoDesdeGithub } from "../instagram/catalogo.ts";
import { citar, hilo, textoDeHilo } from "./formato.ts";
import { capturarPagina, crearTarjeta } from "./imagen.ts";

const DRY_RUN = process.env.DRY_RUN === "1";
const FRECUENCIAS = [1, 2, 3, 4, 6, 8];

if (!DRY_RUN && (await leerConfig("pausa_x")) === "1") {
  console.log("X está en pausa (/sigue x en Telegram para reanudar).");
  process.exit(0);
}

const maxDia = Number(await leerConfig("x_max_dia", "8"));
const deHoy = await postsDeHoy("x");
if (!DRY_RUN && process.env.FORZAR !== "1" && deHoy >= maxDia) {
  console.log(`Ya van ${deHoy} tweets hoy (tope ${maxDia}).`);
  process.exit(0);
}

const cadaHoras = await leerConfig("x_cada_horas", "4");
let publicado: { ids: string[]; texto: string } | null = null;
let decision = "";

const publicar = tool(
  "publicar_tweet",
  "Publica en X: un tweet suelto o un hilo. Llámala UNA sola vez.",
  {
    tweets: hilo,
    citar,
    tipo: z.string().describe("Tipo de tweet según <voz>, ej. 'opinión', 'construyendo', 'tip', 'hilo paso a paso'"),
    gancho: z.string().describe("Cómo abre, ej. 'dato', 'confesión', 'contraintuitivo'"),
    tema: z.string().describe("Tema en 3 a 6 palabras"),
  },
  async ({ tweets, citar, tipo, gancho, tema }) => {
    if (publicado) return error("Ya publicaste en esta ejecución.");
    // Diego quiere imagen en cada hilo: sin ella el agente a veces publica directo.
    if (!tweets[0].imagen) return error("El primer tuit necesita imagen: la del artículo si comentas una noticia, una tarjeta (crear_tarjeta), una captura (capturar_pagina) o una foto tg:... Vuelve a llamar publicar_tweet con ella.");
    tweets = tweets.map((t) => ({ ...t, texto: sinApertura(t.texto) }));
    let ids: string[];
    try {
      ids = DRY_RUN ? ["dry-run"] : await publicarHilo(tweets, citar);
    } catch (e) {
      return error(`No se pudo publicar: ${e instanceof Error ? e.message : e}. Si fue la imagen, intenta sin ella o con otra.`);
    }
    const texto = (citar ? `[cita el tweet ${citar}]\n` : "") + textoDeHilo(tweets);
    publicado = { ids, texto };
    if (!DRY_RUN) {
      await guardarPost({ red: "x", externo_id: ids[0], fecha: new Date().toISOString(), texto, gancho, estructura: tipo, tema, origen: "agente" });
    }
    return ok(`Publicado (${ids.join(", ")}).`);
  },
);

const borrador = tool(
  "dejar_borrador",
  "Si tienes una buena idea pero dudas de que encaje con la voz o los límites (tema sensible, opinión fuerte sobre alguien, dato que no puedes verificar), no publiques: déjale el borrador a Diego por Telegram para que lo revise.",
  { tweets: hilo, citar, motivo: z.string().describe("Por qué dudas") },
  async ({ tweets, citar, motivo }) => {
    const texto = `📝 Borrador para revisar (${motivo})\n\n${citar ? `[cita el tweet ${citar}]\n` : ""}${textoDeHilo(tweets)}\n\nDime "publícalo", pídeme cambios o ignóralo.`;
    decision = `Dejé un borrador: ${motivo}`;
    if (!DRY_RUN) {
      await avisar(texto);
      // Queda en el chat para que el agente de Telegram sepa de qué borrador le hablan.
      await sql("INSERT INTO chat (fecha, rol, texto) VALUES (?, 'agente', ?)", [new Date().toISOString(), texto]);
    }
    return ok("Borrador enviado a Diego.");
  },
);

const noPublicar = tool(
  "no_publicar",
  "Úsala si esta vez no hay nada que valga la pena decir. Mejor nada que un tweet de relleno.",
  { motivo: z.string() },
  async ({ motivo }) => {
    decision = `No publiqué: ${motivo}`;
    return ok("Entendido, no se publica esta vez.");
  },
);

const tarjeta = tool(
  "crear_tarjeta",
  "Crea una imagen 16:9 con tu marca para un tuit del hilo: la idea central en grande (frase), una lista de 3 a 4 puntos, o un antes y después. Sin emojis ni links. Devuelve el valor para el campo imagen.",
  {
    tipo: z.enum(["frase", "lista", "antes_despues"]),
    texto: z.string().max(130).optional().describe("Solo frase: la idea en una oración, máx ~120 caracteres"),
    titulo: z.string().max(70).optional().describe("lista y antes_despues: título corto"),
    puntos: z.array(z.string().max(60)).min(2).max(4).optional().describe("Solo lista"),
    antes: z.array(z.string().max(45)).min(2).max(4).optional().describe("Solo antes_despues"),
    despues: z.array(z.string().max(45)).min(2).max(4).optional().describe("Solo antes_despues"),
  },
  async ({ tipo, texto, titulo, puntos, antes, despues }) => {
    try {
      if (tipo === "frase" && texto) return ok(await crearTarjeta({ tipo, texto }));
      if (tipo === "lista" && titulo && puntos) return ok(await crearTarjeta({ tipo, titulo, puntos }));
      if (tipo === "antes_despues" && titulo && antes && despues) return ok(await crearTarjeta({ tipo, titulo, antes, despues }));
      return error("Faltan campos para ese tipo de tarjeta.");
    } catch (e) {
      return error(String(e));
    }
  },
);

const captura = tool(
  "capturar_pagina",
  "Toma una captura de una de tus páginas en vivo (las de <portafolio>) para mostrar ese caso en el hilo. Devuelve el valor para el campo imagen.",
  { url: z.string() },
  async ({ url }) => {
    try {
      return ok(await capturarPagina(url));
    } catch (e) {
      return error(`No pude abrir la página: ${String(e).slice(0, 200)}`);
    }
  },
);

const cambiarFrecuencia = tool(
  "cambiar_frecuencia",
  `Cambia cada cuántas horas te disparan (entre 8 am y 10 pm de Ecuador). Ahora: cada ${cadaHoras} h. Hazlo solo con evidencia en las métricas o en <aprendizajes>, no por intuición.`,
  { cada_horas: z.literal(FRECUENCIAS), motivo: z.string() },
  async ({ cada_horas, motivo }) => {
    if (!DRY_RUN) {
      await guardarConfig("x_cada_horas", String(cada_horas));
      await avisar(`🔁 Agente de X: paso de cada ${cadaHoras} h a cada ${cada_horas} h.\nMotivo: ${motivo}`);
    }
    return ok(`Frecuencia: cada ${cada_horas} h.`);
  },
);

const prompt = `Hoy es ${hoy()}. Eres el agente que maneja el X (Twitter) de Diego. La cuenta estuvo abandonada y la estás reviviendo. Trabajas solo y de forma autónoma: Diego no va a revisar antes de que publiques, así que cuida cada palabra. Te disparan cada ${cadaHoras} h y hoy ya salieron ${deHoy} tweets (tope ${maxDia}).

${await contexto("x", { propios: 30 })}

<portafolio>
${(await catalogoDesdeGithub()) ?? "(no se pudo leer; todo está en yeyo.dev)"}
</portafolio>

Cómo hacerlo:
1. Mira <posts_recientes_x> y sus métricas: qué tipo de tweet funcionó y qué no. Revisa <noticias>, <lo_que_diego_programa>, <lo_que_diego_lee> y <material_reciente> para ver qué hay nuevo. Cada día, al menos uno de los hilos debe tomar una noticia de <noticias> y decir con opinión cómo pega en los negocios de Ecuador y qué haría Diego (si hoy todavía no salió uno así, prioriza ese). Lo que programó hoy es oro para build in public ("ahorita estoy…", "hoy saqué…").
2. Busca en línea antes de escribir: con WebSearch mira lo último del tema que elegiste (o de la noticia de <noticias>) y cómo afecta a Ecuador, y abre la nota con WebFetch para tener el dato exacto y su imagen principal (og:image). Si sale algo más fresco e importante que lo de <noticias>, úsalo. Decide si vale la pena publicar ahora; si no hay nada bueno, usa no_publicar.
3. Si publicas, escribe un HILO de 4 a 7 tuits para dueños de negocio, siguiendo <voz> y <aprendizajes>: gancho con opinión → un punto por tuit con un ejemplo real → cierre con la lección. Lo técnico de <lo_que_diego_programa> se traduce a qué gana el negocio (ventas, tiempo, plata), nunca en jerga de dev. Elige un tema y un gancho distintos a los de los últimos posts. Solo hechos reales de las fuentes: no inventes cifras, clientes ni anécdotas. Los proyectos de <portafolio> son públicos y se pueden nombrar; otros clientes de Bakano, nunca. Un tuit suelto solo si es una opinión corta y filosa (máx. uno al día).
   Anécdotas: cada post lleva al menos una anécdota o frase real de Diego sacada de <lo_que_diego_dice> (sus reels) o <material_reciente>, en primera persona ("el otro día una dueña me dijo…", "yo siempre digo que…"). Nunca inventes una.
4. Imágenes, siempre (el sistema no deja publicar sin una en el primer tuit), y si suma, otra en el tuit clave:
   - La imagen del artículo (URL https de su og:image) cuando el post comenta una noticia.
   - crear_tarjeta con la idea central, una lista o un antes y después (la que más se comparte).
   - capturar_pagina de una página de <portafolio> cuando cuentas ese caso.
   - Las fotos que mandó Diego (origen telegram_foto, url "tg:...") son lo mejor cuando encajan porque son reales.
   - Nunca inventes una URL de imagen.
   - Referencia: si reaccionas a un tweet de <lo_que_diego_lee>, cítalo con citar (el id sale de su URL) y aporta tu opinión; no lo resumas.
5. Si dudas de algo, usa dejar_borrador en lugar de publicar.
6. Opcional: si las métricas de varios días muestran algo claro, ajusta tu frecuencia con cambiar_frecuencia.
7. Termina en cuanto publiques, dejes el borrador o decidas no publicar.${process.env.FORZAR === "1" ? "\n\nDiego pidió a mano que publiques AHORA (/ya x): publica sí o sí, aunque haya salido algo hace poco; no uses no_publicar. Elige un tema distinto al del último post." : ""}`;

const resultado = await correrAgente({ prompt, herramientas: [publicar, borrador, noPublicar, tarjeta, captura, cambiarFrecuencia], effort: "medium" });

if (publicado) {
  const final: { ids: string[]; texto: string } = publicado;
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}${final.texto}`);
  if (!DRY_RUN) {
    const { username } = await yo();
    await avisar(`🐦✅ Publiqué en X${final.ids.length > 1 ? ` (hilo de ${final.ids.length} 🧵)` : ""}\n🔗 ${urlTweet(username, final.ids[0])}\n\n${final.texto}\n\n🗑️ Si no te gusta dime "borra el último tweet"`);
  }
} else if (decision) {
  console.log(decision);
} else {
  console.error(`El agente terminó sin decidir.\n${resultado}`);
  await avisar(`⚠️🐦 El agente de X terminó sin publicar ni explicar por qué.\n\n${resultado.slice(0, 1500)}`);
  process.exit(1);
}
