-- De qué va cada video de @yeyo.dev: se transcribe y se resume una vez en GitHub Actions, y el
-- bot lo usa al responder comentarios y DMs sobre ese video.
CREATE TABLE videos_ig (
  media_id TEXT PRIMARY KEY,
  permalink TEXT,
  caption TEXT,
  publicado TEXT,
  transcripcion TEXT,
  resumen TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'hecho' | 'fallido'
  intentos INTEGER NOT NULL DEFAULT 0,
  actualizado TEXT NOT NULL
);
CREATE INDEX videos_ig_estado ON videos_ig (estado, publicado);
