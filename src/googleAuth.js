'use strict';

const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function getCalendarOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getCalendarAuthUrl() {
  const oauth2 = getCalendarOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
}

async function handleCalendarCallback(req, res) {
  const code   = req.query.code;
  const userId = process.env.NEXUS_USER_ID;

  if (!code) return res.status(400).send('Missing code');

  try {
    const oauth2 = getCalendarOAuth2Client();
    const { tokens } = await oauth2.getToken(code);

    await supabase.from('users').update({
      gcal_access_token:  tokens.access_token,
      gcal_refresh_token: tokens.refresh_token,
      gcal_token_expiry:  tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      gcal_connected:     true,
    }).eq('id', userId);

    res.send('<h1>Google Calendar conectado correctamente. Podés cerrar esta ventana.</h1>');
  } catch (err) {
    console.error('[googleAuth] Calendar callback error:', err.message);
    res.status(500).send('Error conectando Google Calendar');
  }
}

/**
 * Retorna un cliente de Google Calendar autenticado, con auto-renovación de token.
 */
async function getAuthenticatedCalendarClient(userId) {
  const uid = userId || process.env.NEXUS_USER_ID;
  const { data: user } = await supabase.from('users').select('*').eq('id', uid).single();

  if (!user || !user.gcal_refresh_token) {
    throw new Error('Google Calendar no está conectado. Visitá /api/calendar/auth para conectar.');
  }

  const oauth2 = getCalendarOAuth2Client();
  oauth2.setCredentials({
    access_token:  user.gcal_access_token,
    refresh_token: user.gcal_refresh_token,
    expiry_date:   user.gcal_token_expiry ? new Date(user.gcal_token_expiry).getTime() : null,
  });

  // Auto-renovar si vence en menos de 5 minutos
  const expiryMs  = user.gcal_token_expiry ? new Date(user.gcal_token_expiry).getTime() : 0;
  const fiveMinMs = 5 * 60 * 1000;
  if (expiryMs && Date.now() > expiryMs - fiveMinMs) {
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);

    await supabase.from('users').update({
      gcal_access_token: credentials.access_token,
      gcal_token_expiry: credentials.expiry_date
        ? new Date(credentials.expiry_date).toISOString() : null,
    }).eq('id', uid);
  }

  return google.calendar({ version: 'v3', auth: oauth2 });
}

module.exports = {
  getCalendarAuthUrl,
  handleCalendarCallback,
  getAuthenticatedCalendarClient,
};
