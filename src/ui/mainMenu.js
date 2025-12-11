// ===========================================================
// UI - MAIN MENU
// Menú profesional con inline keyboard
// ===========================================================

// Texto del menú principal
const MAIN_MENU_TEXT =
`📋 *Menú principal – J.I Asesoría & Courier*

Elegí la opción que necesitás:`.trim();

// Teclado inline profesional
function buildMainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "📦 Cotizar Envío",        callback_data: "MENU_COTIZAR" },
        { text: "🏷️ Prealertar Paquete",  callback_data: "MENU_PREALERTA" }
      ],
      [
        { text: "🔍 Consulta de Tracking", callback_data: "MENU_TRACKING" }
      ],
      [
        { text: "📬 Mi Casillero",        callback_data: "MENU_CASILLERO" },
        { text: "➕ Crear Casillero",     callback_data: "MENU_CREAR_CASILLERO" }
      ],
      [
        { text: "💳 Ver Saldo",           callback_data: "MENU_SALDO" }
      ],
      [
        { text: "ℹ️ Ayuda",               callback_data: "MENU_HELP" }
      ]
    ]
  };
}

// Enviar menú principal
async function sendMainMenu(bot, chatId) {
  return bot.sendMessage(chatId, MAIN_MENU_TEXT, {
    parse_mode: 'Markdown',
    reply_markup: buildMainMenu()
  });
}

// Volver al menú desde un callback
async function editToMainMenu(bot, query) {
  return bot.editMessageText(MAIN_MENU_TEXT, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: buildMainMenu()
  });
}

module.exports = {
  MAIN_MENU_TEXT,
  buildMainMenu,
  sendMainMenu,
  editToMainMenu
};