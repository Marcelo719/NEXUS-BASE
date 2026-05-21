'use strict';

const { createClient } = require('@supabase/supabase-js');
const webPush          = require('web-push');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Configurar VAPID para push notifications
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    `mailto:${process.env.OWNER_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/**
 * Verifica el estado de todas las conexiones activas.
 * Retorna un objeto con el estado de cada servicio.
 */
async function runHealthCheck() {
  const results = {};

  // Supabase
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    results['Supabase'] = !error;
  } catch {
    results['Supabase'] = false;
  }

  // WhatsApp API
  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
    );
    results['WhatsApp'] = res.ok;
  } catch {
    results['WhatsApp'] = false;
  }

  // Anthropic API
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    results['Claude AI'] = res.ok;
  } catch {
    results['Claude AI'] = false;
  }

  // ElevenLabs API
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    results['ElevenLabs'] = res.ok;
  } catch {
    results['ElevenLabs'] = false;
  }

  // Google Calendar conectado
  try {
    const { data: user } = await supabase.from('users')
      .select('gcal_connected').eq('id', process.env.NEXUS_USER_ID).single();
    results['Google Calendar'] = user?.gcal_connected || false;
  } catch {
    results['Google Calendar'] = false;
  }

  // Gmail conectado
  try {
    const { data: accounts } = await supabase.from('email_accounts')
      .select('id').eq('tipo', 'gmail').eq('activa', true).limit(1);
    results['Gmail'] = (accounts?.length || 0) > 0;
  } catch {
    results['Gmail'] = false;
  }

  // Outlook conectado
  try {
    const { data: accounts } = await supabase.from('email_accounts')
      .select('id').eq('tipo', 'outlook').eq('activa', true).limit(1);
    results['Outlook'] = (accounts?.length || 0) > 0;
  } catch {
    results['Outlook'] = false;
  }

  // Instagram (verifica que el token esté configurado)
  results['Instagram'] = !!process.env.INSTAGRAM_ACCESS_TOKEN;

  return results;
}

/**
 * Envía una push notification a todos los dispositivos suscritos del owner.
 */
async function sendPushNotification({ title, body, url }) {
  if (!process.env.VAPID_PUBLIC_KEY) return;

  try {
    const { data: subs } = await supabase.from('push_subscriptions')
      .select('*').eq('user_id', process.env.NEXUS_USER_ID).eq('activa', true);

    for (const sub of subs || []) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys:     { p256dh: sub.p256dh, auth: sub.auth },
      };

      await webPush.sendNotification(pushSubscription, JSON.stringify({
        title: title || 'NEXUS',
        body:  body  || '',
        url:   url   || '/',
      })).catch(async (err) => {
        // Suscripción inválida → desactivar
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').update({ activa: false }).eq('id', sub.id);
        }
      });
    }
  } catch (err) {
    console.error('[healthCheck] sendPushNotification error:', err.message);
  }
}

module.exports = {
  runHealthCheck,
  sendPushNotification,
};
