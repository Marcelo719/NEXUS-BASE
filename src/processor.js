'use strict';

const { createClient } = require('@supabase/supabase-js');
const { analyzeMessage } = require('./prompts');
const { sendWhatsAppMessage } = require('./sender');
const { createCalendarEventSafe } = require('./calendar');
const { canAutoRun } = require('./automation');
const { checkAndUpdateCost } = require('./costGuard');
const { addToRetryQueue } = require('./retryQueue');
const { sendPushNotification } = require('./healthCheck');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OWNER_WA_ID = process.env.OWNER_WA_ID;

/**
 * Punto de entrada para WhatsApp. Recibe el mensaje crudo de Meta y lo procesa.
 */
async function processMessage({ plataforma, waId, nombre, msg, phoneNumberId }) {
  try {
    // Detectar tipo de mensaje
    let texto = '';
    let tipoMsg = 'text';

    if (msg.type === 'text') {
      texto   = msg.text?.body || '';
      tipoMsg = 'text';
    } else if (msg.type === 'audio') {
      // Transcripción en background — return para no bloquear
      transcribeAndProcess({ plataforma, waId, nombre, msg, phoneNumberId }).catch(console.error);
      return;
    } else if (msg.type === 'image' || msg.type === 'document') {
      // Análisis en background
      console.log(`[processor] Recibido ${msg.type} de ${waId} — procesando en background`);
      return;
    }

    if (!texto) return;

    // Si es el owner → ejecutar comandos
    if (waId === OWNER_WA_ID) {
      const handled = await handleOwnerCommand(texto, phoneNumberId);
      if (handled) return;
    }

    await processTextMessage({ plataforma, waId, nombre, texto, tipoMsg, phoneNumberId });
  } catch (err) {
    console.error('[processor] Error en processMessage:', err);
    await addToRetryQueue('processMessage', { plataforma, waId, nombre, tipoMsgFallback: 'text' });
  }
}

/**
 * Lógica central para un mensaje de texto (cualquier canal).
 */
async function processTextMessage({ plataforma, waId, nombre, texto, tipoMsg, phoneNumberId, emailAccountId }) {
  const userId = process.env.NEXUS_USER_ID;

  // 2. Upsert contacto
  const contact = await upsertContact({ userId, nombre, plataforma, waId });
  if (!contact) return;

  // 3. Upsert conversación activa
  const conversation = await upsertConversation({ contactId: contact.id, plataforma, preview: texto });

  // 5. Guardar mensaje + analizar con IA en paralelo
  const [savedMsg, aiResult] = await Promise.all([
    saveMessage({ conversationId: conversation.id, remitente: waId, contenido: texto, tipoMsg }),
    analyzeWithAI(texto, contact.id, conversation.id),
  ]);

  // 6. Actualizar metadatos IA del mensaje
  if (savedMsg && aiResult) {
    await supabase.from('messages').update({
      intencion:        aiResult.intencion || null,
      urgencia:         aiResult.urgencia  || null,
      precio_detectado: aiResult.precio    || null,
      fecha_detectada:  aiResult.fecha     || null,
      nota_automatica:  aiResult.nota      || null,
      procesado_ia:     true,
    }).eq('id', savedMsg.id);

    // Actualizar sentimiento del contacto
    if (aiResult.sentiment) {
      await supabase.from('contacts').update({
        sentiment_actual: aiResult.sentiment,
        sentiment_at:     new Date().toISOString(),
      }).eq('id', contact.id);
    }

    // 7. Si hay fecha detectada → gestionar calendario
    if (aiResult.fecha) {
      const user = await getUser(userId);
      const modo = user?.modo_automatizacion || 'auto';
      const autoOk = canAutoRun(modo);

      if (autoOk) {
        await createCalendarEventSafe({
          userId,
          contactId: contact.id,
          titulo:    `Reunión con ${contact.nombre}`,
          fechaHora: aiResult.fecha,
        });
      } else if (modo === 'partial') {
        await supabase.from('pending_actions').upsert({
          contact_id: contact.id,
          tipo:       'crear_evento',
          payload:    { titulo: `Reunión con ${contact.nombre}`, fechaHora: aiResult.fecha },
        }, { onConflict: 'contact_id,tipo' });

        await sendWhatsAppMessage(
          OWNER_WA_ID,
          `📅 *Fecha detectada* con ${contact.nombre}: ${new Date(aiResult.fecha).toLocaleString('es-AR')}\n¿Creo el evento? Respondé *SÍ* o *NO*`
        );
      } else {
        await supabase.from('calendar_events').insert({
          user_id:    userId,
          contact_id: contact.id,
          titulo:     `Reunión con ${contact.nombre}`,
          fecha_hora: aiResult.fecha,
        });
      }
    }
  }

  // 8. Actualizar closing score (delta rápido)
  const totalMensajes = conversation.total_mensajes + 1;
  const deltaScore    = calcDeltaScore(texto);
  let newScore        = Math.min(100, Math.max(0, (contact.closing_score || 0) + deltaScore));

  const prevScore = contact.closing_score || 0;
  await supabase.from('contacts').update({
    closing_score:    newScore,
    closing_score_at: new Date().toISOString(),
    ultimo_contacto:  new Date().toISOString(),
  }).eq('id', contact.id);

  // Notificar si supera 80 por primera vez
  if (prevScore < 80 && newScore >= 80) {
    await sendWhatsAppMessage(
      OWNER_WA_ID,
      `🔥 *${contact.nombre}* acaba de superar el 80% de probabilidad de cierre. ¡Es momento de actuar!`
    );
  }

  // 9. Recalcular score completo con IA cada 5 mensajes (background)
  if (totalMensajes % 5 === 0) {
    recalcScoreFull(contact.id, userId).catch(console.error);
  }

  // 10. Generar perfil de personalidad (background)
  if (totalMensajes === 8 || totalMensajes % 20 === 0) {
    generatePersonalityProfile(contact.id).catch(console.error);
  }

  // 11. Notificación push
  sendPushNotification({
    title: `Nuevo mensaje de ${contact.nombre}`,
    body:  texto.slice(0, 100),
  }).catch(console.error);

  // 12. Si modo auto y score bajo → sugerir respuesta
  const user = await getUser(userId);
  const modo = user?.modo_automatizacion || 'auto';
  if (canAutoRun(modo) && newScore < 40 && aiResult?.requiere_respuesta) {
    const sugerencia = await generateSuggestedReply(texto, contact);
    if (sugerencia) {
      await sendWhatsAppMessage(
        OWNER_WA_ID,
        `💬 *Sugerencia de respuesta* para ${contact.nombre}:\n\n"${sugerencia}"\n\nRespondé *ENVIAR* para enviarla o *EDITAR [nuevo texto]* para modificarla.`
      );
      await supabase.from('pending_actions').upsert({
        contact_id: contact.id,
        tipo:       'enviar_respuesta',
        payload:    { mensaje: sugerencia, waId, phoneNumberId },
      }, { onConflict: 'contact_id,tipo' });
    }
  }
}

// ── Helpers internos ────────────────────────────────────────────────────────

async function upsertContact({ userId, nombre, plataforma, waId }) {
  const { data, error } = await supabase.from('contacts').upsert({
    user_id:           userId,
    nombre,
    plataforma,
    plataforma_user_id: waId,
    ultimo_contacto:   new Date().toISOString(),
  }, { onConflict: 'user_id,plataforma,plataforma_user_id', ignoreDuplicates: false })
    .select().single();

  if (error) {
    // Intentar fetch si ya existe
    const { data: existing } = await supabase.from('contacts')
      .select('*').eq('user_id', userId)
      .eq('plataforma', plataforma).eq('plataforma_user_id', waId).single();
    return existing;
  }
  return data;
}

async function upsertConversation({ contactId, plataforma, preview }) {
  const { data: existing } = await supabase.from('conversations')
    .select('*').eq('contact_id', contactId).eq('activa', true)
    .eq('plataforma', plataforma).maybeSingle();

  if (existing) {
    const { data } = await supabase.from('conversations').update({
      ultimo_mensaje_en:      new Date().toISOString(),
      ultimo_mensaje_preview: preview?.slice(0, 200),
      total_mensajes:         existing.total_mensajes + 1,
    }).eq('id', existing.id).select().single();
    return data || existing;
  }

  const { data } = await supabase.from('conversations').insert({
    contact_id:             contactId,
    plataforma,
    ultimo_mensaje_en:      new Date().toISOString(),
    ultimo_mensaje_preview: preview?.slice(0, 200),
    total_mensajes:         1,
  }).select().single();
  return data;
}

async function saveMessage({ conversationId, remitente, contenido, tipoMsg }) {
  const { data, error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    remitente,
    contenido,
    tipo_msg: tipoMsg,
    enviado_en: new Date().toISOString(),
  }).select().single();
  if (error) console.error('[processor] saveMessage error:', error.message);
  return data;
}

async function analyzeWithAI(texto, contactId, conversationId) {
  try {
    const allowed = await checkAndUpdateCost('haiku', 1, 0.001);
    if (!allowed) return null;

    // Últimos 5 mensajes como contexto
    const { data: prevMsgs } = await supabase.from('messages')
      .select('remitente, contenido').eq('conversation_id', conversationId)
      .order('enviado_en', { ascending: false }).limit(5);

    const contexto = (prevMsgs || []).reverse()
      .map(m => `${m.remitente}: ${m.contenido}`).join('\n');

    return await analyzeMessage(texto, contexto);
  } catch (err) {
    console.error('[processor] analyzeWithAI error:', err.message);
    return null;
  }
}

function calcDeltaScore(texto) {
  const lower = texto.toLowerCase();
  let delta   = 0;

  const positiveSignals = ['cuánto cuesta', 'cuanto cuesta', 'precio', 'presupuesto',
    'quiero', 'me interesa', 'cuando podemos', 'cómo funciona', 'avancemos',
    'perfecto', 'de acuerdo', 'trato hecho', 'listo', 'arrancamos'];
  const negativeSignals = ['no gracias', 'no me interesa', 'muy caro', 'lo pensaré',
    'tal vez', 'ya veremos', 'no por ahora'];

  for (const s of positiveSignals) if (lower.includes(s)) delta += 5;
  for (const s of negativeSignals) if (lower.includes(s)) delta -= 8;

  return Math.max(-20, Math.min(20, delta));
}

async function recalcScoreFull(contactId, userId) {
  try {
    const { data: msgs } = await supabase.from('messages')
      .select('contenido, remitente, intencion')
      .eq('conversation_id', (
        await supabase.from('conversations').select('id')
          .eq('contact_id', contactId).limit(1).single()
      ).data?.id)
      .order('enviado_en', { ascending: false }).limit(30);

    if (!msgs?.length) return;

    const { recalcClosingScore } = require('./prompts');
    const { score, signals } = await recalcClosingScore(msgs);

    await supabase.from('contacts').update({
      closing_score:    Math.max(0, Math.min(100, score)),
      closing_signals:  signals,
      closing_score_at: new Date().toISOString(),
    }).eq('id', contactId);
  } catch (err) {
    console.error('[processor] recalcScoreFull error:', err.message);
  }
}

async function generatePersonalityProfile(contactId) {
  // Placeholder — se puede extender con un prompt de personalidad
  console.log(`[processor] Generando perfil para contacto ${contactId}`);
}

async function generateSuggestedReply(texto, contact) {
  try {
    const { suggestReply } = require('./prompts');
    return await suggestReply(texto, contact);
  } catch (err) {
    console.error('[processor] generateSuggestedReply error:', err.message);
    return null;
  }
}

async function getUser(userId) {
  const { data } = await supabase.from('users').select('*').eq('id', userId).single();
  return data;
}

async function transcribeAndProcess({ plataforma, waId, nombre, msg, phoneNumberId }) {
  // Whisper transcription — usa openai.audio.transcriptions
  try {
    const OpenAI = require('openai');
    const fs     = require('fs');
    const path   = require('path');
    const os     = require('os');

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Obtener URL del audio desde Meta
    const mediaId  = msg.audio?.id;
    const mediaRes = await fetch(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
    );
    const mediaData = await mediaRes.json();
    const audioUrl  = mediaData.url;

    const audioRes  = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    });
    const tmpPath = path.join(os.tmpdir(), `nexus_audio_${Date.now()}.ogg`);
    const buffer  = await audioRes.buffer();
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file:     fs.createReadStream(tmpPath),
      model:    'whisper-1',
      language: 'es',
    });
    fs.unlinkSync(tmpPath);

    const texto = transcription.text;
    if (texto) {
      await processTextMessage({ plataforma, waId, nombre, texto, tipoMsg: 'audio', phoneNumberId });
    }
  } catch (err) {
    console.error('[processor] transcribeAndProcess error:', err.message);
  }
}

// ── Comandos del owner ──────────────────────────────────────────────────────

async function handleOwnerCommand(texto, phoneNumberId) {
  const lower = texto.toLowerCase().trim();

  // Comando: resumen [nombre]
  if (lower.startsWith('resumen ')) {
    const nombre = texto.slice(8).trim();
    const { generateTextSummary } = require('./summaries');
    await generateTextSummary(nombre, OWNER_WA_ID);
    return true;
  }

  // Comando: audio [nombre]
  if (lower.startsWith('audio ')) {
    const nombre = texto.slice(6).trim();
    const { sendAudioSummary } = require('./audioSender');
    await sendAudioSummary(nombre, OWNER_WA_ID);
    return true;
  }

  // Comando: retomar [nombre]
  if (lower.startsWith('retomar ')) {
    const nombre = texto.slice(8).trim();
    const { generateReopenMessage } = require('./summaries');
    await generateReopenMessage(nombre, OWNER_WA_ID);
    return true;
  }

  // Comando: pendientes
  if (lower === 'pendientes') {
    const { listFollowUps } = require('./followup');
    await listFollowUps(OWNER_WA_ID);
    return true;
  }

  // Comando: ver notas [nombre]
  if (lower.startsWith('ver notas ')) {
    const nombre = texto.slice(10).trim();
    const { viewNotes } = require('./notes');
    await viewNotes(nombre, OWNER_WA_ID);
    return true;
  }

  // Comando: nota [nombre]: [texto]
  if (lower.startsWith('nota ')) {
    const rest   = texto.slice(5);
    const [nombre, nota] = rest.split(':').map(s => s.trim());
    if (nombre && nota) {
      const { addNote } = require('./notes');
      await addNote(nombre, nota, OWNER_WA_ID);
      return true;
    }
  }

  // Comando: etiqueta [nombre]: [tag]
  if (lower.startsWith('etiqueta ') && !lower.startsWith('quitar etiqueta ')) {
    const rest = texto.slice(9);
    const [nombre, tag] = rest.split(':').map(s => s.trim());
    if (nombre && tag) {
      const { addTag } = require('./notes');
      await addTag(nombre, tag, OWNER_WA_ID);
      return true;
    }
  }

  // Comando: quitar etiqueta [nombre]: [tag]
  if (lower.startsWith('quitar etiqueta ')) {
    const rest = texto.slice(16);
    const [nombre, tag] = rest.split(':').map(s => s.trim());
    if (nombre && tag) {
      const { removeTag } = require('./notes');
      await removeTag(nombre, tag, OWNER_WA_ID);
      return true;
    }
  }

  // Comando: reporte
  if (lower === 'reporte') {
    const { generateWeeklyReport } = require('./weeklyReport');
    await generateWeeklyReport(true);
    return true;
  }

  // Comando: exportar contactos
  if (lower === 'exportar contactos') {
    const { exportContacts } = require('./export');
    await exportContacts(OWNER_WA_ID);
    return true;
  }

  // Comando: modo auto/parcial/manual
  if (lower === 'modo auto' || lower === 'modo parcial' || lower === 'modo manual') {
    const modoMap = { 'modo auto': 'auto', 'modo parcial': 'partial', 'modo manual': 'manual' };
    const modo    = modoMap[lower];
    await supabase.from('users').update({ modo_automatizacion: modo })
      .eq('id', process.env.NEXUS_USER_ID);
    await sendWhatsAppMessage(OWNER_WA_ID, `✅ Modo cambiado a *${modo}*`);
    return true;
  }

  // Comando: estado
  if (lower === 'estado') {
    const { runHealthCheck } = require('./healthCheck');
    const status = await runHealthCheck();
    const msg = Object.entries(status)
      .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join('\n');
    await sendWhatsAppMessage(OWNER_WA_ID, `*Estado de NEXUS:*\n${msg}`);
    return true;
  }

  // Comando: ayuda
  if (lower === 'ayuda') {
    await sendWhatsAppMessage(OWNER_WA_ID, HELP_TEXT);
    return true;
  }

  // Confirmación de acción pendiente
  if (lower === 'sí' || lower === 'si') {
    await resolvePendingAction('confirmar');
    return true;
  }

  if (lower === 'enviar' || lower === 'ok') {
    await resolvePendingAction('enviar');
    return true;
  }

  if (lower === 'ignorar' || lower === 'no') {
    await resolvePendingAction('ignorar');
    return true;
  }

  if (lower.startsWith('editar ')) {
    const nuevoTexto = texto.slice(7).trim();
    await resolvePendingAction('editar', nuevoTexto);
    return true;
  }

  return false;
}

async function resolvePendingAction(accion, payload) {
  const { data: pending } = await supabase.from('pending_actions')
    .select('*').eq('resuelto', false)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();

  if (!pending) {
    await sendWhatsAppMessage(OWNER_WA_ID, 'No hay acciones pendientes.');
    return;
  }

  if (pending.tipo === 'crear_evento') {
    if (accion === 'confirmar') {
      await createCalendarEventSafe({
        userId:    process.env.NEXUS_USER_ID,
        contactId: pending.contact_id,
        titulo:    pending.payload.titulo,
        fechaHora: pending.payload.fechaHora,
      });
      await sendWhatsAppMessage(OWNER_WA_ID, '✅ Evento creado en Google Calendar.');
    } else {
      await sendWhatsAppMessage(OWNER_WA_ID, '👍 Acción descartada.');
    }
  }

  if (pending.tipo === 'enviar_respuesta') {
    if (accion === 'enviar') {
      await sendWhatsAppMessage(pending.payload.waId, pending.payload.mensaje);
      await sendWhatsAppMessage(OWNER_WA_ID, '✅ Mensaje enviado.');
    } else if (accion === 'editar' && payload) {
      await sendWhatsAppMessage(pending.payload.waId, payload);
      await sendWhatsAppMessage(OWNER_WA_ID, '✅ Mensaje editado y enviado.');
    } else {
      await sendWhatsAppMessage(OWNER_WA_ID, '👍 Mensaje descartado.');
    }
  }

  await supabase.from('pending_actions').update({ resuelto: true }).eq('id', pending.id);
}

const HELP_TEXT = `*Comandos NEXUS Starter:*

📋 *Información*
• resumen [nombre] — resumen del contacto
• audio [nombre] — resumen en audio
• ver notas [nombre] — ver notas y etiquetas
• pendientes — seguimientos activos

✏️ *Gestión*
• nota [nombre]: [texto] — agregar nota
• etiqueta [nombre]: [tag] — agregar etiqueta
• quitar etiqueta [nombre]: [tag] — eliminar etiqueta
• retomar [nombre] — mensaje de reapertura

⚙️ *Configuración*
• modo auto/parcial/manual — modo de automatización
• estado — verificar conexiones

📊 *Reportes*
• reporte — reporte semanal (ahora)
• exportar contactos — CSV de contactos

✅ *Confirmaciones*
• SÍ / SI — confirmar acción
• ENVIAR / OK — enviar sugerencia
• IGNORAR / NO — descartar
• EDITAR [texto] — editar y enviar`;

module.exports = {
  processMessage,
  processTextMessage,
};
