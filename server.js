// server.js - J.I Asesoría & Courier (Telegram bot, Google Sheets, sin GAS)
// Opción C: Bot completo + mejoras
// Requerimientos: npm i express node-telegram-bot-api googleapis

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

///////////////////// CONFIG /////////////////////
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('Falta GOOGLE_CREDENTIALS (JSON) o GOOGLE_APPLICATION_CREDENTIALS (path) en env');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use webhook mode (render-friendly)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

///////////////////// STATE /////////////////////
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)) || {}; }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

///////////////////// CONSTANTES /////////////////////
const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china'];
const TRACKS_PER_PAGE = 5;

// mercancias / marcas (usar si quieres)
const MERCANCIA_ESPECIAL = ["medicamento","medicinas","perfume","perfumes","colonias","vitamina","vitaminas"];
const MERCANCIA_PROHIBIDA = ["licor","arma","munición","explosivo","droga","cannabis","oro","plata"];

///////////////////// GOOGLE SHEETS CLIENT /////////////////////
async function getGoogleSheetsClient() {
  // soporta GOOGLE_CREDENTIALS (JSON o base64) o GOOGLE_APPLICATION_CREDENTIALS (path)
  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    let raw = process.env.GOOGLE_CREDENTIALS;
    if (!raw.trim().startsWith('{')) {
      // puede venir base64
      raw = Buffer.from(raw, 'base64').toString('utf8');
    }
    const credentials = JSON.parse(raw);
    const client = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    auth = await client.getClient();
  } else {
    // usa path apuntado por GOOGLE_APPLICATION_CREDENTIALS
    const client = new google.auth.GoogleAuth({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    auth = await client.getClient();
  }
  return google.sheets({ version: 'v4', auth });
}

///////////////////// UTILIDADES /////////////////////
function normalizePhone(input) {
  if (!input) return '';
  let s = input.toString().trim();
  // elimina todo lo que no sea dígito
  s = s.replace(/\D+/g, '');
  // si vino con 506 como prefijo, quitarlo para formato local (8 dígitos)
  if (s.startsWith('506') && s.length > 8) s = s.slice(3);
  return s;
}
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

function formatCRC(amount) {
  return `¢${Math.round(amount).toLocaleString('es-CR')}`;
}

///////////////////// SHEETS: Lecturas básicas /////////////////////
// Clientes sheet expected columns (as you said):
// A: Nombre (index 0), B: Correo (1), C: contraseña (2), D: Telefono (3), E: ? , F: Direccion (5), H: Saldo (7)
async function findClientByPhoneOrEmail(identifier) {
  const sheets = await getGoogleSheetsClient();
  const range = 'Clientes!A:H';
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const normalized = normalizePhone(identifier);
  const lower = (identifier||'').toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0] || '';
    const email = (row[1] || '').toLowerCase();
    const phone = row[3] || '';
    const saldo = parseFloat(row[7]) || 0;
    if ((phone && normalized && phoneMatches(phone, normalized)) || (email && lower && email === lower)) {
      return { rowIndex: i+1, nombre: name, correo: row[1]||'', telefono: phone, direccion: row[5]||'', saldo };
    }
  }
  return null;
}

async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre||'', correo||'', '', contacto||'', '', direccion||'', '', 0 ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:H',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

///////////////////// Direcciones de casillero /////////////////////
async function getDirecciones(nombreCliente = 'Cliente') {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
  const data = res.data.values || [];
  const rep = (t) => (t||'').replace(/Nombre de cliente/gi, nombreCliente);
  return {
    miami: rep(extractRange(data,1,4,1,3)),
    espana: rep(extractRange(data,16,20,1,3)),
    colombiaCon: rep(extractRange(data,0,6,6,9)),
    colombiaSin: rep(extractRange(data,10,16,6,9)),
    mexico: rep(extractRange(data,23,28,1,3)),
    china: rep(extractRange(data,23,28,6,9))
  };
}
function extractRange(data, startRow, endRow, startCol, endCol) {
  const lines = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= data.length) continue;
    const row = data[r] || [];
    const cells = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = (row[c]||'').toString().trim();
      if (cell) cells.push(cell);
    }
    if (cells.length) lines.push(cells.join(' '));
  }
  return lines.join('\n') || 'No disponible';
}

///////////////////// Trackings (prealerta) /////////////////////
/*
Datos sheet (requisito para prealerta)
Columna A: Número de tracking
Columna B: Cliente (nombre)
Columna C: Fecha (opcional)
Columna D: Origen (Estados Unidos, Colombia, España, China, Mexico) <- tu pedido
... otras columnas ...
Columna I: Observaciones (índice 8)
*/
async function addPrealertToDatos({ trackingNumber, cliente, origen, observaciones }) {
  const sheets = await getGoogleSheetsClient();
  const now = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
  const row = [ trackingNumber||'', cliente||'', now, origen||'', '', '', '', '', observaciones||'' ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
  // avisar admin
  await bot.sendMessage(ADMIN_TELEGRAM_ID, `📣 Nueva prealerta:\nCliente: ${cliente}\nTracking: ${trackingNumber}\nOrigen: ${origen}\nObs: ${observaciones}`);
}

///////////////////// Trackings por nombre (para /mi_casillero) /////////////////////
async function getTrackingsByName(nombre) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:F' });
  const rows = res.data.values || [];
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[1]||'').toString().trim().toLowerCase();
    if (!name) continue;
    if (name === (nombre||'').toLowerCase()) {
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

///////////////////// TARIFAS /////////////////////
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
  const values = (res.data.values || []).map(r => parseFloat(r[0]) || 0);
  const r2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!J1:J3' }).catch(()=>({data:{values:[]}}));
  const arr = (r2.data.values||[]).map(r => parseFloat(r[0]) || 0);
  const j = { deliveryCRC: arr[0] || 0, exchangeRate: arr[2] || 1 };
  return {
    miami: { sinPermiso: values[0]||6.0, conPermiso: values[1]||7.0 },
    colombia: { sinPermiso: values[4]||9.0, conPermiso: values[5]||16.0 },
    espana: { sinPermiso: values[8]||8.5, conPermiso: values[9]||9.9 },
    china: { tarifa: values[11]||10.0 },
    mexico: { tarifa: values[13]||12.0 },
    j
  };
}

///////////////////// SAVE COTIZACION /////////////////////
/*
Cotizaciones columns A..Q (17 cols)
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

  // notify admin
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
    `Subtotal: ${formatCRC(payload.subtotalCRC)}`,
    `Descuento: ${formatCRC(payload.discountAmountCRC)} (${(payload.discountPercent*100).toFixed(1)}%)`,
    `Costo entrega: ${formatCRC(payload.deliveryCostCRC)}`,
    `Total (con entrega): ${formatCRC(payload.totalWithDeliveryCRC)}`,
    `Tipo de cambio: ${payload.exchangeRate}`,
    `Contacto: ${payload.contacto || '-'}`,
    `Email: ${payload.email || '-'}`
  ].join('\n');

  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

function getDiscountPercentByPeso(peso) {
  if (peso >= 75) return 0.15;
  if (peso >= 50) return 0.12;
  if (peso >= 35) return 0.10;
  if (peso >= 25) return 0.07;
  if (peso >= 15) return 0.05;
  return 0.00;
}

async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

  const origen = state.origen;
  const peso = state.peso;
  const unidad = state.unidad;
  const tipoMercancia = state.tipoMercancia || 'General';
  const descripcion = state.descripcion || '';
  const entregaGAM = !!state.entregaGAM;
  const deliveryMethod = state.deliveryMethod || '';

  let tarifaUSD = 0, pesoFacturable = 0, unidadFacturable = 'lb', subtotalUSD = 0;
  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = (origen||'').toLowerCase();

  if (origenLower === 'colombia') {
    // si categoriaSeleccionada indica replica o state.isReplica true -> conPermiso
    const isReplica = ((state.categoriaSeleccionada||'').toLowerCase().includes('réplica') || state.isReplica === true);
    tarifaUSD = isReplica ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
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
    id, fechaLocal, cliente: clienteName, origen, peso, unidad,
    tipoPermiso: tipoMercancia, mercancia: descripcion + (deliveryMethod ? `\nMétodo envío: ${deliveryMethod}` : ''),
    subtotalCRC, discountPercent, discountAmountCRC, totalCRC,
    deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate,
    pesoFacturable, unidadFacturable, contacto, email
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);

  await guardarEnHistorial({
    id, fecha: new Date().toISOString(), chatId,
    email, origen, destino: 'Costa Rica', tipoMercancia, peso, unidad,
    pesoFacturable, tarifa: tarifaUSD, subtotal: subtotalUSD,
    discountPercent, discountAmount: discountAmountCRC/exchangeRate, total: totalCRC/exchangeRate
  });

  return {
    id, subtotalCRC, discountPercent, discountAmountCRC, totalCRC, deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable
  };
}

async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const now = new Date().toISOString();
  const values = [[
    data.id, data.fecha || now, data.chatId || '', 'Cliente', data.email || '', data.origen || '', data.destino || '',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

///////////////////// KEYBOARDS /////////////////////
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/prealerta'],
      ['/saldo_a_pagar', '/contactar']
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
function yesNoKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: 'SI', callback_data: 'GAM|si' }, { text: 'NO', callback_data: 'GAM|no' }]] } };
}
function colombiaReplicaKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: 'Sí (réplica/permiso)', callback_data: 'COL_REPL|si' }, { text: 'No', callback_data: 'COL_REPL|no' }]] } };
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
function contactoKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Correo: info@jiasesoria.com', callback_data: 'CONTACT|email' }],
      [{ text: 'WhatsApp', callback_data: 'CONTACT|wa' }],
      [{ text: 'Telegram', callback_data: 'CONTACT|tg' }]
    ]
  };
}

///////////////////// COMMANDS /////////////////////
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier.\nUsa /menu para ver opciones.`, { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Escribe tu *Nombre completo* (mínimo 1 nombre y 2 apellidos).', { parse_mode: 'Markdown' });
});

bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'MI_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número con el que te registraste (ej: 88885555) para verificar tu casillero.');
});

bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'MI_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número con el que te registraste (ej: 88885555) para ver tus paquetes.');
});

bot.onText(/\/saldo_a_pagar|\/saldo/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe tu número (ej: 88885555) para verificar tu saldo pendiente.');
});

bot.onText(/\/contactar/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Opciones de contacto:', { reply_markup: contactoKeyboard() });
});

// Cotizar: primero validar cliente por teléfono/email o permitir cotizar sin registro
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_CHECK_CLIENT' });
  bot.sendMessage(chatId, 'Para iniciar cotización, escribe tu número (88885555) o tu correo. Si NO estás registrado escribe: NO');
});

// Prealerta (nuevo)
bot.onText(/\/prealerta/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERTA_CHECK_CLIENT' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Primero, escribe tu número de teléfono (88885555) o correo. Si no estás registrado escribe NO');
});

///////////////////// CALLBACKS /////////////////////
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const data = query.data || '';
    await bot.answerCallbackQuery(query.id).catch(()=>{});

    // Categoria selection
    if (data.startsWith('CATEGORIA|')) {
      const cat = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.categoriaSeleccionada = cat;
      st.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, `Has seleccionado *${cat}*. Describe el producto (obligatorio).`, { parse_mode: 'Markdown' });
    }

    // Colombia replica filter
    if (data.startsWith('COL_REPL|')) {
      const ans = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.isReplica = (ans === 'si');
      st.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, 'Perfecto. Ahora describe el producto (obligatorio).');
    }

    // GAM yes/no
    if (data.startsWith('GAM|')) {
      const ans = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.entregaGAM = (ans === 'si');
      // If not GAM, ask method (encomienda/correos)
      if (!st.entregaGAM) {
        st.modo = 'COTIZAR_DELIVERY_METHOD';
        setUserState(chatId, st);
        return bot.sendMessage(chatId, '¿El envío será por Encomienda o por Correos de C.R? Responde: Encomienda o Correos');
      } else {
        st.modo = 'COTIZAR_EMAIL_OR_CLIENT';
        setUserState(chatId, st);
        return bot.sendMessage(chatId, 'Si eres cliente registrado escribe tu correo o número, si no escribe NO (la cotización se mostrará aquí).');
      }
    }

    // Casillero addresses
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1];
      const st = getUserState(chatId) || {};
      // st.client should hold cliente found earlier
      const clienteNombre = (st.client && st.client.nombre) ? st.client.nombre : (st.nombre || (query.from && query.from.first_name) || 'Cliente');
      const dire = await getDirecciones(clienteNombre);
      let direccion = 'No disponible';
      if (pais === 'miami') direccion = dire.miami;
      else if (pais === 'madrid') direccion = dire.espana;
      else if (pais === 'mexico') direccion = dire.mexico;
      else if (pais === 'china') direccion = dire.china;
      else if (pais === 'colombia') {
        // ask con/sin permiso flow
        return bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: colombiaReplicaKeyboard().reply_markup });
      }
      const nombres = { miami:'Miami', madrid:'Madrid', mexico:'Ciudad de México', china:'China', colombia:'Colombia' };
      return bot.sendMessage(chatId, `📍 Dirección en ${nombres[pais]} (casillero para: ${clienteNombre}):\n\n${direccion}`);
    }

    // Colombia con/sin permiso casillero
    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const st = getUserState(chatId) || {};
      const clienteNombre = (st.client && st.client.nombre) ? st.client.nombre : (st.nombre || (query.from && query.from.first_name) || 'Cliente');
      const dire = await getDirecciones(clienteNombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'}) para ${clienteNombre}:\n\n${direccion}`);
    }

    // TRACKING pagination & detail (from sendTrackingList)
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

  } catch (err) {
    console.error('callback_query error', err);
  }
});

///////////////////// sendTrackingList /////////////////////
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

///////////////////// MESSAGE HANDLER (flows) /////////////////////
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // CREATE CASILLERO FLOW
    if (state.modo === 'CREAR_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) return bot.sendMessage(chatId, 'Por favor ingresa *Nombre completo* con al menos 1 nombre y 2 apellidos.', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo electrónico (ej: correo@ejemplo.com).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa ahora tu número de contacto (ej: 88885555).');
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
      return bot.sendMessage(chatId, 'Por último, indica tu dirección de entrega (calle, número, ciudad).');
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      clearUserState(chatId);
      await bot.sendMessage(chatId, `✅ Registro completado. Casillero creado para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      return bot.sendMessage(chatId, '¿Deseas volver al /menu?', { reply_markup: mainMenuKeyboard() });
    }

    // MI_CASILLERO: check cliente by phone then show casillero addresses (not trackings)
    if (state.modo === 'MI_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) {
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      }
      // store client for subsequent address display
      const st = { modo: 'MI_CASILLERO_SHOW', client };
      setUserState(chatId, st);
      await bot.sendMessage(chatId, `Hola *${client.nombre}*. Selecciona el país de tu casillero:`, { parse_mode:'Markdown', reply_markup: casilleroPaisesKeyboard() });
      return;
    }

    // CHECK SALDO
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ${formatCRC(client.saldo || 0)}\n¿Deseas volver al /menu?`, { reply_markup: mainMenuKeyboard() });
    }

    ////////////////// COTIZAR FLOW //////////////////
    // Step 1: check if client registered by phone/email
    if (state.modo === 'COTIZAR_CHECK_CLIENT') {
      const answer = text.toLowerCase();
      if (answer === 'no') {
        // unregistered: ask required name -> then phone -> email
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No hay problema. Escribe tu *Nombre completo* para la cotización.', { parse_mode: 'Markdown' });
      } else {
        // try to find by phone or email
        const client = await findClientByPhoneOrEmail(text);
        if (client) {
          state.client = client;
          state.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, state);
          return bot.sendMessage(chatId, `Hola ${client.nombre}. ¿Cuál es el ORIGEN? (miami, madrid, colombia, mexico, china)`);
        } else {
          // not found: offer register or continue unregistered
          state.modo = 'COTIZAR_OFFER_REGISTER';
          state.pendingIdentifier = text;
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No te encontramos registrado. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para cotizar sin registro.');
        }
      }
    }

    // user chose to register during cotizar
    if (state.modo === 'COTIZAR_OFFER_REGISTER') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Empecemos con tu registro. Escribe tu nombre completo.');
      } else {
        // continue as unregistered: require name, phone, email
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuemos sin registro. Escribe tu *Nombre completo*.', { parse_mode: 'Markdown' });
      }
    }

    // Unregistered name -> phone -> email -> continue to origin
    if (state.modo === 'COTIZAR_UNREG_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu nombre completo (mínimo 2 palabras).');
      state.nombre = text;
      state.modo = 'COTIZAR_UNREG_TELEFONO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREG_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos (ej: 88885555).');
      state.telefono = phone;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ahora ingresa tu correo (ej: correo@ejemplo.com).');
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correo = text;
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN? (miami, madrid, colombia, mexico, china)');
    }

    // Step: origen
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      if (!VALID_ORIGINS.includes(origin)) return bot.sendMessage(chatId, 'Origen inválido. Selecciona: miami, madrid, colombia, mexico, china');
      state.origen = origin;
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    // descripcion (after category selection)
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      // quick prohibited check
      const txtLower = (state.descripcion||'').toLowerCase();
      for (const p of MERCANCIA_PROHIBIDA) if (txtLower.includes(p)) { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb, 3 libras, 5 kilos).');
    }

    // peso
    if (state.modo === 'COTIZAR_PESO') {
      const m = text.match(/([\d.]+)\s*(kg|kgs|kilos|kilo|kilogramos|lb|lbs|libras|libra)/i);
      if (!m) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg, 3 kilos, 3 lb o 4 libras');
      const rawUnit = m[2].toLowerCase();
      const unit = /kg|kilo|kilos|kgs|kilogramos/.test(rawUnit) ? 'kg' : 'lb';
      state.peso = parseFloat(m[1]);
      state.unidad = unit;
      state.modo = 'COTIZAR_GAM_ASK';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', yesNoKeyboard());
    }

    // delivery method if not GAM
    if (state.modo === 'COTIZAR_DELIVERY_METHOD') {
      const ans = text.toLowerCase();
      if (!['encomienda','correos','correos de c.r','correos de cr'].includes(ans) && !['encomienda','correos de cr','correos de c.r.'].includes(ans)) {
        // accept Encomienda or Correos
        // accept various forms
        // normalize:
        if (ans.includes('encom')) state.deliveryMethod = 'Encomienda';
        else if (ans.includes('correos')) state.deliveryMethod = 'Correos de C.R';
        else return bot.sendMessage(chatId, 'Responde Encomienda o Correos');
      } else {
        state.deliveryMethod = ans.includes('encom') ? 'Encomienda' : 'Correos de C.R';
      }
      state.modo = 'COTIZAR_EMAIL_OR_CLIENT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Si eres cliente registrado escribe tu correo o número, si no escribe NO');
    }

    // email or confirm client (after GAM answered yes or we asked)
    if (state.modo === 'COTIZAR_EMAIL_OR_CLIENT') {
      const txtLow = text.toLowerCase();
      if (txtLow === 'no') {
        // will use existing state.nombre/telefono/email if was unregistered; otherwise treat as anonymous
        // proceed to calculation
      } else {
        // try to find client by phone or email
        const found = await findClientByPhoneOrEmail(text);
        if (found) state.client = found;
        else {
          // if text looks like email and not found, store as correo for unregistered case
          if (text.includes('@')) state.correo = text;
          else {
            const maybePhone = normalizePhone(text);
            if (maybePhone.length >= 7) state.telefono = maybePhone;
          }
        }
      }
      // show "processing" and compute
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      try {
        const cot = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);
        const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const msgResp = `✅ Cotización generada\nID: ${cot.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cot.pesoFacturable} ${cot.unidadFacturable}\nSubtotal: ${formatCRC(cot.subtotalCRC)}\nDescuento: ${formatCRC(cot.discountAmountCRC)} (${(cot.discountPercent*100).toFixed(1)}%)\nCosto entrega: ${formatCRC(cot.deliveryCostCRC)}\nTotal (con entrega): ${formatCRC(cot.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cot.exchangeRate})`;
        await bot.sendMessage(chatId, msgResp);
        return bot.sendMessage(chatId, '¿Deseas volver al /menu?', { reply_markup: mainMenuKeyboard() });
      } catch (err) {
        console.error('Error cotizar:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente.');
      }
    }

    ////////////////// PREALERTA FLOW //////////////////
    if (state.modo === 'PREALERTA_CHECK_CLIENT') {
      const txtLow = text.toLowerCase();
      if (txtLow === 'no') {
        state.modo = 'PREALERTA_UNREG_TRACK';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuemos sin registro. Escribe el número de tracking (ej: TRK123456).');
      } else {
        const client = await findClientByPhoneOrEmail(text);
        if (!client) {
          state.modo = 'PREALERTA_OFFER_REGISTER';
          state.pendingIdentifier = text;
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No te encontramos registrado. ¿Quieres registrarte ahora? SI/NO');
        } else {
          state.client = client;
          state.modo = 'PREALERTA_TRACK';
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'Escribe el número de tracking que deseas prealertar.');
        }
      }
    }
    if (state.modo === 'PREALERTA_OFFER_REGISTER') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Empecemos con tu registro. Escribe tu nombre completo.');
      } else {
        state.modo = 'PREALERTA_UNREG_TRACK';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Escribe el número de tracking que deseas prealertar.');
      }
    }
    if (state.modo === 'PREALERTA_TRACK') {
      state.pendingTracking = text;
      state.modo = 'PREALERTA_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona ORIGEN: Estados Unidos, Colombia, España, China o Mexico');
    }
    if (state.modo === 'PREALERTA_ORIGEN') {
      const origin = text.toLowerCase();
      // normalize variants
      let origNorm = origin;
      if (origin.includes('estados') || origin.includes('miami') || origin.includes('usa')) origNorm = 'Estados Unidos';
      else if (origin.includes('colom')) origNorm = 'Colombia';
      else if (origin.includes('espa')) origNorm = 'España';
      else if (origin.includes('china')) origNorm = 'China';
      else if (origin.includes('mex')) origNorm = 'Mexico';
      state.prealertOrigin = origNorm;
      state.modo = 'PREALERTA_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Agrega observaciones (tipo de mercancía/producto). Es obligatorio describir la mercancía.');
    }
    if (state.modo === 'PREALERTA_OBS') {
      const obs = text;
      if (!obs || obs.length < 2) return bot.sendMessage(chatId, 'Describe brevemente el tipo de mercancía (obligatorio).');
      // write to Datos
      const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
      await addPrealertToDatos({ trackingNumber: state.pendingTracking, cliente: clienteName, origen: state.prealertOrigin, observaciones: obs });
      // ask to register another
      state.modo = null;
      clearUserState(chatId);
      await bot.sendMessage(chatId, `✅ Prealerta registrada para ${clienteName}.`, { reply_markup: mainMenuKeyboard() });
      return bot.sendMessage(chatId, '¿Deseas prealertar otro tracking? Escribe /prealerta si quieres hacerlo.');
    }

    // Default fallback: if no state active
    return;
  } catch (err) {
    console.error('message handler error', err);
    try { await bot.sendMessage(msg.chat.id, 'Ocurrió un error. Intenta nuevamente.'); } catch(e){}
  }
});

///////////////////// START / WEBHOOK /////////////////////
app.get('/', (req,res) => res.send('✅ J.I Asesoría & Courier Bot activo'));
app.post(`/${TELEGRAM_TOKEN}`, (req,res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch(e){ console.error('processUpdate error', e); } });

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
