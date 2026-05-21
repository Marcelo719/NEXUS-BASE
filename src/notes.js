'use strict';

const { createClient }   = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Agrega una nota manual al perfil de un contacto.
 */
async function addNote(nombreContacto, nota, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const contact = await findContact(userId, nombreContacto);
    if (!contact) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré a "${nombreContacto}".`);
      return;
    }

    // Concatenar nota con timestamp
    const timestamp  = new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
    const notaActual = contact.notas || '';
    const nuevaNota  = notaActual
      ? `${notaActual}\n[${timestamp}] ${nota}`
      : `[${timestamp}] ${nota}`;

    await supabase.from('contacts').update({ notas: nuevaNota }).eq('id', contact.id);

    await sendWhatsAppMessage(ownerWaId, `✅ Nota agregada a *${contact.nombre}*:\n"${nota}"`);
  } catch (err) {
    console.error('[notes] addNote error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error al guardar nota: ${err.message}`);
  }
}

/**
 * Agrega una etiqueta (tag) al contacto.
 */
async function addTag(nombreContacto, tag, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const contact = await findContact(userId, nombreContacto);
    if (!contact) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré a "${nombreContacto}".`);
      return;
    }

    const tagLower = tag.toLowerCase().trim();
    const tagsAct  = contact.tags || [];

    if (tagsAct.includes(tagLower)) {
      await sendWhatsAppMessage(ownerWaId, `⚠️ *${contact.nombre}* ya tiene la etiqueta "${tagLower}".`);
      return;
    }

    await supabase.from('contacts').update({ tags: [...tagsAct, tagLower] }).eq('id', contact.id);
    await sendWhatsAppMessage(ownerWaId, `✅ Etiqueta "*${tagLower}*" agregada a *${contact.nombre}*.`);
  } catch (err) {
    console.error('[notes] addTag error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error al agregar etiqueta: ${err.message}`);
  }
}

/**
 * Elimina una etiqueta del contacto.
 */
async function removeTag(nombreContacto, tag, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const contact = await findContact(userId, nombreContacto);
    if (!contact) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré a "${nombreContacto}".`);
      return;
    }

    const tagLower  = tag.toLowerCase().trim();
    const tagsAct   = (contact.tags || []).filter(t => t !== tagLower);

    await supabase.from('contacts').update({ tags: tagsAct }).eq('id', contact.id);
    await sendWhatsAppMessage(ownerWaId, `✅ Etiqueta "*${tagLower}*" eliminada de *${contact.nombre}*.`);
  } catch (err) {
    console.error('[notes] removeTag error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error al eliminar etiqueta: ${err.message}`);
  }
}

/**
 * Muestra las notas y etiquetas de un contacto.
 */
async function viewNotes(nombreContacto, ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const contact = await findContact(userId, nombreContacto);
    if (!contact) {
      await sendWhatsAppMessage(ownerWaId, `❌ No encontré a "${nombreContacto}".`);
      return;
    }

    let msg = `📝 *Notas de ${contact.nombre}* (${contact.plataforma})\n`;
    msg += `Estado: ${contact.estado || 'sin_clasificar'}\n`;

    if (contact.tags?.length) {
      msg += `🏷️ Etiquetas: ${contact.tags.map(t => `#${t}`).join(' ')}\n`;
    } else {
      msg += '🏷️ Sin etiquetas\n';
    }

    if (contact.notas) {
      msg += `\n📋 *Notas:*\n${contact.notas}`;
    } else {
      msg += '\nSin notas.';
    }

    await sendWhatsAppMessage(ownerWaId, msg);
  } catch (err) {
    console.error('[notes] viewNotes error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error: ${err.message}`);
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function findContact(userId, nombre) {
  const { data } = await supabase.from('contacts')
    .select('*').eq('user_id', userId)
    .ilike('nombre', `%${nombre}%`)
    .order('ultimo_contacto', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

module.exports = {
  addNote,
  addTag,
  removeTag,
  viewNotes,
};
