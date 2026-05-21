'use strict';

const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ELEVENLABS_API  = 'https://api.elevenlabs.io/v1';
const VOICE_ID        = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const AUDIO_BUCKET    = 'nexus-audios';

/**
 * Convierte texto a audio MP3 usando ElevenLabs API.
 * Retorna el buffer del audio.
 */
async function textToSpeech(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      Accept:         'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id:         'eleven_multilingual_v2',
      voice_settings:   {
        stability:         0.5,
        similarity_boost:  0.75,
        style:             0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[audio] ElevenLabs error ${res.status}: ${err}`);
  }

  return res.buffer();
}

/**
 * Sube un buffer de audio a Supabase Storage y retorna la URL firmada (privada).
 * @param {Buffer} audioBuffer
 * @param {string} filename  nombre del archivo sin extensión
 * @returns {string} URL pública temporal del audio
 */
async function uploadAudioToStorage(audioBuffer, filename) {
  const path = `${filename}_${Date.now()}.mp3`;

  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(path, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert:      false,
    });

  if (error) throw new Error(`[audio] Upload error: ${error.message}`);

  // URL con expiración de 1 hora para enviar por WhatsApp
  const { data, error: signErr } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(path, 3600);

  if (signErr) throw new Error(`[audio] Signed URL error: ${signErr.message}`);

  return { url: data.signedUrl, storagePath: path };
}

/**
 * Calcula la duración aproximada de un texto narrado (segundos).
 * Asume ~140 palabras por minuto para una voz normal.
 */
function estimateDuration(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil((words / 140) * 60);
}

/**
 * Genera audio desde un guión de texto y lo sube a Supabase Storage.
 * Retorna la URL del audio y la duración estimada.
 */
async function generateAndUploadAudio(script, filename) {
  const audioBuffer = await textToSpeech(script);
  const { url, storagePath } = await uploadAudioToStorage(audioBuffer, filename);
  const duracion = estimateDuration(script);
  return { url, storagePath, duracion };
}

module.exports = {
  textToSpeech,
  uploadAudioToStorage,
  generateAndUploadAudio,
  estimateDuration,
};
