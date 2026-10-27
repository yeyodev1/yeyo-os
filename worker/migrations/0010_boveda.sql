-- Bóveda de claves de Diego (cifradas con BOVEDA_KEY, que vive solo como secret del Worker) y
-- mensajes de Telegram que se borran solos después de mostrar una clave.
CREATE TABLE boveda (
  nombre TEXT PRIMARY KEY,
  cifrado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);

CREATE TABLE tg_borrar (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  cuando TEXT NOT NULL
);
