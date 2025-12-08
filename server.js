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

const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china','estados unidos','estados unidos','espana','españa']; // permitimos varios alias

/////////////////////// GOOGLE SHEETS ///////////////////////
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS || '';
  if (!credsRaw) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno');
  // acepta JSON directo o base64
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
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}
function toLocalCRISOString() {
  // iso string local tz
  return new Date().toISOString();
}

function replyBackToMenu(chatId) {
  bot.sendMessage(chatId, '¿Deseas volver al menú principal?', { reply_markup: mainMenuKeyboard() });
}

// extraer rango (helper para Direcciones)
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
function gamKeyboardQuick() {
  return {
    keyboard: [
      ['SI','NO']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function prealertOriginInline() {
  return {
    inline_keyboard: [
      [{ text: 'Estados Unidos', callback_data: 'PRE_ORIG|Estados Unidos' }],
      [{ text: 'Colombia', callback_data: 'PRE_ORIG|Colombia' }],
      [{ text: 'España', callback_data: 'PRE_ORIG|España' }],
      [{ text: 'China', callback_data: 'PRE_ORIG|China' }],
      [{ text: 'Mexico', callback_data: 'PRE_ORIG|Mexico' }],
    ]
  };
}

/////////////////////// LECTURA DIRECCIONES ///////////////////////
async function getDireccionesForCliente(nombreCliente = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
  const data = res.data.values || [];
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

/////////////////////// CLIENTES ///////////////////////
// Asumimos hoja Clientes con columnas: A Nombre, B Correo, C password, D Telefono, F Direccion (user said F earlier but also G H used across code — we'll read as A,B,C,D,F)
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contact = normalizePhone(row[3] || '');
    if (contact && (contact === normalized || contact.endsWith(normalized) || normalized.endsWith(contact))) {
      // name col A index0, email col B index1, telefono index3, direccion index5 (F -> index5), saldo H index7
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

// Prealerta: guardar en Datos: A tracking, B cliente, C '', D origen, E estado (Pre-alertado), ... I observaciones
async function savePrealertToDatos({ tracking, cliente, origen, observaciones, chatId }) {
  const sheets = await getGoogleSheetsClient();
  // create row with at least 9 columns to fill until I
  const row = new Array(9).fill('');
  row[0] = tracking || '';
  row[1] = cliente || 'Cliente Telegram';
  row[2] = ''; // C
  row[3] = origen || '';
  row[4] = 'Pre-alertado'; // E estado
  row[5] = ''; // F
  row[6] = ''; // G
  row[7] = ''; // H
  row[8] = observaciones || ''; // I

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });

  // notify admin
  const msg = `📣 Nueva prealerta\nTracking: ${tracking}\nCliente: ${cliente}\nOrigen: ${origen}\nObservaciones: ${observaciones}`;
  await bot.sendMessage(ADMIN_TELEGRAM_ID, msg);
}

/////////////////////// TARIFAS y DESCUENTOS ///////////////////////
// Leer exactamente las celdas que me indicaste
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();

  // leer tarifas puntuales
  // Miami: B2 (sin permiso), B3 (con permiso)
  // Colombia: B6 (sin), B7 (con)
  // España: B10 (sin), B11 (con)
  // China: B13
  // Mexico: B15
  const ranges = [
    { key: 'miami_sin', range: 'Tarifas!B2' },
    { key: 'miami_con', range: 'Tarifas!B3' },
    { key: 'col_sin', range: 'Tarifas!B6' },
    { key: 'col_con', range: 'Tarifas!B7' },
    { key: 'esp_sin', range: 'Tarifas!B10' },
    { key: 'esp_con', range: 'Tarifas!B11' },
    { key: 'china', range: 'Tarifas!B13' },
    { key: 'mexico', range: 'Tarifas!B15' },
    { key: 'g2g7', range: 'Tarifas!G2:G7' }, // descuentos (porcentajes)
    { key: 'j1j3', range: 'Tarifas!J1:J3' } // J1 delivery en CRC, J3 tipo de cambio
  ];

  const batch = ranges.map(r => ({ range: r.range }));
  let read;
  try {
    read = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: batch });
  } catch (err) {
    console.error('Error leyendo tarifas (batchGet):', err);
    throw err;
  }

  const valueRanges = read.data.valueRanges || [];
  const getVal = (i) => {
    const v = (valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0] && valueRanges[i].values[0][0]) || '0';
    return parseFloat(String(v).replace(',', '.')) || 0;
  };

  const miami_sin = getVal(0);
  const miami_con = getVal(1);
  const col_sin = getVal(2);
  const col_con = getVal(3);
  const esp_sin = getVal(4);
  const esp_con = getVal(5);
  const china = getVal(6);
  const mexico = getVal(7);

  // descuentos
  let discountsArr = [];
  try {
    const gVals = (valueRanges[8] && valueRanges[8].values) || [];
    // gVals is array of arrays [[val],[val]...]
    discountsArr = gVals.map(v => {
      const n = parseFloat(String(v[0]||'0').replace(',', '.')) || 0;
      return n / 100; // convert percent to decimal
    });
    // ensure length 6
    while (discountsArr.length < 6) discountsArr.push(0);
  } catch (e) {
    discountsArr = [0,0,0,0,0,0];
  }

  // j1 j3
  let deliveryCRC = 0, exchangeRate = 1;
  try {
    const jVals = (valueRanges[9] && valueRanges[9].values) || [];
    const arr = jVals.map(v => parseFloat(String(v[0]||'0').replace(',', '.')) || 0);
    deliveryCRC = arr[0] || 0;
    exchangeRate = arr[2] || 1;
  } catch (e) {
    deliveryCRC = 0; exchangeRate = 1;
  }

  return {
    miami: { sinPermiso: miami_sin, conPermiso: miami_con },
    colombia: { sinPermiso: col_sin, conPermiso: col_con },
    espana: { sinPermiso: esp_sin, conPermiso: esp_con },
    china: { tarifa: china },
    mexico: { tarifa: mexico },
    discounts: discountsArr, // [G2..G7] as decimals
    j: { deliveryCRC, exchangeRate }
  };
}

// descuento dinámico por peso (pesoFacturable)
function getDiscountPercentByPesoFromArr(pesoFacturable, discountsArr) {
  // discountsArr indices: 0->0-14, 1->15-24, 2->25-34, 3->35-49, 4->50-74, 5->75+
  if (!discountsArr || discountsArr.length < 6) return 0;
  if (pesoFacturable >= 75) return discountsArr[5];
  if (pesoFacturable >= 50) return discountsArr[4];
  if (pesoFacturable >= 35) return discountsArr[3];
  if (pesoFacturable >= 25) return discountsArr[2];
  if (pesoFacturable >= 15) return discountsArr[1];
  return discountsArr[0] || 0;
}

/////////////////////// GUARDAR COTIZACION ///////////////////////
/*
A..Q columns mapping:
A Fecha Cot
B Cliente
C Origen
D Peso
E Unidad
F Tipo Permiso
G Mercancía
H Sub Total (colones)
I Descuento (colones)
J Total (colones)
K Costo Entrega (colones)
L Total con Entrega (colones)
M Tipo de Cambio
N (vacío)
O ID de cotización
P Número Contacto
Q Correo
*/
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
  row[13] = ''; // N
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
  const now = new Date().toISOString();
  const values = [[
    data.id, data.fecha || now, data.chatId, 'Cliente', data.email || '', data.origen || '', data.destino || '',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

/////////////////////// CÁLCULO DE COTIZACIÓN ///////////////////////
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  // state: origen, peso, unidad, tipoMercancia, descripcion, entregaGAM (bool), client (optional), nombre/telefono/correo if not registered, categoriaSeleccionada, deliveryMethod (if entregaGAM==false)
  const tarifas = await leerTarifas();
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

  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotalUSD = 0;

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
  } else if (origen.includes('miami') || origen.includes('estados unidos') || origen.includes('usa') ) {
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
    id,
    fechaLocal,
    cliente: clienteName,
    origen,
    peso,
    unidad,
    tipoPermiso: tipoMercancia,
    mercancia: descripcion + (state.deliveryMethod ? `\nMétodo envío: ${state.deliveryMethod}` : ''),
    subtotalCRC,
    discountPercent,
    discountAmountCRC,
    totalCRC,
    deliveryCostCRC: deliveryCost,
    totalWithDeliveryCRC,
    exchangeRate,
    pesoFacturable,
    unidadFacturable,
    contacto,
    email
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);

  await guardarEnHistorial({
    id,
    fecha: new Date().toISOString(),
    chatId,
    email,
    origen,
    destino: 'Costa Rica',
    tipoMercancia,
    peso,
    unidad,
    pesoFacturable,
    tarifa: tarifaUSD,
    subtotal: subtotalUSD,
    discountPercent,
    discountAmount: discountAmountCRC / exchangeRate,
    total: totalCRC / exchangeRate
  });

  // notify the chat admin already done in saveCotizacionToSheetAndNotifyAdmin
  return {
    id,
    subtotalCRC,
    discountPercent,
    discountAmountCRC,
    totalCRC,
    deliveryCostCRC: deliveryCost,
    totalWithDeliveryCRC,
    exchangeRate,
    pesoFacturable,
    unidadFacturable
  };
}

/////////////////////// MENSAJES / COMANDOS ///////////////////////
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier. Usa /menu para ver opciones.`, { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
});

// Crear casillero
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  // We attempt to keep last known phone in session
  const st = getUserState(chatId) || {};
  st.modo = 'MI_CASILLERO_CHOOSE';
  setUserState(chatId, st);
  bot.sendMessage(chatId, 'Hola. Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
});

// consultar_tracking (similar to mi_casillero but asks phone)
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});

// saldo
bot.onText(/\/saldo/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente (ej: 88885555).');
});

// prealertar
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_NUM' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Escribe el NÚMERO DE TRACKING:');
});

/////////////////////// CALLBACKS ///////////////////////
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    // categoria select in cotizar
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (obligatorio).`, { parse_mode: 'Markdown' });
    }

    // casillero country selected
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      const nombreRegistro = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDireccionesForCliente(nombreRegistro);
      if (pais === 'colombia') {
        // Ask special or general then show addresses
        return bot.sendMessage(chatId, 'Selecciona tipo de casillero en Colombia:', { reply_markup: { inline_keyboard: [[{ text: '🔒 Mercancía Especial / Réplica', callback_data: 'COLDIR|especial' }],[{ text: '📦 Carga General', callback_data: 'COLDIR|general' }]] } });
      } else {
        let direccion = 'No disponible';
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid') direccion = dire.espana || dire.miami;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        const nombres = { miami:'Miami', madrid:'Madrid', mexico:'Ciudad de México', china:'China' };
        return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
      }
    }

    if (data.startsWith('COLDIR|')) {
      const tipo = data.split('|')[1];
      const nombreRegistro = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDireccionesForCliente(nombreRegistro);
      const direccion = tipo === 'especial' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='especial'?'Especial / Réplica':'Carga General'})*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }

    // GAM selection (inline)
    if (data.startsWith('GAM|')) {
      const val = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.entregaGAM = (val === 'si');
      st.modo = 'COTIZAR_FINAL_CONFIRM'; // ask for contact if needed or proceed
      setUserState(chatId, st);
      // If NO, ask delivery method
      if (!st.entregaGAM) {
        return bot.sendMessage(chatId, '¿El envío se realizará por "Encomienda" o "Correos de C.R"?', { reply_markup: { keyboard:[['Encomienda','Correos de C.R'],['Cancelar']], resize_keyboard:true, one_time_keyboard:true } });
      } else {
        // proceed to contact step (but no email unless unregistered)
        // if client already matched, proceed to compute; otherwise ask email/phone
        if (st.client) {
          // compute
          await bot.sendMessage(chatId, 'Procesando cotización...');
          try {
            const res = await calcularYRegistrarCotizacionRespaldo(chatId, st);
            clearUserState(chatId);
            const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
            const msgResp = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})`;
            await bot.sendMessage(chatId, msgResp);
            replyBackToMenu(chatId);
            return;
          } catch (e) {
            console.error('Error procesando cotizacion (GAM callback):', e);
            clearUserState(chatId);
            return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.');
          }
        } else {
          // ask contact (phone/email) - handled in message handler
          return bot.sendMessage(chatId, 'Por favor ingresa tu número de teléfono con el que te registraste (ej: 88885555) o escribe "NO" para cotizar sin registro.');
        }
      }
    }

    // prealert origin inline
    if (data.startsWith('PRE_ORIG|')) {
      const orig = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.prealertOrigen = orig;
      st.modo = 'PREALERT_OBS';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
    }

    // tracking pagination / detail / export: reuse earlier logic if present in state
    if (data.startsWith('TRACK_PAGE|')) {
      const page = parseInt(data.split('|')[1]||'1',10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      return sendTrackingList(chatId, items, page);
    }
    if (data.startsWith('TRACK_DETAIL|')) {
      const idx = parseInt(data.split('|')[1]||'0',10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      const item = items[idx];
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado o expiró la lista. Vuelve a consultar.');
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
    // ignore commands handled elsewhere
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const textRaw = msg.text.trim();
    const text = textRaw;
    const state = getUserState(chatId) || {};

    // ---------------- CREAR CASILLERO ----------------
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
      state.modo = 'CREAR_DIRECCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      // notify admin
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `✅ Nuevo registro: ${state.nombre} - ${state.telefono} - ${state.correo}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      return replyBackToMenu(chatId);
    }

    // ---------------- CHECK CASILLERO (consultar tracking) ----------------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) {
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      }
      // fetch trackings
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) {
        return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.');
      }
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // ---------------- CHECK SALDO ----------------
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`);
    }

    // ---------------- PREALERT FLOW ----------------
    if (state.modo === 'PREALERT_NUM') {
      // user wrote tracking number
      state.prealertTracking = text;
      state.modo = 'PREALERT_IDENT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas registrar este tracking (ej: 88885555) o responde "NO" si no estás registrado.');
    }
    if (state.modo === 'PREALERT_IDENT') {
      const ident = text.toLowerCase();
      // try phone first
      let client = null;
      if (ident !== 'no') {
        // if looks like email or phone
        if (ident.includes('@')) {
          // search by email (simple scan)
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
          client = await findClientByPhone(ident);
        }
      }
      state.client = client || null;
      state.modo = 'PREALERT_ORIG';
      setUserState(chatId, state);
      // ask origin using keyboard
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete:', { reply_markup: origenKeyboardForPrealert() });
    }
    if (state.modo === 'PREALERT_OBS') {
      // we reached here after PRE_ORIG inline or after origin keyboard step
      // ensure we have tracking and origin (prealertTracking and prealertOrigen)
      const obs = text;
      state.prealertObserv = obs;
      // ensure cliente name
      let clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
      await savePrealertToDatos({
        tracking: state.prealertTracking,
        cliente: clienteName,
        origen: state.prealertOrigen || state.prealertOrigenKeyboard || '',
        observaciones: `Tipo: ${obs} - Prealertado: ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`,
        chatId
      });
      clearUserState(chatId);
      await bot.sendMessage(chatId, '✅ Prealerta registrada correctamente. Gracias.');
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `🔔 Prealerta: ${state.prealertTracking} - ${clienteName} - ${state.prealertOrigen} - ${obs}`);
      return replyBackToMenu(chatId);
    }

    // If user selected origin with keyboard for prealert (text match)
    if (getUserState(chatId) && getUserState(chatId).modo === 'PREALERT_ORIG') {
      const chosen = text.toLowerCase();
      const mapping = {
        'estados unidos': 'Estados Unidos',
        'estados unidos (miami)': 'Estados Unidos',
        'miami': 'Estados Unidos',
        'colombia': 'Colombia',
        'españa': 'España',
        'espana': 'España',
        'china': 'China',
        'mexico': 'Mexico',
        'méxico': 'Mexico'
      };
      const orig = mapping[chosen] || text;
      const st = getUserState(chatId) || {};
      st.prealertOrigen = orig;
      st.modo = 'PREALERT_OBS';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
    }

    // ---------------- COTIZAR FLOW ----------------
    // Start: we expect /cotizar command to set modo 'COTIZAR_START' and ask phone. But allow also initiating by /cotizar command (handled below).
    if (state.modo === 'COTIZAR_START') {
      // the user sent phone or "NO" to continue unregistered
      const ident = text.toLowerCase();
      if (ident === 'no') {
        // proceed as unregistered -> ask name
        state.client = null;
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No hay problema. Ingresa tu *Nombre completo* (para registrar la cotización).', { parse_mode: 'Markdown' });
      } else {
        // treat as phone
        const client = await findClientByPhone(ident);
        if (!client) {
          // ask if wants to register or continue unregistered
          state.modo = 'COTIZAR_UNREG_PROMPT';
          state.unregCandidatePhone = normalizePhone(ident);
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No encontramos registro con ese número. ¿Deseas registrarte ahora? Responde SI para crear casillero, NO para continuar sin registro.');
        } else {
          // matched
          state.client = client;
          state.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN? (toca una opción)', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], one_time_keyboard: true, resize_keyboard: true } });
        }
      }
    }

    // if user said SI to register during cotizar
    if (state.modo === 'COTIZAR_UNREG_PROMPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        // start registration
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Vamos a crear tu casillero. Escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
      } else if (ans === 'no' || ans === 'n') {
        // continue unregistered but ask name, phone, email
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Ingresa tu *Nombre completo* para continuar con la cotización.', { parse_mode: 'Markdown' });
      } else {
        return bot.sendMessage(chatId, 'Responde SI o NO por favor.');
      }
    }

    if (state.modo === 'COTIZAR_UNREG_NOMBRE' || state.modo === 'COTIZAR_UNREG_NOMBRE') {
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
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos locales (ej: 88885555).');
      state.telefono = phone;
      // now proceed to origin selection
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN (toca una opción):', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], one_time_keyboard: true, resize_keyboard: true } });
    }

    // COTIZAR_ORIGEN text
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      const validMap = {
        'miami': 'miami',
        'madrid': 'madrid',
        'colombia': 'colombia',
        'mexico': 'mexico',
        'china': 'china',
        'estados unidos': 'miami',
        'estados unidos (miami)': 'miami',
        'espana': 'madrid',
        'españa': 'madrid'
      };
      const normalized = validMap[origin] || origin;
      if (!['miami','madrid','colombia','mexico','china'].includes(normalized)) {
        return bot.sendMessage(chatId, 'Origen inválido. Selecciona uno de: miami, madrid, colombia, mexico, china (usa el teclado).');
      }
      state.origen = normalized;
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    // COTIZAR_DESCRIPCION
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
      state.tipoMercancia = classification.tipo; // General or Especial
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb, 3 libras, 5 kilos).');
    }

    // COTIZAR_PESO
    if (state.modo === 'COTIZAR_PESO') {
      const pesoMatch = text.match(/([\d.]+)\s*(kg|kgs|kilos|kilo|kilogramos|lb|lbs|libras|libra)/i);
      if (!pesoMatch) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg, 3 kilos, 3 lb o 4 libras');
      const rawUnit = pesoMatch[2].toLowerCase();
      const unit = /kg|kilo|kilos|kgs|kilogramos/.test(rawUnit) ? 'kg' : 'lb';
      state.peso = parseFloat(pesoMatch[1]);
      state.unidad = unit;
      state.modo = 'COTIZAR_GAM';
      setUserState(chatId, state);
      // use inline keyboard for GAM
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', { reply_markup: siNoInlineKeyboard() });
    }

    // COTIZAR_GAM handled by callback above

    // After GAM, if delivery method for NO (Encomienda/Correos de C.R)
    if (state.modo === 'COTIZAR_FINAL_CONFIRM') {
      // expecting deliveryMethod or contact if unregistered
      const st = state;
      if (!st.entregaGAM && (text === 'Encomienda' || text === 'Correos de C.R')) {
        st.deliveryMethod = text;
        // if client exists -> calculate; else ask phone/email or use unregistered stored data
        if (st.client) {
          // compute
          await bot.sendMessage(chatId, 'Procesando cotización...');
          try {
            const res = await calcularYRegistrarCotizacionRespaldo(chatId, st);
            clearUserState(chatId);
            const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
            const msgResp = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})`;
            await bot.sendMessage(chatId, msgResp);
            return replyBackToMenu(chatId);
          } catch (e) {
            console.error('Error procesando cotizacion (final confirm):', e);
            clearUserState(chatId);
            return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.');
          }
        } else {
          // if unregistered (we earlier collected name/email/phone) -> compute
          await bot.sendMessage(chatId, 'Procesando cotización...');
          try {
            const res = await calcularYRegistrarCotizacionRespaldo(chatId, st);
            clearUserState(chatId);
            const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
            const msgResp = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})`;
            await bot.sendMessage(chatId, msgResp);
            return replyBackToMenu(chatId);
          } catch (e) {
            console.error('Error procesando cotizacion (final confirm unreg):', e);
            clearUserState(chatId);
            return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.');
          }
        }
      }

      // If we reach here and user text isn't one of expected, ask again
      return bot.sendMessage(chatId, 'Selecciona "Encomienda" o "Correos de C.R" (usa el teclado).', { reply_markup: { keyboard:[['Encomienda','Correos de C.R'],['Cancelar']], resize_keyboard:true, one_time_keyboard:true } });
    }

    // If none matched, ignore or reply simple
    // Give option to return to menu
    if (!state || !state.modo) {
      return bot.sendMessage(chatId, 'No estoy seguro de qué quieres hacer. Usa /menu para ver las opciones.', { reply_markup: mainMenuKeyboard() });
    }

  } catch (err) {
    console.error('Error en message handler:', err);
    bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente o usa /menu.');
  }
});

/////////////////////// TRACKING PAGINADO (función reutilizable) ///////////////////////
const TRACKS_PER_PAGE = 5;
async function sendTrackingList(chatId, items, page = 1) {
  if (!items || items.length === 0) return bot.sendMessage(chatId, 'No se encontraron paquetes para tu casillero.');
  const totalPages = Math.ceil(items.length / TRACKS_PER_PAGE);
  page = Math.max(1, Math.min(page, totalPages));
  const start = (page - 1) * TRACKS_PER_PAGE;
  const slice = items.slice(start, start + TRACKS_PER_PAGE);

  const lines = slice.map((it, idx) => {
    const localIndex = start + idx + 1;
    return `${localIndex}. ${it.tracking || '(sin tracking)'} — ${it.origen || '-'} — ${it.estado || '-'} — ${it.peso || '-'}`;
  }).join('\n');

  const inline = slice.map((it, idx) => [{ text: `Ver ${start+idx+1}`, callback_data: `TRACK_DETAIL|${start+idx}` }]);
  const paging = [];
  if (page > 1) paging.push({ text: '◀️ Anterior', callback_data: `TRACK_PAGE|${page-1}` });
  if (page < totalPages) paging.push({ text: 'Siguiente ▶️', callback_data: `TRACK_PAGE|${page+1}` });
  if (items.length > 20) paging.push({ text: 'Exportar (respaldo)', callback_data: `TRACK_EXPORT|all` });

  const inline_keyboard = inline.concat([paging]);

  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n\n${lines}`, {
    reply_markup: { inline_keyboard }
  });

  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

/////////////////////// WEBHOOK / STARTUP ///////////////////////
app.post(`/${TELEGRAM_TOKEN}`, (req,res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch(e){ console.error('processUpdate error', e); } });
app.get('/', (req,res) => res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  const webhookUrl = `${URL_BASE}/${TELEGRAM_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  } catch (err) {
    console.error('Error configurando webhook (setWebHook):', err);
  }
});
