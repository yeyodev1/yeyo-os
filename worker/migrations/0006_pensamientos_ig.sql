-- Lo que Claude tiene que pensar sobre Instagram. El Worker no puede correr el Agent SDK, así
-- que encola aquí, dispara el workflow instagram.yml (suscripción de Diego) y aplica la decisión.
CREATE TABLE pensamientos_ig (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,             -- 'dm' | 'comentario'
  ref TEXT NOT NULL,              -- ig_id del lead o id del comentario
  contenido TEXT NOT NULL,        -- lo que lee Claude (lead, perfil, conversación o publicación)
  datos TEXT,                     -- JSON que el Worker necesita para aplicar la decisión
  estado TEXT NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'hecho' | 'fallido'
  tomado TEXT,                    -- cuándo lo tomó un run de Actions
  creado TEXT NOT NULL
);
CREATE INDEX pensamientos_ig_pendientes ON pensamientos_ig (estado, id);
