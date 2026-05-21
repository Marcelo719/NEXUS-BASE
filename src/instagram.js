'use strict';

const fetch = require('node-fetch');
const { processTextMessage } = require('./processor');
const { checkRateLimit, isOwner, logUnauthorizedAttempt, isOwnerCommand } = require('./security');

const IG_API_URL = 'https://graph.facebook.com/v20.0';

/**
 * Normaliza un evento de Instagram DM y lo pasa a processor.js
 */
async function processInstagramMessage(messaging) {
  try {
    const senderId  = messaging.sender?.id;
    const message   = messaging.message;

    if (!senderId || !message) return;

    // Ignorar mensajes propios (echo)
    if (messaging.recipient?.id === senderId) return;

    const texto = message.text || '';
    if (!texto) return;

    // Rate limit
    if (!checkRateLimit(senderId)) {
      console.warn(`[instagram] Rate limit superado para ${senderId}`);
      return;
    }

    // Si es comando y NO es el owner → logear y descartar
    if (isOwnerCommand(texto) && !isOwner(senderId)) {
      await logUnauthorizedAttempt(senderId, texto);
      return;
    }

    // Obtener nombre del usuario desde la API de Instagram
    const nombre = await getInstagramUserName(senderId);

    await processTextMessage({
      plataforma: 'instagram',
      waId:       senderId,
      nombre:     nombre || senderId,
      texto,
      tipoMsg:    'text',
      phoneNumberId: null,
    });
  } catch (err) {
    console.error('[instagram] Error procesando mensaje:', err.message);
  }
}

/**
 * Obtiene el nombre de un usuario de Instagram por su ID.
 */
async function getInstagramUserName(userId) {
  try {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const res = await fetch(
      `${IG_API_URL}/${userId}?fields=name,username&access_token=${accessToken}`
    );
    const data = await res.json();
    return data.name || data.username || userId;
  } catch {
    return userId;
  }
}

/**
 * Envía un mensaje de texto a un usuario de Instagram.
 */
async function sendInstagramMessage(recipientId, text) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igPageId    = process.env.INSTAGRAM_PAGE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;

  const res = await fetch(`${IG_API_URL}/${igPageId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message:   { text },
      messaging_type: 'RESPONSE',
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[instagram] Error enviando mensaje: ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = {
  processInstagramMessage,
  sendInstagramMessage,
  getInstagramUserName,
};
