// Los ejemplos que el bot puede mandar salen del portafolio público de Diego en GitHub
// (personal-portfolio-2025/src/data/projects.ts, lo mismo que se ve en yeyo.dev): si agrega un
// proyecto ahí, el bot lo conoce en el siguiente arranque. Solo páginas terminadas y en vivo.
const FUENTE = "https://raw.githubusercontent.com/yeyodev1/personal-portfolio-2025/main/src/data/projects.ts";

const CATEGORIAS: Record<string, string> = {
  tienda: "Tiendas online y pasarelas de pago",
  automatizacion: "Automatizaciones e IA",
  sistema: "Sistemas a medida",
  cursos: "Cursos y membresías",
  web: "Webs que venden",
};

export async function catalogoDesdeGithub(): Promise<string | null> {
  try {
    const res = await fetch(FUENTE);
    if (!res.ok) return null;
    const fuente = await res.text();
    const bloques = fuente.slice(fuente.indexOf("export const PROJECTS")).split(/\n  \{\n/).slice(1);
    const porCategoria = new Map<string, string[]>();
    for (const b of bloques) {
      const campo = (re: RegExp) => re.exec(b)?.[1]?.trim() ?? "";
      const nombre = campo(/name: ['"]([^'"]+)['"]/);
      const url = campo(/url: '([^']+)'/);
      if (!nombre || !url) continue; // sin página en vivo no sirve como ejemplo
      const linea = `- ${nombre} (${campo(/industry: c\('([^']+)'/)}, ${campo(/place: '([^']+)'/)}) ${url.replace(/^https?:\/\//, "")}: ${campo(/desc: c\(\s*'([^']+)'/)}`;
      const categoria = campo(/category: '(\w+)'/);
      porCategoria.set(categoria, [...(porCategoria.get(categoria) ?? []), linea]);
    }
    if (!porCategoria.size) return null;
    const secciones = [...porCategoria].map(([cat, lineas]) => `${CATEGORIAS[cat] ?? cat}:\n${lineas.join("\n")}`);
    return `Tus páginas terminadas y en vivo (los ÚNICOS ejemplos que puedes mandar, en primera persona: "a Café Malacatos le armé…"; nunca inventes otros ni les pongas cifras):\n${secciones.join("\n")}\nTodo el portafolio: yeyo.dev\n\n`;
  } catch {
    return null;
  }
}
