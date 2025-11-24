// === DEPENDENCIAS ===
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = 'jiasesoriacourier@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_EMAIL_PASSWORD; // SMTP password (App Password)

if (!TELEGRAM_TOKEN) {
  throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
}

// === INICIALIZACIÓN ===
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
bot.setWebHook(`${url}/${TELEGRAM_TOKEN}`);

// === ESTADO POR USUARIO (en memoria, persistente por sesión) ===
const userStates = new Map(); // chatId -> estado

// === MIDDLEWARE WEBHOOK ===
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200); // Telegram requiere 200 inmediato
  bot.processUpdate(req.body);
});

app.get('/', (req, res) => {
  res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier');
});

// === LISTAS DE CLASIFICACIÓN ===
const MERCANCIA_ESPECIAL = [
  "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje",
  "medicamento","medicamentos","medicina","medicinas","suplemento","suplementos","vitamina","vitaminas",
  "alimento","alimentos","enlatado","enlatados","semilla","semillas","agroquimico","agroquímico","fertilizante",
  "lentes de contacto","lentes","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula"
];

const MERCANCIA_PROHIBIDA = [
  "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd",
  "arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso",
  "oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros"
];

const KNOWN_BRANDS = [
  "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier",
  "bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret"
];

// === FUNCIONES DE CLASIFICACIÓN ===
function classifyProduct(obj) {
  const text = (obj.descripcion || '').toLowerCase();
  const categoriaSeleccionada = (obj.categoriaSeleccionada || '').toLowerCase();
  const destino = (obj.destino || '').toLowerCase();

  // Prohibidas
  for (const w of MERCANCIA_PROHIBIDA) {
    if (text.includes(w)) return { tipo: 'Prohibida', tags: [w] };
  }

  // Réplicas explícitas
  if (categoriaSeleccionada.includes('réplica') || categoriaSeleccionada.includes('replica')) {
    return destino.includes('colombia') ? { tipo: 'Especial', tags: ['replica'] } : { tipo: 'General', tags: ['replica'] };
  }

  // Palabras sensibles
  const foundSpecial = [];
  for (const w of MERCANCIA_ESPECIAL) {
    if (text.includes(w)) foundSpecial.push(w);
  }
  if (foundSpecial.length) return { tipo: 'Especial', tags: foundSpecial };

  // Marcas reconocidas
  for (const b of KNOWN_BRANDS) {
    if (text.includes(b)) {
      return destino.includes('colombia') ? { tipo: 'Especial', tags: ['brand:' + b] } : { tipo: 'General', tags: ['brand:' + b] };
    }
  }

  return { tipo: 'General', tags: [] };
}

// === KEYBOARDS ===
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/tracking ABC123'],
      ['/banner']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function categoriaInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Electrónicos', callback_data: 'CATEGORIA|Electrónicos' }, { text: 'Ropa / Calzado', callback_data: 'CATEGORIA|Ropa' }],
      [{ text: 'Perfumería', callback_data: 'CATEGORIA|Perfumería' }, { text: 'Medicinas / Suplementos', callback_data: 'CATEGORIA|Medicinas' }],
      [{ text: 'Alimentos', callback_data: 'CATEGORIA|Alimentos' }, { text: 'Cosméticos', callback_data: 'CATEGORIA|Cosméticos' }],
      [{ text: 'Réplicas / Imitaciones', callback_data: 'CATEGORIA|Réplicas' }, { text: 'Piezas automotrices', callback_data: 'CATEGORIA|Automotriz' }],
      [{ text: 'Documentos', callback_data: 'CATEGORIA|Documentos' }, { text: 'Otro', callback_data: 'CATEGORIA|Otro' }]
    ]
  };
}

// === GESTIÓN DE ESTADO ===
function setUserState(chatId, state) {
  userStates.set(chatId, state);
}

function getUserState(chatId) {
  return userStates.get(chatId);
}

function clearUserState(chatId) {
  userStates.delete(chatId);
}

// === COMANDOS ===
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones o /ayuda para asistencia.`, {
    reply_markup: mainMenuKeyboard()
  });
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_ORIGEN' });
  bot.sendMessage(chatId, 'Comenzamos la cotización. ¿Cuál es el ORIGEN? (miami / españa / colombia / china / mexico)');
});

// === CALLBACKS ===
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id);

  if (data.startsWith('CATEGORIA|')) {
    const categoria = data.split('|')[1];
    const state = getUserState(chatId) || {};
    state.categoriaSeleccionada = categoria;
    state.modo = 'COTIZAR_DESCRIPCION';
    setUserState(chatId, state);
    bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (ej: "perfume 50ml", "par de tenis").`, { parse_mode: 'Markdown' });
  }
});

// === FLUJO DE COTIZACIÓN ===
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const state = getUserState(chatId);

  if (!state || !state.modo) return;

  try {
    if (state.modo === 'COTIZAR_ORIGEN') {
      state.origen = text.toLowerCase();
      state.modo = 'COTIZAR_DESTINO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, `Origen: ${state.origen}. Ahora indica el DESTINO (miami / españa / colombia / china / mexico).`);
    }
    else if (state.modo === 'COTIZAR_DESTINO') {
      state.destino = text.toLowerCase();
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }
    else if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({
        descripcion: state.descripcion,
        categoriaSeleccionada: state.categoriaSeleccionada,
        destino: state.destino
      });

      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.');
      }

      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, `Clasificación: ${state.tipoMercancia}. Indica el PESO (ej: 2.3 kg o 4 lb).`);
    }
    else if (state.modo === 'COTIZAR_PESO') {
      const pesoMatch = text.match(/([\d.]+)\s*(kg|lb)/i);
      if (!pesoMatch) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg o 3 lb');
      
      state.peso = parseFloat(pesoMatch[1]);
      state.unidad = pesoMatch[2].toLowerCase();
      state.modo = 'COTIZAR_EMAIL';
      setUserState(chatId, state);
      bot.sendMessage(chatId, `Resumen:\nOrigen: ${state.origen}\nDestino: ${state.destino}\nTipo: ${state.tipoMercancia}\nDescripción: ${state.descripcion}\n\nIndica tu correo para enviar la cotización.`);
    }
    else if (state.modo === 'COTIZAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Por favor, escribe un email válido.');
      
      state.email = text;
      const cotizacion = await calcularYRegistrarCotizacion(chatId, state);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Cotización enviada.\nTotal: $${cotizacion.total.toFixed(2)}\nID: ${cotizacion.id}`);
    }
  } catch (err) {
    console.error('Error en flujo de cotización:', err);
    bot.sendMessage(chatId, 'Hubo un error. Usa /cotizar para empezar de nuevo.');
    clearUserState(chatId);
  }
});

// === CÁLCULO Y REGISTRO ===
async function calcularYRegistrarCotizacion(chatId, state) {
  const tarifas = await leerTarifas();
  const { origen, destino, peso, unidad, tipoMercancia, email } = state;

  let tarifa = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotal = 0;

  // Conversión y redondeo
  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;

  if (destino === 'colombia') {
    tarifa = tipoMercancia === 'Especial' ? tarifas.colombia_especial_kg : tarifas.colombia_general_kg;
    pesoFacturable = Math.ceil(pesoEnKg || peso);
    unidadFacturable = 'kg';
    subtotal = tarifa * pesoFacturable;
  } else {
    tarifa = tipoMercancia === 'Especial' ? tarifas.espana_especial_lb : tarifas.miami_general_lb;
    pesoFacturable = Math.ceil(pesoEnLb || peso);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  }

  const total = subtotal;
  const id = 'COT-' + Math.random().toString(36).substr(2, 9).toUpperCase();
  const fecha = new Date().toISOString();

  // Guardar en Google Sheets (Historial)
  await guardarEnHistorial({
    id, fecha, chatId, email, origen, destino, tipoMercancia, peso, unidad, pesoFacturable, tarifa, subtotal, total
  });

  // Generar y enviar PDF
  const html = generarPDF(id, fecha, { ...state, pesoFacturable, unidadFacturable, tarifa, subtotal, total });
  await enviarPDF(email, id, html);

  return { id, total };
}

// === GOOGLE SHEETS ===
async function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Tarifas!B2:B15'
  });
  const values = res.data.values || [];
  const [miami_general, miami_especial, , colombia_general, colombia_especial, , espana_general, espana_especial] = values.flat().map(v => parseFloat(v) || 0);
  
  return {
    miami_general_lb: miami_general,
    miami_especial_lb: miami_especial,
    colombia_general_kg: colombia_general,
    colombia_especial_kg: colombia_especial,
    espana_general_lb: espana_general,
    espana_especial_lb: espana_especial
  };
}

async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Historial',
    valueInputOption: 'RAW',
    resource: {
      values: [[
        data.id, data.fecha, data.chatId, 'Cliente', data.email, data.origen, data.destino,
        data.tipoMercancia, data.peso, data.unidad, data.pesoFacturable, data.tarifa,
        data.subtotal, 0, data.total, JSON.stringify(data)
      ]]
    }
  });
}

// === PDF Y EMAIL ===
function generarPDF(id, fecha, c) {
  return `<!DOCTYPE html>
  <html><body>
    <h2>Cotización - J.I Asesoría & Courier</h2>
    <p><strong>ID:</strong> ${id}</p>
    <p><strong>Origen:</strong> ${c.origen}</p>
    <p><strong>Destino:</strong> ${c.destino}</p>
    <p><strong>Tipo:</strong> ${c.tipoMercancia}</p>
    <p><strong>Peso facturable:</strong> ${c.pesoFacturable} ${c.unidadFacturable}</p>
    <p><strong>Total:</strong> $${c.total.toFixed(2)}</p>
  </body></html>`;
}

async function enviarPDF(email, id, html) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: ADMIN_EMAIL,
      pass: ADMIN_PASSWORD
    }
  });

  const mailOptions = {
    from: ADMIN_EMAIL,
    to: email,
    subject: `Cotización J.I Asesoría & Courier - ID ${id}`,
    html,
    attachments: [{ filename: `${id}.pdf`, content: Buffer.from(html), contentType: 'application/pdf' }]
  };

  await transporter.sendMail(mailOptions);
  // También enviar copia al admin
  mailOptions.to = ADMIN_EMAIL;
  await transporter.sendMail(mailOptions);
}

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  console.log(`🔗 Webhook: ${url}/${TELEGRAM_TOKEN}`);
});
