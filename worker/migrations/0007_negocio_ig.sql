-- Usuario de Instagram del negocio del lead y último estado que se mandó a GHL (si después
-- califica, se vuelve a mandar para que el workflow abra la oportunidad).
ALTER TABLE leads_ig ADD COLUMN negocio_ig TEXT;
ALTER TABLE leads_ig ADD COLUMN ghl_estado TEXT;
