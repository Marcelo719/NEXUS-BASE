'use strict';

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Gmail OAuth ──────────────────────────────────────────────────────────────

function getGmailOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

function getGmailAuthUrl() {
  const oauth2 = getGmailOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
  });
}

async function handleGmailCallback(req, res) {
  const code   = req.query.code;
  const userId = process.env.NEXUS_USER_ID;

  if (!code) return res.status(400).send('Missing code');

  try {
    const oauth2 = getGmailOAuth2Client();
    const { tokens } = await oauth2.getToken(code);

    // Obtener email del usuario
    oauth2.setCredentials(tokens);
    const gmail    = google.gmail({ version: 'v1', auth: oauth2 });
    const profile  = await gmail.users.getProfile({ userId: 'me' });
    const email    = profile.data.emailAddress;

    await supabase.from('email_accounts').upsert({
      user_id:       userId,
      tipo:          'gmail',
      email,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry:  tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      activa:        true,
    }, { onConflict: 'user_id,email' });

    await supabase.from('users').update({
      gmail_connected:    true,
      gmail_email:        email,
      gmail_access_token: tokens.access_token,
      gmail_refresh_token: tokens.refresh_token,
      gmail_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    }).eq('id', userId);

    res.send('<h1>Gmail conectado correctamente. Podés cerrar esta ventana.</h1>');
  } catch (err) {
    console.error('[emailAuth] Gmail callback error:', err.message);
    res.status(500).send('Error conectando Gmail');
  }
}

/**
 * Retorna un cliente Gmail autenticado, renovando el token si está vencido.
 */
async function getAuthenticatedGmailClient(accountId) {
  const { data: account } = await supabase.from('email_accounts')
    .select('*').eq('id', accountId).single();

  if (!account) throw new Error(`Email account ${accountId} not found`);

  const oauth2 = getGmailOAuth2Client();
  oauth2.setCredentials({
    access_token:  account.access_token,
    refresh_token: account.refresh_token,
    expiry_date:   account.token_expiry ? new Date(account.token_expiry).getTime() : null,
  });

  // Auto-renovación si el token vence en menos de 5 minutos
  const expiryMs   = account.token_expiry ? new Date(account.token_expiry).getTime() : 0;
  const fiveMinMs  = 5 * 60 * 1000;
  if (expiryMs && Date.now() > expiryMs - fiveMinMs) {
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);

    await supabase.from('email_accounts').update({
      access_token: credentials.access_token,
      token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
    }).eq('id', accountId);
  }

  return google.gmail({ version: 'v1', auth: oauth2 });
}

// ── Outlook OAuth ────────────────────────────────────────────────────────────

const OUTLOOK_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadWrite',
].join(' ');

function getOutlookAuthUrl() {
  const clientId    = process.env.OUTLOOK_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.OUTLOOK_REDIRECT_URI);
  const scopes      = encodeURIComponent(OUTLOOK_SCOPES);
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scopes}&response_mode=query`;
}

async function handleOutlookCallback(req, res) {
  const code   = req.query.code;
  const userId = process.env.NEXUS_USER_ID;

  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        code,
        redirect_uri:  process.env.OUTLOOK_REDIRECT_URI,
        grant_type:    'authorization_code',
        scope:         OUTLOOK_SCOPES,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));

    // Obtener email del usuario
    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    const email   = profile.mail || profile.userPrincipalName;
    const expiry  = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase.from('email_accounts').upsert({
      user_id:       userId,
      tipo:          'outlook',
      email,
      display_name:  profile.displayName,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry:  expiry,
      activa:        true,
    }, { onConflict: 'user_id,email' });

    await supabase.from('users').update({
      outlook_connected:    true,
      outlook_email:        email,
      outlook_access_token: tokens.access_token,
      outlook_refresh_token: tokens.refresh_token,
      outlook_token_expiry: expiry,
    }).eq('id', userId);

    res.send('<h1>Outlook conectado correctamente. Podés cerrar esta ventana.</h1>');
  } catch (err) {
    console.error('[emailAuth] Outlook callback error:', err.message);
    res.status(500).send('Error conectando Outlook');
  }
}

/**
 * Retorna un access token de Outlook válido, renovándolo si es necesario.
 */
async function getOutlookAccessToken(accountId) {
  const { data: account } = await supabase.from('email_accounts')
    .select('*').eq('id', accountId).single();

  if (!account) throw new Error(`Email account ${accountId} not found`);

  const expiryMs  = account.token_expiry ? new Date(account.token_expiry).getTime() : 0;
  const fiveMinMs = 5 * 60 * 1000;

  if (!expiryMs || Date.now() > expiryMs - fiveMinMs) {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type:    'refresh_token',
        scope:         OUTLOOK_SCOPES,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(`Outlook token refresh failed: ${JSON.stringify(tokens)}`);

    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await supabase.from('email_accounts').update({
      access_token: tokens.access_token,
      token_expiry: expiry,
    }).eq('id', accountId);

    return tokens.access_token;
  }

  return account.access_token;
}

module.exports = {
  getGmailAuthUrl,
  handleGmailCallback,
  getAuthenticatedGmailClient,
  getOutlookAuthUrl,
  handleOutlookCallback,
  getOutlookAccessToken,
};
