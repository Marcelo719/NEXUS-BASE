'use strict';

/**
 * Determina si las acciones automáticas pueden ejecutarse sin confirmación.
 * - auto    → sí
 * - partial → no (requiere confirmación del owner)
 * - manual  → no
 */
function canAutoRun(modo) {
  return modo === 'auto';
}

/**
 * Determina si el owner debe ser notificado para aprobar una acción.
 */
function requiresApproval(modo) {
  return modo === 'partial';
}

/**
 * Determina si ninguna acción automática debe ejecutarse.
 */
function isManual(modo) {
  return modo === 'manual';
}

/**
 * Devuelve el texto amigable del modo actual.
 */
function formatModoText(modo) {
  const map = {
    auto:    '🤖 Auto — NEXUS actúa automáticamente',
    partial: '🔔 Parcial — NEXUS te consulta antes de actuar',
    manual:  '✋ Manual — Solo informo, vos decidís todo',
  };
  return map[modo] || modo;
}

module.exports = {
  canAutoRun,
  requiresApproval,
  isManual,
  formatModoText,
};
