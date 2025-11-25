// ==============================
//  J.I ASESORÍA & COURIER - BOT TELEGRAM
//  server.js COMPLETO
// ==============================

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const app = express();

// -----------------------------------------------------
// CONFIGURACIÓN DE ENTORNO
// -----------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_ADMIN = "7826072133";

const GOOGLE_PROJECT_EMAIL = process.env.G_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.G_PRIVATE_KEY.replace(/\\n/g, "\n");
const SPREADSHEET_ID = "1SQ7HrIimD9QaWjM7CAbq5aWNhnwMREOfDnVgUSz4DV0";

// -----------------------------------------------------
// INICIAR BOT
// -----------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// -----------------------------------------------------
// GOOGLE AUTH
// -----------------------------------------------------
const auth = new google.auth.JWT(
  GOOGLE_PROJECT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// -----------------------------------------------------
// FUNCIÓN: NORMALIZAR TELÉFONO
// -----------------------------------------------------
function normalizePhone(input) {
  if (!input) return "";
  let n = input.replace(/\D/g, "");
  if (n.startsWith("506")) n = n.slice(3);
  if (n.length > 8) n = n.slice(-8);
  return n;
}

// -----------------------------------------------------
// FUNCIÓN: LEER HOJA
// -----------------------------------------------------
async function readRange(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

// -----------------------------------------------------
// FUNCIÓN: ESCRIBIR EN HOJA
// -----------------------------------------------------
async function appendRow(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values: [row] },
  });
}

// -----------------------------------------------------
// MENÚ PRINCIPAL
// -----------------------------------------------------
function mainMenu(chatId) {
  bot.sendMessage(chatId, "📦 *Bienvenido a J.I Asesoría & Courier*", {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        ["📮 Mi Casillero"],
        ["💵 Cotizar envío"],
        ["🚚 Consultar Tracking"],
        ["💰 Consultar saldo pendiente"],
        ["👤 Contactar a JICO Courier"],
      ],
      resize_keyboard: true,
    },
  });
}

// -----------------------------------------------------
// VERIFICAR REGISTRO
// -----------------------------------------------------
async function getClient(phone) {
  const rows = await readRange("Clientes!A2:H");
  return rows.find((r) => normalizePhone(r[3]) === phone) || null;
}

// -----------------------------------------------------
// MANEJO DE MENSAJES
// -----------------------------------------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";
  const phone = normalizePhone(msg.from.phone_number || msg.contact?.phone_number || "");

  // ================
  // MENÚ PRINCIPAL
  // ================
  if (text === "/start") return mainMenu(chatId);

  // ================
  // CONTACTAR AGENTE
  // ================
  if (text === "👤 Contactar a JICO Courier") {
    return bot.sendMessage(chatId,
      "¿Por dónde deseas contactar a JICO Courier?\n\n" +
      "📩 *Correo:* info@jiasesoria.com\n" +
      "📱 *WhatsApp:* https://wa.me/50663939073\n" +
      "🤖 *Telegram:* https://t.me/JICOcourierbot",
      { parse_mode: "Markdown" }
    );
  }

  // =========================================================
  // MI CASILLERO
  // =========================================================
  if (text === "📮 Mi Casillero") {
    const cliente = await getClient(phone);
    if (!cliente) {
      return bot.sendMessage(
        chatId,
        "❌ No encontramos tu casillero.\nPor favor escribe */registrar* para crear tu cuenta.",
        { parse_mode: "Markdown" }
      );
    }

    const casillero = cliente[1];
    return bot.sendMessage(
      chatId,
      `📦 *Tu casillero JICO*\n\nNombre: ${cliente[0]}\nCasillero: ${casillero}\n\nDirección Miami:\n2874 NW 72 AVE\nJICO COURIER\nMiami, FL 33122\nTel: +1(786)820-8844`,
      { parse_mode: "Markdown" }
    );
  }

  // =========================================================
  // CONSULTAR TRACKING
  // =========================================================
  if (text === "🚚 Consultar Tracking") {
    const cliente = await getClient(phone);
    if (!cliente) {
      return bot.sendMessage(
        chatId,
        "❌ No estás registrado. Escribe */registrar* para continuar.",
        { parse_mode: "Markdown" }
      );
    }

    const nombre = cliente[0];
    const trackingRows = await readRange("Tracking1!A2:G");

    const userTrackings = trackingRows.filter((row) =>
      (row[2] || "").toLowerCase() === nombre.toLowerCase()
    );

    if (userTrackings.length === 0)
      return bot.sendMessage(chatId, "No tienes paquetes registrados.");

    let txt = "📦 *Tus paquetes:*\n\n";
    userTrackings.forEach((p) => {
      txt += `🔹 Tracking: *${p[0]}*\nEstado: ${p[5]}\nPeso: ${p[4]}\n\n`;
    });

    return bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
  }

  // =========================================================
  // CONSULTAR SALDO
  // =========================================================
  if (text === "💰 Consultar saldo pendiente") {
    const cliente = await getClient(phone);
    if (!cliente) {
      return bot.sendMessage(chatId, "Primero debes registrarte con /registrar");
    }

    const saldo = cliente[7] || 0;
    return bot.sendMessage(chatId, `💵 *Tu saldo pendiente es:* ₡${saldo}`, {
      parse_mode: "Markdown",
    });
  }

  // =========================================================
  // COTIZAR ENVÍO
  // =========================================================
  if (text === "💵 Cotizar envío") {
    bot.sendMessage(chatId, "📍 *Elige origen de tu envío:*", {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["Miami", "España"], ["Colombia", "México"], ["China"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });

    bot.once("message", async (m1) => {
      const origen = m1.text;

      bot.sendMessage(chatId, "📦 Ingresa el peso:");
      bot.once("message", async (m2) => {
        let peso = parseFloat(m2.text.replace(",", "."));
        if (isNaN(peso)) return bot.sendMessage(chatId, "Peso inválido.");

        bot.sendMessage(chatId, "¿El paquete requiere permiso especial? (sí/no)");
        bot.once("message", async (m3) => {
          const permiso = m3.text.toLowerCase() === "si" ? "especial" : "normal";

          bot.sendMessage(chatId, "¿La entrega sería dentro del GAM? (sí/no)");
          bot.once("message", async (m4) => {
            const esGAM = m4.text.toLowerCase() === "si";

            // ============================
            // CARGAR TARIFAS
            // ============================
            const tarifas = await readRange("Tarifas!A1:K20");
            const tipoCambio = parseFloat(tarifas[2][9]); // J3
            const costoEntrega = parseFloat(tarifas[0][9]); // J1

            let tarifa = 0;
            let unidad = "lb";

            switch (origen) {
              case "Miami":
                tarifa = permiso === "especial" ? tarifas[2][1] : tarifas[1][1];
                unidad = "lb";
                break;
              case "España":
                tarifa = permiso === "especial" ? tarifas[10][1] : tarifas[9][1];
                unidad = "lb";
                break;
              case "Colombia":
                tarifa = permiso === "especial" ? tarifas[6][1] : tarifas[5][1];
                unidad = "kg";
                break;
              case "China":
                tarifa = tarifas[12][1];
                unidad = "lb";
                break;
              case "México":
                tarifa = tarifas[14][1];
                unidad = "kg";
                break;
            }

            tarifa = parseFloat(tarifa);

            // Conversión de peso
            let pesoConv = peso;
            if (unidad === "lb") pesoConv = peso / 2.20462;

            const subtotalUSD = tarifa * (unidad === "lb" ? peso : pesoConv);
            const subtotalCRC = subtotalUSD * tipoCambio;

            const costoTotalEntrega = esGAM ? costoEntrega : 0;
            const totalFinal = subtotalCRC + costoTotalEntrega;

            // ============================
            // RESPUESTA AL CLIENTE
            // ============================
            let texto =
              "📦 *COTIZACIÓN COMPLETA*\n\n" +
              `🌍 Origen: *${origen}*\n` +
              `⚖ Peso: *${peso}*\n` +
              `Permiso: *${permiso}*\n\n` +
              `💵 Subtotal: ₡${subtotalCRC.toFixed(2)}\n` +
              `🚚 Entrega: ${esGAM ? "₡" + costoEntrega : "Fuera del GAM (Encomienda)"}\n\n` +
              `💰 *Total Final: ₡${totalFinal.toFixed(2)}*\n` +
              `💱 Tipo de cambio usado: ${tipoCambio}\n\n` +
              `*Esta tarifa puede variar según el tipo de cambio.*`;

            bot.sendMessage(chatId, texto, { parse_mode: "Markdown" });

            // ============================
            // GUARDAR EN GOOGLE SHEETS
            // ============================
            const cliente = await getClient(phone);
            const fecha = new Date();

            await appendRow("Cotizaciones!A2:M", [
              fecha.toLocaleString("es-CR"),
              cliente ? cliente[0] : "No registrado",
              origen,
              peso,
              unidad,
              permiso,
              "Mercancía enviada",
              subtotalCRC.toFixed(2),
              0,
              subtotalCRC.toFixed(2),
              costoTotalEntrega,
              totalFinal.toFixed(2),
              tipoCambio,
            ]);

            // ============================
            // REENVIAR AL TELEGRAM ADMIN
            // ============================
            bot.sendMessage(
              TELEGRAM_ADMIN,
              `📨 NUEVA COTIZACIÓN\n\n${texto}\n\n📱 Cliente: ${cliente ? cliente[0] : "No registrado"}`
            );
          });
        });
      });
    });
  }
});

// -----------------------------------------------------
// EXPRESS KEEP ALIVE
// -----------------------------------------------------
app.get("/", (req, res) => res.send("BOT ACTIVO - JICO Courier"));
app.listen(3000, () => console.log("SERVER RUNNING"));
