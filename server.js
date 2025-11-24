const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  throw new Error('Falta la variable de entorno TELEGRAM_TOKEN');
}

const SPREADSHEET_ID = '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = 'jiasesoriacourier@gmail.com';

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar el bot sin webhook en el constructor
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Configurar el webhook dinámicamente
const url = process.env.RENDER_EXTERNAL_URL || `https://localhost:${PORT}`;
bot.setWebHook(`${url}/${TELEGRAM_TOKEN}`);

// Middleware para manejar el webhook
app.use(express.json());
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => {
  // Telegram espera 200 OK inmediato
  res.sendStatus(200);
  // Procesar la actualización
  bot.processUpdate(req.body);
});

// Ruta de salud
app.get('/', (req, res) => {
  res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier');
});

// === COMANDOS ===
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Cliente';
  const welcome = `Hola ${userName} 👋\nUsa /menu para ver las opciones o /ayuda para asistencia.`;
  bot.sendMessage(chatId, welcome);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menú principal:', {
    reply_markup: {
      keyboard: [
        ['/mi_casillero', '/crear_casillero'],
        ['/cotizar', '/tracking CODIGO'],
        ['/banner']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

// === COMANDO /banner ===
bot.onText(/\/banner/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    // Usa una imagen pública (sube la tuya a Imgur o Drive y hazla pública)
    const bannerUrl = 'https://i.imgur.com/qJnTEVD.jpg';
    await bot.sendPhoto(chatId, bannerUrl);
  } catch (error) {
    bot.sendMessage(chatId, 'No pudimos enviar el banner. Inténtalo más tarde.');
  }
});

// === Iniciar servidor ===
app.listen(PORT, () => {
  console.log(`✅ Bot corriendo en puerto ${PORT}`);
  console.log(`🔗 Webhook URL: ${url}/${TELEGRAM_TOKEN}`);
});
