'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';

// ── Prompt 1: Extracción rápida (Claude Haiku) ───────────────────────────────

/**
 * Analiza un mensaje en tiempo real y extrae metadatos clave.
 * Retorna: { intencion, urgencia, precio, fecha, sentiment, nota, requiere_respuesta }
 */
async function analyzeMessage(texto, contextoConversacion) {
  const systemPrompt = `Sos un asistente de análisis de mensajes de negocio.
Analizás el mensaje y respondés SIEMPRE en JSON válido con este esquema exacto:
{
  "intencion": "consulta|presupuesto|seguimiento|cierre|queja|agradecimiento|otro",
  "urgencia": "alta|media|baja",
  "precio": null o número (solo el valor numérico sin símbolo),
  "fecha": null o fecha ISO 8601 (si hay mención de reunión, llamada o evento),
  "sentiment": "entusiasmado|positivo|neutro|frio|frustrado",
  "nota": "resumen de 1 línea del mensaje o null",
  "requiere_respuesta": true o false
}
No incluyas explicaciones. Solo el JSON.`;

  const userPrompt = `Contexto previo:
${contextoConversacion || '(sin contexto)'}

Mensaje nuevo:
${texto}`;

  const msg = await anthropic.messages.create({
    model:      MODEL_HAIKU,
    max_tokens: 300,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const raw = msg.content[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { intencion: 'otro', urgencia: 'baja', precio: null, fecha: null,
             sentiment: 'neutro', nota: null, requiere_respuesta: false };
  }
}

// ── Prompt 2: Resumen completo en texto (Claude Sonnet) ──────────────────────

/**
 * Genera un resumen detallado de la conversación con un contacto.
 */
async function generateSummary(mensajes, contacto) {
  const historial = mensajes
    .map(m => `[${new Date(m.enviado_en || m.created_at).toLocaleString('es-AR')}] ${m.remitente}: ${m.contenido}`)
    .join('\n');

  const systemPrompt = `Sos NEXUS, un asistente de ventas inteligente.
Generás resúmenes claros y accionables de conversaciones de negocio.`;

  const userPrompt = `Generá un resumen completo de la conversación con ${contacto.nombre} (${contacto.plataforma}).

Estado actual: ${contacto.estado || 'sin clasificar'}
Precio mencionado: ${contacto.precio_mencionado ? `$${contacto.precio_mencionado}` : 'ninguno'}

Historial de mensajes:
${historial}

El resumen debe incluir:
1. 📋 **Resumen** (2-3 líneas de lo más importante)
2. 💰 **Precio/propuesta** (si hay)
3. 📅 **Próximo paso** (acción concreta recomendada)
4. 🎯 **Estado del contacto** (prospecto_frio/tibio/caliente/propuesta_enviada/cliente_activo/cerrado)
5. ⚡ **Urgencia** (alta/media/baja)

Respondé en español, de forma concisa y profesional.`;

  const msg = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 600,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  return msg.content[0]?.text?.trim() || 'No se pudo generar el resumen.';
}

// ── Prompt 3: Guión para audio (Claude Sonnet) ───────────────────────────────

/**
 * Genera un guión optimizado para ser narrado en audio por ElevenLabs.
 */
async function generateAudioScript(mensajes, contacto) {
  const historial = mensajes
    .map(m => `${m.remitente}: ${m.contenido}`)
    .join('\n');

  const systemPrompt = `Sos NEXUS, un asistente de ventas.
Generás guiones de audio cortos para ser narrados por una IA de voz.`;

  const userPrompt = `Generá un guión de audio de máximo 60 segundos para resumir la conversación con ${contacto.nombre}.

El guión debe:
- Sonar natural y fluido al ser narrado
- Usar puntuación que guíe las pausas: comas, puntos
- Evitar símbolos como # * $ € que suenan mal en voz
- Empezar con "Resumen de tu conversación con ${contacto.nombre}."
- Incluir: qué quiere el contacto, precio si lo hay, próximo paso recomendado
- Terminar con una recomendación de acción

Historial:
${historial}

Solo el texto del guión, sin títulos ni formato.`;

  const msg = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 400,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  return msg.content[0]?.text?.trim() || `Resumen de tu conversación con ${contacto.nombre}. Sin información suficiente.`;
}

// ── Prompt 4: Mensaje de reapertura (Claude Sonnet) ──────────────────────────

/**
 * Genera un mensaje personalizado para retomar contacto después de N días de silencio.
 */
async function generateReopenMessage(contacto, ultimosMensajes) {
  const historial = (ultimosMensajes || [])
    .slice(-5)
    .map(m => `${m.remitente}: ${m.contenido}`)
    .join('\n');

  const systemPrompt = `Sos un experto en ventas consultivas.
Escribís mensajes de reapertura de conversación que suenan naturales y no invasivos.`;

  const userPrompt = `Escribí un mensaje para retomar el contacto con ${contacto.nombre},
que lleva ${contacto.dias_sin_respuesta || 0} días sin responder.

Estado: ${contacto.estado || 'sin clasificar'}
Precio mencionado: ${contacto.precio_mencionado ? `$${contacto.precio_mencionado} ${contacto.moneda || 'USD'}` : 'ninguno'}

Últimos mensajes:
${historial || '(sin historial)'}

El mensaje debe:
- Ser breve (máximo 3 líneas)
- Sonar natural y humano, no de vendedor
- Tener un gancho o propuesta de valor
- No ser invasivo ni desesperado
- Estar en español informal (vos)

Solo el texto del mensaje, sin comillas.`;

  const msg = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 200,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  return msg.content[0]?.text?.trim() || `Hola ${contacto.nombre}, ¿cómo estás? ¿Seguís interesado en lo que estuvimos hablando?`;
}

// ── Recálculo de closing score con IA ───────────────────────────────────────

async function recalcClosingScore(mensajes) {
  const historial = mensajes
    .map(m => `${m.remitente} [${m.intencion || '?'}]: ${m.contenido}`)
    .join('\n');

  const msg = await anthropic.messages.create({
    model:      MODEL_HAIKU,
    max_tokens: 200,
    messages:   [{
      role:    'user',
      content: `Analizá esta conversación de ventas y devolvé un JSON con:
{ "score": número del 0 al 100, "signals": { "positivas": [], "negativas": [] } }

Conversación:
${historial}

Solo el JSON, sin explicaciones.`,
    }],
  });

  try {
    return JSON.parse(msg.content[0]?.text?.trim() || '{"score":0,"signals":{}}');
  } catch {
    return { score: 0, signals: {} };
  }
}

// ── Sugerencia de respuesta ──────────────────────────────────────────────────

async function suggestReply(texto, contacto) {
  const msg = await anthropic.messages.create({
    model:      MODEL_HAIKU,
    max_tokens: 200,
    messages:   [{
      role:    'user',
      content: `Sugerí una respuesta breve (máximo 2 líneas) para este mensaje de ${contacto.nombre}:

"${texto}"

La respuesta debe:
- Sonar natural y humana
- Avanzar la conversación hacia el cierre
- Estar en español informal (vos)

Solo el texto de la respuesta, sin comillas.`,
    }],
  });

  return msg.content[0]?.text?.trim() || null;
}

// ── Prompt de reporte semanal ────────────────────────────────────────────────

async function generateWeeklyReportText(datos) {
  const msg = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 800,
    messages:   [{
      role:    'user',
      content: `Generá un reporte semanal de negocio basado en estos datos:

${JSON.stringify(datos, null, 2)}

El reporte debe incluir:
1. 📊 Resumen de la semana
2. 🔥 Contactos más prometedores
3. 💰 Propuestas en curso y montos
4. ⚠️ Seguimientos urgentes
5. 📈 Tendencia general del negocio
6. 🎯 3 acciones prioritarias para la próxima semana

Formato: texto con emojis, conciso y accionable. En español.`,
    }],
  });

  return msg.content[0]?.text?.trim() || 'No se pudo generar el reporte.';
}

module.exports = {
  analyzeMessage,
  generateSummary,
  generateAudioScript,
  generateReopenMessage,
  recalcClosingScore,
  suggestReply,
  generateWeeklyReportText,
};
