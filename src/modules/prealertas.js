// ===========================================================
// MÓDULO: PREALERTAS (FLUJO REAL CON HOJA "Datos")
// ===========================================================

const { getSheet, appendRow, updateRow } = require("../services/sheetsService");
const { clearUserState } = require("../state/stateManager");
const { sendMainMenu } = require("../ui/mainMenu");

// ===========================================================
// REGISTRAR PREALERTA SEGÚN TU ESTRUCTURA REAL
// ===========================================================
// Hoja "Datos":
// A Tracking
// B Cliente (nombre del cliente, NO número)
// C Comentarios internos
// D Origen
// E Estado
// F Peso
// G Monto
// H Fecha prealerta
// I Comentarios del cliente (tipo de mercancía)
// ===========================================================

async function registrarPrealerta(bot, chatId, state) {
  try {
    const { telefono, tracking, origen, peso, unidadPeso, descripcion } = state;

    if (!telefono || !tracking || !origen || !descripcion) {
      await bot.sendMessage(
        chatId,
        "⚠️ Faltan datos para registrar la prealerta.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ============================
    // VALIDAR NOMBRE DEL CLIENTE
    // ============================
    const clientes = await getSheet("Clientes");
    const clienteRow = clientes.find(r => r[1] === telefono);

    if (!clienteRow) {
      await bot.sendMessage(
        chatId,
        "❌ No encontramos un cliente con ese número.\nDebés crear un casillero antes de prealertar.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "➕ Crear casillero", callback_data: "MENU_CREAR_CASILLERO" }],
              [{ text: "📋 Volver al menú", callback_data: "MENU_MAIN" }]
            ]
          }
        }
      );
      return;
    }

    const nombreCliente = clienteRow[0]; // Columna A de Clientes

    // ============================
    // PREPARAR FECHA
    // ============================
    const fecha = new Date().toLocaleString("es-CR", {
      timeZone: "America/Costa_Rica"
    });

    // ============================
    // LEER HOJA DATOS
    // ============================
    const datos = await getSheet("Datos") || [];
    const trackingUpper = tracking.trim().toUpperCase();

    let index = -1;

    for (let i = 1; i < datos.length; i++) {
      const row = datos[i];
      if (!row) continue;

      const rowTracking = (row[0] || "").toString().trim().toUpperCase();

      if (rowTracking === trackingUpper) {
        index = i;
        break;
      }
    }

    // ============================
    // SI YA EXISTE → ACTUALIZAR
    // ============================
    if (index !== -1) {
      const row = datos[index];
      const newRow = [...row];

      newRow[1] = nombreCliente;          // Cliente
      newRow[3] = origen;                 // Origen
      newRow[4] = "Prealertado";          // Estado
      newRow[7] = fecha;                  // Fecha prealerta

      // Peso si lo dio el cliente
      if (peso) {
        newRow[5] = `${peso} ${unidadPeso || ""}`;
      }

      // Comentarios del cliente
      const prev = row[8] || "";
      newRow[8] = prev ? `${prev} | ${descripcion}` : descripcion;

      await updateRow("Datos", index, newRow);

    } else {
      // ============================
      // SI NO EXISTE → AGREGAR NUEVA FILA
      // ============================
      const newRow = [
        trackingUpper,                    // A Tracking
        nombreCliente,                    // B Cliente
        "",                               // C Comentarios internos
        origen,                           // D Origen
        "Prealertado",                    // E Estado
        peso ? `${peso} ${unidadPeso}` : "", // F Peso
        "",                               // G Monto
        fecha,                            // H Fecha prealerta
        descripcion                       // I Comentarios del cliente
      ];

      await appendRow("Datos", newRow);
    }

    // ============================
    // MENSAJE PREMIUM AL CLIENTE
    // ============================
    await bot.sendMessage(
      chatId,
      `✅ *Prealerta registrada correctamente*\n\n` +
      `📦 *Tracking:* ${trackingUpper}\n` +
      `👤 *Cliente:* ${nombreCliente}\n` +
      `🌍 *Origen:* ${origen}\n` +
      (peso ? `⚖️ *Peso:* ${peso} ${unidadPeso}\n` : "") +
      `📝 *Descripción:* ${descripcion}\n` +
      `📅 *Fecha:* ${fecha}\n\n` +
      `El estado de tu paquete ahora es *Prealertado*. Te avisaremos cuando avance el proceso.`,
      { parse_mode: "Markdown" }
    );

    clearUserState(chatId);
    return sendMainMenu(bot, chatId);

  } catch (err) {
    console.error("Error en registrarPrealerta REAL:", err);
    await bot.sendMessage(
      chatId,
      "⚠️ Hubo un error inesperado al registrar la prealerta.",
      { parse_mode: "Markdown" }
    );
  }
}

module.exports = {
  registrarPrealerta
};