'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { hmacMiddleware, checkRateLimit, isOwner, logUnauthorizedAttempt, isOwnerCommand } = require('./security');
const { processMessage } = require('./processor');
const { processInstagramMessage } = require('./instagram');

const app = express();

// Parsear body raw para verificación HMAC
app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = Buffer.from(data, 'utf8');
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
});

// ── Verificación del webhook (GET) ──────────────────────────────────────────

app.get('/api/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_TOKEN) {
    console.log('[webhook] Webhook verificado');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ── Recepción de eventos (POST) ─────────────────────────────────────────────

app.post('/api/webhook', hmacMiddleware, async (req, res) => {
  // Responder 200 de inmediato para que Meta no reintente
  res.status(200).json({ status: 'ok' });

  const body = req.body;
  if (!body || !body.object) return;

  try {
    if (body.object === 'whatsapp_business_account') {
      await handleWhatsAppEvents(body);
    } else if (body.object === 'instagram') {
      await handleInstagramEvents(body);
    }
  } catch (err) {
    console.error('[webhook] Error procesando evento:', err);
  }
});

// ── Handler WhatsApp ────────────────────────────────────────────────────────

async function handleWhatsAppEvents(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value    = change.value;
      const messages = value.messages || [];
      const contacts = value.contacts || [];

      for (const msg of messages) {
        const waId    = msg.from;
        const profile = contacts.find(c => c.wa_id === waId);
        const nombre  = profile?.profile?.name || waId;

        // Rate limit
        if (!checkRateLimit(waId)) {
          console.warn(`[webhook] Rate limit superado para ${waId}`);
          continue;
        }

        // Si es comando y NO es el owner → logear y descartar
        const texto = msg.text?.body || '';
        if (isOwnerCommand(texto) && !isOwner(waId)) {
          await logUnauthorizedAttempt(waId, texto);
          continue;
        }

        await processMessage({
          plataforma: 'whatsapp',
          waId,
          nombre,
          msg,
          phoneNumberId: value.metadata?.phone_number_id,
        });
      }
    }
  }
}

// ── Handler Instagram ───────────────────────────────────────────────────────

async function handleInstagramEvents(body) {
  for (const entry of body.entry || []) {
    for (const messaging of entry.messaging || []) {
      await processInstagramMessage(messaging);
    }
  }
}

// ── OAuth callbacks ─────────────────────────────────────────────────────────

const { handleGmailCallback }    = require('./emailAuth');
const { handleOutlookCallback }  = require('./emailAuth');
const { handleCalendarCallback } = require('./googleAuth');

app.get('/api/auth/gmail',    (req, res) => {
  const { getGmailAuthUrl } = require('./emailAuth');
  res.redirect(getGmailAuthUrl());
});

app.get('/api/auth/gmail/callback',    handleGmailCallback);
app.get('/api/auth/outlook/callback',  handleOutlookCallback);
app.get('/api/calendar/callback',      handleCalendarCallback);

// ── Push subscription ───────────────────────────────────────────────────────

const { createClient: sc } = require('@supabase/supabase-js');
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.post('/api/push/subscribe', express.json(), async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    await supa.from('push_subscriptions').upsert({
      user_id:  process.env.NEXUS_USER_ID,
      endpoint,
      p256dh:   keys.p256dh,
      auth:     keys.auth,
      activa:   true,
    }, { onConflict: 'user_id,endpoint' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] Error guardando suscripción:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Health check ────────────────────────────────────────────────────────────

const { runHealthCheck } = require('./healthCheck');

app.get('/api/health', async (req, res) => {
  const result = await runHealthCheck();
  res.json(result);
});

// ── Iniciar servidor ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[NEXUS] Servidor corriendo en puerto ${PORT}`);

  // Iniciar cron jobs
  require('./cron');
});

module.exports = app;
