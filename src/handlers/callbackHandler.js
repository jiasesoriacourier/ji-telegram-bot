// ===========================================================
// HANDLER DE CALLBACKS (BOTONES INLINE)
// ===========================================================

const {
  getUserState,
  setUserState,
  clearUserState,
  getCachedPhone
} = require("../state/stateManager");

const {
  MAIN_MENU_TEXT,
  buildMainMenu,
  editToMainMenu,
  sendMainMenu
} = require("../ui/mainMenu");


// ===========================================================
// CALLBACK ROUTER
// ===========================================================

module.exports = async function handleCallback(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data || "";

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ===========================
  // BOTÓN: VOLVER AL MENÚ
  // ===========================
  if (data === "MENU_MAIN") {
    clearUserState(chatId);
    return editToMainMenu(bot, query);
  }

  // ===========================
  // MENÚ PRINCIPAL → Opciones
  // ===========================
  if (data === "MENU_COTIZAR") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "COTIZAR_PHONE" });

    return bot.editMessageText(
      "Ingresá tu *teléfono* para iniciar la cotización (8 dígitos):",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "MENU_PREALERTA") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "PREALERTA_TRACKING" });

    return bot.editMessageText(
      "Escribí el *tracking* que vamos a prealertar:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "MENU_TRACKING") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "TRACK_PHONE" });

    return bot.editMessageText(
      "Escribí tu *número de teléfono* para mostrar tus paquetes:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "MENU_CASILLERO") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "CASILLERO_PHONE" });

    return bot.editMessageText(
      "Ingresá tu *número de teléfono* para mostrar tu casillero:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "MENU_CREAR_CASILLERO") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "CREAR_NOMBRE" });

    return bot.editMessageText(
      "Vamos a crear tu casillero. Escribí tu *nombre completo*:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "MENU_SALDO") {
    clearUserState(chatId);
    setUserState(chatId, { modo: "SALDO_PHONE" });

    return bot.editMessageText(
      "Ingresá tu *número de teléfono* para revisar tu saldo:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  // ===========================
  // BOTÓN: AYUDA
  // ===========================
  if (data === "MENU_HELP") {
    return bot.editMessageText(
`ℹ️ *Centro de Ayuda – J.I Asesoría & Courier*

📦 *Cotizar Envío*: Calculamos el costo según origen, peso y tipo de mercancía.
🏷️ *Prealertar Paquete*: Registrás tu tracking en nuestro sistema.
🔍 *Consulta de Tracking*: Revisás el estado de tus paquetes.
📬 *Mi Casillero*: Te mostramos las direcciones según país.
➕ *Crear Casillero*: Registrás tus datos para generar uno nuevo.
💳 *Ver Saldo*: Consultás montos pendientes o pagos.

¿Necesitás algo más? Estamos para servirte. 😊`,
      {
        parse_mode: "Markdown",
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Volver al menú", callback_data: "MENU_MAIN" }]
          ]
        }
      }
    );
  }

  // ==========================================================
  // MANEJAR FLUJOS ESPECÍFICOS
  // (Los módulos concretos se implementarán en partes 6+)
  // ==========================================================

  // ----------------------------------------------------------
  // Confirmar creación de casillero
  // ----------------------------------------------------------
  if (data === "CREAR_CASILLERO_OK") {
    const st = getUserState(chatId);
    if (!st || !st.nombre || !st.telefono || !st.correo) {
      return bot.answerCallbackQuery("Faltan datos.");
    }

    // SE IMPLEMENTARÁ EN PARTE 7 (módulo casilleros)
    return bot.editMessageText(
      "Procesando tu casillero... (esta sección se completará en Parte 7)",
      {
        chat_id: chatId,
        message_id: query.message.message_id
      }
    );
  }

  // ----------------------------------------------------------
  // Confirmar PREALERTA
  // ----------------------------------------------------------
  if (data === "PREALERTA_OK") {
    const st = getUserState(chatId);
    if (!st || !st.tracking || !st.descripcion) {
      return bot.answerCallbackQuery("Faltan datos.");
    }

    // SE IMPLEMENTARÁ EN PARTE 8 (módulo prealertas)
    return bot.editMessageText(
      "Registrando la prealerta... (esta sección se completará en Parte 8)",
      {
        chat_id: chatId,
        message_id: query.message.message_id
      }
    );
  }

  // ----------------------------------------------------------
  // Cancelar cualquier flujo
  // ----------------------------------------------------------
  if (data === "CANCELAR") {
    clearUserState(chatId);
    return bot.editMessageText(
      "Operación cancelada. ¿Qué deseas hacer ahora?",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: buildMainMenu()
      }
    );
  }

  // ----------------------------------------------------------
  // Origen de cotización
  // ----------------------------------------------------------
  if (data.startsWith("COTIZAR_ORIGEN")) {
    const [, origen] = data.split("|");
    const st = getUserState(chatId);
    st.origen = origen;
    st.modo = "COTIZAR_DESCRIPCION";
    setUserState(chatId, st);

    return bot.editMessageText(
      `Perfecto. Escribí una *descripción* del artículo que vas a cotizar.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // Futuras ramificaciones (categoría, peso, confirmación)
  // Se implementarán en la Parte 10 (cotización premium)
  // ----------------------------------------------------------

  return; // default
};