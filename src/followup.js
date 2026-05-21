'use strict';

const { createClient }   = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');
const { generateReopenMessage: generateReopenMsg } = require('./summaries');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_WA = process.env.OWNER_WA_ID;

/**
 * Verifica seguimientos automáticos 7/14/30 días.
 * Llamado por cron a las 9 AM lun-sáb.
 */
async function checkFollowUps() {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: user } = await supabase.from('users')
      .select('pref_seguimiento_dias').eq('id', userId).single();

    const diasBase = user?.pref_seguimiento_dias || 7;

    // Contactos activos que superan los días configurados sin respuesta
    const { data: contacts } = await supabase.from('contacts')
      .select('*')
      .eq('user_id', userId)
      .not('estado', 'in', '("cerrado","sin_clasificar")')
      .gte('dias_sin_respuesta', diasBase)
      .order('dias_sin_respuesta', { ascending: false })
      .limit(20);

    if (!contacts?.length) return;

    // Agrupar por umbral
    const urgentes  = contacts.filter(c => c.dias_sin_respuesta >= 30);
    const medios    = contacts.filter(c => c.dias_sin_respuesta >= 14 && c.dias_sin_respuesta < 30);
    const normales  = contacts.filter(c => c.dias_sin_respuesta >= diasBase && c.dias_sin_respuesta < 14);

    let msg = '📬 *Seguimientos pendientes:*\n';

    if (urgentes.length) {
      msg += '\n🔴 *+30 días sin respuesta:*\n';
      for (const c of urgentes) {
        msg += `• ${c.nombre} (${c.dias_sin_respuesta}d) — ${c.estado}\n`;
      }
    }

    if (medios.length) {
      msg += '\n🟡 *14-30 días:*\n';
      for (const c of medios) {
        msg += `• ${c.nombre} (${c.dias_sin_respuesta}d)\n`;
      }
    }

    if (normales.length) {
      msg += `\n🟢 *${diasBase}-14 días:*\n`;
      for (const c of normales) {
        msg += `• ${c.nombre} (${c.dias_sin_respuesta}d)\n`;
      }
    }

    msg += `\nUsá *retomar [nombre]* para generar un mensaje de reapertura.`;

    await sendWhatsAppMessage(OWNER_WA, msg);
  } catch (err) {
    console.error('[followup] checkFollowUps error:', err.message);
  }
}

/**
 * Lista los seguimientos activos (comando "pendientes").
 */
async function listFollowUps(ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: contacts } = await supabase.from('contacts')
      .select('nombre, estado, dias_sin_respuesta, closing_score')
      .eq('user_id', userId)
      .gte('dias_sin_respuesta', 3)
      .not('estado', 'in', '("cerrado")')
      .order('closing_score', { ascending: false })
      .limit(15);

    if (!contacts?.length) {
      await sendWhatsAppMessage(ownerWaId, '✅ No tenés seguimientos pendientes. Todo al día.');
      return;
    }

    const lines = contacts.map((c, i) => {
      const urgency = c.dias_sin_respuesta >= 14 ? '🔴' : c.dias_sin_respuesta >= 7 ? '🟡' : '🟢';
      return `${i + 1}. ${urgency} *${c.nombre}* — ${c.dias_sin_respuesta}d sin respuesta (score: ${c.closing_score}%)`;
    });

    await sendWhatsAppMessage(ownerWaId,
      `📋 *Seguimientos pendientes:*\n\n${lines.join('\n')}\n\nUsá *retomar [nombre]* para generar un mensaje.`
    );
  } catch (err) {
    console.error('[followup] listFollowUps error:', err.message);
    await sendWhatsAppMessage(ownerWaId, '❌ Error obteniendo seguimientos.');
  }
}

module.exports = {
  checkFollowUps,
  listFollowUps,
};
