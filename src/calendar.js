'use strict';

const { createClient }               = require('@supabase/supabase-js');
const { getAuthenticatedCalendarClient } = require('./googleAuth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Crea un evento en Google Calendar y lo guarda en Supabase.
 * Si Google Calendar no está conectado, solo lo guarda en BD.
 */
async function createCalendarEventSafe({ userId, contactId, titulo, fechaHora, duracionMin = 60, tipo = 'reunion' }) {
  const uid = userId || process.env.NEXUS_USER_ID;

  // Guardar en Supabase primero
  const { data: dbEvent } = await supabase.from('calendar_events').insert({
    user_id:     uid,
    contact_id:  contactId || null,
    titulo,
    fecha_hora:  fechaHora,
    duracion_min: duracionMin,
    tipo,
    confirmado:  false,
  }).select().single();

  // Intentar crear en Google Calendar
  try {
    const calendar = await getAuthenticatedCalendarClient(uid);
    const { data: user } = await supabase.from('users').select('gcal_calendar_id').eq('id', uid).single();
    const calendarId = user?.gcal_calendar_id || 'primary';

    const startDt = new Date(fechaHora);
    const endDt   = new Date(startDt.getTime() + duracionMin * 60 * 1000);

    const gcalEvent = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary:     titulo,
        start:       { dateTime: startDt.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
        end:         { dateTime: endDt.toISOString(),   timeZone: 'America/Argentina/Buenos_Aires' },
        description: `Creado automáticamente por NEXUS`,
      },
    });

    // Actualizar con el ID de Google Calendar
    if (dbEvent) {
      await supabase.from('calendar_events').update({
        gcal_event_id: gcalEvent.data.id,
        confirmado:    true,
      }).eq('id', dbEvent.id);
    }

    console.log(`[calendar] Evento creado en GCal: ${gcalEvent.data.id}`);
    return { dbEvent, gcalEventId: gcalEvent.data.id };

  } catch (err) {
    // GCal no conectado o error → solo queda en BD
    console.warn('[calendar] No se pudo crear en GCal:', err.message);
    return { dbEvent, gcalEventId: null };
  }
}

/**
 * Lista los próximos eventos del usuario.
 */
async function listUpcomingEvents(userId, limit = 5) {
  const uid = userId || process.env.NEXUS_USER_ID;

  const { data: events } = await supabase.from('calendar_events')
    .select('*, contacts(nombre)')
    .eq('user_id', uid)
    .gte('fecha_hora', new Date().toISOString())
    .order('fecha_hora', { ascending: true })
    .limit(limit);

  return events || [];
}

/**
 * Formatea una lista de eventos para enviar por WhatsApp.
 */
function formatEventsForWhatsApp(events) {
  if (!events.length) return '📅 No tenés eventos próximos.';

  const lines = events.map((e, i) => {
    const fecha   = new Date(e.fecha_hora).toLocaleString('es-AR', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    const nombre  = e.contacts?.nombre || 'Sin contacto';
    const gcal    = e.gcal_event_id ? '✅' : '📋';
    return `${i + 1}. ${gcal} *${e.titulo}* con ${nombre}\n   📅 ${fecha}`;
  });

  return `*Próximos eventos:*\n\n${lines.join('\n\n')}`;
}

module.exports = {
  createCalendarEventSafe,
  listUpcomingEvents,
  formatEventsForWhatsApp,
};
