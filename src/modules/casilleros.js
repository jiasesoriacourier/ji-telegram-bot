// ===========================================================
// MÓDULO: REGISTRO DE CASILLEROS
// ===========================================================

const { getSheet, appendRow } = require("../services/sheetsService");
const { validarCodigoEmpresa, generarReferenciaEmpresa } = require("./empresas");
const { clearUserState } = require("../state/stateManager");
const { sendMainMenu } = require("../ui/mainMenu");

// ===========================================================
// Crear casillero en la hoja "Clientes"
// ===========================================================

async function crearCasillero(bot, chatId, state) {
  try {
    const { nombre, telefono, correo, empresaCodigo } = state;

    // Validar que no exista ya el casillero por teléfono
    const sheet = await getSheet("Clientes");
    let existe = false;

    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      if (!row) continue;

      const telExistente = (row[1] || "").trim();
      if (telExistente === telefono) {
        existe = true;
        break;
      }
    }

    if (existe) {
      await bot.sendMessage(
        chatId,
        "⚠️ *Este teléfono ya tiene un casillero registrado.*\n" +
        "Si necesitás asistencia, escribinos por WhatsApp.",
        { parse_mode: "Markdown" }
      );
      clearUserState(chatId);
      return sendMainMenu(bot, chatId);
    }

    // Validar empresa (si el cliente ingresó código)
    let referenciaEmpresa = "";
    if (empresaCodigo && empresaCodigo !== "NO") {
      const empresa = await validarCodigoEmpresa(empresaCodigo);
      if (empresa) {
        referenciaEmpresa = generarReferenciaEmpresa(empresa);
      }
    }

    // Registrar nuevo cliente
    const fecha = new Date();
    const fechaStr = fecha.toLocaleDateString("es-CR");

    const nuevaFila = [
      nombre,             // Col A - Nombre
      telefono,           // Col B - Teléfono
      correo,             // Col C - Correo
      "",                 // Col D - Dirección auxiliar
      "",                 // Col E - Dirección auxiliar
      "",                 // Col F - Notas
      fechaStr,           // Col G - Fecha registro
      "",                 // Col H - Último acceso
      "",                 // Col I - Categoría o segmento (opcional)
      referenciaEmpresa   // Col J - Empresa afiliada
    ];

    await appendRow("Clientes", nuevaFila);

    // Respuesta PREMIUM
    await bot.sendMessage(
      chatId,
      `🎉 *Casillero creado correctamente*\n\n` +
      `👤 *Nombre:* ${nombre}\n` +
      `📱 *Teléfono:* ${telefono}\n` +
      `📧 *Correo:* ${correo}\n` +
      (referenciaEmpresa
        ? `🏢 *Empresa afiliada:* ${referenciaEmpresa}\n`
        : `🏢 *Empresa afiliada:* Ninguna\n`) +
      `\n¡Listo para empezar a recibir tus paquetes con nosotros! 🚀`,
      { parse_mode: "Markdown" }
    );

    clearUserState(chatId);
    return sendMainMenu(bot, chatId);

  } catch (err) {
    console.error("Error al crear casillero:", err);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocurrió un error al crear el casillero. Intentá nuevamente.",
      { parse_mode: "Markdown" }
    );
  }
}

// ===========================================================
// Flujo de empresa afiliada dentro del registro
// ===========================================================
async function manejarCodigoEmpresa(bot, chatId, text, state) {
  const codigo = text.trim().toUpperCase();

  // Cliente escribe NO (sin empresa afiliada)
  if (codigo === "NO") {
    state.empresaCodigo = "NO";
    state.modo = "CREAR_CORREO";
    return bot.sendMessage(
      chatId,
      "Perfecto, continuemos. Ingresá tu *correo electrónico*:",
      { parse_mode: "Markdown" }
    );
  }

  // Validar empresa
  const empresa = await validarCodigoEmpresa(codigo);

  if (!empresa) {
    return bot.sendMessage(
      chatId,
      "❌ *Ese código no está afiliado a ninguna empresa registrada.*\n" +
      "Verificá el código con tu empresa o escribí *NO* si no pertenecés a ninguna.",
      { parse_mode: "Markdown" }
    );
  }

  // Código válido
  state.empresaCodigo = codigo;
  state.modo = "CREAR_CORREO";

  return bot.sendMessage(
    chatId,
    `✅ *Código confirmado.*\nEmpresa: *${empresa.nombre}*\n\nIngresá tu *correo electrónico*:`,
    { parse_mode: "Markdown" }
  );
}

module.exports = {
  crearCasillero,
  manejarCodigoEmpresa
};