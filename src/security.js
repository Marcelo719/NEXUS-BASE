'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory rate limit store: { waId: { count, resetAt } }
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 30;      // mensajes por ventana
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto

/**
 * Verifica la firma HMAC-SHA256 de Meta en cada request webhook.
 * Debe llamarse ANTES de parsear el body.
 */
function verifyMetaSignature(req, res, buf) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    throw new Error('Missing x-hub-signature-256 header');
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(buf)
    .digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error('Invalid HMAC signature');
  }
}

/**
 * Middleware Express para verificar firma HMAC.
 * Rechaza con 403 si la firma es inválida.
 */
function hmacMiddleware(req, res, next) {
  try {
    verifyMetaSignature(req, res, req.rawBody);
    next();
  } catch (err) {
    console.error('[security] HMAC verification failed:', err.message);
    res.status(403).json({ error: 'Forbidden' });
  }
}

/**
 * Rate limit por número de WhatsApp remitente.
 * Retorna true si el mensaje debe procesarse, false si está bloqueado.
 */
function checkRateLimit(waId) {
  const now = Date.now();
  const entry = rateLimitStore.get(waId);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(waId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return false;
  }
  return true;
}

/**
 * Verifica si el remitente es el owner autorizado.
 */
function isOwner(waId) {
  return waId === process.env.OWNER_WA_ID;
}

/**
 * Loguea intento no autorizado de comando en Supabase.
 */
async function logUnauthorizedAttempt(waId, comando) {
  try {
    await supabaseAdmin.from('security_log').insert({
      wa_id: waId,
      comando: comando || 'desconocido',
    });
  } catch (err) {
    console.error('[security] Failed to log unauthorized attempt:', err.message);
  }
}

/**
 * Lista de palabras clave que identifican comandos de owner.
 */
const OWNER_COMMANDS = [
  'resumen', 'audio', 'retomar', 'pendientes', 'ver notas',
  'nota', 'etiqueta', 'quitar etiqueta', 'reporte', 'exportar',
  'modo', 'estado', 'ayuda', 'sí', 'si', 'enviar', 'ok',
  'ignorar', 'no', 'editar',
];

/**
 * Detecta si el texto es un comando de owner.
 */
function isOwnerCommand(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return OWNER_COMMANDS.some(cmd => lower.startsWith(cmd));
}

module.exports = {
  hmacMiddleware,
  checkRateLimit,
  isOwner,
  logUnauthorizedAttempt,
  isOwnerCommand,
  verifyMetaSignature,
};
