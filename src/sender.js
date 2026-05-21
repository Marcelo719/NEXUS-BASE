'use strict';

const fetch = require('node-fetch');

const WA_API_URL = 'https://graph.facebook.com/v20.0';

/**
 * Envía un mensaje de texto por WhatsApp Business API.
 */
async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'text',
    text:              { body: text, preview_url: false },
  };

  const res = await fetch(`${WA_API_URL}/${phoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[sender] WhatsApp API error: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Envía un audio (link público o Supabase Storage URL) por WhatsApp.
 */
async function sendWhatsAppAudio(to, audioUrl) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  // Subir el audio a Meta primero para obtener un media_id
  const mediaId = await uploadMediaToMeta(audioUrl, accessToken, phoneNumberId);

  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'audio',
    audio:             { id: mediaId },
  };

  const res = await fetch(`${WA_API_URL}/${phoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[sender] WhatsApp audio API error: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Descarga el audio de Supabase Storage y lo sube a Meta para obtener un media_id.
 */
async function uploadMediaToMeta(audioUrl, accessToken, phoneNumberId) {
  const FormData = require('form-data');

  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`[sender] No se pudo descargar el audio: ${audioUrl}`);

  const buffer   = await audioRes.buffer();
  const form     = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/mpeg');
  form.append('file', buffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });

  const res = await fetch(`${WA_API_URL}/${phoneNumberId}/media`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
    body:    form,
  });

  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`[sender] Error subiendo media a Meta: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Marca un mensaje como leído en WhatsApp.
 */
async function markAsRead(messageId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  await fetch(`${WA_API_URL}/${phoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status:            'read',
      message_id:        messageId,
    }),
  });
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  uploadMediaToMeta,
  markAsRead,
};
