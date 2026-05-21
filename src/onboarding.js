'use strict';

const { createClient }    = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');
const { runHealthCheck }  = require('./healthCheck');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_WA = process.env.OWNER_WA_ID;

const PASOS = {
  1: {
    titulo: '👋 *Bienvenido a NEXUS Starter!*',
    msg: `*LA APP QUE SIMPLIFICA TODO*
_Todos tus chats y tu correo, en tu WhatsApp_

Voy a guiarte en 5 pasos para dejarte todo listo.

*Paso 1/5: Verificación inicial*
✅ WhatsApp conectado (estás hablando conmigo!)

¿Querés continuar con la configuración? Respondé *SÍ*`,
  },
  2: {
    titulo: '📧 *Paso 2/5: Conectar Gmail*',
    msg: `Para recibir tus emails directamente acá, necesito conectar tu Gmail.

👉 Ingresá a este link para autorizar:
{GMAIL_URL}

Una vez que lo conectes, respondé *SÍ* para continuar.`,
  },
  3: {
    titulo: '📅 *Paso 3/5: Conectar Google Calendar*',
    msg: `Conectemos tu agenda para crear reuniones automáticamente cuando detecte fechas en tus conversaciones.

👉 Ingresá a este link:
{CALENDAR_URL}

Una vez conectado, respondé *SÍ* para continuar.`,
  },
  4: {
    titulo: '⚙️ *Paso 4/5: Configurar preferencias*',
    msg: `Elegí cómo querés que opere NEXUS:

• *modo auto* — actúo automáticamente sin consultarte
• *modo parcial* — te consulto antes de hacer cosas importantes
• *modo manual* — solo te informo, vos decidís todo

Respondé: *modo auto*, *modo parcial* o *modo manual*`,
  },
  5: {
    titulo: '🔍 *Paso 5/5: Verificación final*',
    msg: `Verificando todas las conexiones...`,
  },
};

/**
 * Procesa el onboarding del usuario según el paso actual.
 * Se llama cuando el usuario (owner) envía un mensaje durante el onboarding.
 */
async function handleOnboardingMessage(waId, texto) {
  const userId = process.env.NEXUS_USER_ID;
  if (waId !== OWNER_WA) return false;

  const { data: user } = await supabase.from('users')
    .select('onboarding_completo, onboarding_paso').eq('id', userId).single();

  if (!user || user.onboarding_completo) return false;

  const paso  = user.onboarding_paso || 1;
  const lower = texto.toLowerCase().trim();

  switch (paso) {
    case 1:
      if (lower === 'sí' || lower === 'si') {
        await advanceOnboarding(userId, 2);
        const gmailUrl = `${process.env.GMAIL_REDIRECT_URI?.replace('/callback', '')}`.replace('auth/gmail', 'auth/gmail');
        const appUrl   = process.env.GMAIL_REDIRECT_URI?.split('/api')[0] || 'https://tu-app.vercel.app';
        const msg      = PASOS[2].msg.replace('{GMAIL_URL}', `${appUrl}/api/auth/gmail`);
        await sendWhatsAppMessage(OWNER_WA, `${PASOS[2].titulo}\n\n${msg}`);
        return true;
      }
      break;

    case 2:
      if (lower === 'sí' || lower === 'si') {
        await advanceOnboarding(userId, 3);
        const appUrl = process.env.GOOGLE_REDIRECT_URI?.split('/api')[0] || 'https://tu-app.vercel.app';
        const msg    = PASOS[3].msg.replace('{CALENDAR_URL}', `${appUrl}/api/calendar/auth`);
        await sendWhatsAppMessage(OWNER_WA, `${PASOS[3].titulo}\n\n${msg}`);
        return true;
      }
      if (lower.includes('saltar') || lower.includes('skip')) {
        await advanceOnboarding(userId, 3);
        const appUrl = process.env.GOOGLE_REDIRECT_URI?.split('/api')[0] || 'https://tu-app.vercel.app';
        const msg    = PASOS[3].msg.replace('{CALENDAR_URL}', `${appUrl}/api/calendar/auth`);
        await sendWhatsAppMessage(OWNER_WA, `${PASOS[3].titulo}\n\n${msg}`);
        return true;
      }
      break;

    case 3:
      if (lower === 'sí' || lower === 'si' || lower.includes('saltar')) {
        await advanceOnboarding(userId, 4);
        await sendWhatsAppMessage(OWNER_WA, `${PASOS[4].titulo}\n\n${PASOS[4].msg}`);
        return true;
      }
      break;

    case 4:
      if (lower === 'modo auto' || lower === 'modo parcial' || lower === 'modo manual') {
        const modoMap = { 'modo auto': 'auto', 'modo parcial': 'partial', 'modo manual': 'manual' };
        const modo    = modoMap[lower];
        await supabase.from('users').update({ modo_automatizacion: modo }).eq('id', userId);
        await advanceOnboarding(userId, 5);
        await sendWhatsAppMessage(OWNER_WA, `${PASOS[5].titulo}\n\n${PASOS[5].msg}`);

        // Ejecutar health check
        const status  = await runHealthCheck();
        const statusMsg = Object.entries(status)
          .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join('\n');

        const allOk = Object.values(status).every(v => v);

        if (allOk) {
          await completeOnboarding(userId);
          await sendWhatsAppMessage(OWNER_WA,
            `✅ *Todas las conexiones verificadas:*\n\n${statusMsg}\n\n🎉 *¡NEXUS está listo!*\n\nTus mensajes de WhatsApp, Instagram y emails ya los estoy monitoreando.\nMandá *ayuda* para ver todos los comandos disponibles.`
          );
        } else {
          await completeOnboarding(userId);
          await sendWhatsAppMessage(OWNER_WA,
            `⚠️ *Estado de las conexiones:*\n\n${statusMsg}\n\nAlgunas conexiones no están activas, pero podés usarme igual.\nConectá los servicios faltantes cuando puedas.\n\nMandá *ayuda* para ver los comandos.`
          );
        }
        return true;
      }
      break;
  }

  return false;
}

/**
 * Inicia el onboarding enviando el primer mensaje.
 */
async function startOnboarding() {
  const userId = process.env.NEXUS_USER_ID;

  const { data: user } = await supabase.from('users')
    .select('onboarding_completo, onboarding_paso').eq('id', userId).single();

  if (user?.onboarding_completo) return;

  await sendWhatsAppMessage(OWNER_WA, `${PASOS[1].titulo}\n\n${PASOS[1].msg}`);
  await supabase.from('users').update({ onboarding_paso: 1 }).eq('id', userId);
}

async function advanceOnboarding(userId, paso) {
  await supabase.from('users').update({ onboarding_paso: paso }).eq('id', userId);
}

async function completeOnboarding(userId) {
  await supabase.from('users').update({
    onboarding_completo: true,
    onboarding_paso:     5,
  }).eq('id', userId);
}

module.exports = {
  handleOnboardingMessage,
  startOnboarding,
};
