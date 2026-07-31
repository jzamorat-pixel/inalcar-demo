-- D1 schema for the Inalcar lead-cooling engine.
-- Deploy with: wrangler d1 execute inalcar-leads --file=./schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id                 TEXT PRIMARY KEY,      -- telefono E.164 (o session_id en demo)
  nombre             TEXT,
  interes            TEXT,
  presupuesto        TEXT,
  tipo               TEXT,                  -- nuevo|usado|ambos
  etapa              TEXT DEFAULT 'explorando',
  score_compra       INTEGER DEFAULT 0,     -- último score 0-100 reportado por el LLM
  score_compra_max   INTEGER DEFAULT 0,     -- score más alto que alcanzó (para saber si "era buen lead")
  interacciones      INTEGER DEFAULT 0,     -- mensajes del cliente
  agendo_visita      INTEGER DEFAULT 0,     -- 0/1
  primera_interaccion INTEGER,              -- epoch ms
  ultima_interaccion  INTEGER,              -- epoch ms
  cooling_score      INTEGER DEFAULT 0,
  temperatura        TEXT DEFAULT 'CALIENTE', -- CALIENTE|TIBIO|FRIO|CONGELADO
  ultima_accion_tier TEXT,                  -- último tier para el que ya se disparó una acción (evita duplicados)
  archivado          INTEGER DEFAULT 0,
  calendly_invitee_uri TEXT,                -- uri del invitee en Calendly, si agendó
  calendly_email     TEXT,                  -- email que dejó en Calendly (el chat no lo captura)
  updated_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leads_archivado ON leads(archivado);

CREATE TABLE IF NOT EXISTS lead_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       TEXT NOT NULL,
  tier          TEXT NOT NULL,
  accion        TEXT NOT NULL,   -- recordatorio_cliente | alerta_ejecutivo | reactivacion_final
  detalle       TEXT,
  created_at    INTEGER,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
