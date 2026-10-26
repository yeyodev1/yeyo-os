-- Motor de Instagram al instante: el Worker recibe los DMs por el webhook de Meta y revisa
-- los comentarios cada minuto; Claude decide y el Worker responde por la API de Instagram.

-- Cada mensaje de los hilos que maneja el bot. El mid único frena los reintentos de Meta y
-- separa lo que mandó el bot de lo que Diego escribió a mano (ecos).
CREATE TABLE mensajes_ig (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_id TEXT NOT NULL,            -- id de Instagram de la persona (IGSID)
  usuario TEXT,
  rol TEXT NOT NULL,              -- 'lead' | 'bot' | 'diego' | 'auto' (automatización de Buzzfy)
  texto TEXT NOT NULL,
  mid TEXT UNIQUE,
  fecha TEXT NOT NULL
);
CREATE INDEX mensajes_ig_hilo ON mensajes_ig (ig_id, id);

-- Comentarios ya vistos: el cron y el webhook no contestan dos veces el mismo.
CREATE TABLE comentarios_ig (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  usuario TEXT,
  texto TEXT,
  accion TEXT NOT NULL,           -- 'previo' | 'pausa' | 'viejo' | 'procesando' | 'ignorar' | 'responder+publica+dm' …
  fecha TEXT NOT NULL
);

ALTER TABLE leads_ig ADD COLUMN ig_id TEXT;
ALTER TABLE leads_ig ADD COLUMN procesando TEXT; -- candado: una sola respuesta a la vez por lead
CREATE INDEX leads_ig_ig_id ON leads_ig (ig_id);
