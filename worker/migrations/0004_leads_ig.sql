-- Leads de los DMs de Instagram. La rutina cazadora los cualifica sola (negocio,
-- presupuesto $400+, qué necesita) y le pasa a Diego los calificados.
CREATE TABLE leads_ig (
  usuario TEXT PRIMARY KEY,       -- username de Instagram, sin @
  conversation_id TEXT,
  estado TEXT NOT NULL DEFAULT 'cualificando',
  -- 'cualificando' (el bot pregunta) | 'calificado' ($400+, pasó a Diego) | 'no_califica' (< $400, cierre amable)
  -- | 'diego' (Diego lo atiende, el bot no escribe) | 'pana' | 'ruido'
  negocio TEXT,                   -- qué negocio es y si ya opera
  presupuesto TEXT,               -- lo que dijo, tal cual ("unos 600", "no tengo más de 200")
  necesidad TEXT,                 -- 'tienda' | 'pasarela' | 'automatizacion' | 'otro: …'
  mensajes_bot INTEGER NOT NULL DEFAULT 0, -- cuántos DMs mandó el bot (tope en la rutina)
  ultimo_envio TEXT,              -- texto exacto del último DM del bot: si en el hilo hay otro, escribió Diego
  ultimo_visto TEXT,              -- fecha ISO del último mensaje del lead ya procesado
  notas TEXT,
  -- Contacto para GHL (el workflow de la landing de Bakano deduplica por teléfono).
  nombre TEXT,
  telefono TEXT,                  -- E.164 (+593…)
  email TEXT,
  ghl_enviado TEXT,               -- fecha en que entró a GHL; null = todavía no
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);
CREATE INDEX leads_ig_estado ON leads_ig (estado, actualizado);
