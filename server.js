// server.js - Bot Telegram + Google Sheets (sin GAS) - Versión completa
// Dependencias: express, node-telegram-bot-api, googleapis
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - SPREADSHEET_ID (opcional; hay un default en el código)
// - GOOGLE_CREDENTIALS  (JSON string or base64)  OR GOOGLE_SERVICE_KEY (JSON string)
// - ADMIN_TELEGRAM_ID (opcional; default 7826072133)
// - RENDER_EXTERNAL_URL (opcional, para setWebHook)

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ---------------- CONFIG ----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS && !process.env.GOOGLE_SERVICE_KEY) {
  throw new Error('Falta GOOGLE_CREDENTIALS o GOOGLE_SERVICE_KEY en variables de entorno (JSON o base64)');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ---------------- Estado por usuario (simple in-memory) ----------------
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// ---------------- Listas y constantes ----------------
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
const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china','usa','espana']; // normalizados

// ---------------- Google Sheets client ----------------
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_SERVICE_KEY;
  if (!credsRaw) throw new Error('No GOOGLE_CREDENTIALS / GOOGLE_SERVICE_KEY found');

  try {
    // If it's base64, decode. If it's file-like (starts with {) parse directly.
    if (!credsRaw.trim().startsWith('{')) {
      // try base64 decode
      credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
    }
    const credentials = JSON.parse(credsRaw);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (err) {
    console.error('Error parseando GOOGLE_CREDENTIALS:', err.message || err);
    throw err;
  }
}

// ---------------- UTILIDADES ----------------
function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).trim();
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
function ensureMenuOptions() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/pendiente', '/prealertar']
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
function origenKeyboard() {
  return {
    keyboard: [
      ['miami','madrid'],
      ['colombia','mexico'],
      ['china','Cancelar']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}
function yesNoInline() {
  return { inline_keyboard: [[{ text: 'SI', callback_data: 'GAM|si' }, { text: 'NO', callback_data: 'GAM|no' }]] };
}
function originChoiceInline() {
  return {
    inline_keyboard: [
      [{ text: 'Estados Unidos (Miami)', callback_data: 'PRE_ORIGIN|miami' }],
      [{ text: 'Colombia', callback_data: 'PRE_ORIGIN|colombia' }],
      [{ text: 'España (Madrid)', callback_data: 'PRE_ORIGIN|espana' }],
      [{ text: 'México', callback_data: 'PRE_ORIGIN|mexico' }],
      [{ text: 'China', callback_data: 'PRE_ORIGIN|china' }]
    ]
  };
}

// ---------------- LECTURA DE DIRECCIONES ----------------
async function getDireccionesForCliente(nombreCliente = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
  const data = res.data.values || [];

  const replaceName = (t) => (t || '').replace(/Nombre de cliente/gi, nombreCliente);

  // These ranges are approximate; your sheet structure: adjust indices if needed
  // We'll extract text blocks by row ranges described earlier:
  const chunk = (r1, r2, c1, c2) => {
    const lines = [];
    for (let r = r1; r <= r2 && r < data.length; r++) {
      const row = data[r] || [];
      const parts = [];
      for (let c = c1; c <= c2; c++) {
        if (row[c]) parts.push(row[c]);
      }
      if (parts.length) lines.push(parts.join(' '));
    }
    return lines.join('\n') || 'No disponible';
  };

  return {
    miami: replaceName(chunk(1,4,1,3)),
    espana: replaceName(chunk(16,20,1,3)),
    colombiaCon: replaceName(chunk(0,6,6,9)),   // G1:J7 ~ indices depend on sheet; adjust if needed
    colombiaSin: replaceName(chunk(10,16,6,9)), // G11:J17
    mexico: replaceName(chunk(23,28,1,3)),
    china: replaceName(chunk(23,28,6,9))
  };
}

// ---------------- SHEETS: Clientes ----------------
async function findClientByPhoneOrEmail(value) {
  if (!value) return null;
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I' });
  const rows = res.data.values || [];
  const vnorm = normalizePhone(value);
  const vlower = (value || '').toLowerCase();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0] || '';
    const email = (row[1] || '').toLowerCase();
    const phone = normalizePhone(row[3] || row[4] || ''); // try D or E depending sheet variant
    // match by phone or email
    if (phone && vnorm && (phone === vnorm || phone.endsWith(vnorm) || vnorm.endsWith(phone))) {
      return { rowIndex: i+1, nombre: name, correo: row[1]||'', telefono: row[3]||row[4]||'', direccion: row[6]||row[5]||'', saldo: parseFloat(row[7]||row[8]||0) || 0 };
    }
    if (email && vlower && email === vlower) {
      return { rowIndex: i+1, nombre: name, correo: row[1]||'', telefono: row[3]||row[4]||'', direccion: row[6]||row[5]||'', saldo: parseFloat(row[7]||row[8]||0) || 0 };
    }
  }
  return null;
}
async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', correo || '', '', contacto || '', '', direccion || '', '', 0 ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I', valueInputOption: 'RAW', resource: { values } });
  // notify admin
  await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 Nuevo registro: ${nombre} (${contacto || '-'}, ${correo || '-'})`);
}

// ---------------- TRACKINGS (Datos) ----------------
async function getTrackingsByName(nombre) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:I' });
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
        cliente: r[1] || '',
        origen: r[3] || '',
        estado: r[4] || '',
        peso: r[5] || '',
        comentarios: r[8] || ''
      });
    }
  }
  return items;
}
async function addPrealertTracking({ trackingNumber, clienteName, origen, observaciones }) {
  const sheets = await getGoogleSheetsClient();
  // We write into Datos: A tracking, B cliente, C (opt) maybe date? We'll put origen in D, estado in E, observations in I (index 8)
  // Build row with at least 9 columns (A..I)
  const now = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
  const row = [ trackingNumber, clienteName, now, origen, 'Pre-alertado', '', '', '', observaciones || '' ];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:I', valueInputOption: 'RAW', resource: { values: [row] } });
  // notify admin
  await bot.sendMessage(ADMIN_TELEGRAM_ID, `🔔 Prealerta: ${trackingNumber}\nCliente: ${clienteName}\nOrigen: ${origen}\nObs: ${observaciones || '-'}`);
}

// ---------------- LECTURA DE TARIFAS Y DESCUENTOS ----------------
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  // Tarifas B2:B15 (USD per kg/lb grid)
  let values = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
    values = (res.data.values || []).map(r => parseFloat(r[0]) || 0);
  } catch (e) {
    console.warn('No se pudo leer Tarifas!B2:B15:', e.message || e);
    // fallback defaults
    values = Array(15).fill(0);
  }

  // Read J1:J3 -> J1 delivery CRC, J2 maybe unused, J3 exchangeRate
  let jVals = { deliveryCRC: 0, exchangeRate: 1 };
  try {
    const r2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!J1:J3' });
    const arr = (r2.data.values || []).map(r => r[0]);
    jVals.deliveryCRC = parseFloat(arr[0]) || 0;
    jVals.exchangeRate = parseFloat(arr[2]) || 1;
  } catch (e) {
    console.warn('No se pudo leer Tarifa J1:J3:', e.message || e);
  }

  // Read discounts G2..G7 as integers (5 => 5%)
  const discounts = { 15:0,25:0,35:0,50:0,75:0 }; // mapping thresholds
  try {
    const r3 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!G2:G7' });
    const arr = (r3.data.values || []).map(r => parseFloat(r[0]) || 0);
    // arr[0] -> G2 (0-14 maybe), arr[1] -> G3 (15-24), etc.
    // We'll map thresholds as user specified earlier:
    // G2 -> 0-14 (we'll ignore, 0%)
    // G3 -> 15-24
    // G4 -> 25-34
    // G5 -> 35-49
    // G6 -> 50-74
    // G7 -> 75+
    discounts[15] = (arr[1] || 0) / 100.0;
    discounts[25] = (arr[2] || 0) / 100.0;
    discounts[35] = (arr[3] || 0) / 100.0;
    discounts[50] = (arr[4] || 0) / 100.0;
    discounts[75] = (arr[5] || 0) / 100.0;
  } catch (e) {
    console.warn('No se pudo leer descuentos G2:G7:', e.message || e);
  }

  return {
    grid: values,
    j: jVals,
    discounts
  };
}

function getDiscountFromTable(discounts, peso) {
  // peso is integer (facturable)
  if (peso >= 75) return discounts[75] || 0;
  if (peso >= 50) return discounts[50] || 0;
  if (peso >= 35) return discounts[35] || 0;
  if (peso >= 25) return discounts[25] || 0;
  if (peso >= 15) return discounts[15] || 0;
  return 0;
}

// ---------------- GUARDAR COTIZACIONES ----------------
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
    `Descuento: ¢${Math.round(payload.discountAmountCRC)} (${((payload.discountPercent||0)*100).toFixed(1)}%)`,
    `Costo entrega: ¢${Math.round(payload.deliveryCostCRC)}`,
    `Total (con entrega): ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `Tipo de cambio: ${payload.exchangeRate}`,
    `Contacto: ${payload.contacto || '-'}`,
    `Email: ${payload.email || '-'}`
  ].join('\n');

  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

// ---------------- HISTORIAL ----------------
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

// ---------------- CÁLCULO DE COTIZACIÓN ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  // state: origen, peso, unidad, tipoMercancia, descripcion, entregaGAM (bool), client (object if matched) or nombre/telefono/correo fields
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

  const origen = state.origen;
  const peso = state.peso;
  const unidad = state.unidad;
  const tipoMercancia = state.tipoMercancia || 'General';
  const descripcion = state.descripcion || '';
  const entregaGAM = !!state.entregaGAM;

  // determine tarifaUSD from grid depending on origin & special/general
  // We expect tarifas.grid to have specific indices; adjust mapping depending your Tarifas!B2:B15 layout.
  // For simplicity: we'll map by origin to approximate index positions (you can refine later).
  const grid = tarifas.grid || [];
  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotalUSD = 0;

  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = (origen || '').toLowerCase();

  // NOTE: adjust index mapping if your Tarifas sheet differs.
  try {
    if (origenLower === 'colombia') {
      // For Colombia we use kg rates: assume grid[4] = sinPermiso, grid[5] = conPermiso (as in earlier code)
      tarifaUSD = (tipoMercancia === 'Especial' || (state.categoriaSeleccionada || '').toLowerCase().includes('réplica')) ? (grid[5] || 16) : (grid[4] || 9);
      pesoFacturable = Math.ceil(pesoEnKg);
      unidadFacturable = 'kg';
      subtotalUSD = tarifaUSD * pesoFacturable;
    } else if (origenLower === 'mexico') {
      tarifaUSD = grid[13] || 12;
      pesoFacturable = Math.ceil(pesoEnKg);
      unidadFacturable = 'kg';
      subtotalUSD = tarifaUSD * pesoFacturable;
    } else if (origenLower === 'china') {
      tarifaUSD = grid[11] || 10;
      pesoFacturable = Math.ceil(pesoEnLb);
      unidadFacturable = 'lb';
      subtotalUSD = tarifaUSD * pesoFacturable;
    } else if (origenLower === 'miami' || origenLower === 'usa') {
      tarifaUSD = (tipoMercancia === 'Especial') ? (grid[1] || 7) : (grid[0] || 6);
      pesoFacturable = Math.ceil(pesoEnLb);
      unidadFacturable = 'lb';
      subtotalUSD = tarifaUSD * pesoFacturable;
    } else if (origenLower === 'madrid' || origenLower === 'espana') {
      tarifaUSD = (tipoMercancia === 'Especial') ? (grid[9] || 9.9) : (grid[8] || 8.5);
      pesoFacturable = Math.ceil(pesoEnLb);
      unidadFacturable = 'lb';
      subtotalUSD = tarifaUSD * pesoFacturable;
    } else {
      throw new Error('Origen no soportado');
    }
  } catch (e) {
    console.warn('Error determinando tarifaUSD:', e.message || e);
    throw e;
  }

  const subtotalCRC = subtotalUSD * exchangeRate;
  // get discount percent from table
  const discountPercent = getDiscountFromTable(tarifas.discounts || {}, pesoFacturable);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;

  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });

  const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
  const contacto = (state.client && state.client.telefono) ? state.client.telefono : (state.telefono || '');
  const email = (state.client && state.client.correo) ? state.client.correo : (state.correo || '');

  // store deliveryMethod info if fuera GAM
  if (!entregaGAM && state.deliveryChoice) {
    state.deliveryMethod = state.deliveryChoice; // "Encomienda" or "Correos de C.R."
  }

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
    id,
    fecha: new Date().toISOString(),
    chatId,
    cliente: clienteName,
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

// ---------------- MENSAJES / COMMANDS ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier.\nUsa /menu para ver opciones.`, { reply_markup: ensureMenuOptions() });
});
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: ensureMenuOptions() }));

// alias for pendiente
bot.onText(/\/pendiente|\/saldo|\/saldo_a_pagar|\/pendiente_de_pago/i, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente (ej: 88885555).');
});

// crear casillero
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero (muestra direcciones)
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  // We want to keep the user's context (ask for phone to identify)
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número con el que te registraste (ej: 88885555) para ver tu casillero.');
});

// consultar tracking
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_TRACKING_PHONE' });
  bot.sendMessage(chatId, 'Para consultar tus paquetes escribe el número con el que te registraste (ej: 88885555).');
});

// prealertar flow
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_ORIGIN' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Selecciona el ORIGEN:', { reply_markup: originChoiceInline() });
});

// cotizar
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_START' });
  bot.sendMessage(chatId, 'Comenzamos la cotización. Ingresa tu *número de teléfono* o *correo* de registro. Si no estás registrado, escribe "NO".', { parse_mode: 'Markdown' });
});

// banner /contact options
bot.onText(/\/banner/, (msg) => {
  bot.sendPhoto(msg.chat.id, 'https://i.imgur.com/qJnTEVD.jpg').catch(()=>bot.sendMessage(msg.chat.id,'Banner no disponible'));
});

// ---------------- CALLBACKS ----------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});

  try {
    // GAM yes/no (from COTIZAR_GAM phase)
    if (data.startsWith('GAM|')) {
      const ans = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.entregaGAM = (ans === 'si');
      st.modo = st.client ? 'COTIZAR_DESCRIPCION' : 'COTIZAR_ASK_CONTACT_IF_UNREG';
      setUserState(chatId, st);
      if (st.client) {
        return bot.sendMessage(chatId, 'Indica la descripción de la mercancía (marca/modelo, breve).');
      } else {
        return bot.sendMessage(chatId, 'Si no estás registrado, por favor ingresa tu correo (ej: correo@ejemplo.com) o escribe NO para continuar sin registro.');
      }
    }

    // prealert origin selection
    if (data.startsWith('PRE_ORIGIN|')) {
      const origin = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.pre_origin = origin;
      st.modo = 'PREALERT_ASK_TRACKING';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, `Origen seleccionado: ${origin}. Ahora escribe el número de TRACKING (ej: 1Z... o 123456789).`);
    }

    // category selection in cotizar
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.categoriaSeleccionada = categoria;
      // classification step: if origen Colombia and category might be replica, we will ask later
      st.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, st);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Describe el producto (marca, tipo).`, { parse_mode: 'Markdown' });
    }

    // PREALERT origin inline handles above. Next: Colombia casillero type selection
    if (data.startsWith('CASILLERO_COLO|')) {
      const tipo = data.split('|')[1]; // 'con' or 'sin' or 'replica' etc.
      const st = getUserState(chatId) || {};
      const nombre = st.client && st.client.nombre ? st.client.nombre : (query.from.first_name || 'Cliente');
      const dire = await getDireccionesForCliente(nombre);
      const direccion = (tipo === 'especial' || tipo === 'replica') ? dire.colombiaCon : dire.colombiaSin;
      await bot.sendMessage(chatId, `📍 Dirección Colombia (${tipo==='especial'?'Especial/Replica':'General'}):\n\n${direccion}`, { parse_mode: 'Markdown' });
      // after showing address, offer return to menu
      await bot.sendMessage(chatId, '¿Deseas volver al /menu?', { reply_markup: ensureMenuOptions() });
      clearUserState(chatId);
      return;
    }

    // GAM selection for pre-alert? Not used.

    // Tracking pagination and detail handlers (if used) - simple pass-through
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
    console.error('Error callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error procesando la opción.');
  }
});

// ---------------- MESSAGE HANDLER (flows) ----------------
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return; // commands handled elsewhere
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // --- CREAR CASILLERO ---
    if (state.modo === 'CREAR_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) return bot.sendMessage(chatId, 'Por favor ingresa *Nombre completo* con al menos 1 nombre y 2 apellidos.', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_CORREO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ahora ingresa tu *correo electrónico* para contacto.', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_CORREO') {
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
      await bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, '¿Deseas volver al /menu?', { reply_markup: ensureMenuOptions() });
      return;
    }

    // --- CHECK CASILLERO (mi_casillero) ---
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhoneOrEmail(phone);
      if (!client) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      }
      // Save client to session for subsequent actions
      const st = { modo: 'MI_CASILLERO_ORIGEN', client };
      setUserState(chatId, st);
      // greet with client's name
      await bot.sendMessage(chatId, `Hola ${client.nombre}. Selecciona el país de tu casillero:`, { reply_markup: casilleroInlineKeyboardForMenu() });
      return;
    }

    // --- CONSULTAR TRACKING PHONE ---
    if (state.modo === 'CHECK_TRACKING_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.');
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // --- CHECK SALDO ---
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhoneOrEmail(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}\n¿Deseas volver al /menu?`, { reply_markup: ensureMenuOptions() });
    }

    // --- PREALERT FLOW ---
    if (state.modo === 'PREALERT_ASK_TRACKING') {
      const trackingNumber = text;
      if (!trackingNumber || trackingNumber.length < 4) return bot.sendMessage(chatId, 'Tracking inválido. Intenta nuevamente.');
      state.trackingNumber = trackingNumber;
      state.modo = 'PREALERT_ASK_CLIENT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas asociar este tracking. Si no deseas asociarlo, responde NO.');
    }
    if (state.modo === 'PREALERT_ASK_CLIENT') {
      const ident = text.toLowerCase();
      let client = null;
      if (ident !== 'no') client = await findClientByPhoneOrEmail(ident);
      if (!client && ident !== 'no') {
        // ask if want to register
        state.pendingIdent = ident;
        state.modo = 'PREALERT_ASK_REGISTER';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos ese número/correo. ¿Deseas registrarte ahora? Responde SI o NO.');
      }
      // proceed
      state.client = client;
      state.modo = 'PREALERT_ASK_MERCH';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el tipo de mercancía/producto (obligatorio). Ej: Ropa, Electrónicos, Medicamento, etc.');
    }
    if (state.modo === 'PREALERT_ASK_REGISTER') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI o NO.');
      if (['si','s'].includes(ans)) {
        state.modo = 'CREAR_NOMBRE'; // jump into create flow and reuse create flow
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Vamos a registrarte. Primero escribe tu nombre completo.');
      } else {
        // continue as unregistered - request name/contact/email to attach to tracking
        state.modo = 'PREALERT_ASK_UNREG_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Entonces ingresa tu Nombre completo para asociarlo a este tracking.');
      }
    }
    if (state.modo === 'PREALERT_ASK_UNREG_NAME') {
      state.nombre = text;
      state.modo = 'PREALERT_ASK_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (ej: correo@ejemplo.com).');
    }
    if (state.modo === 'PREALERT_ASK_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correo = text;
      state.modo = 'PREALERT_ASK_UNREG_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'PREALERT_ASK_UNREG_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta nuevamente.');
      state.telefono = phone;
      state.modo = 'PREALERT_ASK_MERCH';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el tipo de mercancía/producto (obligatorio).');
    }
    if (state.modo === 'PREALERT_ASK_MERCH') {
      const merch = text;
      if (!merch) return bot.sendMessage(chatId, 'Debes indicar el tipo de mercancía.');
      state.merch = merch;
      // All data collected -> save prealert
      const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || (state.pendingIdent || 'Cliente Telegram'));
      const origen = state.pre_origin || 'Desconocido';
      const obs = `Tipo: ${merch}. Prealertado: ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`;
      await addPrealertTracking({ trackingNumber: state.trackingNumber, clienteName, origen, observaciones: obs });
      clearUserState(chatId);
      await bot.sendMessage(chatId, `✅ Tracking prealertado: ${state.trackingNumber}\nCliente: ${clienteName}\nOrigen: ${origen}\nObservaciones: ${obs}`);
      await bot.sendMessage(chatId, '¿Deseas prealertar otro tracking? Responde SI para continuar o NO para volver al /menu.');
      // set short-lived state to decide
      setUserState(chatId, { modo: 'PREALERT_ASK_CONTINUE' });
      return;
    }
    if (state.modo === 'PREALERT_ASK_CONTINUE') {
      const ans = text.toLowerCase();
      if (['si','s'].includes(ans)) {
        setUserState(chatId, { modo: 'PREALERT_ORIGIN' });
        return bot.sendMessage(chatId, 'Selecciona ORIGEN:', { reply_markup: originChoiceInline() });
      } else {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Muy bien. Volviendo al /menu.', { reply_markup: ensureMenuOptions() });
      }
    }

    // --- COTIZAR FLOW ---
    // COTIZAR_START: user provided phone/email or NO
    if (state.modo === 'COTIZAR_START') {
      const ident = text.toLowerCase();
      if (ident === 'no') {
        // unregistered -> ask name
        state.modo = 'COTIZAR_UNREG_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No estás registrado. Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
      // try match
      const client = await findClientByPhoneOrEmail(ident);
      if (client) {
        state.client = client; // attach client
        state.modo = 'COTIZAR_ORIGEN';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Cliente encontrado. Selecciona ORIGEN (usa teclado):', { reply_markup: origenKeyboard() });
      } else {
        // not found -> ask whether to register or continue unregistered
        state.pendingIdent = ident;
        state.modo = 'COTIZAR_ASK_REGISTER';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos registro. ¿Deseas registrarte ahora? Responde SI o NO.');
      }
    }
    if (state.modo === 'COTIZAR_ASK_REGISTER') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI o NO.');
      if (['si','s'].includes(ans)) {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Primero escribe tu Nombre completo.');
      } else {
        // proceed unregistered: ask mandatory name -> phone -> email
        state.modo = 'COTIZAR_UNREG_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ok. Ingresa tu Nombre completo (obligatorio).');
      }
    }
    if (state.modo === 'COTIZAR_UNREG_NAME') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa al menos Nombre y Apellido.');
      state.nombre = text;
      state.modo = 'COTIZAR_UNREG_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREG_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos.');
      state.telefono = phone;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (ej: correo@ejemplo.com).');
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correo = text;
      // proceed to origen selection
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Gracias. Ahora selecciona el ORIGEN (usa teclado):', { reply_markup: origenKeyboard() });
    }

    // COTIZAR_ORIGEN: user types origin (because keyboard used)
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      if (!VALID_ORIGINS.includes(origin)) {
        return bot.sendMessage(chatId, 'Origen inválido. Usa una opción del teclado: miami, madrid, colombia, mexico, china');
      }
      state.origen = origin;
      // if origin is colombia, we may later ask replica question depending on category
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    // COTIZAR_DESCRIPCION: after category => description
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
      // If origin is Colombia and category could be replica, ask special question
      if (state.origen === 'colombia' && (state.categoriaSeleccionada||'').toLowerCase().includes('ropa') ) {
        state.modo = 'COTIZAR_COLOMBIA_REPLICA';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿La mercancía es Réplica/Imitación o requiere permiso? Responde SI o NO.');
      }
      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb, 3 libras, 5 kilos).');
    }

    if (state.modo === 'COTIZAR_COLOMBIA_REPLICA') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI o NO.');
      if (['si','s'].includes(ans)) {
        state.tipoMercancia = 'Especial';
      } else {
        state.tipoMercancia = 'General';
      }
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
      state.modo = 'COTIZAR_GAM_MENU';
      setUserState(chatId, state);
      // ask GAM via inline yes/no
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', { reply_markup: yesNoInline() });
    }

    // After GAM choice (handled by callback), we may be in COTIZAR_EMAIL_OR_CLIENT or COTIZAR_DESCRIPCION depending earlier
    if (state.modo === 'COTIZAR_EMAIL_OR_CLIENT') {
      // backward compatibility - not used much
    }

    // If no known flow, ignore
  } catch (err) {
    console.error('Error message handler:', err);
    // best-effort reply
    try { bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente.'); } catch(e){}
  }
});

// Helper to present casillero keyboard inline (with Colombia special handling)
function casilleroInlineKeyboardForMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇺🇸 Miami', callback_data: 'CASILLERO|miami' }],
        [{ text: '🇪🇸 Madrid', callback_data: 'CASILLERO|espana' }],
        [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO_COLOPA' }],
        [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
        [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }]
      ]
    }
  };
}

// CASILLERO callbacks: show addresses (Colombia shows choice to pick special/general)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    if (data === 'CASILLERO_COLOPA') {
      // ask special or general
      return bot.sendMessage(chatId, 'Selecciona el tipo de casillero en Colombia:', { reply_markup: { inline_keyboard: [[{ text: '🧰 Especial / Réplica', callback_data: 'CASILLERO_COLO|especial' }],[{ text: '📦 General (sin permiso)', callback_data: 'CASILLERO_COLO|general' }]] } });
    }
    // the other CASILLERO|xxx handled earlier in earlier callback handler - but ensure handling
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1];
      const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDireccionesForCliente(nombre);
      let direccion = 'No disponible';
      if (pais === 'miami') direccion = dire.miami;
      else if (pais === 'espana' || pais === 'madrid') direccion = dire.espana;
      else if (pais === 'mexico') direccion = dire.mexico;
      else if (pais === 'china') direccion = dire.china;
      const nombres = { miami:'Miami', espana:'Madrid', mexico:'Ciudad de México', china:'China' };
      return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('Error in CASILLERO callback:', e);
    bot.sendMessage(chatId, 'Error mostrando casillero.');
  }
});

// sendTrackingList (paginated)
const TRACKS_PER_PAGE = 5;
async function sendTrackingList(chatId, items, page = 1) {
  if (!items || items.length === 0) return bot.sendMessage(chatId, 'No se encontraron paquetes para tu casillero.');
  const totalPages = Math.ceil(items.length / TRACKS_PER_PAGE);
  page = Math.max(1, Math.min(page, totalPages));
  const start = (page - 1) * TRACKS_PER_PAGE;
  const slice = items.slice(start, start + TRACKS_PER_PAGE);

  const lines = slice.map((it, idx) => {
    const localIndex = start + idx + 1;
    // include pending amount if estado matches
    return `${localIndex}. ${it.tracking || '(sin tracking)'} — ${it.origen || '-'} — ${it.estado || '-'} — ${it.peso || '-'}`;
  }).join('\n');

  const inline = slice.map((it, idx) => [{ text: `Ver ${start+idx+1}`, callback_data: `TRACK_DETAIL|${start+idx}` }]);
  const paging = [];
  if (page > 1) paging.push({ text: '◀️ Anterior', callback_data: `TRACK_PAGE|${page-1}` });
  if (page < totalPages) paging.push({ text: 'Siguiente ▶️', callback_data: `TRACK_PAGE|${page+1}` });
  const inline_keyboard = inline.concat([paging]);

  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n\n${lines}`, {
    reply_markup: { inline_keyboard }
  });

  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

// ---------------- INICIALIZAR SERVIDOR Y WEBHOOK ----------------
const PORT = process.env.PORT || 3000;
app.get('/', (req,res) => res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier'));
app.post(`/${TELEGRAM_TOKEN}`, (req,res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch(e){ console.error('processUpdate error', e); } });

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
