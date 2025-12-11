// ===========================================================
// State Manager
// Manejo de estado por usuario (memoria en RAM)
// + caché de teléfono usado recientemente
// ===========================================================

/**
 * Estructura:
 * - userStates: guarda el "modo" y datos de flujo por chatId
 * - phoneCache: guarda el último teléfono usado por chatId (con TTL)
 */

const userStates = new Map();   // chatId -> state object
const phoneCache = new Map();   // chatId -> { phone, ts }

// Tiempo máximo que recordamos el teléfono (en milisegundos)
const PHONE_TTL_MS = 60 * 60 * 1000; // 1 hora

// ===========================================================
// ESTADO GENERAL (para flujos)
// ===========================================================

/**
 * Obtiene el estado actual de un usuario (chatId).
 * Si no existe, devuelve null.
 */
function getUserState(chatId) {
  if (!userStates.has(chatId)) return null;
  return userStates.get(chatId);
}

/**
 * Establece el estado de un usuario.
 * @param {number|string} chatId 
 * @param {object} state 
 */
function setUserState(chatId, state) {
  if (!state || typeof state !== 'object') {
    userStates.delete(chatId);
    return;
  }
  userStates.set(chatId, { ...state });
}

/**
 * Limpia el estado de un usuario.
 * @param {number|string} chatId 
 */
function clearUserState(chatId) {
  userStates.delete(chatId);
}

// ===========================================================
// CACHÉ DE TELÉFONO
// ===========================================================

/**
 * Guarda un teléfono en caché para un chatId,
 * para poder preguntar "¿Desea usar el número anterior?".
 * @param {number|string} chatId 
 * @param {string} phone 
 */
function setCachedPhone(chatId, phone) {
  if (!phone) return;
  phoneCache.set(chatId, {
    phone: String(phone).trim(),
    ts: Date.now()
  });
}

/**
 * Obtiene el teléfono en caché si no está vencido.
 * @param {number|string} chatId 
 * @returns {string|null}
 */
function getCachedPhone(chatId) {
  const entry = phoneCache.get(chatId);
  if (!entry) return null;

  const age = Date.now() - entry.ts;
  if (age > PHONE_TTL_MS) {
    phoneCache.delete(chatId);
    return null;
  }
  return entry.phone;
}

/**
 * Elimina el teléfono en caché de un usuario.
 * @param {number|string} chatId 
 */
function clearCachedPhone(chatId) {
  phoneCache.delete(chatId);
}

/**
 * Limpia toda la caché de teléfonos y estados (por si se necesita).
 */
function clearAllState() {
  userStates.clear();
  phoneCache.clear();
}

// ===========================================================
// EXPORTS
// ===========================================================

module.exports = {
  getUserState,
  setUserState,
  clearUserState,
  setCachedPhone,
  getCachedPhone,
  clearCachedPhone,
  clearAllState,
  PHONE_TTL_MS
};