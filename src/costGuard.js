'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_WA = process.env.OWNER_WA_ID;

// Costo aproximado por llamada (USD) — ajustar según uso real
const COST_PER_CALL = {
  haiku:      0.0008,
  sonnet:     0.008,
  elevenlabs: 0.003,
};

/**
 * Verifica si hay presupuesto disponible y registra el costo.
 * Retorna true si se puede proceder, false si el límite fue alcanzado.
 * @param {string} tipo      'haiku' | 'sonnet' | 'elevenlabs'
 * @param {number} llamadas  número de llamadas a registrar
 * @param {number} costoUsd  costo real en USD (si se conoce), o 0 para usar el default
 */
async function checkAndUpdateCost(tipo, llamadas = 1, costoUsd = 0) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: user } = await supabase.from('users')
      .select('cost_limit_daily_usd, cost_alert_at_pct, cost_pause_advanced')
      .eq('id', userId).single();

    const limitUsd   = parseFloat(process.env.COST_LIMIT_DAILY_USD  || user?.cost_limit_daily_usd  || 10);
    const alertPct   = parseInt(process.env.COST_ALERT_PCT          || user?.cost_alert_at_pct     || 80, 10);
    const paused     = user?.cost_pause_advanced;

    // Si está pausado, rechazar solo llamadas avanzadas (Sonnet, ElevenLabs)
    if (paused && (tipo === 'sonnet' || tipo === 'elevenlabs')) {
      console.warn(`[costGuard] Pausado para ${tipo} por límite de costos.`);
      return false;
    }

    // Calcular gasto acumulado del día
    const today = new Date().toISOString().split('T')[0];
    const { data: costRows } = await supabase.from('cost_log')
      .select('costo_usd').eq('user_id', userId).eq('fecha', today);

    const totalHoy = (costRows || []).reduce((sum, r) => sum + parseFloat(r.costo_usd), 0);
    const costo    = costoUsd || (COST_PER_CALL[tipo] * llamadas);

    // Si supera el límite → rechazar
    if (totalHoy + costo > limitUsd) {
      await sendWhatsAppMessage(OWNER_WA,
        `🚨 *NEXUS: Límite diario de IA alcanzado* ($${limitUsd} USD)\nGasto de hoy: $${totalHoy.toFixed(4)}\nLas funciones avanzadas de IA están pausadas hasta mañana.`
      ).catch(() => {});

      await supabase.from('users').update({ cost_pause_advanced: true }).eq('id', userId);
      return false;
    }

    // Alerta en umbral
    const pctActual  = ((totalHoy + costo) / limitUsd) * 100;
    const pctPrevio  = (totalHoy / limitUsd) * 100;
    if (pctActual >= alertPct && pctPrevio < alertPct) {
      await sendWhatsAppMessage(OWNER_WA,
        `⚠️ *NEXUS: Alerta de costos*\nUsaste el ${alertPct}% del límite diario ($${limitUsd})\nGasto actual: $${(totalHoy + costo).toFixed(4)}`
      ).catch(() => {});
    }

    // Registrar costo
    await supabase.rpc('increment_cost_log', {
      p_user_id: userId,
      p_fecha:   today,
      p_tipo:    tipo,
      p_llamadas: llamadas,
      p_costo:   costo,
    });

    return true;
  } catch (err) {
    console.error('[costGuard] Error:', err.message);
    return true; // En caso de error, permitir la llamada
  }
}

/**
 * Resetea la pausa diaria de IA (llamado a medianoche por cron).
 */
async function resetDailyCostPause() {
  const userId = process.env.NEXUS_USER_ID;
  await supabase.from('users')
    .update({ cost_pause_advanced: false })
    .eq('id', userId);
  console.log('[costGuard] Pausa diaria de costos reseteada.');
}

/**
 * Retorna el gasto acumulado del día actual.
 */
async function getDailySpend() {
  const userId = process.env.NEXUS_USER_ID;
  const today  = new Date().toISOString().split('T')[0];

  const { data: rows } = await supabase.from('cost_log')
    .select('tipo, llamadas, costo_usd')
    .eq('user_id', userId).eq('fecha', today);

  const total  = (rows || []).reduce((sum, r) => sum + parseFloat(r.costo_usd), 0);
  return { rows: rows || [], total };
}

module.exports = {
  checkAndUpdateCost,
  resetDailyCostPause,
  getDailySpend,
};
