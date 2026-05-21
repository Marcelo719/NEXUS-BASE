'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Handlers registrados por tipo de tarea
const handlers = {};

/**
 * Registra un handler para un tipo de tarea.
 * @param {string}   tipo    Identificador único del tipo
 * @param {Function} handler async (payload) => void
 */
function registerHandler(tipo, handler) {
  handlers[tipo] = handler;
}

/**
 * Agrega una tarea a la cola de reintentos.
 */
async function addToRetryQueue(tipo, payload, maxIntentos = 3) {
  try {
    await supabase.from('retry_queue').insert({
      tipo,
      payload,
      max_intentos:   maxIntentos,
      proximo_intento: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[retryQueue] addToRetryQueue error:', err.message);
  }
}

/**
 * Procesa las tareas pendientes de la cola.
 * Llamado por cron cada 5 minutos.
 */
async function processRetryQueue() {
  const now = new Date().toISOString();

  const { data: tasks } = await supabase.from('retry_queue')
    .select('*')
    .eq('resuelto', false)
    .lte('proximo_intento', now)
    .order('proximo_intento', { ascending: true })
    .limit(20);

  for (const task of tasks || []) {
    const handler = handlers[task.tipo];

    if (!handler) {
      console.warn(`[retryQueue] Sin handler para tipo: ${task.tipo}`);
      // Si no hay handler y superó max_intentos, marcar como resuelto para no bloquear
      if (task.intentos >= task.max_intentos) {
        await supabase.from('retry_queue').update({ resuelto: true }).eq('id', task.id);
      }
      continue;
    }

    try {
      await handler(task.payload);
      await supabase.from('retry_queue').update({ resuelto: true }).eq('id', task.id);
    } catch (err) {
      const nuevoIntento  = task.intentos + 1;
      const backoffMs     = Math.min(Math.pow(2, nuevoIntento) * 60 * 1000, 60 * 60 * 1000); // max 1 hora
      const proximoIntento = new Date(Date.now() + backoffMs).toISOString();

      if (nuevoIntento >= task.max_intentos) {
        await supabase.from('retry_queue').update({
          intentos:     nuevoIntento,
          ultimo_error: err.message,
          resuelto:     true, // agotar intentos
        }).eq('id', task.id);
        console.error(`[retryQueue] Tarea ${task.id} (${task.tipo}) agotó intentos: ${err.message}`);
      } else {
        await supabase.from('retry_queue').update({
          intentos:        nuevoIntento,
          ultimo_error:    err.message,
          proximo_intento: proximoIntento,
        }).eq('id', task.id);
        console.warn(`[retryQueue] Tarea ${task.id} reintento ${nuevoIntento}/${task.max_intentos} en ${backoffMs / 60000}min`);
      }
    }
  }
}

module.exports = {
  registerHandler,
  addToRetryQueue,
  processRetryQueue,
};
