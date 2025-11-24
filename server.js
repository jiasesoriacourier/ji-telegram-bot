const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = 'jiasesoriacourier@gmail.com';

// Inicializar Express
const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar bot de Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
const url = process.env.RENDER_EXTERNAL_URL || `https://localhost:${PORT}`;
bot.setWebHook(`${url}/${TELEGRAM_TOKEN}`);

// Middleware para Telegram
app.use(bot.webhookCallback(`/${TELEGRAM_TOKEN}`));

// Ruta de salud (para Render)
app.get('/', (req, res) => {
  res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier');
});

// === FUNCIÓN PARA AUTENTICAR CON GOOGLE SHEETS ===
async function getGoogleSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  return sheets;
}

// === COMANDO /start ===
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Cliente';
  const welcome = `Hola ${userName} 👋\nUsa /menu para ver las opciones o /ayuda para asistencia.`;
  await bot.sendMessage(chatId, welcome);
});

// === COMANDO /menu ===
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const menu = 'Menú principal:';
  const options = {
    reply_markup: {
      keyboard: [
        ['/mi_casillero', '/crear_casillero'],
        ['/cotizar', '/tracking CODIGO'],
        ['/banner']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
  await bot.sendMessage(chatId, menu, options);
});

// === COMANDO /mi_casillero ===
bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const sheets = await getGoogleSheet();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Clientes!A:I'
    });
    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      return bot.sendMessage(chatId, 'No encontramos tu casillero. Usa /crear_casillero');
    }
    const cliente = rows.slice(1).find(row => String(row[4]) === String(chatId) || String(row[5]) === String(chatId));
    if (!cliente) {
      return bot.sendMessage(chatId, 'No encontramos tu casillero. Usa /crear_casillero');
    }
    const casillero = `📦 Casillero de ${cliente[0]}\nDirección: ${cliente[6] || 'No registrada'}\nContacto: ${cliente[4] || cliente[5] || 'No registrado'}`;
    await bot.sendMessage(chatId, casillero);
  } catch (error) {
    console.error('Error en /mi_casillero:', error);
    await bot.sendMessage(chatId, 'Error al buscar tu casillero. Contacta al administrador.');
  }
});

// === COMANDO /banner ===
bot.onText(/\/banner/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    // Puedes subir un banner a tu Drive y compartirlo públicamente
    const bannerUrl = 'https://i.imgur.com/qJnTEVD.jpg'; // ← Reemplaza con tu imagen pública
    await bot.sendPhoto(chatId, bannerUrl);
  } catch (error) {
    await bot.sendMessage(chatId, 'No pudimos enviar el banner. Inténtalo más tarde.');
  }
});

// === Iniciar servidor ===
app.listen(PORT, () => {
  console.log(`Bot corriendo en puerto ${PORT}`);
});
