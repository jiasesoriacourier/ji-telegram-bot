// server.js - Bot Telegram + Google Sheets (Render-ready)

// === DEPENDENCIAS ===
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit'); // npm i pdfkit

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jiasesoriacourier@gmail.com';
const ADMIN_EMAIL_PASSWORD = process.env.ADMIN_EMAIL_PASSWORD;

if (!TELEGRAM_TOKEN) {
  throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
}
if (!process.env.GOOGLE_CREDENTIALS) {
  throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno (JSON o Base64)');
}
if (!ADMIN_EMAIL_PASSWORD) {
  console.warn('⚠️ ADMIN_EMAIL_PASSWORD no definido. Los envíos por correo fallarán hasta definirlo.');
}

// === INICIALIZACIÓN ===
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// En Render la URL externa se obtiene con variable RENDER_EXTERNAL_URL (o la defines)
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// Estado por usuario (simple Map en memoria)
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

// === UTILIDADES DE ESTADO ===
function setUserState(chatId, state) { userStates.set(chatId, state); }
function getUserState(chatId) { return userStates.get(chatId); }
function clearUserState(chatId) { userStates.delete(chatId); }

// === GOOGLE SHEETS CLIENT (manejo de GOOGLE_CREDENTIALS en JSON o Base64) ===
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS;
  // Si es base64, decodificamos
  try {
    if (!credsRaw.trim().startsWith('{')) {
      credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
    }
    const credentials = JSON.parse(credsRaw);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (err) {
    console.error('Error parseando GOOGLE_CREDENTIALS:', err);
    throw err;
  }
}

// === EXTRACCIÓN DE RANGO (indices 0-based) ===
function extractRange(data, startRow, endRow, startCol, endCol) {
  // data: array de filas (cada fila es array de celdas), indices 0-based
  const lines = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= data.length) continue;
    const row = data[r] || [];
    const cells = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = (row[c] || '').toString().trim();
      if (cell) cells.push(cell);
    }
    if (cells.length > 0) lines.push(cells.join(' '));
  }
  return lines.join('\n');
}

// === LECTURA DE DIRECCIONES (usando los rangos que pusiste) ===
async function getDirecciones(nombreCliente = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const sheetVals = sheets.spreadsheets.values;
  const range = 'Direcciones!A:Z';
  const res = await sheetVals.get({ spreadsheetId: SPREADSHEET_ID, range });
  const data = res.data.values || [];

  const replaceName = (text) => text.replace(/Nombre de cliente/gi, nombreCliente);

  return {
    // Miami: B2:D5 => rows 1..4, cols 1..3
    miami: replaceName(extractRange(data, 1, 4, 1, 3)),
    // España: B17:D21 => rows 16..20, cols 1..3
    espana: replaceName(extractRange(data, 16, 20, 1, 3)),
    // Colombia con permiso: G1:J7 => rows 0..6, cols 6..9
    colombiaCon: replaceName(extractRange(data, 0, 6, 6, 9)),
    // Colombia sin permiso: G11:J17 => rows 10..16, cols 6..9
    colombiaSin: replaceName(extractRange(data, 10, 16, 6, 9)),
    // Mexico: B24:D29 => rows 23..28, cols 1..3
    mexico: replaceName(extractRange(data, 23, 28, 1, 3)),
    // China: G24:J29 => rows 23..28, cols 6..9
    china: replaceName(extractRange(data, 23, 28, 6, 9))
  };
}

// === KEYBOARDS CORRECTOS (callback_data) ===
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

function casilleroPaisesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🇺🇸 Miami (EE.UU.)', callback_data: 'CASILLERO|miami' }],
      [{ text: '🇪🇸 Madrid (España)', callback_data: 'CASILLERO|espana' }],
      [{ text: '🇨🇴 Bogotá / Medellín (Colombia)', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 Ciudad de México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 Shanghái / Guangzhou (China)', callback_data: 'CASILLERO|china' }]
    ]
  };
}

function colombiaPermisoKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],
      [{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]
    ]
  };
}

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

// === RUTAS / WEBHOOK ===
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => {
  // Responder rápido a Telegram y procesar después
  res.sendStatus(200);
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error('Error procesando update:', err);
  }
});

app.get('/', (req, res) => {
  res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier');
});

// === COMANDOS (text handlers) ===
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
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

// === CALLBACKS (inline buttons) ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
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
        const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
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
      const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const direcciones = await getDirecciones(nombre);
      const direccion = tipo === 'con' ? direcciones.colombiaCon : direcciones.colombiaSin;
      bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo === 'con' ? 'Con permiso' : 'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción. Intenta nuevamente.');
  }
});

// === FLUJO DE COTIZACIÓN (mensajes libres) ===
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId);
    if (!state || !state.modo) return;

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
      bot.sendMessage(chatId, 'Procesando cotización...');

      const cotizacion = await calcularYRegistrarCotizacion(chatId, state);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Cotización enviada.\nTotal: $${cotizacion.total.toFixed(2)}\nID: ${cotizacion.id}`);
    }
  } catch (err) {
    console.error('Error en flujo de cotización (message):', err);
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
    tarifa = (tipoMercancia === 'Especial' || tipoMercancia === 'Replica' ) ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
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
    tarifa = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  }
  else if (origenLower === 'espana' || origenLower === 'madrid') {
    tarifa = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
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

  await guardarEnHistorial({
    id, fecha, chatId, email, origen, destino: 'Costa Rica', tipoMercancia, peso, unidad, pesoFacturable, tarifa, subtotal, total
  });

  // Generar PDF (buffer)
  const pdfBuffer = await generarPDFBuffer(id, fecha, { ...state, pesoFacturable, unidadFacturable, tarifa, subtotal, total });

  // Enviar por email (adjunto PDF)
  await enviarPDF(email, id, pdfBuffer);

  return { id, total };
}

// === LEER TARIFAS (según celdas que definiste) ===
// Tarifas en hoja "Tarifas":
// Miami: B2 (sin permiso) -> index 0, B3 (con permiso) -> index 1
// Colombia: B6 (sin permiso) -> index 4, B7 (con permiso) -> index 5
// España: B10 -> index 8, B11 -> index 9
// China: B13 -> index 11
// Mexico: B15 -> index 13
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Tarifas!B2:B15'
  });
  const values = (res.data.values || []).map(r => r[0]);

  const val = idx => parseFloat(values[idx]) || 0;

  return {
    miami: {
      sinPermiso: val(0) || 6.0,
      conPermiso: val(1) || 7.0
    },
    colombia: {
      sinPermiso: val(4) || 9.0,
      conPermiso: val(5) || 16.0
    },
    espana: {
      sinPermiso: val(8) || 8.5,
      conPermiso: val(9) || 9.9
    },
    china: {
      tarifa: val(11) || 10.0
    },
    mexico: {
      tarifa: val(13) || 12.0
    }
  };
}

// === GUARDAR EN HISTORIAL (Google Sheets) ===
async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const now = new Date().toISOString();
  const values = [[
    data.id, data.fecha || now, data.chatId, 'Cliente', data.email, data.origen, data.destino,
    data.tipoMercancia, data.peso, data.unidad, data.pesoFacturable, data.tarifa,
    data.subtotal, 0, data.total, JSON.stringify(data)
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Historial!A:Z',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

// === GENERAR PDF (con pdfkit) ===
function generarPDFBuffer(id, fecha, c) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      doc.fontSize(16).text('Cotización - J.I Asesoría & Courier', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`ID: ${id}`);
      doc.text(`Fecha: ${fecha}`);
      doc.moveDown();
      doc.text(`Origen: ${c.origen}`);
      doc.text(`Destino: Costa Rica`);
      doc.text(`Tipo: ${c.tipoMercancia}`);
      doc.text(`Descripción: ${c.descripcion || '-'}`);
      doc.text(`Peso declarado: ${c.peso} ${c.unidad}`);
      doc.text(`Peso facturable: ${c.pesoFacturable} ${c.unidadFacturable}`);
      doc.moveDown();
      doc.text(`Tarifa aplicada: ${c.tarifa}`);
      doc.text(`Subtotal: $${(c.subtotal || 0).toFixed(2)}`);
      doc.text(`Total: $${(c.total || 0).toFixed(2)}`);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// === ENVIAR PDF POR CORREO (nodemailer) ===
async function enviarPDF(email, id, pdfBuffer) {
  if (!ADMIN_EMAIL_PASSWORD) {
    console.warn('No se envió correo: falta ADMIN_EMAIL_PASSWORD');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: ADMIN_EMAIL, pass: ADMIN_EMAIL_PASSWORD }
  });

  // Envío al cliente
  const mailOptionsClient = {
    from: ADMIN_EMAIL,
    to: email,
    subject: `Cotización J.I Asesoría & Courier - ID ${id}`,
    html: `<p>Adjuntamos la cotización (ID ${id}).</p>`,
    attachments: [{ filename: `${id}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
  };

  // Envío al admin (copia)
  const mailOptionsAdmin = {
    from: ADMIN_EMAIL,
    to: ADMIN_EMAIL,
    subject: `Copia - Cotización ${id}`,
    html: `<p>Copia de cotización ID ${id} enviada a ${email}.</p>`,
    attachments: [{ filename: `${id}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
  };

  await transporter.sendMail(mailOptionsClient);
  await transporter.sendMail(mailOptionsAdmin);
}

// === INICIAR SERVIDOR Y CONFIGURAR WEBHOOK (setWebHook al iniciar) ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  const webhookUrl = `${url}/${TELEGRAM_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  } catch (err) {
    console.error('Error configurando webhook:', err);
  }
});
