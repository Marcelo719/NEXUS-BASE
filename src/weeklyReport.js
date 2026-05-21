'use strict';

const { createClient }   = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');
const { generateWeeklyReportText } = require('./prompts');
const { checkAndUpdateCost }       = require('./costGuard');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_WA = process.env.OWNER_WA_ID;

/**
 * Genera el reporte semanal de negocio.
 * @param {boolean} manual - Si es true, es por comando. Si es false, es el cron dominical.
 */
async function generateWeeklyReport(manual = false) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const allowed = await checkAndUpdateCost('sonnet', 1, 0.015);
    if (!allowed) {
      if (manual) await sendWhatsAppMessage(OWNER_WA, '⚠️ Límite de IA alcanzado. Reporte no generado.');
      return;
    }

    // Rango: últimos 7 días
    const ahora    = new Date();
    const hace7d   = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Nuevos contactos esta semana
    const { data: nuevos } = await supabase.from('contacts')
      .select('nombre, plataforma, estado, closing_score')
      .eq('user_id', userId)
      .gte('created_at', hace7d.toISOString());

    // Mensajes esta semana
    const { count: totalMensajes } = await supabase.from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', hace7d.toISOString());

    // Contactos calientes (score >= 70)
    const { data: calientes } = await supabase.from('contacts')
      .select('nombre, closing_score, estado, precio_mencionado, moneda')
      .eq('user_id', userId)
      .gte('closing_score', 70)
      .order('closing_score', { ascending: false })
      .limit(10);

    // Propuestas en curso
    const { data: propuestas } = await supabase.from('contacts')
      .select('nombre, precio_mencionado, moneda, dias_sin_respuesta')
      .eq('user_id', userId)
      .eq('estado', 'propuesta_enviada');

    // Clientes activos
    const { data: clientes } = await supabase.from('contacts')
      .select('nombre').eq('user_id', userId).eq('estado', 'cliente_activo');

    // Emails recibidos esta semana
    const { count: emailsRecibidos } = await supabase.from('emails')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', hace7d.toISOString());

    // Costo de IA esta semana
    const { data: costRows } = await supabase.from('cost_log')
      .select('costo_usd').eq('user_id', userId)
      .gte('fecha', hace7d.toISOString().split('T')[0]);

    const costoSemana = (costRows || []).reduce((s, r) => s + parseFloat(r.costo_usd), 0);

    const datos = {
      periodo:           `${hace7d.toLocaleDateString('es-AR')} al ${ahora.toLocaleDateString('es-AR')}`,
      nuevos_contactos:  nuevos?.length || 0,
      total_mensajes:    totalMensajes || 0,
      emails_recibidos:  emailsRecibidos || 0,
      contactos_calientes: calientes?.map(c => ({
        nombre: c.nombre,
        score:  c.closing_score,
        precio: c.precio_mencionado ? `${c.precio_mencionado} ${c.moneda}` : null,
      })) || [],
      propuestas_activas: propuestas?.map(p => ({
        nombre: p.nombre,
        monto:  p.precio_mencionado ? `${p.precio_mencionado} ${p.moneda}` : 'sin monto',
        dias_espera: p.dias_sin_respuesta,
      })) || [],
      clientes_activos:  clientes?.length || 0,
      costo_ia_usd:      costoSemana.toFixed(2),
    };

    const reporte = await generateWeeklyReportText(datos);

    // Guardar reporte en BD
    await supabase.from('weekly_reports').insert({
      user_id:      userId,
      semana_fin:   ahora.toISOString(),
      datos_raw:    datos,
      reporte_texto: reporte,
    });

    await sendWhatsAppMessage(OWNER_WA, `📊 *Reporte Semanal — NEXUS*\n\n${reporte}`);

  } catch (err) {
    console.error('[weeklyReport] error:', err.message);
    if (manual) await sendWhatsAppMessage(OWNER_WA, `❌ Error generando reporte: ${err.message}`);
  }
}

module.exports = { generateWeeklyReport };
