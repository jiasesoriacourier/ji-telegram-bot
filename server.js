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
function setUserState(chatId, state) {
  userStates.set(String(chatId), { ...state, updatedAt: Date.now() });
}
function getUserState(chatId) {
  const state = userStates.get(String(chatId));
  if (state && Date.now() - state.updatedAt > 24 * 60 * 60 * 1000) {
    userStates.delete(String(chatId));
    return null;
  }
  return state || null;
}
function clearUserState(chatId) {
  userStates.delete(String(chatId));
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

/////////////////////// CACHÉ ///////////////////////
let cache = {
  tarifas: {  null, ts: 0 },
  direcciones: {  null, ts: 0 }
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

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

/////////////////////// CACHÉ HELPER ///////////////////////
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
      ['/crear_casillero_empresarial'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo', '/prealertar'],
      ['/soporte']
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
function tipoEmpresaKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Ferretería', callback_data: 'TIPO_EMP|Ferretería' }, { text: 'Farmacia', callback_data: 'TIPO_EMP|Farmacia' }],
      [{ text: 'Supermercado', callback_data: 'TIPO_EMP|Supermercado' }, { text: 'Pulpería', callback_data: 'TIPO_EMP|Pulpería' }],
      [{ text: 'Asociación Solidarista', callback_data: 'TIPO_EMP|Asociación Solidarista' }, { text: 'Constructora', callback_data: 'TIPO_EMP|Constructora' }],
      [{ text: 'Otro', callback_data: 'TIPO_EMP|Otro' }]
    ]
  };
}
function siNoReutilizarPhoneKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ Sí, usar el mismo', callback_data: 'REUSE_PHONE|si' }, { text: '✏️ Cambiar número', callback_data: 'REUSE_PHONE|no' }]
    ]
  };
}
function siNoInlineKeyboard() {
  return { inline_keyboard: [[{ text: 'SI', callback_data: 'GAM|si' }, { text: 'NO', callback_data: 'GAM|no' }]] };
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

/////////////////////// CLIENTES Y EMPRESAS ///////////////////////
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
        saldo: parseFloat(row[7]) || 0,
        empresaId: row[6] || ''
      };
    }
  }
  return null;
}
async function findEmpresaByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Empresas!A:F' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contact = normalizePhone(row[3] || '');
    if (contact && (contact === normalized || contact.endsWith(normalized) || normalized.endsWith(contact))) {
      return {
        rowIndex: i + 1,
        nombre: row[0] || '',
        tipo: row[1] || '',
        correo: row[2] || '',
        telefono: row[3] || '',
        contacto: row[4] || '',
        abrev: (row[5] || '').trim() || row[0].replace(/[^a-zA-Z0-9]/g, '').substring(0,4).toUpperCase() || 'EMP'
      };
    }
  }
  return null;
}
async function addClientToSheet({ nombre, correo, contacto, direccion, empresaId = '' }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', correo || '', '', contacto || '', '', direccion || '', empresaId, 0 ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:I',
    valueInputOption: 'RAW',
    resource: { values }
  });
}
async function addEmpresaToSheet({ nombre, tipo, correo, telefono, contacto, abrev }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', tipo || '', correo || '', telefono || '', contacto || '', abrev || '' ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Empresas!A:F',
    valueInputOption: 'RAW',
    resource: { values }
  });
}
async function getEmpresaById(id) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Empresas!A:F' });
  const rows = res.data.values || [];
  const idx = parseInt(id, 10) - 1;
  if (idx >= 0 && idx < rows.length) {
    const row = rows[idx];
    return {
      nombre: row[0] || '',
      tipo: row[1] || '',
      correo: row[2] || '',
      telefono: row[3] || '',
      contacto: row[4] || '',
      abrev: (row[5] || '').trim() || row[0].replace(/[^a-zA-Z0-9]/g, '').substring(0,4).toUpperCase() || 'EMP'
    };
  }
  return null;
}

/////////////////////// NOMBRE PARA DIRECCIÓN ///////////////////////
async function getNombreParaDireccion(cliente) {
  if (!cliente.empresaId) {
    return cliente.nombre;
  }
  const empresa = await getEmpresaById(cliente.empresaId);
  const abrev = empresa?.abrev || 'EMP';
  return `JICO-${abrev}-${cliente.nombre}`;
}

/////////////////////// FUNCIONES EXISTENTES (igual que en tu archivo) ///////////////////////
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
  await bot.sendMessage(ADMIN_TELEGRAM_ID, `📣 Nueva prealerta\nTracking: ${tracking}\nCliente: ${cliente}\nOrigen: ${origen}\nObservaciones: ${observaciones}`);
}
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
  return {
    miami: { sinPermiso: getVal(0), conPermiso: getVal(1) },
    colombia: { sinPermiso: getVal(2), conPermiso: getVal(3) },
    espana: { sinPermiso: getVal(4), conPermiso: getVal(5) },
    china: { tarifa: getVal(6) },
    mexico: { tarifa: getVal(7) },
    discounts: (valueRanges[8]?.values?.map(v => (parseFloat(String(v[0]||'0').replace(',','.'))||0)/100) || []).concat(Array(6).fill(0)).slice(0,6),
    j: {
      deliveryCRC: (valueRanges[9]?.values?.[0]?.[0] ? parseFloat(String(valueRanges[9].values[0][0]).replace(',','.')) : 0) || 0,
      exchangeRate: (valueRanges[9]?.values?.[2]?.[0] ? parseFloat(String(valueRanges[9].values[2][0]).replace(',','.')) : 1) || 1
    }
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
async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const values = [[
    data.id, new Date().toISOString(), data.chatId, 'Cliente', data.email || '', data.origen || '', 'Costa Rica',
    data.tipoMercancia || '', data.peso || '', data.unidad || '', data.pesoFacturable || '', data.tarifa || '',
    data.subtotal || 0, data.discountAmount || 0, data.total || 0, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}
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
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});
bot.onText(/\/crear_casillero_empresarial/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'EMP_TIPO' });
  bot.sendMessage(chatId, 'Vamos a registrar tu empresa. Selecciona el *tipo de empresa*:', {
    parse_mode: 'Markdown', reply_markup: tipoEmpresaKeyboard()
  });
});
bot.onText(/\/registrar_colaborador/, async (msg) => {
  const chatId = msg.chat.id;
  const st = getUserState(chatId) || {};
  if (st.lastPhone) {
    st.modo = 'COLAB_CONF_PHONE';
    st.lastCommand = '/registrar_colaborador';
    setUserState(chatId, st);
    bot.sendMessage(chatId, `¿Usar el mismo número (**${st.lastPhone}**) de la empresa?`, {
      parse_mode: 'Markdown', reply_markup: siNoReutilizarPhoneKeyboard()
    });
  } else {
    st.modo = 'COLAB_PHONE';
    st.lastCommand = '/registrar_colaborador';
    setUserState(chatId, st);
    bot.sendMessage(chatId, 'Ingresa el *número de teléfono corporativo* de la empresa (ej: 88885555).', { parse_mode: 'Markdown' });
  }
});
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  const st = getUserState(chatId) || {};
  if (st.lastPhone) {
    st.lastCommand = '/mi_casillero';
    setUserState(chatId, st);
    bot.sendMessage(chatId, `¿Usar el mismo número (**${st.lastPhone}**) para esta consulta?`, {
      parse_mode: 'Markdown', reply_markup: siNoReutilizarPhoneKeyboard()
    });
  } else {
    st.modo = 'MI_CASILLERO_PHONE';
    st.lastCommand = '/mi_casillero';
    setUserState(chatId, st);
    bot.sendMessage(chatId, 'Ingresa tu número de teléfono con el que te registraste (ej: 88885555):');
  }
});
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  const st = getUserState(chatId) || {};
  if (st.lastPhone) {
    st.lastCommand = '/cotizar';
    setUserState(chatId, st);
    bot.sendMessage(chatId, `¿Realizar la cotización con el mismo número? *${st.lastPhone}*`, {
      parse_mode: 'Markdown', reply_markup: siNoReutilizarPhoneKeyboard()
    });
  } else {
    st.modo = 'COTIZAR_START';
    st.lastCommand = '/cotizar';
    setUserState(chatId, st);
    bot.sendMessage(chatId, 'Ingresa tu número de teléfono (ej: 88885555) o escribe "NO" si no estás registrado.');
  }
});
bot.onText(/\/soporte/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Por favor, escribe tu mensaje de soporte (máximo 280 caracteres):');
  setUserState(chatId, { modo: 'SOPORTE_MSG' });
});
bot.onText(/^\/responder_duda (\d+) (.+)$/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_TELEGRAM_ID)) return;
  const targetChatId = match[1];
  const replyText = match[2];
  try {
    await bot.sendMessage(targetChatId, `📩 *Respuesta del equipo:*\n${replyText}`, { parse_mode: 'Markdown' });
    await bot.sendMessage(msg.chat.id, '✅ Respuesta enviada al cliente.');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '❌ Error al enviar mensaje al cliente.');
  }
});
bot.onText(/\/saldo/, (msg) => {
  const chatId = msg.chat.id;
  const st = getUserState(chatId) || {};
  if (st.lastPhone) {
    st.lastCommand = '/saldo';
    setUserState(chatId, st);
    bot.sendMessage(chatId, `¿Usar el mismo número (**${st.lastPhone}**) para verificar saldo?`, {
      parse_mode: 'Markdown', reply_markup: siNoReutilizarPhoneKeyboard()
    });
  } else {
    st.modo = 'CHECK_SALDO_PHONE';
    st.lastCommand = '/saldo';
    setUserState(chatId, st);
    bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste (ej: 88885555).');
  }
});
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  const st = getUserState(chatId) || {};
  if (st.lastPhone) {
    st.lastCommand = '/consultar_tracking';
    setUserState(chatId, st);
    bot.sendMessage(chatId, `¿Usar el mismo número (**${st.lastPhone}**) para consultar tracking?`, {
      parse_mode: 'Markdown', reply_markup: siNoReutilizarPhoneKeyboard()
    });
  } else {
    st.modo = 'CHECK_CASILLERO_PHONE';
    st.lastCommand = '/consultar_tracking';
    setUserState(chatId, st);
    bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste (ej: 88885555).');
  }
});
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_NUM' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Escribe el NÚMERO DE TRACKING:');
});

/////////////////////// CALLBACKS ///////////////////////
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(() => {});
  try {
    if (data.startsWith('REUSE_PHONE|')) {
      const val = data.split('|')[1];
      const st = getUserState(chatId) || {};
      const lastPhone = st.lastPhone;
      if (val === 'si') {
        if (st.lastCommand === '/mi_casillero') handlePhoneForCasillero(chatId, lastPhone);
        else if (st.lastCommand === '/cotizar') handlePhoneForCotizar(chatId, lastPhone);
        else if (st.lastCommand === '/saldo') handlePhoneForSaldo(chatId, lastPhone);
        else if (st.lastCommand === '/consultar_tracking') handlePhoneForTracking(chatId, lastPhone);
        else if (st.lastCommand === '/registrar_colaborador') handlePhoneForColaborador(chatId, lastPhone);
      } else {
        if (st.lastCommand === '/registrar_colaborador') {
          st.modo = 'COLAB_PHONE';
          setUserState(chatId, st);
          bot.sendMessage(chatId, 'Ingresa el nuevo número de teléfono corporativo (ej: 88885555):');
        } else {
          if (st.lastCommand === '/mi_casillero') st.modo = 'MI_CASILLERO_PHONE';
          else if (st.lastCommand === '/cotizar') st.modo = 'COTIZAR_START';
          else if (st.lastCommand === '/saldo') st.modo = 'CHECK_SALDO_PHONE';
          else if (st.lastCommand === '/consultar_tracking') st.modo = 'CHECK_CASILLERO_PHONE';
          setUserState(chatId, st);
          bot.sendMessage(chatId, 'Ingresa tu nuevo número de teléfono (ej: 88885555):');
        }
      }
      return;
    }
    if (data.startsWith('TIPO_EMP|')) {
      const tipo = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.tipoEmpresa = tipo;
      st.modo = 'EMP_NOMBRE';
      setUserState(chatId, st);
      bot.sendMessage(chatId, 'Ahora ingresa el *nombre de la empresa*:', { parse_mode: 'Markdown' });
      return;
    }
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, state);
      bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (obligatorio).`, { parse_mode: 'Markdown' });
      return;
    }
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      if (pais === 'colombia') {
        const state = getUserState(chatId) || {};
        state.modo = 'COL_DESCRIPCION';
        setUserState(chatId, state);
        bot.sendMessage(chatId, 'Describe brevemente la mercancía que recibirás en Colombia (ej: "camisetas", "perfume Chanel", "zapatos Nike réplica"):');
        return;
      } else {
        const state = getUserState(chatId) || {};
        const nombreRegistro = (state.client && state.client.nombre) || 'Cliente';
        const dire = await getCachedDirecciones(nombreRegistro);
        let direccion = 'No disponible';
        const nombres = { miami: 'Miami', madrid: 'Madrid', mexico: 'Ciudad de México', china: 'China' };
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid') direccion = dire.espana;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n${direccion}`, { parse_mode: 'Markdown' });
        return;
      }
    }
    if (data.startsWith('GAM|')) {
      const val = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.entregaGAM = (val === 'si');
      st.modo = 'COTIZAR_FINAL_CONFIRM';
      setUserState(chatId, st);
      if (!st.entregaGAM) {
        bot.sendMessage(chatId, '¿El envío se realizará por "Encomienda" o "Correos de C.R"?', {
          reply_markup: { keyboard: [['Encomienda', 'Correos de C.R'], ['Cancelar']], resize_keyboard: true, one_time_keyboard: true }
        });
      } else {
        if (st.client) {
          bot.sendMessage(chatId, 'Procesando cotización...');
          try {
            const res = await calcularYRegistrarCotizacionRespaldo(chatId, st);
            clearUserState(chatId);
            const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
            const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${st.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent * 100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})`;
            bot.sendMessage(chatId, msg);
            replyBackToMenu(chatId);
          } catch (e) {
            clearUserState(chatId);
            bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización.');
          }
        } else {
          bot.sendMessage(chatId, 'Por favor ingresa tu número de teléfono con el que te registraste (ej: 88885555) o escribe "NO" para cotizar sin registro.');
        }
      }
      return;
    }
    if (data.startsWith('PRE_ORIG|')) {
      const orig = data.split('|')[1];
      const st = getUserState(chatId) || {};
      st.prealertOrigen = orig;
      st.modo = 'PREALERT_OBS';
      setUserState(chatId, st);
      bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
      return;
    }
    if (data.startsWith('TRACK_PAGE|')) {
      const page = parseInt(data.split('|')[1] || '1', 10);
      const st = getUserState(chatId) || {};
      sendTrackingList(chatId, st.itemsCache || [], page);
      return;
    }
    if (data.startsWith('TRACK_DETAIL|')) {
      const idx = parseInt(data.split('|')[1] || '0', 10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      const item = items[idx];
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado.');
      const text = `📦 *Tracking:* ${item.tracking}\n*Origen:* ${item.origen}\n*Estado:* ${item.estado}\n*Peso:* ${item.peso}\n*Comentarios:* ${item.comentarios || '-'}`;
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      return;
    }
    if (data.startsWith('TRACK_EXPORT|')) {
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      if (!items.length) return bot.sendMessage(chatId, 'No hay paquetes para exportar.');
      let txt = `Respaldo de trackings (${items.length}):\n`;
      items.forEach((it, i) => { txt += `\n${i + 1}. ${it.tracking} — ${it.origen} — ${it.estado} — ${it.peso}\nComentarios: ${it.comentarios || '-'}\n`; });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, txt);
      bot.sendMessage(chatId, 'Listado enviado como respaldo al administrador.');
      return;
    }
  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.');
  }
});

/////////////////////// MANEJADORES REUTILIZABLES ///////////////////////
async function handlePhoneForCasillero(chatId, phone) {
  const client = await findClientByPhone(phone);
  if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
  const st = getUserState(chatId) || {};
  st.client = client;
  st.lastPhone = phone;
  setUserState(chatId, st);
  bot.sendMessage(chatId, 'Hola. Selecciona el país de tu casillero:', { reply_markup: casilleroPaisesKeyboard() });
}
async function handlePhoneForCotizar(chatId, phone) {
  const st = { lastPhone: phone, lastCommand: '/cotizar' };
  if (phone.toLowerCase() === 'no') {
    st.client = null;
    st.modo = 'COTIZAR_UNREG_NOMBRE';
  } else {
    const client = await findClientByPhone(phone);
    if (client) {
      st.client = client;
      st.modo = 'COTIZAR_ORIGEN';
    } else {
      st.modo = 'COTIZAR_UNREG_PROMPT';
      st.unregCandidatePhone = normalizePhone(phone);
    }
  }
  setUserState(chatId, st);
  if (st.modo === 'COTIZAR_UNREG_NOMBRE') {
    bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* (para registrar la cotización).', { parse_mode: 'Markdown' });
  } else if (st.modo === 'COTIZAR_ORIGEN') {
    bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN?', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
  } else if (st.modo === 'COTIZAR_UNREG_PROMPT') {
    bot.sendMessage(chatId, 'No encontrado. ¿Deseas registrarte? Responde SI o NO.');
  }
}
async function handlePhoneForSaldo(chatId, phone) {
  const client = await findClientByPhone(phone);
  clearUserState(chatId);
  if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
  bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`);
}
async function handlePhoneForTracking(chatId, phone) {
  const client = await findClientByPhone(phone);
  clearUserState(chatId);
  if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
  const items = await getTrackingsByName(client.nombre);
  if (!items?.length) return bot.sendMessage(chatId, 'No hay paquetes asociados.');
  sendTrackingList(chatId, items, 1);
}
async function handlePhoneForColaborador(chatId, phone) {
  const empresa = await findEmpresaByPhone(phone);
  if (!empresa) return bot.sendMessage(chatId, 'No encontramos una empresa registrada con ese número.');
  const st = getUserState(chatId) || {};
  st.empresa = empresa;
  st.modo = 'COLAB_NOMBRE';
  setUserState(chatId, st);
  bot.sendMessage(chatId, 'Ingresa el *nombre completo del colaborador*:', { parse_mode: 'Markdown' });
}

/////////////////////// MENSAJES LIBRES ///////////////////////
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    if (state.modo === 'SOPORTE_MSG') {
      if (text.length > 280) return bot.sendMessage(chatId, 'Máximo 280 caracteres.');
      const user = msg.from;
      const name = user.first_name || 'cliente';
      const username = user.username ? `@${user.username}` : '';
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆘 Soporte nuevo\nID: ${chatId}\nNombre: ${name} ${username}\nMensaje: ${text}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, '✅ Tu mensaje fue enviado. Un asesor te contactará pronto.');
      return;
    }

    // EMPRESARIAL
    if (state.modo === 'EMP_NOMBRE') {
      state.nombreEmpresa = text;
      state.modo = 'EMP_CORREO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el *correo corporativo*:', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'EMP_CORREO') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correoEmpresa = text;
      state.modo = 'EMP_TELEFONO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el *número de contacto corporativo* (ej: 88885555):', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'EMP_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos.');
      state.telefonoEmpresa = phone;
      state.modo = 'EMP_CONTACTO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el *nombre del contacto principal*:', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'EMP_CONTACTO') {
      state.contactoPrincipal = text;
      const abrev = state.nombreEmpresa.replace(/[^a-zA-Z0-9]/g, '').substring(0,4).toUpperCase() || 'EMP';
      await addEmpresaToSheet({
        nombre: state.nombreEmpresa,
        tipo: state.tipoEmpresa,
        correo: state.correoEmpresa,
        telefono: state.telefonoEmpresa,
        contacto: state.contactoPrincipal,
        abrev
      });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `🏢 Nueva empresa registrada:\n${state.nombreEmpresa}\nTipo: ${state.tipoEmpresa}\nContacto: ${state.contactoPrincipal}\nTel: ${state.telefonoEmpresa}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Empresa registrada exitosamente.\nAhora puedes registrar colaboradores con /registrar_colaborador.`);
      replyBackToMenu(chatId);
      return;
    }

    if (state.modo === 'COLAB_PHONE') {
      const phone = normalizePhone(text);
      const empresa = await findEmpresaByPhone(phone);
      if (!empresa) return bot.sendMessage(chatId, 'No encontramos una empresa registrada con ese número.');
      state.empresa = empresa;
      state.modo = 'COLAB_NOMBRE';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el *nombre completo del colaborador*:', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'COLAB_NOMBRE') {
      state.colabNombre = text;
      state.modo = 'COLAB_EMAIL';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el *correo del colaborador* (opcional):');
      return;
    }
    if (state.modo === 'COLAB_EMAIL') {
      const correo = text.includes('@') ? text : '';
      await addClientToSheet({
        nombre: state.colabNombre,
        correo,
        contacto: '',
        direccion: '',
        empresaId: state.empresa.rowIndex
      });
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Colaborador *${state.colabNombre}* registrado bajo la empresa *${state.empresa.nombre}*.`);
      replyBackToMenu(chatId);
      return;
    }

    // FLUJOS EXISTENTES
    if (state.modo === 'CREAR_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) return bot.sendMessage(chatId, 'Por favor ingresa *Nombre completo* con al menos 1 nombre y 2 apellidos.', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_EMAIL';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ahora ingresa tu *correo electrónico* para contacto.', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'CREAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa ahora tu *número de contacto* (ej: 88885555).', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'CREAR_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos.');
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
      bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
      return;
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, `✅ Nuevo registro: ${state.nombre} - ${state.telefono} - ${state.correo}`);
      clearUserState(chatId);
      bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
      replyBackToMenu(chatId);
      return;
    }

    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      const items = await getTrackingsByName(client.nombre);
      if (!items?.length) return bot.sendMessage(chatId, 'No hay paquetes asociados.');
      sendTrackingList(chatId, items, 1);
      return;
    }

    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontrado. Usa /crear_casillero.');
      bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`);
      return;
    }

    if (state.modo === 'PREALERT_NUM') {
      state.prealertTracking = text;
      state.modo = 'PREALERT_IDENT';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa el número de teléfono o correo con el que deseas registrar este tracking (ej: 88885555) o responde "NO" si no estás registrado.');
      return;
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
          client = await findClientByPhone(ident);
        }
      }
      state.client = client || null;
      state.modo = 'PREALERT_ORIG';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete:', { reply_markup: origenKeyboardForPrealert() });
      return;
    }
    if (state.modo === 'PREALERT_ORIG') {
      const chosen = text.toLowerCase();
      const mapping = { 'estados unidos': 'Estados Unidos', 'miami': 'Estados Unidos', 'colombia': 'Colombia', 'españa': 'España', 'espana': 'España', 'china': 'China', 'mexico': 'Mexico' };
      const orig = mapping[chosen] || text;
      state.prealertOrigen = orig;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Describe el tipo de mercancía y observaciones (obligatorio).');
      return;
    }
    if (state.modo === 'PREALERT_OBS') {
      const obs = text;
      const classification = classifyProduct({ descripcion: obs, origen: state.prealertOrigen || '' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptar esta prealerta.');
        return;
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

    if (state.modo === 'COTIZAR_START') {
      const ident = text.toLowerCase();
      if (ident === 'no') {
        state.client = null;
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* para continuar con la cotización.', { parse_mode: 'Markdown' });
        return;
      } else {
        const client = await findClientByPhone(ident);
        if (!client) {
          state.modo = 'COTIZAR_UNREG_PROMPT';
          state.unregCandidatePhone = normalizePhone(ident);
          setUserState(chatId, state);
          bot.sendMessage(chatId, 'No encontrado. ¿Deseas registrarte? Responde SI o NO.');
          return;
        } else {
          state.client = client;
          state.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, state);
          bot.sendMessage(chatId, 'Perfecto. ¿Cuál es el ORIGEN?', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
          return;
        }
      }
    }
    if (state.modo === 'COTIZAR_UNREG_PROMPT') {
      const ans = text.toLowerCase();
      if (ans === 'si' || ans === 's') {
        state.modo = 'CREAR_NOMBRE';
        setUserState(chatId, state);
        bot.sendMessage(chatId, 'Vamos a crear tu casillero. Escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
        return;
      } else if (ans === 'no' || ans === 'n') {
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* para continuar con la cotización.', { parse_mode: 'Markdown' });
        return;
      } else {
        bot.sendMessage(chatId, 'Responde SI o NO por favor.');
        return;
      }
    }
    if (state.modo === 'COTIZAR_UNREG_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu nombre completo (mínimo nombre y apellido).');
      state.nombre = text;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa tu correo electrónico (obligatorio).');
      return;
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.correo = text;
      state.modo = 'COTIZAR_UNREG_TELEFONO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Ingresa tu número de teléfono de contacto (ej: 88885555).');
      return;
    }
    if (state.modo === 'COTIZAR_UNREG_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos.');
      state.telefono = phone;
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Selecciona el ORIGEN:', { reply_markup: { keyboard: [['miami','madrid'],['colombia','mexico'],['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true } });
      return;
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
      bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
      return;
    }
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.');
        return;
      }
      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb).');
      return;
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
      bot.sendMessage(chatId, '¿La entrega es dentro del GAM?', { reply_markup: siNoInlineKeyboard() });
      return;
    }
    if (state.modo === 'COTIZAR_FINAL_CONFIRM') {
      if (!state.entregaGAM && (text === 'Encomienda' || text === 'Correos de C.R')) {
        state.deliveryMethod = text;
        await bot.sendMessage(chatId, 'Procesando cotización...');
        try {
          const res = await calcularYRegistrarCotizacionRespaldo(chatId, state);
          clearUserState(chatId);
          const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
          const msg = `✅ Cotización generada\nID: ${res.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${res.pesoFacturable} ${res.unidadFacturable}\nSubtotal: ¢${res.subtotalCRC.toFixed(0)}\nDescuento: ¢${res.discountAmountCRC.toFixed(0)} (${(res.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${res.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${res.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${res.exchangeRate})`;
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

    // COLOMBIA AUTOMÁTICO
    if (state.modo === 'COL_DESCRIPCION') {
      const desc = text;
      const classification = classifyProduct({ descripcion: desc, origen: 'colombia' });
      if (classification.tipo === 'Prohibida') {
        clearUserState(chatId);
        bot.sendMessage(chatId, '⚠️ Mercancía prohibida para casillero en Colombia.');
        return;
      }
      const nombreRegistro = (state.client && state.client.nombre) || 'Cliente';
      const nombreParaDir = await getNombreParaDireccion({ nombre: nombreRegistro, empresaId: (state.client?.empresaId || '') });
      const dire = await getCachedDirecciones(nombreParaDir);
      const direccion = classification.tipo === 'Especial' ? dire.colombiaCon : dire.colombiaSin;
      const tipoStr = classification.tipo === 'Especial' ? 'Especial / Réplica' : 'Carga General';
      clearUserState(chatId);
      bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipoStr})*:\n${direccion}`, { parse_mode: 'Markdown' });
      return;
    }

  } catch (err) {
    console.error('Error en message handler:', err);
    bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente o usa /menu.');
  }
});

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
