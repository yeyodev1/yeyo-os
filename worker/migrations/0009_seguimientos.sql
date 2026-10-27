-- Seguimiento automático: si el lead deja de responder, el bot lo retoma una vez dentro de la
-- ventana de 24 h de Instagram.
ALTER TABLE leads_ig ADD COLUMN seguimientos INTEGER NOT NULL DEFAULT 0;
