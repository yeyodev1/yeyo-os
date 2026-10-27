// Ve y escucha los videos nuevos de @yeyo.dev para que el bot sepa de qué va cada uno: descarga el
// video, transcribe el audio (faster-whisper, local), saca 3 capturas y Claude, con la suscripción
// de Diego, escribe un resumen corto. El Worker lo guarda en videos_ig y lo usa al responder.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, ok } from "../comun/agente.ts";

type Video = { media_id: string; permalink: string | null; caption: string | null; media_url: string };

const URL_VIDEOS = `${process.env.AGENTES_URL}/api/instagram/videos`;
const CABECERAS = { Authorization: `Bearer ${process.env.AGENTES_SECRET}`, "Content-Type": "application/json" };
const voz = await readFile("contenido/voz.md", "utf8").catch(() => "");

async function guardar(media_id: string, transcripcion: string | null, resumen: string | null): Promise<void> {
  await fetch(URL_VIDEOS, { method: "POST", headers: CABECERAS, body: JSON.stringify({ media_id, transcripcion, resumen }) });
}

async function procesar(v: Video): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "video-"));
  const mp4 = join(dir, "video.mp4");
  const res = await fetch(v.media_url);
  if (!res.ok) throw new Error(`No pude descargar el video (${res.status})`);
  await writeFile(mp4, Buffer.from(await res.arrayBuffer()));

  const duracion = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" })) || 30;
  const transcripcion = execFileSync("python3", ["scripts/transcribir.py", mp4], { encoding: "utf8", maxBuffer: 10_000_000 }).trim();
  const capturas = [0.15, 0.5, 0.85].map((p, i) => {
    const archivo = join(dir, `captura-${i + 1}.jpg`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(duracion * p), "-i", mp4, "-frames:v", "1", "-vf", "scale=540:-2", archivo]);
    return archivo;
  });

  let resumen: string | null = null;
  const herramienta = tool(
    "guardar_resumen",
    "Guarda de qué va el video.",
    { resumen: z.string().describe("2 a 4 líneas: tema, qué se ve y se dice, el gancho, y a qué tipo de negocio le sirve") },
    async ({ resumen: r }) => {
      resumen = r;
      return ok("Guardado. Termina.");
    },
  );
  await correrAgente({
    prompt: `Este es un video que Diego (@yeyo.dev) publicó en Instagram. Un bot que responde sus DMs y comentarios necesita saber de qué va, para conversar sobre él con la gente que lo comenta o lo comparte.

Mira las capturas con Read (${capturas.join(", ")}) y lee la transcripción. Luego llama guardar_resumen UNA vez con 2 a 4 líneas, en español: de qué trata, qué se ve y qué se dice (el caso, el cliente o el resultado si los hay), cuál es el gancho, y a qué tipo de negocio o persona le sirve. Solo lo que realmente está en el video; no inventes cifras ni nombres.

<caption>
${v.caption ?? "(sin caption)"}
</caption>

<transcripcion>
${transcripcion || "(sin voz)"}
</transcripcion>

<contexto_de_diego>
${voz.slice(0, 2500)}
</contexto_de_diego>`,
    herramientas: [herramienta],
    web: false,
    leerArchivos: true,
    effort: "low",
    maxTurns: 8,
  });
  await guardar(v.media_id, transcripcion, resumen);
  console.log(`${v.permalink ?? v.media_id}: ${resumen ? "resumido" : "sin resumen"}`);
}

// Hasta 5 videos por pedido, de 3 en 3 a la vez; sigue mientras queden pendientes (la primera
// vez son los últimos 25).
const A_LA_VEZ = 3;
for (let ronda = 0; ronda < 8; ronda++) {
  const res = await fetch(URL_VIDEOS, { headers: CABECERAS });
  if (!res.ok) throw new Error(`El Worker respondió ${res.status}`);
  const { videos } = (await res.json()) as { videos: Video[] };
  if (!videos.length) break;
  for (let i = 0; i < videos.length; i += A_LA_VEZ) {
    await Promise.all(
      videos.slice(i, i + A_LA_VEZ).map((v) =>
        procesar(v).catch(async (e) => {
          console.error(`${v.media_id}:`, e);
          await guardar(v.media_id, null, null);
        }),
      ),
    );
  }
}
console.log("Videos al día.");
