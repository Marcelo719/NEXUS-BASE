'use strict';

const { createClient } = require('@supabase/supabase-js');
const { generateSummary, generateReopenMessage } = require('./prompts');
const { sendWhatsAppMessage } = require('./sender');
const { checkAndUpdateCost } = require('./costGuard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Genera un resumen en texto de la conversación con un contacto y lo envía al owner.
 */
async function generateTextSummary(nombreContacto, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    // Buscar contacto
    const { data: contacts } = await supabase.from('contacts')
      .select('*').eq('user_id', userId)
      .ilike('nombre', `%${nombreContacto}%`)
      .order('ultimo_contacto', { ascending: false }).limit(1);

    const contacto = contacts?.[0];
    if (!contacto) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré ningún contacto con el nombre "${nombreContacto}".`);
      return;
    }

    const allowed = await checkAndUpdateCost('sonnet', 1, 0.009);
    if (!allowed) {
      await sendWhatsAppMessage(ownerWaId, '⚠️ Límite diario de IA alcanzado. Resumen no generado.');
      return;
    }

    // Obtener mensajes de la conversación más reciente
    const { data: conv } = await supabase.from('conversations')
      .select('id').eq('contact_id', contacto.id)
      .order('ultimo_mensaje_en', { ascending: false }).limit(1).maybeSingle();

    let mensajes = [];
    if (conv) {
      const { data: msgs } = await supabase.from('messages')
        .select('remitente, contenido, enviado_en, intencion')
        .eq('conversation_id', conv.id)
        .order('enviado_en', { ascending: false }).limit(30);
      mensajes = (msgs || []).reverse();
    }

    if (mensajes.length === 0) {
      await sendWhatsAppMessage(ownerWaId, `⚠️ ${contacto.nombre} no tiene mensajes para resumir.`);
      return;
    }

    const resumen = await generateSummary(mensajes, contacto);

    // Guardar en tabla summaries
    const { data: sumRow } = await supabase.from('summaries').insert({
      contact_id:    contacto.id,
      tipo:          'texto',
      resumen_texto: resumen,
    }).select().single();

    // Extraer próximo paso y estado del texto del resumen (heurístico)
    if (sumRow) {
      const proximo = extractSection(resumen, 'Próximo paso');
      const estado  = extractEstado(resumen);
      if (proximo || estado) {
        await supabase.from('summaries').update({
          proximo_paso:    proximo || null,
          estado_contacto: estado  || null,
        }).eq('id', sumRow.id);
      }
    }

    await sendWhatsAppMessage(ownerWaId,
      `📋 *Resumen — ${contacto.nombre}* (${contacto.plataforma})\n\n${resumen}`
    );

  } catch (err) {
    console.error('[summaries] generateTextSummary error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error generando resumen: ${err.message}`);
  }
}

/**
 * Genera un mensaje de reapertura de conversación y lo envía al owner para aprobación.
 */
async function generateReopenMsg(nombreContacto, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: contacts } = await supabase.from('contacts')
      .select('*').eq('user_id', userId)
      .ilike('nombre', `%${nombreContacto}%`)
      .order('ultimo_contacto', { ascending: false }).limit(1);

    const contacto = contacts?.[0];
    if (!contacto) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré a "${nombreContacto}".`);
      return;
    }

    const allowed = await checkAndUpdateCost('sonnet', 1, 0.006);
    if (!allowed) {
      await sendWhatsAppMessage(ownerWaId, '⚠️ Límite diario de IA alcanzado.');
      return;
    }

    // Últimos 5 mensajes
    const { data: conv } = await supabase.from('conversations')
      .select('id').eq('contact_id', contacto.id)
      .order('ultimo_mensaje_en', { ascending: false }).limit(1).maybeSingle();

    let ultimosMensajes = [];
    if (conv) {
      const { data: msgs } = await supabase.from('messages')
        .select('remitente, contenido')
        .eq('conversation_id', conv.id)
        .order('enviado_en', { ascending: false }).limit(5);
      ultimosMensajes = (msgs || []).reverse();
    }

    const mensaje = await generateReopenMessage(contacto, ultimosMensajes);

    await sendWhatsAppMessage(ownerWaId,
      `🔄 *Mensaje de reapertura para ${contacto.nombre}:*\n\n"${mensaje}"\n\nRespondé *ENVIAR* para enviarlo o *EDITAR [nuevo texto]* para modificarlo.`
    );

    // Guardar en pending_actions
    const waId = contacto.plataforma_user_id;
    await supabase.from('pending_actions').upsert({
      contact_id: contacto.id,
      tipo:       'enviar_respuesta',
      payload:    { mensaje, waId, phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID },
    }, { onConflict: 'contact_id,tipo' });

  } catch (err) {
    console.error('[summaries] generateReopenMsg error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error: ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractSection(text, sectionTitle) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(sectionTitle.toLowerCase())) {
      return lines[i + 1]?.trim() || null;
    }
  }
  return null;
}

const ESTADOS = ['prospecto_frio', 'prospecto_tibio', 'prospecto_caliente',
                 'propuesta_enviada', 'cliente_activo', 'cerrado'];

function extractEstado(text) {
  const lower = text.toLowerCase();
  return ESTADOS.find(e => lower.includes(e.replace(/_/g, ' '))) || null;
}

module.exports = {
  generateTextSummary,
  generateReopenMessage: generateReopenMsg,
};
