// === DEPENDENCIAS ===
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = 'jiasesoriacourier@gmail.com';
const ADMIN_EMAIL_PASSWORD = process.env.ADMIN_EMAIL_PASSWORD;

if (!TELEGRAM_TOKEN) {
  throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
}

// === INICIALIZACIÓN ===
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
bot.setWebHook(`${url}/${TELEGRAM_TOKEN}`);

// === ESTADO POR USUARIO ===
const userStates = new Map();

// === LISTAS DE CLASIFICACIÓN ===
const MERCANCIA_ESPECIAL = [
  "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje",
  "medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas",
  "alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante",
  "lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula"
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

// === MIDDLEWARE WEBHOOK ===
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200);
  bot.processUpdate(req.body);
});

app.get('/', (req, res) => {
  res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier');
});

// === FUNCIONES DE CLASIFICACIÓN ===
function classifyProduct(obj) {
  const text = (obj.descripcion || '').toLowerCase();
  const categoriaSeleccionada = (obj.categoriaSeleccionada || '').toLowerCase();
  const origen = (obj.origen || '').toLowerCase();

  for (const w of MERCANCIA_PROHIBIDA) {
    if (text.includes(w)) return { tipo: 'Prohibida', tags: [w] };
  }

  if (categoriaSeleccionada.includes('réplica') || categoriaSeleccionada.includes('replica')) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['replica'] } : { tipo: 'General', tags: ['replica'] };
  }

  const foundSpecial = [];
  for (const w of MERCANCIA_ESPECIAL) {
    if (text.includes(w)) foundSpecial.push(w);
  }
  if (foundSpecial.length) return { tipo: 'Especial', tags: foundSpecial };

  for (const b of KNOWN_BRANDS) {
    if (text.includes(b)) {
      return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
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
      [{ text: 'Electrónicos', callback_ 'CATEGORIA|Electrónicos' }, { text: 'Ropa / Calzado', callback_ 'CATEGORIA|Ropa' }],
      [{ text: 'Perfumería', callback_ 'CATEGORIA|Perfumería' }, { text: 'Medicinas / Suplementos', callback_ 'CATEGORIA|Medicinas' }],
      [{ text: 'Alimentos', callback_ 'CATEGORIA|Alimentos' }, { text: 'Cosméticos', callback_ 'CATEGORIA|Cosméticos' }],
      [{ text: 'Réplicas / Imitaciones', callback_ 'CATEGORIA|Réplicas' }, { text: 'Piezas automotrices', callback_ 'CATEGORIA|Automotriz' }],
      [{ text: 'Documentos', callback_ 'CATEGORIA|Documentos' }, { text: 'Otro', callback_ 'CATEGORIA|Otro' }]
    ]
  };
}

function casilleroPaisesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🇺🇸 Miami (EE.UU.)', callback_ 'CASILLERO|miami' }],
      [{ text: '🇪🇸 Madrid (España)', callback_ 'CASILLERO|espana' }],
      [{ text: '🇨🇴 Bogotá / Medellín (Colombia)', callback_ 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 Ciudad de México', callback_ 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 Shanghái / Guangzhou (China)', callback_ 'CASILLERO|china' }]
    ]
  };
}

function colombiaPermisoKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📦 Con permiso o réplicas', callback_ 'COL_CASILLERO|con' }],
      [{ text: '📦 Sin permiso', callback_ 'COL_CASILLERO|sin' }]
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

// === GOOGLE SHEETS ===
async function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function extractRange(data, startRow, endRow, startCol, endCol) {
  const lines = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= data.length) continue;
    const row = data[r];
    const cells = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = (row[c] || '').toString().trim();
      if (cell) cells.push(cell);
    }
    if (cells.length > 0) lines.push(cells.join(' '));
  }
  return lines.join('\n');
}

async function getDirecciones(nombreCliente) {
  const sheets = await getGoogleSheetsClient();
  const sheet = sheets.spreadsheets.values;
  const range = 'Direcciones!A:Z';
  const data = (await sheet.get({ spreadsheetId: SPREADSHEET_ID, range })).data.values || [];

  const replaceName = (text) => text.replace(/Nombre de cliente/gi, nombreCliente);

  return {
    miami: replaceName(extractRange(data, 1, 4, 1, 4)),      // B2:D5
    espana: replaceName(extractRange(data, 16, 20, 1, 4)),   // B17:D21
    colombiaCon: replaceName(extractRange(data, 1, 8, 6, 10)), // G2:J8
    colombiaSin: replaceName(extractRange(data, 10, 17, 6, 10)), // G11:J17
    mexico: replaceName(extractRange(data, 23, 28, 1, 4)),   // B24:D29
    china: replaceName(extractRange(data, 23, 28, 6, 10))    // G24:J29
  };
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

bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
});

bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_ORIGEN' });
  bot.sendMessage(chatId, 'Comenzamos la cotización. ¿Cuál es el ORIGEN?\n\nOpciones: miami, madrid, colombia, mexico, china');
});

bot.onText(/\/banner/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const bannerUrl = 'https://i.imgur.com/qJnTEVD.jpg';
    await bot.sendPhoto(chatId, bannerUrl);
  } catch (error) {
    bot.sendMessage(chatId, 'No pudimos enviar el banner.');
  }
});

// === CALLBACKS ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data.startsWith('CATEGORIA|')) {
    const categoria = data.split('|')[1];
    const state = getUserState(chatId) || {};
    state.categoriaSeleccionada = categoria;
    state.modo = 'COTIZAR_DESCRIPCION';
    setUserState(chatId, state);
    bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto.`, { parse_mode: 'Markdown' });
  }
  else if (data.startsWith('CASILLERO|')) {
    const pais = data.split('|')[1];
    if (pais === 'colombia') {
      bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: colombiaPermisoKeyboard() });
    } else {
      const nombre = query.from.first_name || 'Cliente';
      const direcciones = await getDirecciones(nombre);
      let direccion = 'No disponible';
      if (pais === 'miami') direccion = direcciones.miami;
      else if (pais === 'espana') direccion = direcciones.espana;
      else if (pais === 'mexico') direccion = direcciones.mexico;
      else if (pais === 'china') direccion = direcciones.china;
      const nombresPaises = {
        miami: 'Miami (EE.UU.)',
        espana: 'Madrid (España)',
        mexico: 'Ciudad de México',
        china: 'China'
      };
      bot.sendMessage(chatId, `📍 *Dirección en ${nombresPaises[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }
  }
  else if (data.startsWith('COL_CASILLERO|')) {
    const tipo = data.split('|')[1];
    const nombre = query.from.first_name || 'Cliente';
    const direcciones = await getDirecciones(nombre);
    const direccion = tipo === 'con' ? direcciones.colombiaCon : direcciones.colombiaSin;
    bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo === 'con' ? 'Con permiso' : 'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown' });
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
      bot.sendMessage(chatId, `Origen: ${state.origen}. Ahora indica el DESTINO (Costa Rica).`);
    }
    else if (state.modo === 'COTIZAR_DESTINO') {
      state.destino = 'costa rica';
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }
    else if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({
        descripcion: state.descripcion,
        categoriaSeleccionada: state.categoriaSeleccionada,
        origen: state.origen
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
      bot.sendMessage(chatId, `Resumen:\nOrigen: ${state.origen}\nTipo: ${state.tipoMercancia}\nDescripción: ${state.descripcion}\n\nIndica tu correo para enviar la cotización.`);
    }
    else if (state.modo === 'COTIZAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido.');
      
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
  const { origen, peso, unidad, tipoMercancia, email } = state;

  let tarifa = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotal = 0;

  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = origen.toLowerCase();

  if (origenLower === 'colombia') {
    tarifa = tipoMercancia === 'Especial' ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotal = tarifa * pesoFacturable;
  }
  else if (origenLower === 'mexico') {
    tarifa = tarifas.mexico.tarifa;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotal = tarifa * pesoFacturable;
  }
  else if (origenLower === 'china') {
    tarifa = tarifas.china.tarifa;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  }
  else if (origenLower === 'miami' || origenLower === 'usa') {
    tarifa = tipoMercancia === 'Especial' ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  }
  else if (origenLower === 'espana' || origenLower === 'madrid') {
    tarifa = tipoMercancia === 'Especial' ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  }
  else {
    throw new Error("Origen no soportado. Usa: miami, madrid, colombia, mexico o china");
  }

  const total = subtotal;
  const id = 'COT-' + Math.random().toString(36).substr(2, 9).toUpperCase();
  const fecha = new Date().toISOString();

  // Guardar en Google Sheets (Historial)
  await guardarEnHistorial({
    id, fecha, chatId, email, origen, destino: 'Costa Rica', tipoMercancia, peso, unidad, pesoFacturable, tarifa, subtotal, total
  });

  // Generar y enviar PDF
  const html = generarPDF(id, fecha, { ...state, pesoFacturable, unidadFacturable, tarifa, subtotal, total });
  await enviarPDF(email, id, html);

  return { id, total };
}

async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Tarifas!B2:B15'
  });
  const values = res.data.values || [];
  return {
    miami: {
      sinPermiso: parseFloat(values[1]?.[0]) || 6.0,
      conPermiso: parseFloat(values[2]?.[0]) || 7.0
    },
    colombia: {
      sinPermiso: parseFloat(values[5]?.[0]) || 9.0,
      conPermiso: parseFloat(values[6]?.[0]) || 16.0
    },
    espana: {
      sinPermiso: parseFloat(values[9]?.[0]) || 8.5,
      conPermiso: parseFloat(values[10]?.[0]) || 9.9
    },
    china: {
      tarifa: parseFloat(values[12]?.[0]) || 10.0
    },
    mexico: {
      tarifa: parseFloat(values[14]?.[0]) || 12.0
    }
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
    <p><strong>Destino:</strong> Costa Rica</p>
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
      pass: ADMIN_EMAIL_PASSWORD
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
  mailOptions.to = ADMIN_EMAIL;
  await transporter.sendMail(mailOptions);
}

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  console.log(`🔗 Webhook: ${url}/${TELEGRAM_TOKEN}`);
});
