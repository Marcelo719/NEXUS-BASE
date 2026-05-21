'use strict';

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsAppMessage } = require('./sender');

const supabase    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const EXPORT_BUCKET = 'nexus-exports';

/**
 * Exporta todos los contactos del usuario a un CSV y sube a Supabase Storage.
 * Envía el link de descarga al owner por WhatsApp.
 */
async function exportContacts(ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    await sendWhatsAppMessage(ownerWaId, '📊 Generando exportación de contactos...');

    const { data: contacts, error } = await supabase.from('contacts')
      .select('nombre, plataforma, handle, estado, precio_mencionado, moneda, tags, notas, primer_contacto, ultimo_contacto, dias_sin_respuesta, closing_score, sentiment_actual, total_conversaciones')
      .eq('user_id', userId)
      .order('closing_score', { ascending: false });

    if (error) throw error;

    if (!contacts?.length) {
      await sendWhatsAppMessage(ownerWaId, '⚠️ No hay contactos para exportar.');
      return;
    }

    // Construir CSV
    const headers = [
      'Nombre', 'Plataforma', 'Handle', 'Estado', 'Precio', 'Moneda',
      'Etiquetas', 'Notas', 'Primer contacto', 'Último contacto',
      'Días sin respuesta', 'Score cierre (%)', 'Sentiment', 'Conversaciones',
    ];

    const rows = contacts.map(c => [
      escapeCSV(c.nombre),
      escapeCSV(c.plataforma),
      escapeCSV(c.handle || ''),
      escapeCSV(c.estado || ''),
      c.precio_mencionado || '',
      c.moneda || 'USD',
      escapeCSV((c.tags || []).join(', ')),
      escapeCSV(c.notas || ''),
      formatDate(c.primer_contacto),
      formatDate(c.ultimo_contacto),
      c.dias_sin_respuesta || 0,
      c.closing_score || 0,
      c.sentiment_actual || 'neutro',
      c.total_conversaciones || 0,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.join(',')),
    ].join('\n');

    const csvBuffer = Buffer.from('﻿' + csvContent, 'utf8'); // BOM para Excel
    const filename  = `contactos_${new Date().toISOString().split('T')[0]}.csv`;

    // Subir a Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from(EXPORT_BUCKET)
      .upload(filename, csvBuffer, {
        contentType: 'text/csv;charset=utf-8',
        upsert:      true,
      });

    if (uploadError) throw uploadError;

    const { data: signedData } = await supabase.storage
      .from(EXPORT_BUCKET)
      .createSignedUrl(filename, 86400); // 24 horas

    await sendWhatsAppMessage(ownerWaId,
      `✅ *Exportación lista!*\n📊 ${contacts.length} contactos\n\n🔗 Link de descarga (24hs):\n${signedData.signedUrl}`
    );

  } catch (err) {
    console.error('[export] exportContacts error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error exportando: ${err.message}`);
  }
}

/**
 * Exporta todos los resúmenes de conversaciones a CSV.
 */
async function exportSummaries(ownerWaId) {
  const userId = process.env.NEXUS_USER_ID;

  try {
    const { data: summaries } = await supabase
      .from('summaries')
      .select('*, contacts(nombre, plataforma, estado)')
      .eq('contacts.user_id', userId)
      .order('generado_en', { ascending: false })
      .limit(500);

    if (!summaries?.length) {
      await sendWhatsAppMessage(ownerWaId, '⚠️ No hay resúmenes para exportar.');
      return;
    }

    const headers = ['Contacto', 'Plataforma', 'Estado', 'Tipo', 'Resumen', 'Próximo paso', 'Generado en'];

    const rows = summaries.map(s => [
      escapeCSV(s.contacts?.nombre || ''),
      escapeCSV(s.contacts?.plataforma || ''),
      escapeCSV(s.contacts?.estado || ''),
      escapeCSV(s.tipo),
      escapeCSV(s.resumen_texto || ''),
      escapeCSV(s.proximo_paso || ''),
      formatDate(s.generado_en),
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const csvBuffer  = Buffer.from('﻿' + csvContent, 'utf8');
    const filename   = `resumenes_${new Date().toISOString().split('T')[0]}.csv`;

    await supabase.storage.from(EXPORT_BUCKET).upload(filename, csvBuffer, {
      contentType: 'text/csv;charset=utf-8', upsert: true,
    });

    const { data: signedData } = await supabase.storage.from(EXPORT_BUCKET)
      .createSignedUrl(filename, 86400);

    await sendWhatsAppMessage(ownerWaId,
      `✅ *Resúmenes exportados!*\n${summaries.length} registros\n\n🔗 ${signedData.signedUrl}`
    );

  } catch (err) {
    console.error('[export] exportSummaries error:', err.message);
    await sendWhatsAppMessage(ownerWaId, `❌ Error: ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeCSV(str) {
  if (!str) return '';
  const s = String(str).replace(/"/g, '""');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

module.exports = {
  exportContacts,
  exportSummaries,
};
