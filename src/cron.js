'use strict';

const cron = require('node-cron');

const { processRetryQueue }   = require('./retryQueue');
const { fetchAllGmailAccounts, fetchAllOutlookAccounts } = require('./email');
const { sendEventReminders, sendMorningBriefing }        = require('./reminders');
const { checkFollowUps }      = require('./followup');
const { generateWeeklyReport } = require('./weeklyReport');
const { resetDailyCostPause }  = require('./costGuard');

const TZ = 'America/Argentina/Buenos_Aires';

// ── Cola de reintentos — cada 5 minutos ─────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  processRetryQueue().catch(err => console.error('[cron] retryQueue error:', err.message));
});

// ── Polling de emails Gmail — cada 2 minutos ─────────────────────────────────
cron.schedule('*/2 * * * *', () => {
  fetchAllGmailAccounts().catch(err => console.error('[cron] gmail poll error:', err.message));
});

// ── Polling de emails Outlook — cada 2 minutos ───────────────────────────────
cron.schedule('*/2 * * * *', () => {
  fetchAllOutlookAccounts().catch(err => console.error('[cron] outlook poll error:', err.message));
});

// ── Recordatorios de eventos — cada 30 minutos ──────────────────────────────
cron.schedule('*/30 * * * *', () => {
  sendEventReminders().catch(err => console.error('[cron] reminders error:', err.message));
});

// ── Briefing matutino — 8 AM lun-vie ────────────────────────────────────────
cron.schedule('0 8 * * 1-5', () => {
  sendMorningBriefing().catch(err => console.error('[cron] briefing error:', err.message));
}, { timezone: TZ });

// ── Seguimiento automático — 9 AM lun-sáb ──────────────────────────────────
cron.schedule('0 9 * * 1-6', () => {
  checkFollowUps().catch(err => console.error('[cron] followup error:', err.message));
}, { timezone: TZ });

// ── Reporte semanal — domingos 18hs ─────────────────────────────────────────
cron.schedule('0 18 * * 0', () => {
  generateWeeklyReport(false).catch(err => console.error('[cron] weeklyReport error:', err.message));
}, { timezone: TZ });

// ── Reset de costos — medianoche ─────────────────────────────────────────────
cron.schedule('0 0 * * *', () => {
  resetDailyCostPause().catch(err => console.error('[cron] costReset error:', err.message));
}, { timezone: TZ });

console.log('[cron] Todos los cron jobs inicializados.');
