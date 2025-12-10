// server.js - J.I Asesoría & Courier (versión final con prioridad de descripción y categoría incluida en cotizaciones)
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const URL_BASE = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID en variables de entorno');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

/* ----------------- Estado y cache local ----------------- */
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)) || null; }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

const userPhoneCache = {};
function savePhone(chatId, phone) { try { userPhoneCache[String(chatId)] = { phone: String(phone), ts: Date.now() }; } catch(e){} }
function getCachedPhone(chatId) {
  const e = userPhoneCache[String(chatId)];
  if (!e) return null;
  const ONE_HOUR = 60 * 60 * 1000;
  if ((Date.now() - e.ts) > ONE_HOUR) { delete userPhoneCache[String(chatId)]; return null; }
  return e.phone;
}

/* ----------------- Google Sheets client ----------------- */
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS || '';
  if (!credsRaw) throw new Error('Falta GOOGLE_CREDENTIALS en env');
  if (!credsRaw.trim().startsWith('{')) credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
  const credentials = JSON.parse(credsRaw);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/* ----------------- Utilidades ----------------- */
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, '');
  if (s.startsWith('506')) s = s.slice(3);
  return s;
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

/* ----------------- Cache sencillo ----------------- */
let cache = { tarifas: { data: null, ts: 0 }, direcciones: { data: null, ts: 0 } };
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

/* ----------------- Keyboards ----------------- */
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
      [{ text: 'Electrónicos', callback_data: 'CATEGORIA|Electrónicos' }, { text: 'Ropa / Calzado', callback_data: 'CATEGORIA|Ropa / Calzado' }],
      [{ text: 'Colonias / Perfumes', callback_data: 'CATEGORIA|Colonias / Perfumes' }, { text: 'Medicamentos', callback_data: 'CATEGORIA|Medicamentos' }],
      [{ text: 'Alimentos / Procesados', callback_data: 'CATEGORIA|Alimentos / Procesados' }, { text: 'Cremas / Cosméticos', callback_data: 'CATEGORIA|Cremas / Cosméticos' }],
      [{ text: 'Réplicas / Imitaciones', callback_data: 'CATEGORIA|Réplicas / Imitaciones' }, { text: 'Piezas automotrices', callback_data: 'CATEGORIA|Piezas automotrices' }],
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
function siNoInlineKeyboard() { return { inline_keyboard: [[{ text: 'SI', callback_data: 'GAM|si' }, { text: 'NO', callback_data: 'GAM|no' }]] }; }
function replyBackToMenu(chatId) {
  bot.sendMessage(chatId, '¿Deseas volver al menú principal?', {
    reply_markup: { inline_keyboard: [[ { text: 'Sí', callback_data: 'MENU|SI' }, { text: 'No', callback_data: 'MENU|NO' } ]] }
  });
}

/* ----------------- Clientes / Trackings ----------------- */
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
  if (ADMIN_TELEGRAM_ID) await bot.sendMessage(ADMIN_TELEGRAM_ID, msg);
}

/* ----------------- Tarifas (leer de la hoja Tarifas) ----------------- */
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const ranges = [
    'Tarifas!B3', // Miami sin permiso
    'Tarifas!B4', // Miami con permiso
    'Tarifas!B6', // Colombia sin permiso
    'Tarifas!B7', // Colombia con permiso
    'Tarifas!B10',// España sin permiso
    'Tarifas!B11',// España con permiso
    'Tarifas!B14',// China tarifa
    'Tarifas!B15',// México tarifa
    'Tarifas!G4:G8', // descuentos
    'Tarifas!J1:J3'  // entrega y tipo de cambio
  ];
  const read = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
  const valueRanges = read.data.valueRanges || [];

  const getVal = (i) => {
    try {
      const raw = valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0] && valueRanges[i].values[0][0];
      if (raw === undefined || raw === null || String(raw).toString().trim() === '') return 0;
      return parseFloat(String(raw).replace(',', '.')) || 0;
    } catch (e) { return 0; }
  };

  const miami_sin = getVal(0),
        miami_con = getVal(1),
        col_sin = getVal(2),
        col_con = getVal(3),
        esp_sin = getVal(4),
        esp_con = getVal(5),
        china = getVal(6),
        mexico = getVal(7);

  let discountsArrNumbers = [0,0,0,0,0];
  try {
    const gVals = valueRanges[8] && valueRanges[8].values ? valueRanges[8].values : [];
    discountsArrNumbers = gVals.map(r => parseFloat((r[0]||'0').toString().replace(',', '.')) || 0);
    while (discountsArrNumbers.length < 5) discountsArrNumbers.push(0);
  } catch (e) { discountsArrNumbers = [0,0,0,0,0]; }

  let deliveryCRC = 0, exchangeRate = 1;
  try {
    const jVals = valueRanges[9] && valueRanges[9].values ? valueRanges[9].values : [];
    deliveryCRC = parseFloat((jVals[0] && jVals[0][0]) ? String(jVals[0][0]).replace(',', '.') : 0) || 0;
    // read J3 directly (index 2)
    exchangeRate = (jVals[2] && jVals[2][0]) ? parseFloat(String(jVals[2][0]).replace(',', '.')) : null;
    if (!exchangeRate) {
      // fallback: try find numeric in that small array but do not pick delivery cost
      for (let r = 0; r < jVals.length; r++) {
        if (r === 0) continue;
        const v = jVals[r] && jVals[r][0];
        if (v && !isNaN(parseFloat(String(v).replace(',', '.')))) { exchangeRate = parseFloat(String(v).replace(',', '.')); break; }
      }
    }
    exchangeRate = exchangeRate || 1;
  } catch (e) { deliveryCRC = 0; exchangeRate = 1; }

  return {
    miami: { sinPermiso: miami_sin, conPermiso: miami_con },
    colombia: { sinPermiso: col_sin, conPermiso: col_con },
    espana: { sinPermiso: esp_sin, conPermiso: esp_con },
    china: { tarifa: china },
    mexico: { tarifa: mexico },
    discounts: discountsArrNumbers,
    j: { deliveryCRC, exchangeRate }
  };
}

/* ----------------- Discounts helper ----------------- */
function getDiscountPercentByPesoFromArr(pesoFacturable, discountsArr) {
  if (!discountsArr || discountsArr.length < 5) return 0;
  if (pesoFacturable >= 75) return (discountsArr[4]||0) / 100;
  if (pesoFacturable >= 50) return (discountsArr[3]||0) / 100;
  if (pesoFacturable >= 35) return (discountsArr[2]||0) / 100;
  if (pesoFacturable >= 25) return (discountsArr[1]||0) / 100;
  if (pesoFacturable >= 15) return (discountsArr[0]||0) / 100;
  return 0;
}

/* ----------------- Guardar cotización y historial ----------------- */
async function saveCotizacionToSheetAndNotifyAdmin(payload) {
  const sheets = await getGoogleSheetsClient();
  const row = new Array(18).fill('');
  row[0] = payload.fechaLocal || '';
  row[1] = payload.cliente || '';
  row[2] = payload.origen || '';
  row[3] = payload.peso || '';
  row[4] = payload.unidad || '';
  row[5] = payload.tipoPermiso || '';
  row[6] = payload.mercancia || '';
  row[7] = payload.categoriaFinal || '';
  row[8] = Math.round(payload.subtotalCRC || 0);
  row[9] = Math.round(payload.discountAmountCRC || 0);
  row[10] = Math.round(payload.totalCRC || 0);
  row[11] = Math.round(payload.deliveryCostCRC || 0);
  row[12] = Math.round(payload.totalWithDeliveryCRC || 0);
  row[13] = payload.exchangeRate || '';
  row[14] = '';
  row[15] = payload.id || '';
  row[16] = payload.contacto || '';
  row[17] = payload.email || '';
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cotizaciones!A:R',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
  const adminMsg = [
    `📣 Nueva cotización (respaldo)`,
    `ID: ${payload.id}`,
    `Fecha: ${payload.fechaLocal}`,
    `Cliente: ${payload.cliente}`,
    `Origen: ${payload.origen}`,
    `Categoría seleccionada / usada: ${payload.categoriaFinal || '-'}`,
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
  if (ADMIN_TELEGRAM_ID) await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const values = [[
    data.id, new Date().toISOString(), data.chatId, 'Cliente', data.email || '', data.origen || '', 'Costa Rica',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

/* ----------------- Diccionario de keywords por categoría (display names) ----------------- */
const categoryKeywords = {
  'Colonias / Perfumes': ['perfume','perfumes','colonia','colonias','fragancia','fragancias','eau de parfum','edp','eau de toilette','edt'],
  'Cremas / Cosméticos': ['maquillaje','makeup','cosméticos','cosmeticos','cremas','crema','crema facial','labial','lipstick','base','bb cream','cc cream','sombra','mascara','serum'],
  'Medicamentos': ['ibuprofeno','paracetamol','acetaminofén','naproxeno','omeprazol','amoxicilina','loratadina','jarabe','antihistamínico','antibiotico'],
  'Suplementos / Vitaminas': ['suplementos','vitaminas','proteina','whey','creatina','bcca','colageno','omega'],
  'Alimentos / Procesados': ['Comida','snack','snacks','papas','chips','galleta','galletas','chocolate','dulce','caramelo','granola','cereal','café','te','mantequilla de mani','peanut butter','enlatado','atun','sardinas','pastas'],
  'Semillas': ['semilla','semillas','chia','linaza','girasol','maiz','maíz','frijol'],
  'Agroquímicos / Fertilizantes': ['fertilizante','pesticida','pesticidas','herbicida','insecticida','glifosato','abono','npk','urea'],
  'Lentes / Líquidos': ['lentes de contacto','lentes','contact lenses','solución para lentes','acuvue','air optix','freshlook'],
  'Químicos de laboratorio': ['alcohol isopropilico','alcohol isopropílico','acetona','reactivo','ácido','pipeta','reactivos'],
  'Productos de limpieza': ['detergente','desinfectante','cloro','lejía','lejia','limpiador','wipes','sanitizante'],
  'Bebidas no alcohólicas': ['refresco','soda','sodas','gaseosa','bebida energética','red bull','pepsi','coca cola','gatorade'],
  'Réplicas / Imitaciones': ['replica','réplica','copia','imitacion','imitación','1:1','aaa','fake','falso','tenis replica','bolso replica'],
  'Documentos': ['documento','papeles','carta','factura'],
  'Piezas automotrices': ['pieza','piezas','repuesto','motor','freno','frenos'],
  'Electrónicos': ['televisor','tv','celular','telefono','smartphone','electronico','cámara','camera','tablet','laptop','ordenador','cargador']
};

/* ----------------- decidir si categoría es Especial o General ----------------- */
const specialCategoryNames = new Set([
  'Colonias / Perfumes','Cremas / Cosméticos','Medicamentos','Suplementos / Vitaminas','Semillas',
  'Agroquímicos / Fertilizantes','Lentes / Líquidos','Químicos de laboratorio','Productos de limpieza',
  'Bebidas no alcohólicas','Réplicas / Imitaciones','Alimentos / Procesados'
]);
// Note: Electrónicos, Documentos, Piezas automotrices, Ropa / Calzado, Otro => General

function categoryToTariffClass(categoryName, origen) {
  if (!categoryName) return 'General';
  if (categoryName === 'Réplicas / Imitaciones') {
    if ((origen||'').toLowerCase().includes('colombia')) return 'Especial';
    return 'General';
  }
  if (specialCategoryNames.has(categoryName)) return 'Especial';
  return 'General';
}

/* ----------------- Detectar categoría desde descripción (PRIORIDAD) ----------------- */
function detectCategoryFromDescription(desc) {
  const t = (desc || '').toLowerCase();
  if (!t) return null;
  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    for (const kw of keywords) {
      if (!kw) continue;
      if (t.includes(kw.toLowerCase())) return cat;
    }
  }
  return null;
}

/* ----------------- Unidad por origen ----------------- */
function usesKgForOrigin(origen) {
  if (!origen) return false;
  const s = origen.toLowerCase();
  return ['colombia','mexico'].some(k => s.includes(k));
}

/* ----------------- Cálculo y registro de cotización ----------------- */
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  const tarifas = await getCachedTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;
  const origen = (state.origen || '').toLowerCase();
  const pesoIngresado = parseFloat(state.peso) || 0;
  const unidadIngresada = (state.unidad || 'lb').toLowerCase();
  const descripcion = state.descripcion || '';

  // DETECCIÓN: descripción tiene prioridad absoluta
  const categoriaDetectada = detectCategoryFromDescription(descripcion);
  let categoriaFinal = categoriaDetectada || state.categoriaSeleccionada || state.categoriaFinal || 'Otro';
  // normalizar algunos labels si vienen distintos
  if (categoriaFinal && typeof categoriaFinal === 'string') categoriaFinal = categoriaFinal.trim();

  const tipoMercancia = categoryToTariffClass(categoriaFinal, state.origen || '');

  const pesoEnLb = unidadIngresada === 'kg' ? pesoIngresado * 2.20462 : pesoIngresado;
  const pesoEnKg = unidadIngresada === 'lb' ? pesoIngresado / 2.20462 : pesoIngresado;

  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';

  if (['colombia','col'].some(k => origen.includes(k))) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
  } else if (origen.includes('mexico')) {
    tarifaUSD = tarif