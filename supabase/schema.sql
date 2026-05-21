-- ============================================================
-- NEXUS STARTER — Schema completo de base de datos
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Habilitar extensiones
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- Tipos enumerados
-- ============================================================

CREATE TYPE plataforma_origen AS ENUM (
  'whatsapp', 'instagram', 'email'
);

CREATE TYPE estado_contacto AS ENUM (
  'prospecto_frio', 'prospecto_tibio', 'prospecto_caliente',
  'propuesta_enviada', 'cliente_activo', 'cerrado', 'sin_clasificar'
);

CREATE TYPE intencion_msg AS ENUM (
  'consulta', 'presupuesto', 'seguimiento', 'cierre',
  'queja', 'agradecimiento', 'otro'
);

-- ============================================================
-- Tabla principal de usuarios
-- ============================================================

CREATE TABLE users (
  id                    uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre                text        NOT NULL,
  email                 text        UNIQUE NOT NULL,
  whatsapp_num          text,
  zona_horaria          text        DEFAULT 'America/Argentina/Buenos_Aires',

  -- Google Calendar OAuth
  gcal_access_token     text,
  gcal_refresh_token    text,
  gcal_token_expiry     timestamptz,
  gcal_connected        boolean     DEFAULT false,
  gcal_calendar_id      text        DEFAULT 'primary',

  -- Gmail OAuth
  gmail_access_token    text,
  gmail_refresh_token   text,
  gmail_token_expiry    timestamptz,
  gmail_connected       boolean     DEFAULT false,
  gmail_email           text,

  -- Outlook OAuth
  outlook_access_token  text,
  outlook_refresh_token text,
  outlook_token_expiry  timestamptz,
  outlook_connected     boolean     DEFAULT false,
  outlook_email         text,

  -- Onboarding
  onboarding_completo   boolean     DEFAULT false,
  onboarding_paso       integer     DEFAULT 1,

  -- Preferencias
  pref_briefing_manana  boolean     DEFAULT true,
  pref_recordatorio_24h boolean     DEFAULT true,
  pref_recordatorio_1h  boolean     DEFAULT true,
  pref_seguimiento_dias integer     DEFAULT 7,
  pref_voz_audio        text        DEFAULT 'Rachel',
  plataformas_conectadas text[]     DEFAULT '{whatsapp}',
  modo_automatizacion   text        DEFAULT 'auto'
    CHECK (modo_automatizacion IN ('auto', 'partial', 'manual')),

  -- Control de costos
  cost_limit_daily_usd  numeric(8,2) DEFAULT 10.00,
  cost_alert_at_pct     integer      DEFAULT 80,
  cost_pause_advanced   boolean      DEFAULT false,

  -- Idioma
  idioma                text        DEFAULT 'es'
    CHECK (idioma IN ('es', 'en', 'pt')),

  created_at            timestamptz DEFAULT now()
);

-- ============================================================
-- Contactos
-- ============================================================

CREATE TABLE contacts (
  id                   uuid              PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              uuid              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nombre               text              NOT NULL,
  plataforma           plataforma_origen NOT NULL,
  plataforma_user_id   text,
  handle               text,
  foto_url             text,
  estado               estado_contacto   DEFAULT 'sin_clasificar',
  precio_mencionado    numeric(12,2),
  moneda               text              DEFAULT 'USD',
  tags                 text[]            DEFAULT '{}',
  notas                text,
  primer_contacto      timestamptz       DEFAULT now(),
  ultimo_contacto      timestamptz       DEFAULT now(),
  dias_sin_respuesta   integer           GENERATED ALWAYS AS
    (EXTRACT(day FROM now() - ultimo_contacto)::integer) STORED,
  total_conversaciones integer           DEFAULT 0,
  closing_score        integer           DEFAULT 0 CHECK (closing_score >= 0 AND closing_score <= 100),
  closing_score_at     timestamptz       DEFAULT now(),
  closing_signals      jsonb             DEFAULT '{}',
  sentiment_actual     text              DEFAULT 'neutro'
    CHECK (sentiment_actual IN ('entusiasmado','positivo','neutro','frio','frustrado')),
  sentiment_at         timestamptz       DEFAULT now(),
  dedup_ignorar_ids    uuid[]            DEFAULT '{}',
  created_at           timestamptz       DEFAULT now(),
  updated_at           timestamptz       DEFAULT now(),
  UNIQUE(user_id, plataforma, plataforma_user_id)
);

CREATE INDEX idx_contacts_user      ON contacts(user_id);
CREATE INDEX idx_contacts_estado    ON contacts(estado);
CREATE INDEX idx_contacts_nombre    ON contacts USING gin(nombre gin_trgm_ops);
CREATE INDEX idx_contacts_score     ON contacts(closing_score DESC);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contactos_propios" ON contacts FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- Conversaciones
-- ============================================================

CREATE TABLE conversations (
  id                    uuid              PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id            uuid              NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  plataforma            plataforma_origen NOT NULL,
  ultimo_mensaje_en     timestamptz       DEFAULT now(),
  ultimo_mensaje_preview text,
  ultimo_remitente      text,
  total_mensajes        integer           DEFAULT 0,
  activa                boolean           DEFAULT true,
  created_at            timestamptz       DEFAULT now()
);

CREATE INDEX idx_conv_contact ON conversations(contact_id);
CREATE INDEX idx_conv_ultimo  ON conversations(ultimo_mensaje_en DESC);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conv_propias" ON conversations FOR ALL USING (
  contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid())
);

-- ============================================================
-- Mensajes
-- ============================================================

CREATE TABLE messages (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  remitente        text        NOT NULL,
  contenido        text        NOT NULL,
  tipo_msg         text        DEFAULT 'text',
  intencion        intencion_msg,
  urgencia         text,
  precio_detectado numeric(12,2),
  fecha_detectada  timestamptz,
  nota_automatica  text,
  procesado_ia     boolean     DEFAULT false,
  enviado_en       timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX idx_msg_conv     ON messages(conversation_id);
CREATE INDEX idx_msg_enviado  ON messages(enviado_en DESC);
CREATE INDEX idx_msg_sin_proc ON messages(procesado_ia) WHERE procesado_ia = false;
CREATE INDEX idx_msg_contenido ON messages USING gin(contenido gin_trgm_ops);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "msg_propios" ON messages FOR ALL USING (
  conversation_id IN (
    SELECT cv.id FROM conversations cv
    JOIN contacts ct ON cv.contact_id = ct.id
    WHERE ct.user_id = auth.uid()
  )
);

-- ============================================================
-- Email accounts
-- ============================================================

CREATE TABLE email_accounts (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo          text        NOT NULL CHECK (tipo IN ('gmail','outlook','imap')),
  email         text        NOT NULL,
  display_name  text,
  access_token  text,
  refresh_token text,
  token_expiry  timestamptz,
  imap_host     text,
  imap_port     integer,
  imap_user     text,
  imap_pass     text,
  activa        boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  UNIQUE(user_id, email)
);

-- ============================================================
-- Emails
-- ============================================================

CREATE TABLE emails (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  account_id      uuid        NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id_ext  text        UNIQUE,
  thread_id       text,
  remitente       text        NOT NULL,
  remitente_email text        NOT NULL,
  destinatario    text,
  asunto          text,
  cuerpo_texto    text,
  leido           boolean     DEFAULT false,
  respondido      boolean     DEFAULT false,
  intencion       intencion_msg,
  urgencia        text,
  nota_auto       text,
  procesado_ia    boolean     DEFAULT false,
  recibido_en     timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_emails_contact  ON emails(contact_id);
CREATE INDEX idx_emails_account  ON emails(account_id);
CREATE INDEX idx_emails_recibido ON emails(recibido_en DESC);
CREATE INDEX idx_emails_sin_proc ON emails(procesado_ia) WHERE procesado_ia = false;

-- ============================================================
-- Resúmenes
-- ============================================================

CREATE TABLE summaries (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      uuid        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tipo            text        NOT NULL CHECK (tipo IN ('texto','audio')),
  resumen_texto   text,
  proximo_paso    text,
  estado_contacto text,
  precio_detectado numeric(12,2),
  audio_url       text,
  audio_duracion  integer,
  generado_en     timestamptz DEFAULT now()
);

CREATE INDEX idx_summaries_contact ON summaries(contact_id);

-- ============================================================
-- Eventos de calendario
-- ============================================================

CREATE TABLE calendar_events (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  titulo          text        NOT NULL,
  fecha_hora      timestamptz NOT NULL,
  duracion_min    integer     DEFAULT 60,
  tipo            text        DEFAULT 'reunion',
  gcal_event_id   text,
  confirmado      boolean     DEFAULT false,
  recordatorio_24h_enviado boolean DEFAULT false,
  recordatorio_1h_enviado  boolean DEFAULT false,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_cal_contact ON calendar_events(contact_id);
CREATE INDEX idx_cal_fecha   ON calendar_events(fecha_hora);
CREATE INDEX idx_cal_user    ON calendar_events(user_id);

-- ============================================================
-- Acciones pendientes (esperando respuesta del owner)
-- ============================================================

CREATE TABLE pending_actions (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id  uuid        REFERENCES contacts(id) ON DELETE CASCADE,
  tipo        text        NOT NULL,
  payload     jsonb,
  resuelto    boolean     DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(contact_id, tipo)
);

-- ============================================================
-- Logs de seguridad
-- ============================================================

CREATE TABLE security_log (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  wa_id      text        NOT NULL,
  comando    text,
  intento_en timestamptz DEFAULT now()
);

-- ============================================================
-- Control de costos de IA
-- ============================================================

CREATE TABLE cost_log (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fecha       date        DEFAULT CURRENT_DATE,
  tipo        text        NOT NULL,
  llamadas    integer     DEFAULT 0,
  costo_usd   numeric(8,4) DEFAULT 0,
  UNIQUE(user_id, fecha, tipo)
);

-- ============================================================
-- Cola de reintentos
-- ============================================================

CREATE TABLE retry_queue (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo            text        NOT NULL,
  payload         jsonb       NOT NULL,
  intentos        integer     DEFAULT 0,
  max_intentos    integer     DEFAULT 3,
  proximo_intento timestamptz DEFAULT now(),
  ultimo_error    text,
  resuelto        boolean     DEFAULT false,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_retry_pendientes ON retry_queue(proximo_intento) WHERE resuelto = false;

-- ============================================================
-- Reportes semanales
-- ============================================================

CREATE TABLE weekly_reports (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  semana_fin    timestamptz NOT NULL,
  datos_raw     jsonb,
  reporte_texto text,
  created_at    timestamptz DEFAULT now()
);

-- ============================================================
-- Push subscriptions (PWA)
-- ============================================================

CREATE TABLE push_subscriptions (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text        NOT NULL,
  p256dh     text        NOT NULL,
  auth       text        NOT NULL,
  activa     boolean     DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

-- ============================================================
-- Vista: bandeja unificada
-- ============================================================

CREATE OR REPLACE VIEW bandeja_unificada AS
SELECT
  ct.id              AS contact_id,
  ct.nombre,
  ct.plataforma,
  ct.handle,
  ct.estado,
  ct.foto_url,
  ct.precio_mencionado,
  ct.tags,
  ct.dias_sin_respuesta,
  ct.closing_score,
  ct.sentiment_actual,
  ct.notas,
  cv.id              AS conv_id,
  cv.ultimo_mensaje_en,
  cv.ultimo_mensaje_preview,
  cv.ultimo_remitente,
  cv.total_mensajes,
  s.resumen_texto    AS ultimo_resumen,
  s.proximo_paso
FROM contacts ct
LEFT JOIN conversations cv ON cv.contact_id = ct.id
  AND cv.ultimo_mensaje_en = (
    SELECT MAX(c2.ultimo_mensaje_en) FROM conversations c2 WHERE c2.contact_id = ct.id
  )
LEFT JOIN summaries s ON s.contact_id = ct.id
  AND s.generado_en = (
    SELECT MAX(s2.generado_en) FROM summaries s2 WHERE s2.contact_id = ct.id
  );

-- ============================================================
-- Función para buscar contactos similares (deduplicación)
-- ============================================================

CREATE OR REPLACE FUNCTION find_similar_contacts(
  p_user_id             uuid,
  p_nombre              text,
  p_umbral              float DEFAULT 0.45,
  p_excluir_plataforma  plataforma_origen DEFAULT NULL,
  p_excluir_plat_id     text DEFAULT NULL
)
RETURNS TABLE (
  id         uuid, nombre text, plataforma plataforma_origen,
  handle     text, total_conversaciones integer, similarity float
) AS $$
  SELECT c.id, c.nombre, c.plataforma, c.handle,
    c.total_conversaciones, similarity(c.nombre, p_nombre) AS similarity
  FROM contacts c
  WHERE c.user_id = p_user_id
    AND similarity(c.nombre, p_nombre) >= p_umbral
    AND (p_excluir_plataforma IS NULL OR c.plataforma != p_excluir_plataforma)
    AND (p_excluir_plat_id IS NULL OR c.plataforma_user_id != p_excluir_plat_id)
  ORDER BY similarity DESC LIMIT 3;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- Función para costo atómico
-- ============================================================

CREATE OR REPLACE FUNCTION increment_cost_log(
  p_user_id uuid, p_fecha date, p_tipo text, p_llamadas integer, p_costo numeric
) RETURNS void AS $$
  INSERT INTO cost_log (user_id, fecha, tipo, llamadas, costo_usd)
  VALUES (p_user_id, p_fecha, p_tipo, p_llamadas, p_costo)
  ON CONFLICT (user_id, fecha, tipo) DO UPDATE SET
    llamadas  = cost_log.llamadas + EXCLUDED.llamadas,
    costo_usd = cost_log.costo_usd + EXCLUDED.costo_usd;
$$ LANGUAGE sql;

-- ============================================================
-- Buckets de Storage (ejecutar manualmente en Supabase Dashboard)
-- Crear bucket "nexus-audios"  → Privado
-- Crear bucket "nexus-exports" → Privado
-- ============================================================
