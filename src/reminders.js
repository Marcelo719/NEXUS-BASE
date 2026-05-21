'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');
const { listUpcomingEvents } = require('./calendar');

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_WA   = process.env.OWNER_WA_ID;

/**
 * Verifica eventos próximos y envía recordatorios 24hs y 1hs antes.
 * Llamado por cron cada 30 minutos.
 */
async function sendEventReminders() {
  const userId = process.env.NEXUS_USER_ID;

  // Obtener preferencias del usuario
  const { data: user } = await supabase.from('users')
    .select('pref_recordatorio_24h, pref_recordatorio_1h, zona_horaria')
    .eq('id', userId).single();

  if (!user) return;

  const now     = new Date();
  const in24h   = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in1h    = new Date(now.getTime() + 60 * 60 * 1000);
  const margin  = 35 * 60 * 1000; // ventana de 35 minutos para el cron de 30min

  const { data: events } = await supabase.from('calendar_events')
    .select('*, contacts(nombre, plataforma)')
    .eq('user_id', userId)
    .gte('fecha_hora', now.toISOString())
    .lte('fecha_hora', in24h.toISOString());

  for (const event of events || []) {
    const eventTime   = new Date(event.fecha_hora).getTime();
    const diff        = eventTime - now.getTime();

    // Recordatorio 24 horas antes
    if (
      user.pref_recordatorio_24h &&
      !event.recordatorio_24h_enviado &&
      diff > 23 * 60 * 60 * 1000 &&
      diff <= 24 * 60 * 60 * 1000 + margin
    ) {
      const nombre  = event.contacts?.nombre || 'Sin contacto';
      const fechaStr = new Date(event.fecha_hora).toLocaleString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      });

      await sendWhatsAppMessage(OWNER_WA,
        `⏰ *Recordatorio 24hs* — Mañana tenés una reunión:\n\n📅 ${event.titulo}\n👤 Con: ${nombre}\n🕐 ${fechaStr}`
      );

      await supabase.from('calendar_events')
        .update({ recordatorio_24h_enviado: true })
        .eq('id', event.id);
    }

    // Recordatorio 1 hora antes
    if (
      user.pref_recordatorio_1h &&
      !event.recordatorio_1h_enviado &&
      diff > 0 &&
      diff <= 60 * 60 * 1000 + margin
    ) {
      const nombre  = event.contacts?.nombre || 'Sin contacto';
      const fechaStr = new Date(event.fecha_hora).toLocaleString('es-AR', {
        hour: '2-digit', minute: '2-digit',
      });

      await sendWhatsAppMessage(OWNER_WA,
        `🔔 *En 1 hora* — ${event.titulo} con ${nombre} a las ${fechaStr}`
      );

      await supabase.from('calendar_events')
        .update({ recordatorio_1h_enviado: true })
        .eq('id', event.id);
    }
  }
}

/**
 * Briefing matutino: enviado a las 8 AM lun-vie.
 * Incluye agenda del día y seguimientos urgentes.
 */
async function sendMorningBriefing() {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: user } = await supabase.from('users')
      .select('pref_briefing_manana, nombre').eq('id', userId).single();

    if (!user?.pref_briefing_manana) return;

    // Eventos de hoy
    const today       = new Date();
    const endOfDay    = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    const { data: todayEvents } = await supabase.from('calendar_events')
      .select('titulo, fecha_hora, contacts(nombre)')
      .eq('user_id', userId)
      .gte('fecha_hora', today.toISOString())
      .lte('fecha_hora', endOfDay.toISOString())
      .order('fecha_hora', { ascending: true });

    // Contactos calientes (score >= 60) con seguimientos pendientes
    const { data: hotContacts } = await supabase.from('contacts')
      .select('nombre, closing_score, estado, ultimo_contacto')
      .eq('user_id', userId)
      .gte('closing_score', 60)
      .order('closing_score', { ascending: false })
      .limit(5);

    // Contactos sin respuesta por más de 3 días
    const { data: urgentFollowups } = await supabase.from('contacts')
      .select('nombre, dias_sin_respuesta, estado')
      .eq('user_id', userId)
      .gte('dias_sin_respuesta', 3)
      .not('estado', 'eq', 'cerrado')
      .order('dias_sin_respuesta', { ascending: false })
      .limit(5);

    const nombre = user.nombre?.split(' ')[0] || 'Ahí';
    const fechaStr = today.toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    let msg = `☀️ *Buenos días, ${nombre}!*\n📅 ${fechaStr}\n`;

    // Agenda del día
    if (todayEvents?.length) {
      msg += '\n*Agenda de hoy:*\n';
      for (const ev of todayEvents) {
        const hora = new Date(ev.fecha_hora).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit' });
        msg += `• ${hora} — ${ev.titulo}${ev.contacts?.nombre ? ` con ${ev.contacts.nombre}` : ''}\n`;
      }
    } else {
      msg += '\n📋 Sin reuniones agendadas hoy.\n';
    }

    // Contactos calientes
    if (hotContacts?.length) {
      msg += '\n🔥 *Contactos calientes:*\n';
      for (const c of hotContacts) {
        msg += `• ${c.nombre} (${c.closing_score}% cierre)\n`;
      }
    }

    // Seguimientos urgentes
    if (urgentFollowups?.length) {
      msg += '\n⚠️ *Seguimientos pendientes:*\n';
      for (const c of urgentFollowups) {
        msg += `• ${c.nombre} — ${c.dias_sin_respuesta} días sin respuesta\n`;
      }
    }

    msg += '\n_NEXUS — LA APP QUE SIMPLIFICA TODO_';

    await sendWhatsAppMessage(OWNER_WA, msg);
  } catch (err) {
    console.error('[reminders] sendMorningBriefing error:', err.message);
  }
}

module.exports = {
  sendEventReminders,
  sendMorningBriefing,
};
