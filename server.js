// server.js - J.I Asesoría & Courier - Telegram bot (Render-ready)
// Dependencias: express, node-telegram-bot-api, googleapis
// Configurar variables de entorno: TELEGRAM_TOKEN, SPREADSHEET_ID, GOOGLE_CREDENTIALS (JSON o base64), ADMIN_TELEGRAM_ID (opcional), RENDER_EXTERNAL_URL (opcional)
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

/////////////////////// CONFIG ///////////////////////
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';
const URL_BASE = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) console.warn('Advertencia: No se encontró GOOGLE_CREDENTIALS en env. Debes definirlo.');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Bot en modo webhook
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

/////////////////////// ESTADO EN MEMORIA ///////////////////////
// Map chatId -> state
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)) || null; }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

/////////////////////// CACHE DE TELÉFONO ///////////////////////
// Guarda phone por usuario temporalmente (1 hora por defecto)
const userPhoneCache = {}; // chatId -> { phone, ts }

function savePhone(chatId, phone) {
  try {
    userPhoneCache[String(chatId)] = { phone: String(phone), ts: Date.now() };
  } catch (e) {}
}
function getCachedPhone(chatId) {
  const entry = userPhoneCache[String(chatId)];
  if (!entry) return null;
  const ONE_HOUR = 60 * 60 * 1000;
  if ((Date.now() - entry.ts) > ONE_HOUR) {
    delete userPhoneCache[String(chatId)];
    return null;
  }
  return entry.phone;
}

/////////////////////// CONSTANTES ///////////////////////
const MERCANCIA_ESPECIAL = [
  "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje",
  "medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas",
  "alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante",
  "lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula","acetaminofen","paracetamol"
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
const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china','estados unidos','espana','españa'];

/////////////////////// CLASSIFY PRODUCT ///////////////////////
function classifyProduct({ descripcion, categoriaSeleccionada, origen }) {
  const desc = (descripcion || '').toLowerCase();
  const cat = (categoriaSeleccionada || '').toLowerCase();

  if (MERCANCIA_PROHIBIDA.some(p => desc.includes(p))) {
    return { tipo: 'Prohibida' };
  }

  if (MERCANCIA_ESPECIAL.some(k => desc.includes(k))) {
    return { tipo: 'Especial' };
  }

  if (['perfumería', 'medicinas', 'cosméticos', 'réplicas'].some(c => cat.includes(c))) {
    return { tipo: 'Especial' };
  }

  const hasBrand = KNOWN_BRANDS.some(b => desc.includes(b));
  const hasReplicaKeywords = ['réplica', 'replica', 'falso', 'falsa', 'imitación', 'imitacion', 'copia'].some(k => desc.includes(k));
  const hasCategoryAmbiguous = ['ropa', 'zapatos', 'bolso', 'bolsa', 'reloj', 'gafas', 'calzado', 'accesorio'].some(k => desc.includes(k));

  if (hasBrand && hasCategoryAmbiguous && hasReplicaKeywords) {
    return { tipo: 'Especial', razon: 'Réplica detectada' };
  }

  if (hasBrand && hasCategoryAmbiguous) {
    if (origen === 'colombia') {
      return { tipo: 'Especial', razon: 'Producto de lujo (marca + categoría)' };
    }
    return { tipo: 'Dudosa', razon: 'Producto de lujo potencial' };
  }

  return { tipo: 'General' };
}

/////////////////////// GOOGLE SHEETS ///////////////////////
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS || '';
  if (!credsRaw) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno');
  try {
    if (!credsRaw.trim().startsWith('{')) credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
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

/////////////////////// UTILIDADES ///////////////////////
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, '');
  if (s.startsWith('506')) s = s.slice(3);
  return s;
}
function replyBackToMenu(chatId) {
  bot.sendMessage(chatId, '¿Deseas volver al menú principal?', { reply_markup: mainMenuKeyboard() });
}
function extractRange(data, startRow, endRow, startCol, endCol) {
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

/////////////////////// CACHE ///////////////////////
let cache = {
  tarifas: {data: null, ts: 0 },
  direcciones: {data: null, ts: 0 }
};
const CACHE_TTL = 10 * 60 * 1000;

async function getCachedTarifas() {
  const now = Date.now();
  if (!cache.tarifas.data || (now - cache.tarifas.ts) > CACHE_TTL) {
    cache.tarifas.data = await leerTarifas();
    cache.tarifas.ts = now;
  }
  return cache.tarifas.data;
}
async function getCachedDirecciones(nombreCliente = 'Nombre de cliente') {
  const now = Date.now();
  if (!cache.direcciones.data || (now - cache.direcciones.ts) > CACHE_TTL) {
    const sheets = await getGoogleSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
    cache.direcciones.data = res.data.values || [];
    cache.direcciones.ts = now;
  }
  const data = cache.direcciones.data;
  const replaceName = (text) => (text || '').toString().replace(/Nombre de cliente/gi, nombreCliente);
  return {
    miami: replaceName(extractRange(data, 1, 4, 1, 3)),
    espana: replaceName(extractRange(data, 16, 20, 1, 3)),
    colombiaCon: replaceName(extractRange(data, 0, 6, 6, 9)),
    colombiaSin: replaceName(extractRange(data, 10, 16, 6, 9)),
    mexico: replaceName(extractRange(data, 23, 28, 1, 3)),
    china: replaceName(extractRange(data, 23, 28, 6, 9))
  };
}

/////////////////////// TECLADOS ///////////////////////
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo', '/prealertar']
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
      [{ text: '🇺🇸 Estados Unidos (Miami)', callback_data: 'CASILLERO|miami' }],
      [{ text: '🇪🇸 España (Madrid)', callback_data: 'CASILLERO|madrid' }],
      [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }]
    ]
  };
}
function origenKeyboardForPrealert() {
  return {
    keyboard: [
      ['Estados Unidos','Colombia','España'],
      ['China','Mexico','Cancelar']
    ],
    resize_keyboard: true, one_time_keyboard: true
  };
}
function siNoInlineKeyboard() {
  return { inline_keyboard: [[{ text: 'SI', callback_data: 'GAM|si' }, { text: 'NO', callback_data: 'GAM|no' }]] };
}

/////////////////////// CLIENTES ///////////////////////
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contact = normalizePhone(row[3] || '');
    if (contact && (contact === normalized || contact.endsWith(normalized) || normalized.endsWith(contact))) {
      return {
        rowIndex: i + 1,
        nombre: row[0] || '',
        correo: row[1] || '',
        telefono: row[3] || '',
        direccion: row[5] || '',
        saldo: parseFloat(row[7]) || 0
      };
    }
  }
  return null;
}
async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', correo || '', '', contacto || '', '', direccion || '', '', 0 ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:I',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

/////////////////////// TRACKINGS (Datos) ///////////////////////
async function getTrackingsByName(nombre) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:F' });
  const rows = res.data.values || [];
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[1]||'').toString().trim().toLowerCase();
    if (!name) continue;
    if (name === nombre.toLowerCase()) {
      items.push({
        rowIndex: i+1,
        tracking: r[0] || '',
        comentarios: r[2] || '',
        origen: r[3] || '',
        estado: r[4] || '',
        peso: r[5] || ''
      });
    }
  }
  return items;
}
async function savePrealertToDatos({ tracking, cliente, origen, observaciones, chatId }) {
  const sheets = await getGoogleSheetsClient();
  const row = new Array(9).fill('');
  row[0] = tracking || '';
  row[1] = cliente || 'Cliente Telegram';
  row[2] = '';
  row[3] = origen || '';
  row[4] = 'Pre-alertado';
  row[5] = '';
  row[6] = '';
  row[7] = '';
  row[8] = observaciones || '';
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
  const msg = `📣 Nueva prealerta\nTracking: ${tracking}\nCliente: ${cliente}\nOrigen: ${origen}\nObservaciones: ${observaciones}`;
  await bot.sendMessage(ADMIN_TELEGRAM_ID, msg);
}

/////////////////////// TARIFAS y DESCUENTOS ///////////////////////
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const ranges = [
    { range: 'Tarifas!B2' }, { range: 'Tarifas!B3' }, { range: 'Tarifas!B6' }, { range: 'Tarifas!B7' },
    { range: 'Tarifas!B10' }, { range: 'Tarifas!B11' }, { range: 'Tarifas!B13' }, { range: 'Tarifas!B15' },
    { range: 'Tarifas!G2:G7' }, { range: 'Tarifas!J1:J3' }
  ];
  const read = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: ranges.map(r => r.range) });
  const valueRanges = read.data.valueRanges || [];
  const getVal = (i) => {
    const v = (valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0] && valueRanges[i].values[0][0]) || '0';
    return parseFloat(String(v).replace(',', '.')) || 0;
  };

  const miami_sin = getVal(0), miami_con = getVal(1), col_sin = getVal(2), col_con = getVal(3),
        esp_sin = getVal(4), esp_con = getVal(5), china = getVal(6), mexico = getVal(7);

  let discountsArr = [0,0,0,0,0,0];
  try {
    const gVals = (valueRanges[8] && valueRanges[8].values) || [];
    discountsArr = gVals.map(v => {
      const n = parseFloat(String(v[0]||'0').replace(',', '.')) || 0;
      return n / 100;
    });
    while (discountsArr.length < 6) discountsArr.push(0);
  } catch (e) {}

  let deliveryCRC = 0, exchangeRate = 1;
  try {
    const jVals = (valueRanges[9] && valueRanges[9].values) || [];
    const arr = jVals.map(v => parseFloat(String(v[0]||'0').replace(',', '.')) || 0);
    deliveryCRC = arr[0] || 0;
    exchangeRate = arr[2] || 1;
  } catch (e) {}

  return {
    miami: { sinPermiso: miami_sin, conPermiso: miami_con },
    colombia: { sinPermiso: col_sin, conPermiso: col_con },
    espana: { sinPermiso: esp_sin, conPermiso: esp_con },
    china: { tarifa: china },
    mexico: { tarifa: mexico },
    discounts: discountsArr,
    j: { deliveryCRC, exchangeRate }
  };
}
function getDiscountPercentByPesoFromArr(pesoFacturable, discountsArr) {
  if (!discountsArr || discountsArr.length < 6) return 0;
  if (pesoFacturable >= 75) return discountsArr[5];
  if (pesoFacturable >= 50) return discountsArr[4];
  if (pesoFacturable >= 35) return discountsArr[3];
  if (pesoFacturable >= 25) return discountsArr[2];
  if (pesoFacturable >= 15) return discountsArr[1];
  return discountsArr[0] || 0;
}

/////////////////////// GUARDAR COTIZACION ///////////////////////
async function saveCotizacionToSheetAndNotifyAdmin(payload) {
  const sheets = await getGoogleSheetsClient();
  const row = new Array(17).fill('');
  row[0] = payload.fechaLocal || '';
  row[1] = payload.cliente || '';
  row[2] = payload.origen || '';
  row[3] = payload.peso || '';
  row[4] = payload.unidad || '';
  row[5] = payload.tipoPermiso || '';
  row[6] = payload.mercancia || '';
  row[7] = Math.round(payload.subtotalCRC || 0);
  row[8] = Math.round(payload.discountAmountCRC || 0);
  row[9] = Math.round(payload.totalCRC || 0);
  row[10] = Math.round(payload.deliveryCostCRC || 0);
  row[11] = Math.round(payload.totalWithDeliveryCRC || 0);
  row[12] = payload.exchangeRate || '';
  row[13] = '';
  row[14] = payload.id || '';
  row[15] = payload.contacto || '';
  row[16] = payload.email || '';
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cotizaciones!A:Q',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
  const adminMsg = [
    `📣 Nueva cotización (respaldo)`,
    `ID: ${payload.id}`,
    `Fecha: ${payload.fechaLocal}`,
    `Cliente: ${payload.cliente}`,
    `Origen: ${payload.origen}`,
    `Peso declarado: ${payload.peso} ${payload.unidad}`,
    `Peso facturable: ${payload.pesoFacturable} ${payload.unidadFacturable}`,
    `Tipo: ${payload.tipoPermiso}`,
    `Mercancía: ${payload.mercancia}`,
    `Subtotal: ¢${Math.round(payload.subtotalCRC)}`,
    `Descuento: ¢${Math.round(payload.discountAmountCRC)} (${(payload.discountPercent*100).toFixed(1)}%)`,
    `Costo entrega: ¢${Math.round(payload.deliveryCostCRC)}`,
    `Total (con entrega): ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `Tipo de cambio usado: ${payload.exchangeRate}`,
    `Contacto: ${payload.contacto || '-'}`,
    `Email: ${payload.email || '-'}`
  ].join('\n');
  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

/////////////////////// HISTORIAL ///////////////////////
async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const values = [[
    data.id, new Date().toISOString(), data.chatId, 'Cliente', data.email || '', data.origen || '', 'Costa Rica',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

/////////////////////// CÁLCULO DE COTIZACIÓN ///////////////////////
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  const tarifas = await getCachedTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;
  const origen = (state.origen || '').toLowerCase();
  const peso = parseFloat(state.peso) || 0;
  const unidad = state.unidad || 'lb';
  const tipoMercancia = state.tipoMercancia || 'General';
  const descripcion = state.descripcion || '';
  const entregaGAM = !!state.entregaGAM;
  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;

  let tarifaUSD = 0, pesoFacturable = 0, unidadFacturable = 'lb', subtotalUSD = 0;

  if (['colombia','col'].includes(origen)) {
    tarifaUSD = (tipoMercancia === 'Especial' || (state.categoriaSeleccionada || '').toLowerCase().includes('réplica')) ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origen.includes('mexico')) {
    tarifaUSD = tarifas.mexico.tarifa;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origen.includes('china')) {
    tarifaUSD = tarifas.china.tarifa;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (['miami','estados unidos','usa'].some(k => origen.includes(k))) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origen.includes('madrid') || origen.includes('espana') || origen.includes('españa')) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else {
    throw new Error('Origen no soportado');
  }

  const subtotalCRC = subtotalUSD * exchangeRate;
  const discountPercent = getDiscountPercentByPesoFromArr(pesoFacturable, tarifas.discounts || []);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;
  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
  const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
  const contacto = (state.client && state.client.telefono) ? state.client.telefono : (state.telefono || '');
  const email = (state.client && state.client.correo) ? state.client.correo : (state.correo || '');

  const payload = {
    id, fechaLocal, cliente: clienteName, origen, peso, unidad, tipoPermiso: tipoMercancia,
    mercancia: descripcion + (state.deliveryMethod ? `\nMétodo envío: ${state.deliveryMethod}` : ''),
    subtotalCRC, discountPercent, discountAmountCRC, totalCRC, deliveryCostCRC: deliveryCost,
    totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable, contacto, email
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);
  await guardarEnHistorial({
    id, chatId, email, origen, tipoMercancia, peso, unidad, pesoFacturable, tarifa: tarifaUSD,
    subtotal: subtotalUSD, discountPercent, discountAmount: discountAmountCRC / exchangeRate, total: totalCRC / exchangeRate
  });

  return {
    id, subtotalCRC, discountPercent, discountAmountCRC, totalCRC,
    deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable
  };
}

/////////////////////// COMANDOS ///////////////////////
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier. Usa /menu para ver opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  // Crear casillero no pide teléfono inicialmente, comienza con nombre
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});
bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  // Si hay teléfono cacheado, ofrecer usarlo
  const cached = getCachedPhone(chatId);
  if (cached) {
    setUserState(chatId, { modo: 'AWAIT_USE_CACHED', target: 'MI_CASILLERO' });
    return bot.sendMessage(chatId, `¿Desea usar el número anterior *${cached}* para consultar su casillero?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: `USE_PHONE|MI_CASILLERO|si` }, { text: 'No', callback_data: `USE_PHONE|MI_CASILLERO|no` } ]] }
    });
  }
  setUserState(chatId, { modo: 'MI_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Por favor ingresa tu número de teléfono con el que te registraste (ej: 88885555):');
});
bot.onText(/\/consultar_tracking/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = getCachedPhone(chatId);
  if (cached) {
    setUserState(chatId, { modo: 'AWAIT_USE_CACHED', target: 'CHECK_CASILLERO' });
    return bot.sendMessage(chatId, `¿Desea usar el número anterior *${cached}* para ver tus paquetes?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: `USE_PHONE|CHECK_CASILLERO|si` }, { text: 'No', callback_data: `USE_PHONE|CHECK_CASILLERO|no` } ]] }
    });
  }
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});
bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = getCachedPhone(chatId);
  if (cached) {
    setUserState(chatId, { modo: 'AWAIT_USE_CACHED', target: 'CHECK_SALDO' });
    return bot.sendMessage(chatId, `¿Desea usar el número anterior *${cached}* para verificar su saldo?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: `USE_PHONE|CHECK_SALDO|si` }, { text: 'No', callback_data: `USE_PHONE|CHECK_SALDO|no` } ]] }
    });
  }
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente (ej: 88885555).');
});
bot.onText(/\/prealertar/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = getCachedPhone(chatId);
  if (cached) {
    setUserState(chatId, { modo: 'AWAIT_USE_CACHED', target: 'PREALERT' });
    return bot.sendMessage(chatId, `¿Desea usar el número anterior *${cached}* para esta prealerta?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: `USE_PHONE|PREALERT|si` }, { text: 'No', callback_data: `USE_PHONE|PREALERT|no` } ]] }
    });
  }
  setUserState(chatId, { modo: 'PREALERT_NUM' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Escribe el NÚMERO DE TRACKING:');
});
bot.onText(/\/cotizar/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = getCachedPhone(chatId);
  if (cached) {
    setUserState(chatId, { modo: 'AWAIT_USE_CACHED', target: 'COTIZAR' });
    return bot.sendMessage(chatId, `¿Desea usar el número anterior *${cached}* para cotizar?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: `USE_PHONE|COTIZAR|si` }, { text: 'No', callback_data: `USE_PHONE|COTIZAR|no` } ]] }
    });
  }
  setUserState(chatId, { modo: 'COTIZAR_START' });
  bot.sendMessage(chatId, 'Ingresa tu número de teléfono (ej: 88885555) o escribe "NO" si no estás registrado.');
});

/////////////////////// CALLBACKS ///////////////////////
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    // --- Manejo USE_PHONE para reusar número cacheado ---
    if (data.startsWith('USE_PHONE|')) {
      const parts = data.split('|');
      const target = parts[1] || '';
      const ans = (parts[2] || '').toLowerCase();
      if (ans === 'si') {
        const cached = getCachedPhone(chatId);
        if (!cached) {
          return bot.sendMessage(chatId, 'No se encontró un número guardado. Por favor ingresa el número ahora.');
        }
        // según target, ejecutar el flujo correspondiente
        if (target === 'MI_CASILLERO') {
          const client = await findClientByPhone(cached);
          if (!client) return bot.sendMessage(chatId, 'Número no registrado. Usa /crear_casillero o ingresa otro número.');
          const state = { client };
          setUserState(chatId, state);
          const nombreRegistro = client.nombre;
          const dire = await getCachedDirecciones(nombreRegistro);
          return bot.sendMessage(chatId, 'Hola. Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
        }
        if (target === 'CHECK_CASILLERO') {
          const client = await findClientByPhone(cached);
          if (!client) return bot.sendMessage(chatId, 'Número no registrado. Usa /crear_casillero o ingresa otro número.');
          const items = await getTrackingsByName(client.nombre);
          if (!items?.length) return bot.sendMessage(chatId, 'No hay paquetes asociados.');
          setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page: 1 });
          return sendTrackingList(chatId, items, 1);
        }
        if (target === 'CHECK_SALDO') {
          const client = await findClientByPhone(cached);
          if (!client) return bot.sendMessage(chatId, 'Número no registrado. Usa /crear_casillero o ingresa otro número.');
          clearUserState(chatId);
          return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`);
        }
        if (target === 'PREALERT') {
          // usar número como cliente si existe, o continuar sin registrar
          const client = await findClientByPhone(cached);
          const st = getUserState(chatId) || {};
          st.client = client || null;
          st.modo = 'PREALERT_NUM';
          st.prealertTracking = null;
          setUserState(chatId, st);
          return bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Escribe el NÚMERO DE TRACKING:');
        }
        if (target === 'COTIZAR') {
          const client = await findClientByPhone(cached);
          const st = getUserState(chatId) || {};
          st.client = client || null;
          st.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, st);
          return bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN?', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
        }
        return bot.sendMessage(chatId, 'Acción no reconocida.');
      } else {
        // ans === 'no' -> pedir número nuevo y setear modo apropiado según target
        if (data.includes('|MI_CASILLERO|')) {
          setUserState(chatId, { modo: 'MI_CASILLERO_PHONE' });
          return bot.sendMessage(chatId, 'Por favor ingresa tu número de teléfono con el que te registraste (ej: 88885555):');
        }
        if (data.includes('|CHECK_CASILLERO|')) {
          setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
          return bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
        }
        if (data.includes('|CHECK_SALDO|')) {
          setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
          return bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente (ej: 88885555).');
        }
        if (data.includes('|PREALERT|')) {
          setUserState(chatId, { modo: 'PREALERT_IDENT' }); // we expect ident (phone/email) next
          return bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas registrar este tracking (ej: 88885555) o responde "NO" si no estás registrado.');
        }
        if (data.includes('|COTIZAR|')) {
          setUserState(chatId, { modo: 'COTIZAR_START' });
          return bot.sendMessage(chatId, 'Ingresa tu número de teléfono (ej: 88885555) o escribe "NO" si no estás registrado.');
        }
        return bot.sendMessage(chatId, 'Operación cancelada. Usa /menu para volver al inicio.');
      }
    }

    // --- Flujos originales (categoría, casillero, etc.) ---
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (obligatorio).`, { parse_mode: 'Markdown' });
    }
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      if (pais === 'colombia') {
        const state = getUserState(chatId) || {};
        state.modo = 'COL_DESCRIPCION';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Describe brevemente la mercancía que recibirás en Colombia (ej: "camisetas", "perfume Chanel", "zapatos Nike réplica"):');
      } else {
        const state = getUserState(chatId) || {};
        const nombreRegistro = (state.client && state.client.nombre) || 'Cliente';
        const dire = await getCachedDirecciones(nombreRegistro);
        let direccion = 'No disponible';
        const nombres = { miami:'Miami', madrid:'Madrid', mexico:'Ciudad de México', china:'China' };
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid') direccion = dire.espana;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n${direccion}`, { parse_mode: 'Markdown' });
      }
    }
    if (data.startsWith('COLDIR|')) {
      const tipo = data.split('|')[1];
      const nombreRegistro = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getCachedDirecciones(nombreRegistro);
      const direccion = tipo === 'especial' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='especial'?'Especial / Réplica':'Carga General'})*:\n${direccion}`, { parse_mode: 'Markdown' });
    }
    if (data.startsWith('GAM|')) {
      const val = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.entregaGAM = (val === 'si');
      st.modo = 'COTIZAR_FINAL_CONFIRM';
      setUserState(chatId, st);
      if (!st.entregaGAM) {
        return bot.sendMessage(chatId, '¿El envío se realizará por "Encomienda" o "Correos de C.R"?', {
          reply_markup: { keyboard:[['Encomienda','Correos de C.R'],['Cancelar']], resize_keyboard:true, one_time_keyboard:true }
        });
      } else {
        if (st.client) {
          await bot.sendMessage(chatId, 'Procesando cotización...');
          try {
            const res = await calcularYRegistrarCotizacionRespaldo(chatId, st);
            clearUserState(chatId);
            const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
            const nota = "\n\n📝 Nota: Los montos aquí mostrados son aproximados y pueden variar según el tipo de cambio al momento del cobro, el peso final del paquete y la clasificación real de la mercancía.";
            const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})${nota}`;
            await bot.sendMessage(chatId, msg);
            replyBackToMenu(chatId);
          } catch (e) {
            clearUserState(chatId);
            return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización.');
          }
        } else {
          return bot.sendMessage(chatId, 'Por favor ingresa tu número de teléfono con el que te registraste (ej: 88885555) o escribe "NO" para cotizar sin registro.');
        }
      }
    }
    if (data.startsWith('PRE_ORIG|')) {
      const orig = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.prealertOrigen = orig;
      st.modo = 'PREALERT_OBS';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
    }
    if (data.startsWith('TRACK_PAGE|')) {
      const page = parseInt(data.split('|')[1]||'1',10);
      const st = getUserState(chatId) || {};
      return sendTrackingList(chatId, st.itemsCache || [], page);
    }
    if (data.startsWith('TRACK_DETAIL|')) {
      const idx = parseInt(data.split('|')[1]||'0',10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      const item = items[idx];
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado.');
      const text = `📦 *Tracking:* ${item.tracking}\n*Origen:* ${item.origen}\n*Estado:* ${item.estado}\n*Peso:* ${item.peso}\n*Comentarios:* ${item.comentarios || '-'}`;
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }
    if (data.startsWith('TRACK_EXPORT|')) {
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      if (!items.length) return bot.sendMessage(chatId, 'No hay paquetes para exportar.');
      let txt = `Respaldo de trackings (${items.length}):\n`;
      items.forEach((it,i)=> { txt += `\n${i+1}. ${it.tracking} — ${it.origen} — ${it.estado} — ${it.peso}\nComentarios: ${it.comentarios||'-'}\n`; });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, txt);
      return bot.sendMessage(chatId, 'Listado enviado como respaldo al administrador.');
    }

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.');
  }
});

/////////////////////// MENSAJES LIBRES ///////////////////////
bot.on('message', async (msg) => {
  try {
    if (!msg.text) return;
    // Ignorar comandos aquí; ya los maneja bot.onText
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // Si NO hay un estado (usuario no está en un flujo), responder mensaje genérico amable
    if (!state || !state.modo) {
      return bot.sendMessage(chatId,
        `¡Hola! 👋\nBienvenido a *J.I Asesoría & Courier*.\n\nPara usar nuestro sistema selecciona una opción del menú o escribe uno de los comandos:\n/prealertar\n/consultar_tracking\n/crear_casillero\n/mi_casillero\n/cotizar\n/saldo\n\nSi necesitas ayuda escribe /ayuda.`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
      );
    }

    // --- Flujos existentes que dependen de state.modo ---
    // CREAR CASILLERO
    if (state.modo === 'CREAR_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) return bot.sendMessage(chatId, 'Por favor ingresa *Nombre completo* con al menos 1 nombre y 2 apellidos.', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ahora ingresa tu *correo electrónico* para contacto.', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa ahora tu *número de contacto* (ej: 88885555).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos locales (ej: 88885555).');
      const existing = await findClientByPhone(phone);
      if (existing) {
        clearUserState(chatId);
        bot.sendMessage(chatId, `Ya existe un registro con ese número bajo el nombre: *${existing.nombre}*. Si es tuyo, usa /mi_casillero.`, { parse_mode: 'Markdown' });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `Intento de registro con número ya existente: ${phone} por chat ${chatId}`);
        return;
      }
      state.telefono = phone;
      // Guardar teléfono en cache
      savePhone(chatId, phone);
      state.modo = 'CREAR_DIRECCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `✅ Nuevo registro: ${state.nombre} - ${state.telefono} - ${state.correo}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      return replyBackToMenu(chatId);
    }

    // MI_CASILLERO_PHONE
    if (state.modo === 'MI_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      // guardar en cache
      savePhone(chatId, phone);
      const client = await findClientByPhone(phone);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      state.client = client;
      setUserState(chatId, state);
      const nombreRegistro = client.nombre;
      const dire = await getCachedDirecciones(nombreRegistro);
      return bot.sendMessage(chatId, 'Hola. Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
    }

    // COL_DESCRIPCION (Colombia automático)
    if (state.modo === 'COL_DESCRIPCION') {
      const desc = text;
      const classification = classifyProduct({ descripcion: desc, origen: 'colombia' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        return bot.sendMessage(chatId, '⚠️ Mercancía prohibida para casillero en Colombia.');
      }
      const nombreRegistro = (state.client && state.client.nombre) || 'Cliente';
      const dire = await getCachedDirecciones(nombreRegistro);
      const direccion = classification.tipo === 'Especial' ? dire.colombiaCon : dire.colombiaSin;
      const tipoStr = classification.tipo === 'Especial' ? 'Especial / Réplica' : 'Carga General';
      clearUserState(chatId);
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipoStr})*:\n${direccion}`, { parse_mode: 'Markdown' });
    }

    // COTIZAR
    if (state.modo === 'COTIZAR_START') {
      const ident = text.toLowerCase();
      if (ident === 'no') {
        state.client = null;
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* (para registrar la cotización).', { parse_mode: 'Markdown' });
      } else {
        const client = await findClientByPhone(ident);
        // guardar en cache si se ingresó número
        const normalized = normalizePhone(ident);
        if (normalized) savePhone(chatId, normalized);
        if (!client) {
          state.modo = 'COTIZAR_UNREG_PROMPT';
          state.unregCandidatePhone = normalizePhone(ident);
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No encontrado. ¿Deseas registrarte? Responde SI o NO.');
        } else {
          state.client = client;
          state.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN?', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
        }
      }
    }
    if (state.modo === 'COTIZAR_UNREG_PROMPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Vamos a crear tu casillero. Escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
      } else if (ans === 'no' || ans === 'n') {
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* para continuar con la cotización.', { parse_mode: 'Markdown' });
      } else {
        return bot.sendMessage(chatId, 'Responde SI o NO por favor.');
      }
    }
    if (state.modo === 'COTIZAR_UNREG_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu nombre completo (mínimo nombre y apellido).');
      state.nombre = text;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo electrónico (obligatorio).');
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correo = text;
      state.modo = 'COTIZAR_UNREG_TELEFONO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de teléfono de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREG_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos.');
      state.telefono = phone;
      // guardar en cache
      savePhone(chatId, phone);
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN:', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
    }
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      const validMap = { 'miami': 'miami', 'madrid': 'madrid', 'colombia': 'colombia', 'mexico': 'mexico', 'china': 'china' };
      const normalized = validMap[origin] || origin;
      if (!['miami','madrid','colombia','mexico','china'].includes(normalized)) {
        return bot.sendMessage(chatId, 'Origen inválido. Usa el teclado.');
      }
      state.origen = normalized;
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.');
      }
      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb).');
    }
    if (state.modo === 'COTIZAR_PESO') {
      const pesoMatch = text.match(/([\d.]+)\s*(kg|kgs|kilos|kilo|kilogramos|lb|lbs|libras|libra)/i);
      if (!pesoMatch) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg, 3 kilos, 3 lb o 4 libras');
      const rawUnit = pesoMatch[2].toLowerCase();
      const unit = /kg|kilo|kilos|kgs|kilogramos/.test(rawUnit) ? 'kg' : 'lb';
      state.peso = parseFloat(pesoMatch[1]);
      state.unidad = unit;
      state.modo = 'COTIZAR_GAM';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', { reply_markup: siNoInlineKeyboard() });
    }
    if (state.modo === 'COTIZAR_FINAL_CONFIRM') {
      if (!state.entregaGAM && (text === 'Encomienda' || text === 'Correos de C.R')) {
        state.deliveryMethod = text;
        await bot.sendMessage(chatId, 'Procesando cotización...');
        try {
          const res = await calcularYRegistrarCotizacionRespaldo(chatId, state);
          clearUserState(chatId);
          const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
          const nota = "\n\n📝 Nota: Los montos aquí mostrados son aproximados y pueden variar según el tipo de cambio al momento del cobro, el peso final del paquete y la clasificación real de la mercancía.";
          const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})${nota}`;
          bot.sendMessage(chatId, msg);
          replyBackToMenu(chatId);
          return;
        } catch (e) {
          clearUserState(chatId);
          bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización.');
          return;
        }
      }
      return bot.sendMessage(chatId, 'Selecciona "Encomienda" o "Correos de C.R" (usa el teclado).', { reply_markup: { keyboard: [['Encomienda','Correos de C.R'],['Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
    }

    // Otros flujos (CHECK_SALDO_PHONE, PREALERT, etc.)

    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      savePhone(chatId, phone);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      const items = await getTrackingsByName(client.nombre);
      if (!items?.length) return bot.sendMessage(chatId, 'No hay paquetes asociados.');
      return sendTrackingList(chatId, items, 1);
    }
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      savePhone(chatId, phone);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`);
    }
    if (state.modo === 'PREALERT_NUM') {
      state.prealertTracking = text;
      state.modo = 'PREALERT_IDENT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas registrar este tracking (ej: 88885555) o responde "NO" si no estás registrado.');
    }
    if (state.modo === 'PREALERT_IDENT') {
      const ident = text.toLowerCase();
      let client = null;
      if (ident !== 'no') {
        if (ident.includes('@')) {
          const sheets = await getGoogleSheetsClient();
          const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I' });
          const rows = res.data.values || [];
          for (let i = 0; i < rows.length; i++) {
            if ((rows[i][1]||'').toString().toLowerCase() === ident) {
              client = { nombre: rows[i][0] || '', correo: rows[i][1] || '', telefono: rows[i][3] || '' };
              break;
            }
          }
        } else {
          // es teléfono
          const phone = normalizePhone(ident);
          savePhone(chatId, phone);
          client = await findClientByPhone(ident);
        }
      }
      if (!client && ident !== 'no') {
        // preguntar si desea registrarse
        state.modo = 'PREALERT_UNREG_PROMPT';
        state.unregCandidatePhone = normalizePhone(ident);
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Número/correo no registrado. ¿Deseas registrarte? Responde SI o NO.');
      }
      state.client = client || null;
      state.modo = 'PREALERT_ORIG';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete:', { reply_markup: origenKeyboardForPrealert() });
    }
    if (state.modo === 'PREALERT_UNREG_PROMPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Vamos a crear tu casillero. Escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
      } else if (ans === 'no' || ans === 'n') {
        // continuar sin cliente
        state.client = null;
        state.modo = 'PREALERT_ORIG';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete:', { reply_markup: origenKeyboardForPrealert() });
      } else {
        return bot.sendMessage(chatId, 'Responde SI o NO por favor.');
      }
    }
    if (state.modo === 'PREALERT_ORIG') {
      const chosen = text.toLowerCase();
      const mapping = { 'estados unidos': 'Estados Unidos', 'miami': 'Estados Unidos', 'colombia': 'Colombia', 'españa': 'España', 'espana': 'España', 'china': 'China', 'mexico': 'Mexico' };
      const orig = mapping[chosen] || text;
      state.prealertOrigen = orig;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
    }
    if (state.modo === 'PREALERT_OBS') {
      const obs = text;
      const classification = classifyProduct({ descripcion: obs, origen: state.prealertOrigen || '' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptar esta prealerta.');
      }
      let clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
      await savePrealertToDatos({
        tracking: state.prealertTracking,
        cliente: clienteName,
        origen: state.prealertOrigen || '',
        observaciones: `Tipo: ${obs} - Prealertado: ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`,
        chatId
      });
      clearUserState(chatId);
      bot.sendMessage(chatId, '✅ Prealerta registrada correctamente.');
      replyBackToMenu(chatId);
      return;
    }

  } catch (err) {
    console.error('Error en message handler:', err);
    bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente o usa /menu.');
  }
});

/////////////////////// TRACKING PAGINADO ///////////////////////
const TRACKS_PER_PAGE = 5;
async function sendTrackingList(chatId, items, page = 1) {
  if (!items?.length) return bot.sendMessage(chatId, 'No se encontraron paquetes.');
  const totalPages = Math.ceil(items.length / TRACKS_PER_PAGE);
  page = Math.max(1, Math.min(page, totalPages));
  const start = (page - 1) * TRACKS_PER_PAGE;
  const slice = items.slice(start, start + TRACKS_PER_PAGE);
  const lines = slice.map((it, idx) => `${start + idx + 1}. ${it.tracking || '(sin tracking)'} — ${it.origen || '-'} — ${it.estado || '-'} — ${it.peso || '-'}`).join('\n');
  const inline = slice.map((it, idx) => [{ text: `Ver ${start+idx+1}`, callback_data: `TRACK_DETAIL|${start+idx}` }]);
  const paging = [];
  if (page > 1) paging.push({ text: '◀️ Anterior', callback_data: `TRACK_PAGE|${page-1}` });
  if (page < totalPages) paging.push({ text: 'Siguiente ▶️', callback_data: `TRACK_PAGE|${page+1}` });
  if (items.length > 20) paging.push({ text: 'Exportar (respaldo)', callback_data: `TRACK_EXPORT|all` });
  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n${lines}`, {
    reply_markup: { inline_keyboard: inline.concat([paging]) }
  });
  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

/////////////////////// WEBHOOK / STARTUP ///////////////////////
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch (e) { console.error('processUpdate error', e); } });
app.get('/', (req, res) => res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  const webhookUrl = `${URL_BASE}/${TELEGRAM_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  } catch (err) {
    console.error('Error configurando webhook:', err);
  }
});
