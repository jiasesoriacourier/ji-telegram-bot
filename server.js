// server.js - Bot Telegram + Google Sheets (sin GAS) - J.I Asesoría & Courier
// Requisitos: npm i express node-telegram-bot-api googleapis body-parser
// Coloca tu JSON de credenciales en ./credentials/ji-telegram-bot-480321-5c1ec001692b.json
// Set env vars:
// - TELEGRAM_TOKEN = tu token de Telegram (ej: 8490822681:AA...u5rFrFw)
// - SPREADSHEET_ID = 10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM (ya hay valor por defecto)
// - ADMIN_TELEGRAM_ID = 7826072133 (por defecto)

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ---------------- CONFIG ----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';

if (!TELEGRAM_TOKEN) {
  console.error('ERROR: Define TELEGRAM_TOKEN en variables de entorno.');
  process.exit(1);
}

// Path al JSON de credenciales (subir a ./credentials/)
const GOOGLE_KEYFILE = path.join(__dirname, 'credentials', 'ji-telegram-bot-480321-5c1ec001692b.json');
if (!fs.existsSync(GOOGLE_KEYFILE)) {
  console.error(`ERROR: No se encontró el archivo de credenciales en ${GOOGLE_KEYFILE}`);
  console.error('Coloca tu JSON en ./credentials/ y asegúrate de llamarlo exactamente ji-telegram-bot-480321-5c1ec001692b.json');
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// estado por usuario (simple en memoria)
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// ---------------- CONSTANTES / LISTAS ----------------
const MERCANCIA_ESPECIAL = [ "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje","medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas","alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante","lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula" ];
const MERCANCIA_PROHIBIDA = [ "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd","arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso","oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros" ];
const KNOWN_BRANDS = [ "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier","bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret" ];

const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china']; // orígenes simplificados
const PREALERTA_ORIGINS = ['Estados Unidos','Colombia','España','China','Mexico']; // texto para prealerta

// ---------------- GOOGLE SHEETS CLIENT ----------------
async function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ---------------- UTILIDADES ----------------
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, '');
  if (s.startsWith('506')) s = s.slice(3);
  return s;
}
function phoneMatches(sheetPhone, incoming) {
  if (!sheetPhone || !incoming) return false;
  const a = normalizePhone(sheetPhone);
  const b = normalizePhone(incoming);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}
function safeNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
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

// ---------------- DIRECCIONES (reemplaza "Nombre de cliente" por nombre real) ----------------
async function getDireccionesForClient(clienteNombre = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
  const data = res.data.values || [];
  const replaceName = (text) => (text || '').replace(/Nombre de cliente/gi, clienteNombre);
  return {
    miami: replaceName(extractRange(data, 1, 4, 1, 3)),
    espana: replaceName(extractRange(data, 16, 20, 1, 3)),
    colombiaCon: replaceName(extractRange(data, 0, 6, 6, 9)),
    colombiaSin: replaceName(extractRange(data, 10, 16, 6, 9)),
    mexico: replaceName(extractRange(data, 23, 28, 1, 3)),
    china: replaceName(extractRange(data, 23, 28, 6, 9))
  };
}

// ---------------- BUSCAR CLIENTE ----------------
// Hoja "Clientes" formato: A Nombre, B Correo, C contraseña, D Telefono, E?, F Direccion, G?, H Saldo (colones)
async function findClientByPhoneOrEmail(value) {
  const sheets = await getGoogleSheetsClient();
  const range = 'Clientes!A:H';
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const val = value.toString().trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const nombre = r[0] || '';
    const correo = (r[1] || '').toString().trim().toLowerCase();
    const telefono = (r[3] || '').toString().trim();
    const saldo = safeNumber(r[7]);
    if (correo && correo === val) {
      return { rowIndex: i+1, nombre, correo: r[1] || '', telefono, direccion: r[5] || '', saldo };
    }
    if (telefono && phoneMatches(telefono, val)) {
      return { rowIndex: i+1, nombre, correo: r[1] || '', telefono, direccion: r[5] || '', saldo };
    }
  }
  return null;
}

// ---------------- AGREGAR CLIENTE ----------------
async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', correo || '', '', contacto || '', '', direccion || '', '', 0 ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H', valueInputOption: 'RAW', resource: { values } });
}

// ---------------- TRACKINGS (DATOS) ----------------
async function getTrackingsByName(nombre) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:F' });
  const rows = res.data.values || [];
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const nm = (r[1] || '').toString().trim().toLowerCase();
    if (!nm) continue;
    if (nm === (nombre || '').toLowerCase()) {
      items.push({
        rowIndex: i+1,
        tracking: r[0] || '',
        comentarios: r[8] || r[2] || '', // intentar columna I o C
        origen: r[3] || '',
        estado: r[4] || '',
        peso: r[5] || ''
      });
    }
  }
  return items;
}

// ---------------- PAGINACIÓN TRACKINGS ----------------
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
  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n\n${lines}`, { reply_markup: { inline_keyboard } });
  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

// ---------------- TECLADOS ----------------
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/pendiente', '/prealerta']
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
      [{ text: '🇺🇸 Miami', callback_data: 'CASILLERO|miami' }],
      [{ text: '🇪🇸 Madrid', callback_data: 'CASILLERO|espana' }],
      [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }]
    ]
  };
}
function gamInlineKeyboard() {
  return { inline_keyboard:[[ { text:'Sí', callback_data:'GAM|si' }, { text:'No', callback_data:'GAM|no' } ]] };
}
function yesNoKeyboard(callbackPrefix) {
  return { inline_keyboard:[[ { text:'Sí', callback_data:`${callbackPrefix}|si` }, { text:'No', callback_data:`${callbackPrefix}|no` } ]] };
}
function prealertaOriginKeyboard() {
  return {
    inline_keyboard: PREALERTA_ORIGINS.map(p => [{ text: p, callback_data: `PRE_ORIG|${p}` }])
  };
}

// ---------------- CLASIFICACIÓN ----------------
function classifyProduct(obj) {
  const text = (obj.descripcion || '').toLowerCase();
  const categoriaSeleccionada = (obj.categoriaSeleccionada || '').toLowerCase();
  const origen = (obj.origen || '').toLowerCase();
  for (const w of MERCANCIA_PROHIBIDA) if (text.includes(w)) return { tipo: 'Prohibida', tags: [w] };
  if (categoriaSeleccionada.includes('réplica') || categoriaSeleccionada.includes('replica')) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['replica'] } : { tipo: 'General', tags: ['replica'] };
  }
  const foundSpecial = [];
  for (const w of MERCANCIA_ESPECIAL) if (text.includes(w)) foundSpecial.push(w);
  if (foundSpecial.length) return { tipo: 'Especial', tags: foundSpecial };
  for (const b of KNOWN_BRANDS) if (text.includes(b)) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
  }
  return { tipo: 'General', tags: [] };
}

// ---------------- LECTURA DE TARIFAS ----------------
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
  const values = (res.data.values || []).map(r => r[0]);
  const val = idx => parseFloat(values[idx]) || 0;
  let jVals = {};
  try {
    const r2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!J1:J3' });
    const arr = (r2.data.values || []).map(r => r[0]);
    jVals.deliveryCRC = parseFloat(arr[0]) || 0;
    jVals.exchangeRate = parseFloat(arr[2]) || 1;
  } catch (e) {
    jVals.deliveryCRC = 0;
    jVals.exchangeRate = 1;
  }
  return {
    miami: { sinPermiso: val(0) || 6.0, conPermiso: val(1) || 7.0 },
    colombia: { sinPermiso: val(4) || 9.0, conPermiso: val(5) || 16.0 },
    espana: { sinPermiso: val(8) || 8.5, conPermiso: val(9) || 9.9 },
    china: { tarifa: val(11) || 10.0 },
    mexico: { tarifa: val(13) || 12.0 },
    j: jVals
  };
}

// ---------------- GUARDAR EN HISTORIAL ----------------
async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const now = new Date().toISOString();
  const values = [[
    data.id, data.fecha || now, data.chatId, data.cliente || 'Cliente', data.email || '', data.origen || '', data.destino || '',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

// ---------------- GUARDAR COTIZACIÓN EN HOJA "Cotizaciones" Y NOTIFICAR ----------------
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
    `Total: ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `Tipo de cambio: ${payload.exchangeRate}`,
    `Contacto: ${payload.contacto || '-'}`,
    `Email: ${payload.email || '-'}`
  ].join('\n');

  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

// ---------------- DESCUENTO POR PESO ----------------
function getDiscountPercentByPeso(peso) {
  if (peso >= 75) return 0.15;
  if (peso >= 50) return 0.12;
  if (peso >= 35) return 0.10;
  if (peso >= 25) return 0.07;
  if (peso >= 15) return 0.05;
  return 0.00;
}

// ---------------- CÁLCULO Y REGISTRO DE COTIZACIÓN (respaldo en sheet) ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  // state puede contener client (obj) o datos no registrados: nombre, telefono, correo
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

  const origen = state.origen;
  const peso = state.peso;
  const unidad = state.unidad;
  const tipoMercancia = state.tipoMercancia || 'General';
  const descripcion = state.descripcion || '';
  const entregaGAM = !!state.entregaGAM;

  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotalUSD = 0;

  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = (origen || '').toLowerCase();

  if (origenLower === 'colombia') {
    tarifaUSD = (tipoMercancia === 'Especial' || (state.categoriaSeleccionada || '').toLowerCase().includes('réplica')) ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origenLower === 'mexico') {
    tarifaUSD = tarifas.mexico.tarifa;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origenLower === 'china') {
    tarifaUSD = tarifas.china.tarifa;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origenLower === 'miami' || origenLower === 'usa') {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origenLower === 'madrid' || origenLower === 'espana') {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else {
    throw new Error('Origen no soportado');
  }

  const subtotalCRC = subtotalUSD * exchangeRate;
  const discountPercent = getDiscountPercentByPeso(pesoFacturable);
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
    mercancia: descripcion + (state.deliveryMethod ? `\nMetodo envio: ${state.deliveryMethod}` : ''),
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
    id, fecha: new Date().toISOString(), chatId, email, origen, destino: 'Costa Rica', tipoMercancia, peso, unidad,
    pesoFacturable, tarifa: tarifaUSD, subtotal: subtotalUSD, discountPercent, discountAmount: discountAmountCRC / exchangeRate, total: totalCRC / exchangeRate
  });

  return {
    id, subtotalCRC, discountPercent, discountAmountCRC, totalCRC, deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable
  };
}

// ---------------- PREALERTA: Guardar tracking en hoja "Datos" ----------------
// Requerimientos: A:Tracking, B:Cliente, D:Origen, I:Observaciones
async function savePrealertaToDatos({ tracking, clienteNombre, origen, observaciones }) {
  const sheets = await getGoogleSheetsClient();
  // construir fila A..I (índices 0..8)
  const row = new Array(9).fill('');
  row[0] = tracking || '';
  row[1] = clienteNombre || '';
  row[2] = ''; // C
  row[3] = origen || ''; // D
  row[4] = ''; // E
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

  // notificar admin
  const adminMsg = `📣 Nueva prealerta\nTracking: ${tracking}\nCliente: ${clienteNombre}\nOrigen: ${origen}\nObservaciones: ${observaciones || '-'}`;
  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

// ---------------- COMANDOS / MENÚ ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier.\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

bot.onText(/\/crear_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Para verificar tu casillero, escribe el *número de teléfono* con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});

bot.onText(/\/consultar_tracking/, async (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});

// cambiar nombre de comando saldo/pendiente según petición
bot.onText(/\/pendiente|\/saldo|\/saldo_a_pagar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente.');
});

// prealerta comando
bot.onText(/\/prealerta/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERTA_TRACKING' });
  bot.sendMessage(chatId, 'Inicia prealerta: escribe el número de TRACKING (ej: 1Z....).');
});

bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  // new logic: primero pedir teléfono o correo para intentar match
  setUserState(chatId, { modo: 'COTIZAR_IDENTIFICAR' });
  bot.sendMessage(chatId, 'Para comenzar la cotización, escribe tu *número de teléfono* (88885555) o *correo* (si prefieres). Si deseas continuar sin registro escribe "SIN REGISTRO".', { parse_mode: 'Markdown' });
});

// contacto simple
bot.onText(/\/contactar/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Opciones de contacto:', { reply_markup: { inline_keyboard: [[{ text: 'Correo: info@jiasesoria.com', callback_data: 'CONTACT|email' }], [{ text: 'WhatsApp', callback_data: 'CONTACT|wa' }], [{ text: 'Telegram', callback_data: 'CONTACT|tg' }]] } });
});

// ---------------- CALLBACKS (inline) ----------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    const state = getUserState(chatId) || {};

    // Selección GAM en cotizacion (inline)
    if (data.startsWith('GAM|')) {
      const ans = data.split('|')[1];
      if (!state.modo || !state.modo.startsWith('COTIZAR')) return bot.sendMessage(chatId, 'Flujo de cotización no activo.');
      state.entregaGAM = (ans === 'si');
      // if not GAM => ask delivery method
      if (!state.entregaGAM) {
        state.modo = 'COTIZAR_DELIVERY_METHOD';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿El envío fuera del GAM será por Encomienda o Correos de C.R? Responde: ENCOMIENDA o CORREOS.');
      } else {
        // continue: ask email / identify registered
        state.modo = 'COTIZAR_CHECK_EMAIL';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Si estás registrado, tu correo ya fue obtenido. Si no, escribe tu correo (opcional) o responde "NO".');
      }
    }

    // CASILLERO Países - mostrar direcciones con nombre del cliente guardado en state.client
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1];
      const st = getUserState(chatId) || {};
      const client = st.client || { nombre: (query.from && query.from.first_name) ? query.from.first_name : 'Cliente' };
      const dire = await getDireccionesForClient(client.nombre);
      let direccion = 'No disponible';
      if (pais === 'miami') direccion = dire.miami;
      else if (pais === 'espana' || pais === 'madrid') direccion = dire.espana || dire.miami;
      else if (pais === 'mexico') direccion = dire.mexico;
      else if (pais === 'china') direccion = dire.china;
      else if (pais === 'colombia') {
        // pregunta si con permiso o sin permiso
        return bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: { inline_keyboard: [[{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],[{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]] } });
      }
      const nombres = { miami:'Miami', espana:'Madrid', mexico:'Ciudad de México', china:'China', colombia:'Colombia' };
      return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}* para *${client.nombre}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const st = getUserState(chatId) || {};
      const client = st.client || { nombre: (query.from && query.from.first_name) ? query.from.first_name : 'Cliente' };
      const dire = await getDireccionesForClient(client.nombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})* para *${client.nombre}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const st = getUserState(chatId) || {};
      st.categoriaSeleccionada = categoria;
      // special case: if origin Colombia and category Ropa/Calzado ask replica
      if ((st.origen || '').toLowerCase() === 'colombia' && categoria.toLowerCase().includes('ropa')) {
        st.modo = 'COTIZAR_REPLICA_PROMPT';
        setUserState(chatId, st);
        return bot.sendMessage(chatId, '¿Es réplica/imitación? (Selecciona):', { reply_markup: yesNoKeyboard('REPLICA') });
      }
      st.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Describe brevemente el producto (obligatorio).`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('REPLICA|') || data.startsWith('REPLICA')) {
      const ans = data.split('|')[1] || data.split('|')[0].split('|')[1];
    }

    if (data.startsWith('REPLICA|') || data.startsWith('REPLICA') || data.startsWith('REPLICA|si') || data.startsWith('REPLICA|no')) {
      // old fallback - ignore
    }

    if (data.startsWith('REPLICA') || data.startsWith('REPLICA|')) {
      // handle replica callback only if created with REPLICA prefix (we use yesNoKeyboard with prefix 'REPLICA')
    }

    if (data.startsWith('REPLICA|')) {
      const ans = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.esReplica = (ans === 'si');
      // set tipoMercancia accordingly
      st.tipoMercancia = st.esReplica ? 'Especial' : 'General';
      st.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Ahora describe brevemente el producto (obligatorio).');
    }

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

    if (data.startsWith('PRE_ORIG|')) {
      const origenSeleccionado = data.split('|')[1] || '';
      const st = getUserState(chatId) || {};
      if (!st.modo || !st.modo.startsWith('PREALERTA')) return bot.sendMessage(chatId, 'Flujo de prealerta no activo.');
      st.pre_origen = origenSeleccionado;
      st.modo = 'PREALERTA_TIPO_MERCANCIA';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía* (obligatorio).', { parse_mode: 'Markdown' });
    }

    if (data.startsWith('CONTACT|')) {
      const t = data.split('|')[1];
      if (t === 'email') return bot.sendMessage(chatId, 'Escribe a: info@jiasesoria.com');
      if (t === 'wa') return bot.sendMessage(chatId, 'WhatsApp: https://wa.me/50663939073');
      if (t === 'tg') return bot.sendMessage(chatId, 'Telegram: https://web.telegram.org/a/#50663939073');
    }

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.');
  }
});

// ---------------- MENSAJES LIBRES (flujo principal) ----------------
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // --- CREAR CASILLERO FLOW ---
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
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos (ej: 88885555).');
      const existing = await findClientByPhoneOrEmail(phone);
      if (existing) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, `Ya existe un registro con ese número bajo el nombre: *${existing.nombre}*. Si es tuyo, usa /mi_casillero.`, { parse_mode: 'Markdown' });
      }
      state.telefono = phone;
      state.modo = 'CREAR_DIRECCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      clearUserState(chatId);
      await bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.\nUsa /menu para regresar.`, { parse_mode: 'Markdown' });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `🔔 Nuevo registro: ${state.nombre} - ${state.telefono} - ${state.correo}`);
      return;
    }

    // --- PREALERTA FLOW ---
    if (state.modo === 'PREALERTA_TRACKING') {
      // receive tracking number
      state.tracking = text;
      state.modo = 'PREALERTA_IDENTIFICAR';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Escribe el número de teléfono o correo con el que deseas registrar este tracking (para asociarlo a un cliente).');
    }
    if (state.modo === 'PREALERTA_IDENTIFICAR') {
      // try to match client
      const val = text;
      const client = await findClientByPhoneOrEmail(val);
      if (!client) {
        // ask if wants to register or continue as "Cliente Invitado"
        state.pre_client = { nombre: 'Cliente Invitado', telefono: val, correo: val.includes('@') ? val : '' };
        state.modo = 'PREALERTA_ORIGEN';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos ese número/correo. Selecciona el ORIGEN del tracking:', { reply_markup: prealertaOriginKeyboard() });
      }
      state.client = client;
      state.modo = 'PREALERTA_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Hola ${client.nombre}. Selecciona el ORIGEN del tracking:`, { reply_markup: prealertaOriginKeyboard() });
    }
    if (state.modo === 'PREALERTA_TIPO_MERCANCIA') {
      // receive tipo de mercancía obligatorio
      state.tipoMercancia = text;
      state.modo = 'PREALERTA_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Observaciones (opcional). Si no hay, responde "NINGUNA".');
    }
    if (state.modo === 'PREALERTA_OBS') {
      const obs = text === '' ? 'NINGUNA' : text;
      const tracking = state.tracking || '';
      const clienteNombre = (state.client && state.client.nombre) ? state.client.nombre : (state.pre_client && state.pre_client.nombre) ? state.pre_client.nombre : 'Cliente Telegram';
      const origen = state.pre_origen || '';
      await savePrealertaToDatos({ tracking, clienteNombre, origen, observaciones: `Tipo merc: ${state.tipoMercancia} | ${obs}` });
      // ask if wants to add another tracking
      setUserState(chatId, { modo: null });
      await bot.sendMessage(chatId, `✅ Prealerta registrada para *${clienteNombre}*.\nTracking: ${tracking}\nOrigen: ${origen}`, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, '¿Deseas prealertar otro tracking? Responde SI para continuar o NO para volver al /menu.');
      // set temporary state to capture Yes/No
      setUserState(chatId, { modo: 'PREALERTA_ANOTHER' });
      return;
    }
    if (state.modo === 'PREALERTA_ANOTHER') {
      const ans = text.toLowerCase();
      if (['si','s','yes'].includes(ans)) {
        setUserState(chatId, { modo: 'PREALERTA_TRACKING' });
        return bot.sendMessage(chatId, 'Escribe el número de TRACKING.');
      } else {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Volviendo al /menu.', { reply_markup: mainMenuKeyboard() });
      }
    }

    // --- CHECK CASILLERO: cuando usuario envía teléfono para ver casillero/tracking ---
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = text;
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      // save client in state to be used by CASILLERO callback
      setUserState(chatId, { modo: 'SHOW_CASILLERO_OPTIONS', client });
      // ask country selection
      return bot.sendMessage(chatId, `Hola ${client.nombre}. Selecciona el país de tu casillero:`, { reply_markup: casilleroPaisesKeyboard() });
    }

    // --- CHECK SALDO ---
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = text;
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      // saldo en columna H (colones)
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${Math.round(client.saldo || 0)}\nUsa /menu para volver.`, { reply_markup: mainMenuKeyboard() });
    }

    // --- COTIZAR FLOW: identificacion inicial ---
    if (state.modo === 'COTIZAR_IDENTIFICAR') {
      const val = text.toLowerCase();
      if (val === 'sin registro' || val === 'sinregistro' || val === 'sin') {
        // proceed as unregistered - require name, phone, email in order
        setUserState(chatId, { modo: 'COTIZAR_UNREG_NOMBRE' });
        return bot.sendMessage(chatId, 'Has elegido cotizar SIN registro. Primero, escribe tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
      // try to match by phone or email
      const client = await findClientByPhoneOrEmail(text);
      if (!client) {
        // ask if wants to register
        setUserState(chatId, { modo: 'COTIZAR_NOTFOUND_OPT', tempValue: text });
        return bot.sendMessage(chatId, 'No encontramos un registro con ese dato. ¿Deseas registrarte ahora? Responde SI o NO.');
      }
      // found registered client -> proceed
      setUserState(chatId, { modo: 'COTIZAR_ORIGEN', client });
      return bot.sendMessage(chatId, `Hola ${client.nombre}. Empezamos la cotización. ¿Cuál es el ORIGEN? (miami, madrid, colombia, mexico, china)`);
    }

    // not found option (after asking register or not)
    if (state.modo === 'COTIZAR_NOTFOUND_OPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        // start registration flow, then continue cotizacion: ask name
        setUserState(chatId, { modo: 'COTIZAR_REG_NOMBRE', tempValue: state.tempValue || '' });
        return bot.sendMessage(chatId, 'Perfecto. Ingresa tu *Nombre completo* para registrarte.', { parse_mode: 'Markdown' });
      } else {
        // proceed as unregistered but force name, phone, email mandatory
        setUserState(chatId, { modo: 'COTIZAR_UNREG_NOMBRE', tempValue: state.tempValue || '' });
        return bot.sendMessage(chatId, 'Continuemos sin registro. Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
    }

    // registration during cotizacion
    if (state.modo === 'COTIZAR_REG_NOMBRE' || state.modo === 'COTIZAR_UNREG_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu *Nombre completo* (al menos nombre y apellido).', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ahora ingresa tu *correo electrónico* (obligatorio).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'COTIZAR_UNREG_TELEFONO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREG_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos (ej: 88885555).');
      state.telefono = phone;
      // if registration requested earlier (COTIZAR_REG_NOMBRE) -> add to sheet
      if (state.modoWas === 'COTIZAR_REG_NOMBRE' || state.modo === 'COTIZAR_REG_NOMBRE') {
        // save new client
        await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: '' });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `🔔 Nuevo registro (desde cotización): ${state.nombre} - ${state.telefono} - ${state.correo}`);
      }
      // continue to origen
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN? (miami, madrid, colombia, mexico, china)');
    }

    // COTIZAR ORIGEN
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      if (!VALID_ORIGINS.includes(origin)) return bot.sendMessage(chatId, 'Origen inválido. Selecciona uno de: miami, madrid, colombia, mexico, china');
      state.origen = origin;
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    // DESCRIPCION (después de categoría o para casos previos)
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb, 3 libras, 5 kilos).');
    }

    if (state.modo === 'COTIZAR_PESO') {
      const pesoMatch = text.match(/([\d.]+)\s*(kg|kgs|kilos|kilo|kilogramos|lb|lbs|libras|libra)/i);
      if (!pesoMatch) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg, 3 kilos, 3 lb o 4 libras');
      const rawUnit = pesoMatch[2].toLowerCase();
      const unit = /kg|kilo|kilos|kgs|kilogramos/.test(rawUnit) ? 'kg' : 'lb';
      state.peso = parseFloat(pesoMatch[1]);
      state.unidad = unit;
      state.modo = 'COTIZAR_GAM_CHOOSE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', { reply_markup: gamInlineKeyboard() });
    }

    // delivery method selection when outside GAM
    if (state.modo === 'COTIZAR_DELIVERY_METHOD') {
      // expects "ENCOMIENDA" or "CORREOS"
      const val = text.toLowerCase();
      if (!/encomienda|correos|correo|correos de c.r|correos de cr/.test(val)) return bot.sendMessage(chatId, 'Responde: ENCOMIENDA o CORREOS.');
      state.deliveryMethod = val.includes('encom') ? 'Encomienda' : 'Correos de C.R';
      state.modo = 'COTIZAR_CHECK_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Si estás registrado la info ya fue tomada. Si no, escribe tu correo (opcional) o responde "NO".');
    }

    // final email step for registered/unregistered flows (we treat it optional if client exists)
    if (state.modo === 'COTIZAR_CHECK_EMAIL') {
      const lower = text.toLowerCase();
      if (lower === 'no') state.email = null;
      else if (text.includes('@')) state.email = text;
      // show processing message and calculate
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      try {
        // attach client info if available in state.client
        if (state.client) state.client = state.client;
        // if not registered but provided nombre/telefono/email, leave them
        const result = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);
        const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const msgResp = `✅ Cotización generada\nID: ${result.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${result.pesoFacturable} ${result.unidadFacturable}\nSubtotal: ¢${Math.round(result.subtotalCRC)}\nDescuento: ¢${Math.round(result.discountAmountCRC)}\nCosto entrega: ¢${Math.round(result.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(result.totalWithDeliveryCRC)}\n(Tipo de cambio: ${result.exchangeRate})`;
        await bot.sendMessage(chatId, msgResp);
        await bot.sendMessage(chatId, '¿Deseas volver al /menu o finalizar?', { reply_markup: mainMenuKeyboard() });
        return;
      } catch (err) {
        console.error('Error procesando cotización:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.');
      }
    }

    // default fallback: if no active flow, ignore
  } catch (err) {
    console.error('Error en message handler:', err);
  }
});

// ---------------- RUTAS / WEBHOOK ----------------
app.get('/', (req, res) => res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier'));
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch(e){ console.error('processUpdate error', e); } });

// arrancar servidor y configurar webhook
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  const webhookUrl = `${url}/${TELEGRAM_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  } catch (err) {
    console.error('Error configurando webhook (setWebHook):', err);
  }
});
