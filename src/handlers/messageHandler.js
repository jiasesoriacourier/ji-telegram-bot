// ===========================================================
// HANDLER DE MENSAJES
// ===========================================================

const {
  getUserState,
  setUserState,
  clearUserState,
  getCachedPhone
} = require("../state/stateManager");

const { 
  sendMainMenu, 
  MAIN_MENU_TEXT 
} = require("../ui/mainMenu");


// ===========================================================
// Detalles
// Este handler decide qué hacer cuando el usuario escribe texto,
// sin importar si viene de un comando o un menú.
// ===========================================================


module.exports = async function handleMessage(bot, msg) {
  try {
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId);

    // Ignorar mensajes que son comandos, ellos se manejan aparte.
    if (text.startsWith('/')) return;

    // -------------------------------------------------------
    // 1) SI NO EXISTE ESTADO → MOSTRAR MENÚ PROFESIONAL
    // -------------------------------------------------------
    if (!state) {
      await bot.sendMessage(
        chatId,
        `¡Hola! 👋\nBienvenido a *J.I Asesoría & Courier*.\n\nSeleccioná una opción del menú para continuar.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📋 Ver menú principal", callback_data: "MENU_MAIN" }]
            ]
          }
        }
      );
      return;
    }

    // -------------------------------------------------------
    // 2) EXISTE ESTADO → RUTAS SEGÚN state.modo
    // -------------------------------------------------------

    switch (state.modo) {

      // -----------------------------------------------------
      // A) Flujo: crear casillero → pedir nombre
      // -----------------------------------------------------
      case "CREAR_NOMBRE": {
        if (text.length < 5 || !text.includes(" ")) {
          return bot.sendMessage(
            chatId,
            "Por favor ingresá tu *nombre completo* (mínimo un nombre y un apellido).",
            { parse_mode: "Markdown" }
          );
        }

        state.nombre = text;
        state.modo = "CREAR_TELEFONO";
        setUserState(chatId, state);

        return bot.sendMessage(
          chatId,
          "Perfecto. Ahora ingresá tu *teléfono* (solo números).",
          { parse_mode: "Markdown" }
        );
      }

      case "CREAR_TELEFONO": {
        if (!/^\d{8}$/.test(text)) {
          return bot.sendMessage(chatId, "Número inválido. Debe tener 8 dígitos.");
        }

        state.telefono = text;
        state.modo = "CREAR_CORREO";
        setUserState(chatId, state);

        return bot.sendMessage(
          chatId,
          "Excelente. Ahora escribí tu *correo electrónico*:",
          { parse_mode: "Markdown" }
        );
      }

      case "CREAR_CORREO": {
        if (!text.includes("@") || !text.includes(".")) {
          return bot.sendMessage(chatId, "Correo inválido. Intentá nuevamente.");
        }

        state.correo = text;
        state.modo = "CREAR_CONFIRMAR";
        setUserState(chatId, state);

        return bot.sendMessage(chatId,
          `Revisá que tus datos estén correctos:\n\n` +
          `👤 Nombre: *${state.nombre}*\n` +
          `📱 Teléfono: *${state.telefono}*\n` +
          `📧 Correo: *${state.correo}*\n\n` +
          `¿Confirmás?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Sí, crear casillero", callback_data: "CREAR_CASILLERO_OK" }],
                [{ text: "Cancelar", callback_data: "CANCELAR" }]
              ]
            }
          }
        );
      }

      // -----------------------------------------------------
      // B) Flujo: prealerta → pedir tracking
      // -----------------------------------------------------
      case "PREALERTA_TRACKING": {
        if (text.length < 5) {
          return bot.sendMessage(chatId, "Tracking inválido. Ingresá uno válido.");
        }

        state.tracking = text;
        state.modo = "PREALERTA_DESC";
        setUserState(chatId, state);

        return bot.sendMessage(
          chatId,
          "Perfecto. Escribí una *descripción* del paquete:",
          { parse_mode: "Markdown" }
        );
      }

      case "PREALERTA_DESC": {
        state.descripcion = text;
        state.modo = "PREALERTA_CONFIRM";
        setUserState(chatId, state);

        return bot.sendMessage(
          chatId,
          `Vamos a registrar esta prealerta:\n` +
          `📦 Tracking: *${state.tracking}*\n` +
          `📝 Descripción: *${state.descripcion}*\n\n` +
          `¿Confirmás?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Confirmar", callback_data: "PREALERTA_OK" }],
                [{ text: "Cancelar", callback_data: "CANCELAR" }]
              ]
            }
          }
        );
      }

      // -----------------------------------------------------
      // C) Flujo de cotización (parte inicial)
      // -----------------------------------------------------
      case "COTIZAR_PHONE": {
        if (!/^\d{8}$/.test(text)) {
          return bot.sendMessage(chatId, "El teléfono debe tener 8 dígitos.");
        }

        state.telefono = text;
        state.modo = "COTIZAR_ORIGEN";
        setUserState(chatId, state);

        return bot.sendMessage(
          chatId,
          "Seleccioná el *país de origen* del paquete:",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🇺🇸 Miami", callback_data: "COTIZAR_ORIGEN|Miami" }],
                [{ text: "🇨🇴 Colombia", callback_data: "COTIZAR_ORIGEN|Colombia" }],
                [{ text: "🇨🇳 China", callback_data: "COTIZAR_ORIGEN|China" }],
                [{ text: "🇪🇸 España", callback_data: "COTIZAR_ORIGEN|España" }]
              ]
            }
          }
        );
      }

      // -----------------------------------------------------
      // D) Si el flujo está incompleto, pero existe estado:
      // simplemente pedir que use el menú
      // -----------------------------------------------------
      default:
        return bot.sendMessage(
          chatId,
          "Por favor continuá usando las opciones del menú:",
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Volver al menú", callback_data: "MENU_MAIN" }]
              ]
            }
          }
        );
    }

  } catch (err) {
    console.error("Error en messageHandler:", err);
  }
};