'use strict';

const { createClient } = require('@supabase/supabase-js');
const { getAuthenticatedGmailClient, getOutlookAccessToken } = require('./emailAuth');
const { processTextMessage } = require('./processor');
const fetch = require('node-fetch');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Gmail ────────────────────────────────────────────────────────────────────

/**
 * Obtiene y procesa los nuevos emails de Gmail de una cuenta específica.
 */
async function fetchNewGmailMessages(accountId, userId) {
  try {
    const gmail = await getAuthenticatedGmailClient(accountId);

    // Buscar mensajes no leídos recibidos en los últimos 3 minutos
    const after  = Math.floor((Date.now() - 3 * 60 * 1000) / 1000);
    const query  = `is:unread after:${after} -from:me`;

    const listRes = await gmail.users.messages.list({
      userId:  'me',
      q:       query,
      maxResults: 20,
    });

    const messages = listRes.data.messages || [];

    for (const { id } of messages) {
      // Verificar si ya está en la BD
      const { data: exists } = await supabase.from('emails')
        .select('id').eq('message_id_ext', id).maybeSingle();
      if (exists) continue;

      const msgRes = await gmail.users.messages.get({
        userId:  'me',
        id,
        format: 'full',
      });

      const msg      = msgRes.data;
      const headers  = msg.payload?.headers || [];
      const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const remitente       = getHeader('from');
      const remitenteEmail  = extractEmail(remitente);
      const asunto          = getHeader('subject');
      const destinatario    = getHeader('to');
      const threadId        = msg.threadId;
      const cuerpoTexto     = extractGmailBody(msg.payload);

      await processEmailMessage({
        accountId,
        userId,
        messageIdExt:  id,
        threadId,
        remitente,
        remitenteEmail,
        asunto,
        destinatario,
        cuerpoTexto,
        plataforma: 'email',
      });
    }
  } catch (err) {
    console.error(`[email] fetchNewGmailMessages error (account ${accountId}):`, err.message);
  }
}

/**
 * Extrae el texto plano del body de un mensaje Gmail.
 */
function extractGmailBody(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  for (const part of payload.parts || []) {
    const text = extractGmailBody(part);
    if (text) return text;
  }
  return '';
}

/**
 * Envía un email por Gmail.
 */
async function sendGmailMessage(accountId, to, subject, body) {
  const gmail = await getAuthenticatedGmailClient(accountId);

  const raw = buildRawEmail(to, subject, body);
  await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw },
  });
}

// ── Outlook ──────────────────────────────────────────────────────────────────

/**
 * Obtiene y procesa los nuevos emails de Outlook.
 */
async function fetchNewOutlookMessages(accountId, userId) {
  try {
    const accessToken = await getOutlookAccessToken(accountId);

    const since   = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const filter  = encodeURIComponent(`isRead eq false and receivedDateTime ge ${since}`);
    const url     = `https://graph.microsoft.com/v1.0/me/messages?$filter=${filter}&$top=20&$select=id,subject,from,toRecipients,body,receivedDateTime,conversationId`;

    const res  = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();

    for (const msg of data.value || []) {
      const { data: exists } = await supabase.from('emails')
        .select('id').eq('message_id_ext', msg.id).maybeSingle();
      if (exists) continue;

      const remitente       = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address;
      const remitenteEmail  = msg.from?.emailAddress?.address;
      const cuerpoTexto     = msg.body?.content?.replace(/<[^>]+>/g, '') || '';

      await processEmailMessage({
        accountId,
        userId,
        messageIdExt:  msg.id,
        threadId:      msg.conversationId,
        remitente,
        remitenteEmail,
        asunto:        msg.subject,
        destinatario:  msg.toRecipients?.[0]?.emailAddress?.address,
        cuerpoTexto,
        plataforma:    'email',
      });
    }
  } catch (err) {
    console.error(`[email] fetchNewOutlookMessages error (account ${accountId}):`, err.message);
  }
}

/**
 * Envía un email por Outlook.
 */
async function sendOutlookMessage(accountId, to, subject, body) {
  const accessToken = await getOutlookAccessToken(accountId);

  await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body:         { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    }),
  });
}

// ── Lógica común ─────────────────────────────────────────────────────────────

/**
 * Procesa un email entrante: busca o crea contacto, guarda en BD, pasa a processor.
 */
async function processEmailMessage({
  accountId, userId, messageIdExt, threadId,
  remitente, remitenteEmail, asunto, destinatario, cuerpoTexto,
}) {
  const userId_ = userId || process.env.NEXUS_USER_ID;

  // Buscar contacto existente por email
  let contact;
  const { data: existing } = await supabase.from('contacts')
    .select('*').eq('user_id', userId_)
    .eq('plataforma_user_id', remitenteEmail).maybeSingle();

  contact = existing;

  // Crear email en BD
  const { data: emailRow } = await supabase.from('emails').insert({
    account_id:     accountId,
    contact_id:     contact?.id || null,
    message_id_ext: messageIdExt,
    thread_id:      threadId,
    remitente:      remitente || remitenteEmail,
    remitente_email: remitenteEmail,
    destinatario,
    asunto,
    cuerpo_texto:   cuerpoTexto,
  }).select().single();

  if (!emailRow) return;

  // Pasar al processor central con el texto del email
  const textoCompleto = `[Email] Asunto: ${asunto}\n\n${cuerpoTexto}`;
  await processTextMessage({
    plataforma:     'email',
    waId:           remitenteEmail,
    nombre:         remitente || remitenteEmail,
    texto:          textoCompleto,
    tipoMsg:        'email',
    phoneNumberId:  null,
    emailAccountId: accountId,
  });

  // Marcar como procesado
  await supabase.from('emails').update({ procesado_ia: true }).eq('id', emailRow.id);
}

/**
 * Fetch de todas las cuentas Gmail activas (llamado desde cron).
 */
async function fetchAllGmailAccounts() {
  const { data: accounts } = await supabase.from('email_accounts')
    .select('id, user_id').eq('tipo', 'gmail').eq('activa', true);

  for (const acc of accounts || []) {
    fetchNewGmailMessages(acc.id, acc.user_id).catch(console.error);
  }
}

/**
 * Fetch de todas las cuentas Outlook activas (llamado desde cron).
 */
async function fetchAllOutlookAccounts() {
  const { data: accounts } = await supabase.from('email_accounts')
    .select('id, user_id').eq('tipo', 'outlook').eq('activa', true);

  for (const acc of accounts || []) {
    fetchNewOutlookMessages(acc.id, acc.user_id).catch(console.error);
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function extractEmail(str) {
  if (!str) return '';
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str.trim();
}

function buildRawEmail(to, subject, body) {
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\n');
  return Buffer.from(email).toString('base64url');
}

module.exports = {
  fetchNewGmailMessages,
  fetchNewOutlookMessages,
  fetchAllGmailAccounts,
  fetchAllOutlookAccounts,
  sendGmailMessage,
  sendOutlookMessage,
  processEmailMessage,
};
