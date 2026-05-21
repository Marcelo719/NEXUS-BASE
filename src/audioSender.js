'use strict';

const { createClient } = require('@supabase/supabase-js');
const { generateAudioScript } = require('./prompts');
const { generateAndUploadAudio } = require('./audio');
const { sendWhatsAppAudio, sendWhatsAppMessage } = require('./sender');
const { checkAndUpdateCost } = require('./costGuard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Orquesta la generación y envío de un resumen en audio para un contacto.
 * @param {string} nombreContacto - Nombre del contacto (búsqueda parcial)
 * @param {string} ownerWaId      - WhatsApp ID del owner para el envío
 */
async function sendAudioSummary(nombreContacto, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    // Buscar contacto
    const { data: contacts } = await supabase.from('contacts')
      .select('*')
      .eq('user_id', userId)
      .ilike('nombre', `%${nombreContacto}%`)
      .order('ultimo_contacto', { ascending: false })
      .limit(1);

    const contacto = contacts?.[0];
    if (!contacto) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré ningún contacto con el nombre "${nombreContacto}".`);
      return;
    }

    // Verificar límite de costos (Sonnet + ElevenLabs)
    const allowed = await checkAndUpdateCost('sonnet', 1, 0.012);
    if (!allowed) {
      await sendWhatsAppMessage(ownerWaId, '⚠️ Límite diario de IA alcanzado. Audio no generado.');
      return;
    }

    await sendWhatsAppMessage(ownerWaId, `🎙️ Generando audio de ${contacto.nombre}...`);

    // Obtener últimos mensajes
    const { data: conv } = await supabase.from('conversations')
      .select('id').eq('contact_id', contacto.id)
      .order('ultimo_mensaje_en', { ascending: false }).limit(1).maybeSingle();

    let mensajes = [];
    if (conv) {
      const { data: msgs } = await supabase.from('messages')
        .select('remitente, contenido, enviado_en')
        .eq('conversation_id', conv.id)
        .order('enviado_en', { ascending: false })
        .limit(20);
      mensajes = (msgs || []).reverse();
    }

    if (mensajes.length === 0) {
      await sendWhatsAppMessage(ownerWaId, `⚠️ ${contacto.nombre} no tiene mensajes suficientes para generar un audio.`);
      return;
    }

    // Generar guión con Claude Sonnet
    const script = await generateAudioScript(mensajes, contacto);

    // Generar audio con ElevenLabs y subir a Supabase Storage
    const filename = `summary_${contacto.id}`;
    const { url, duracion } = await generateAndUploadAudio(script, filename);

    // Guardar en tabla summaries
    await supabase.from('summaries').insert({
      contact_id:    contacto.id,
      tipo:          'audio',
      resumen_texto: script,
      audio_url:     url,
      audio_duracion: duracion,
    });

    // Enviar audio por WhatsApp
    await sendWhatsAppAudio(ownerWaId, url);

    // Enviar texto del guión también como referencia
    await sendWhatsAppMessage(ownerWaId, `📝 *Guión del audio — ${contacto.nombre}:*\n\n${script}`);

  } catch (err) {
    console.error('[audioSender] Error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error generando audio: ${err.message}`);
  }
}

module.exports = { sendAudioSummary };
