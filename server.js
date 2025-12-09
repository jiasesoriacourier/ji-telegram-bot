// server.js - J.I Asesoría & Courier (versión final con registro de empresas por código - Opción C)
// Reemplazar completamente el server.js actual por este archivo.
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
let cache = { tarifas: { data: null, ts: 0 }, direcciones: { data: null, ts: 0 }, empresas: { data: null, ts: 0 } };
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
async function getCachedEmpresas() {
  const now = Date.now();
  if (!cache.empresas.data || (now - cache.empresas.ts) > CACHE_TTL) {
    const sheets = await getGoogleSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Empresas!A:F' });
    cache.empresas.data = res.data.values || [];
    cache.empresas.ts = now;
  }
  return cache.empresas.data;
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
function yesNoKeyboardInline() {
  return { inline_keyboard: [[{ text: 'Sí', callback_data: 'ANS|si' }, { text: 'No', callback_data: 'ANS|no' }]] };
}

/* ----------------- Clientes / Trackings ----------------- */
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:Z' });
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
        saldo: parseFloat(row[7]) || 0,
        empresaCode: row[9] || '' // columna J (índice 9)
      };
    }
  }
  return null;
}
async function addClientToSheet({ nombre, correo, contacto, direccion, empresaCode }) {
  const sheets = await getGoogleSheetsClient();
  // Guardamos hasta columna J (A..J)
  const values = [[ nombre || '', correo || '', '', contacto || '', '', direccion || '', '', 0, '', empresaCode || '' ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:J',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

/* ----------------- Empresas sheet helpers ----------------- */
// Leemos 'Empresas' y en la columna F (index 5) está la Abreviatura / código exacto que el cliente debe ingresar (opción C)
async function findEmpresaByCode(code) {
  if (!code) return null;
  const empresas = await getCachedEmpresas();
  const search = String(code || '').trim().toUpperCase();
  for (let i = 0; i < empresas.length; i++) {
    const row = empresas[i] || [];
    const abbrev = (row[5] || '').toString().trim().toUpperCase(); // columna F
    if (abbrev && abbrev === search) {
      return {
        rowIndex: i + 1,
        nombre: row[0] || '',
        tipo: row[1] || '',
        correo: row[2] || '',
        telefono: row[3] || '',
        contacto: row[4] || '',
        abreviatura: row[5] || ''
      };
    }
  }
  return null;
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
  // Guardamos categoría final en columna H (índice 7) y código empresa en columna R? (ya se agrega en clientes) -> A:R example
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
  'Alimentos / Procesados': ['snack','snacks','papas','chips','galleta','galletas','chocolate','dulce','caramelo','granola','cereal','café','te','mantequilla de mani','peanut butter','enlatado','atun','sardinas','pastas'],
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

  // prioridad absoluta: descripción > selección
  const categoriaDetectada = detectCategoryFromDescription(descripcion);
  let categoriaFinal = categoriaDetectada || state.categoriaSeleccionada || state.categoriaFinal || 'Otro';
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
    tarifaUSD = tarifas.mexico.tarifa || 0;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
  } else if (origen.includes('china')) {
    tarifaUSD = tarifas.china.tarifa || 0;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else if (['miami','estados unidos','usa'].some(k => origen.includes(k))) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else if (origen.includes('madrid') || origen.includes('espana') || origen.includes('españa')) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else {
    tarifaUSD = tarifas.miami && tarifas.miami.sinPermiso ? tarifas.miami.sinPermiso : 0;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  }

  tarifaUSD = Number(tarifaUSD) || 0;
  const subtotalUSD = tarifaUSD * (pesoFacturable || 0);
  const subtotalCRC = subtotalUSD * (exchangeRate || 1);
  const discountPercent = getDiscountPercentByPesoFromArr(pesoFacturable, tarifas.discounts || []);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;
  const entregaGAM = !!state.entregaGAM;
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;
  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
  const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
  const contacto = (state.client && state.client.telefono) ? state.client.telefono : (state.telefono || '');
  const email = (state.client && state.client.correo) ? state.client.correo : (state.correo || '');

  const payload = {
    id, fechaLocal, cliente: clienteName, origen: state.origen || '', peso: pesoIngresado, unidad: unidadIngresada,
    tipoPermiso: tipoMercancia, mercancia: descripcion || '', categoriaFinal,
    subtotalCRC, discountPercent, discountAmountCRC, totalCRC, deliveryCostCRC: deliveryCost,
    totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable, contacto, email
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);
  await guardarEnHistorial({
    id, chatId, email, origen: state.origen || '', tipoMercancia, peso: pesoIngresado, unidad: unidadIngresada,
    pesoFacturable, tarifa: tarifaUSD, subtotal: subtotalUSD, discountPercent,
    discountAmount: discountAmountCRC / (exchangeRate || 1), total: totalCRC / (exchangeRate || 1)
  });

  return {
    id, subtotalCRC, discountPercent, discountAmountCRC, totalCRC,
    deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable, categoriaFinal
  };
}

/* ----------------- Leyenda de descuento (Opción 3: emocional) ----------------- */
function buildDiscountLegend(pesoFacturable, discountsArr, origen) {
  const bands = [
    { min: 15, max: 24, disc: discountsArr[0] || 0 },
    { min: 25, max: 34, disc: discountsArr[1] || 0 },
    { min: 35, max: 49, disc: discountsArr[2] || 0 },
    { min: 50, max: 74, disc: discountsArr[3] || 0 },
    { min: 75, max: Infinity, disc: discountsArr[4] || 0 }
  ];
  const unit = usesKgForOrigin(origen) ? 'kg' : 'lb';
  if (!pesoFacturable || pesoFacturable <= 0) return '';
  for (let i=0;i<bands.length;i++) {
    const b = bands[i];
    if (pesoFacturable >= b.min && pesoFacturable <= b.max) {
      if (i === bands.length -1) {
        return `💰 ¡Tu envío ya está obteniendo el descuento máximo (${b.disc}%)! Excelente decisión.`;
      }
      const next = bands[i+1];
      const falta = Math.max(0, next.min - pesoFacturable);
      return `💡 ¡Solo te faltan *${falta} ${unit}* para desbloquear un descuento del *${next.disc}%*! Aprovechá y ahorrá más en tu envío.`;
    }
  }
  if (pesoFacturable < 15) {
    const falta = 15 - pesoFacturable;
    return `💡 ¡Solo te faltan *${falta} ${unit}* para desbloquear un descuento del *${bands[0].disc}%*! Aprovechá y ahorrá más en tu envío.`;
  }
  return '';
}

/* ----------------- Bot commands & flows ----------------- */
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nBienvenido a J.I Asesoría & Courier. Usa /menu para ver opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => { bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }); });
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});
bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
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

/* ----------------- Callback handling ----------------- */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    if (data.startsWith('USE_PHONE|')) {
      const parts = data.split('|');
      const target = parts[1] || '';
      const ans = (parts[2] || '').toLowerCase();
      if (ans === 'si') {
        const cached = getCachedPhone(chatId);
        if (!cached) return bot.sendMessage(chatId, 'No se encontró un número guardado. Por favor ingresa el número ahora.');
        if (target === 'MI_CASILLERO') {
          const client = await findClientByPhone(cached);
          if (!client) return bot.sendMessage(chatId, 'Número no registrado. Usa /crear_casillero o ingresa otro número.');
          setUserState(chatId, { client });
          const dire = await getCachedDirecciones(client.nombre);
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
          setUserState(chatId, { modo: 'PREALERT_IDENT' });
          return bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas registrar este tracking (ej: 88885555) o responde "NO" si no estás registrado.');
        }
        if (data.includes('|COTIZAR|')) {
          setUserState(chatId, { modo: 'COTIZAR_START' });
          return bot.sendMessage(chatId, 'Ingresa tu número de teléfono (ej: 88885555) o escribe "NO" si no estás registrado.');
        }
        return bot.sendMessage(chatId, 'Operación cancelada. Usa /menu para volver al inicio.');
      }
    }

    if (data === 'MENU|SI') return bot.sendMessage(chatId, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
    if (data === 'MENU|NO') return bot.sendMessage(chatId, 'Perfecto. Si necesitas algo más, escribe /menu.');

    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.categoriaFinal = categoria;
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
            const tarifas = await getCachedTarifas();
            const discountLegend = buildDiscountLegend(res.pesoFacturable, tarifas.discounts || [], st.origen);
            const nota = "\n\n📝 Nota: Los montos aquí mostrados son aproximados y pueden variar según el tipo de cambio al momento del cobro, el peso final del paquete y la clasificación real de la mercancía.";
            const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nCategoría: ${res.categoriaFinal || st.categoriaSeleccionada || '-'}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})${nota}\n\n${discountLegend}`;
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

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.');
  }
});

/* ----------------- Mensajes de texto / flujos ----------------- */
bot.on('message', async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const textRaw = msg.text.trim();
    const text = textRaw;
    const state = getUserState(chatId) || {};

    // 1) Si es comando manejado por onText, ignorar aquí (se maneja en onText)
    if (text.startsWith('/')) return;

    // 2) Handler universal: si no hay modo activo, responde y guía al menú
    if (!state || !state.modo) {
      return bot.sendMessage(chatId,
        `¡Hola! 👋\nBienvenido a *J.I Asesoría & Courier*.\n\nPara usar nuestro sistema selecciona una opción del menú o escribe uno de los comandos:\n/prealertar\n/consultar_tracking\n/crear_casillero\n/mi_casillero\n/cotizar\n/saldo\n\nSi necesitas ayuda escribe /ayuda.`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
      );
    }

    // --- Flujos de registro y asociación ---
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
        if (ADMIN_TELEGRAM_ID) await bot.sendMessage(ADMIN_TELEGRAM_ID, `Intento de registro con número ya existente: ${phone} por chat ${chatId}`);
        return;
      }
      state.telefono = phone;
      savePhone(chatId, phone);
      // Preguntamos si pertenece a empresa/asociación afiliada
      state.modo = 'CREAR_ASSOC_PROMPT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿Pertenecés a alguna empresa o asociación afiliada? Responde SI o NO (si no, escribe NO).');
    }
    if (state.modo === 'CREAR_ASSOC_PROMPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_ASSOC_CODE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Por favor ingresa el *código* que te proporcionó tu empresa/asociación (ej: AJPN-2024).', { parse_mode: 'Markdown' });
      } else if (ans === 'no' || ans === 'n') {
        state.empresaCode = '';
        state.modo = 'CREAR_DIRECCION';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
      } else {
        return bot.sendMessage(chatId, 'Responde SI o NO por favor.');
      }
    }
    if (state.modo === 'CREAR_ASSOC_CODE') {
      const code = text.trim();
      const empresa = await findEmpresaByCode(code);
      if (!empresa) {
        return bot.sendMessage(chatId, 'Ese código no está afiliado a ninguna empresa registrada. Verificá el código con tu asociación o escribe NO si no pertenecés.');
      }
      state.empresaCode = empresa.abreviatura || code;
      state.empresaNombre = empresa.nombre || '';
      state.modo = 'CREAR_DIRECCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Código verificado: *${empresa.nombre}*.\nAhora indica tu *dirección de entrega* (calle, número, ciudad).`, { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({
        nombre: state.nombre,
        correo: state.correo,
        contacto: state.telefono,
        direccion: state.direccion,
        empresaCode: state.empresaCode || ''
      });
      if (ADMIN_TELEGRAM_ID) await bot.sendMessage(ADMIN_TELEGRAM_ID, `✅ Nuevo registro: ${state.nombre} - ${state.telefono} - ${state.correo} - Empresa: ${state.empresaCode || '-'}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      return replyBackToMenu(chatId);
    }

    // Mi casillero flow
    if (state.modo === 'MI_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      savePhone(chatId, phone);
      const client = await findClientByPhone(phone);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      state.client = client;
      setUserState(chatId, state);
      const dire = await getCachedDirecciones(client.nombre);
      return bot.sendMessage(chatId, 'Hola. Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
    }

    // Colombia casillero description
    if (state.modo === 'COL_DESCRIPCION') {
      const desc = text;
      const nombreRegistro = (state.client && state.client.nombre) || 'Cliente';
      const dire = await getCachedDirecciones(nombreRegistro);
      const categoriaDetect = detectCategoryFromDescription(desc);
      const tipo = categoryToTariffClass(categoriaDetect || '', 'colombia') === 'Especial' ? 'Especial' : 'General';
      const direccion = tipo === 'Especial' ? dire.colombiaCon : dire.colombiaSin;
      clearUserState(chatId);
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='Especial'?'Especial / Réplica':'Carga General'})*:\n${direccion}`, { parse_mode: 'Markdown' });
    }

    /* ----------------- Cotización flows (fragmento relevante) ----------------- */
    if (state.modo === 'COTIZAR_START') {
      const ident = text.toLowerCase();
      if (ident === 'no') {
        state.client = null;
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* (para registrar la cotización).', { parse_mode: 'Markdown' });
      } else {
        const client = await findClientByPhone(ident);
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

    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const detected = detectCategoryFromDescription(text);
      if (detected) {
        state.categoriaFinal = detected;
      } else if (state.categoriaSeleccionada) {
        state.categoriaFinal = state.categoriaSeleccionada;
      }
      const tipoClas = categoryToTariffClass(state.categoriaFinal || detected || '', state.origen || '');
      state.tipoMercancia = (tipoClas === 'Especial') ? 'Especial' : 'General';
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
          const tarifas = await getCachedTarifas();
          const discountLegend = buildDiscountLegend(res.pesoFacturable, tarifas.discounts || [], state.origen);
          const nota = "\n\n📝 Nota: Los montos aquí mostrados son aproximados y pueden variar según el tipo de cambio al momento del cobro, el peso final del paquete y la clasificación real de la mercancía.";
          const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nCategoría: ${res.categoriaFinal || state.categoriaSeleccionada || '-'}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})${nota}\n\n${discountLegend}`;
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

    // PREALERT flows (resumidos: se usan similares validaciones)
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
          const phone = normalizePhone(ident);
          savePhone(chatId, phone);
          client = await findClientByPhone(ident);
        }
      }
      if (!client && ident !== 'no') {
        state.modo = 'PREALERT_UNREG_PROMPT';
        state.unregCandidatePhone = normalizePhone(ident);
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Número/correo no registrado. ¿Deseas registrarte? Responde SI o NO.');
      }
      state.client = client || null;
      state.modo = 'PREALERT_ORIG';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete:', { reply_markup: { keyboard: [['Estados Unidos','Colombia','España'],['China','Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
    }

  } catch (err) {
    console.error('Error en message handler:', err);
    bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente o usa /menu.');
  }
});

/* ----------------- Track list helper ----------------- */
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

/* ----------------- Webhook / Server ----------------- */
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
