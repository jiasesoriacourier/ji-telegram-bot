// server.js - J.I Asesoría & Courier
// Versión reorganizada (un solo archivo), menú 100% INLINE, flujos corregidos (tracking / casillero / prealerta / cotización)
// Requisitos clave: búsqueda de clientes por Teléfono (Clientes!D), Nombre (A), Correo (B), Código empresa (I).

'use strict';

/* =========================================================
 * 1) Configuración y variables de entorno
 * ======================================================= */
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const PORT = process.env.PORT || 3000;
const URL_BASE = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID en variables de entorno');

/* =========================================================
 * 2) Inicialización del bot + servidor
 * ======================================================= */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

/* =========================================================
 * 3) Utilidades generales
 * ======================================================= */
const TZ_CR = 'America/Costa_Rica';
const ONE_HOUR_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

function nowCR() {
  return new Date().toLocaleString('es-CR', { timeZone: TZ_CR });
}

function normalizeText(s) {
  return (s ?? '').toString().trim();
}

function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, '');
  if (s.startsWith('506')) s = s.slice(3);
  return s;
}

function maskPhone(p) {
  const s = normalizePhone(p);
  if (s.length <= 4) return s;
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

function safeParseNumber(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

async function safeAnswerCallback(query) {
  try { await bot.answerCallbackQuery(query.id); } catch (_) {}
}

/* =========================================================
 * 4) Google Sheets client
 * ======================================================= */
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS || '';
  if (!credsRaw) throw new Error('Falta GOOGLE_CREDENTIALS en env');

  // Soporta JSON directo o base64
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
}

/* =========================================================
 * 5) Manejo de estado del usuario + caches
 * ======================================================= */
const userStates = new Map(); // chatId -> state
function getState(chatId) { return userStates.get(String(chatId)) || null; }
function setState(chatId, state) { userStates.set(String(chatId), state); }
function clearState(chatId) { userStates.delete(String(chatId)); }

// Cache temporal de teléfono por 1 hora (por chat)
const phoneCache = {}; // chatId -> { phone, ts }
function savePhoneToCache(chatId, phone) {
  const p = normalizePhone(phone);
  if (!p) return;
  phoneCache[String(chatId)] = { phone: p, ts: Date.now() };
}
function getCachedPhone(chatId) {
  const e = phoneCache[String(chatId)];
  if (!e) return null;
  if ((Date.now() - e.ts) > ONE_HOUR_MS) {
    delete phoneCache[String(chatId)];
    return null;
  }
  return e.phone;
}

// Cache de lecturas frecuentes
const cache = {
  tarifas: { data: null, ts: 0 },
  direcciones: { data: null, ts: 0 },
  empresas: { data: null, ts: 0 }
};

/* =========================================================
 * 6) Menú principal INLINE (profesional, sin ensuciar chat)
 * ======================================================= */
function mainMenuInline() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Consulta de Tracking', callback_data: 'MENU|TRACKING' },
        { text: '💰 Cotizar Envío', callback_data: 'MENU|COTIZAR' }
      ],
      [
        { text: '📝 Prealertar Paquete', callback_data: 'MENU|PREALERTA' },
        { text: '🏷️ Mi Casillero', callback_data: 'MENU|CASILLERO' }
      ],
      [
        { text: '💳 Saldo Pendiente', callback_data: 'MENU|SALDO' },
        { text: '❓ Ayuda', callback_data: 'MENU|AYUDA' }
      ]
    ]
  };
}

async function upsertMenu(chatId, opts = {}) {
  const title = opts.title || '📍 *Menú principal*\nSeleccioná una opción para continuar:';
  const state = getState(chatId) || {};
  const menuMsgId = state.menuMessageId;

  // Intento 1: editar el menú existente
  if (menuMsgId && opts.edit !== false) {
    try {
      await bot.editMessageText(title, {
        chat_id: chatId,
        message_id: menuMsgId,
        parse_mode: 'Markdown',
        reply_markup: mainMenuInline()
      });
      // Limpieza de estado de flujos, pero conservamos menuMessageId
      setState(chatId, { menuMessageId: menuMsgId });
      return;
    } catch (_) {
      // Si falla (message not found / too old), caemos a enviar uno nuevo
    }
  }

  // Intento 2: enviar nuevo menú y guardar message_id para ediciones futuras
  const sent = await bot.sendMessage(chatId, title, {
    parse_mode: 'Markdown',
    reply_markup: mainMenuInline()
  });
  setState(chatId, { menuMessageId: sent.message_id });
}

/* =========================================================
 * 7) Keyboards INLINE reutilizables
 * ======================================================= */
function yesNoInline(prefix) {
  return {
    inline_keyboard: [[
      { text: 'Sí', callback_data: `${prefix}|SI` },
      { text: 'No', callback_data: `${prefix}|NO` }
    ]]
  };
}

function backToMenuInline() {
  return { inline_keyboard: [[{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]] };
}

function originsInline(prefix) {
  return {
    inline_keyboard: [
      [
        { text: '🇺🇸 Estados Unidos', callback_data: `${prefix}|Estados Unidos` },
        { text: '🇪🇸 España', callback_data: `${prefix}|España` }
      ],
      [
        { text: '🇨🇴 Colombia', callback_data: `${prefix}|Colombia` },
        { text: '🇲🇽 México', callback_data: `${prefix}|México` }
      ],
      [{ text: '🇨🇳 China', callback_data: `${prefix}|China` }],
      [{ text: '❌ Cancelar', callback_data: 'NAV|MENU' }]
    ]
  };
}

function weightUnitInline(prefix) {
  return {
    inline_keyboard: [[
      { text: 'Libras (lb)', callback_data: `${prefix}|lb` },
      { text: 'Kilos (kg)', callback_data: `${prefix}|kg` }
    ]]
  };
}

function casilleroPaisesInline() {
  return {
    inline_keyboard: [
      [{ text: '🇺🇸 Estados Unidos (Miami)', callback_data: 'CASILLERO|miami' }],
      [{ text: '🇪🇸 España (Madrid)', callback_data: 'CASILLERO|madrid' }],
      [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }],
      [{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]
    ]
  };
}

function categoriaInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Electrónicos', callback_data: 'COT|CAT|Electrónicos' },
        { text: 'Ropa / Calzado', callback_data: 'COT|CAT|Ropa / Calzado' }
      ],
      [
        { text: 'Colonias / Perfumes', callback_data: 'COT|CAT|Colonias / Perfumes' },
        { text: 'Medicamentos', callback_data: 'COT|CAT|Medicamentos' }
      ],
      [
        { text: 'Alimentos / Procesados', callback_data: 'COT|CAT|Alimentos / Procesados' },
        { text: 'Cremas / Cosméticos', callback_data: 'COT|CAT|Cremas / Cosméticos' }
      ],
      [
        { text: 'Réplicas / Imitaciones', callback_data: 'COT|CAT|Réplicas / Imitaciones' },
        { text: 'Piezas automotrices', callback_data: 'COT|CAT|Piezas automotrices' }
      ],
      [
        { text: 'Documentos', callback_data: 'COT|CAT|Documentos' },
        { text: 'Otro', callback_data: 'COT|CAT|Otro' }
      ],
      [{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]
    ]
  };
}

function deliveryMethodInline() {
  return {
    inline_keyboard: [
      [{ text: '🚚 Encomienda', callback_data: 'COT|DELIV_METHOD|Encomienda' }],
      [{ text: '📮 Correos de C.R', callback_data: 'COT|DELIV_METHOD|Correos de C.R' }],
      [{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]
    ]
  };
}

/* =========================================================
 * 8) Lógica de negocio: Clientes, Direcciones, Empresas
 * ======================================================= */

// Clientes: buscar SIEMPRE por Columna D (Teléfono). Obtener Nombre A, Correo B, Código empresa I.
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:I'
  });

  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowPhone = normalizePhone(row[3] || ''); // D
    if (!rowPhone) continue;

    // match flexible: exact, endsWith, etc.
    if (rowPhone === normalized || rowPhone.endsWith(normalized) || normalized.endsWith(rowPhone)) {
      return {
        rowIndex: i + 1,
        nombre: row[0] || '', // A
        correo: row[1] || '', // B
        telefono: row[3] || '', // D
        codigoEmpresa: row[8] || '', // I
        // Campos auxiliares si existen (no críticos)
        direccion: row[5] || '', // F
        saldo: safeParseNumber(row[7] || 0) // H
      };
    }
  }
  return null;
}

// Registro: guardar código empresa en Columna I
async function addClientToSheet({ nombre, correo, telefono, direccion, codigoEmpresa }) {
  const sheets = await getGoogleSheetsClient();

  // A..I (9 columnas)
  const row = new Array(9).fill('');
  row[0] = nombre || '';          // A Nombre
  row[1] = correo || '';          // B Correo
  row[2] = '';                    // C (libre)
  row[3] = telefono || '';        // D Teléfono
  row[4] = '';                    // E (libre)
  row[5] = direccion || '';       // F Dirección
  row[6] = '';                    // G (libre)
  row[7] = 0;                     // H Saldo (si aplica)
  row[8] = codigoEmpresa || '';   // I Código empresa afiliada

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
}

// Direcciones: lectura cacheada de hoja Direcciones
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
    if (cells.length) lines.push(cells.join(' '));
  }
  return lines.join('\n');
}

async function getCachedDirecciones(nombreCliente = 'Nombre de cliente') {
  const now = Date.now();
  if (!cache.direcciones.data || (now - cache.direcciones.ts) > CACHE_TTL_MS) {
    const sheets = await getGoogleSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Direcciones!A:Z'
    });
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

// Empresas afiliadas: validar código contra hoja Empresas columna F
async function getCachedEmpresaCodes() {
  const now = Date.now();
  if (!cache.empresas.data || (now - cache.empresas.ts) > CACHE_TTL_MS) {
    const sheets = await getGoogleSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Empresas!F:F'
    });
    const rows = res.data.values || [];
    cache.empresas.data = new Set(rows.map(r => normalizeText(r[0]).toUpperCase()).filter(Boolean));
    cache.empresas.ts = now;
  }
  return cache.empresas.data;
}

/* =========================================================
 * 9) Lógica de negocio: Tarifas, descuentos y categorías
 * ======================================================= */
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const ranges = [
    'Tarifas!B2', // Miami sin permiso
    'Tarifas!B3', // Miami con permiso
    'Tarifas!B6', // Colombia sin permiso
    'Tarifas!B7', // Colombia con permiso
    'Tarifas!B10',// España sin permiso
    'Tarifas!B11',// España con permiso
    'Tarifas!B13',// China tarifa
    'Tarifas!B15',// México tarifa
    'Tarifas!G4:G8', // descuentos
    'Tarifas!J1:J3'  // entrega y tipo de cambio
  ];

  const read = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
  const vr = read.data.valueRanges || [];

  const getVal = (i) => {
    try {
      const raw = vr[i]?.values?.[0]?.[0];
      if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
      return safeParseNumber(raw);
    } catch (_) { return 0; }
  };

  const miami_sin = getVal(0);
  const miami_con = getVal(1);
  const col_sin = getVal(2);
  const col_con = getVal(3);
  const esp_sin = getVal(4);
  const esp_con = getVal(5);
  const china = getVal(6);
  const mexico = getVal(7);

  let discounts = [0, 0, 0, 0, 0];
  try {
    const gVals = vr[8]?.values || [];
    discounts = gVals.map(r => safeParseNumber(r[0] || 0));
    while (discounts.length < 5) discounts.push(0);
  } catch (_) {}

  let deliveryCRC = 0;
  let exchangeRate = 1;
  try {
    const jVals = vr[9]?.values || [];
    deliveryCRC = safeParseNumber(jVals?.[0]?.[0] || 0);
    exchangeRate = safeParseNumber(jVals?.[2]?.[0] || 0) || 1;
  } catch (_) {}

  return {
    miami: { sinPermiso: miami_sin, conPermiso: miami_con },
    colombia: { sinPermiso: col_sin, conPermiso: col_con },
    espana: { sinPermiso: esp_sin, conPermiso: esp_con },
    china: { tarifa: china },
    mexico: { tarifa: mexico },
    discounts,
    j: { deliveryCRC, exchangeRate }
  };
}

async function getCachedTarifas() {
  const now = Date.now();
  if (!cache.tarifas.data || (now - cache.tarifas.ts) > CACHE_TTL_MS) {
    cache.tarifas.data = await leerTarifas();
    cache.tarifas.ts = now;
  }
  return cache.tarifas.data;
}

function getDiscountPercentByPesoFromArr(pesoFacturable, discountsArr) {
  if (!discountsArr || discountsArr.length < 5) return 0;
  if (pesoFacturable >= 75) return (discountsArr[4] || 0) / 100;
  if (pesoFacturable >= 50) return (discountsArr[3] || 0) / 100;
  if (pesoFacturable >= 35) return (discountsArr[2] || 0) / 100;
  if (pesoFacturable >= 25) return (discountsArr[1] || 0) / 100;
  if (pesoFacturable >= 15) return (discountsArr[0] || 0) / 100;
  return 0;
}

// Leyenda motivacional por descuento (siguiente rango)
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

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (pesoFacturable >= b.min && pesoFacturable <= b.max) {
      if (i === bands.length - 1) {
        return `🎯 ¡Tu envío ya está en el descuento máximo (*${b.disc}%*)!`;
      }
      const next = bands[i + 1];
      const falta = Math.max(0, next.min - pesoFacturable);
      return `🎯 Si agregás *${falta} ${unit}* más, obtenés un *${next.disc}%* de descuento en el transporte.`;
    }
  }

  if (pesoFacturable < 15) {
    const falta = 15 - pesoFacturable;
    return `🎯 Si agregás *${falta} ${unit}* más, obtenés un *${bands[0].disc}%* de descuento en el transporte.`;
  }
  return '';
}

/* -------- Categorías por descripción (prioridad absoluta) -------- */
const categoryKeywords = {
  'Colonias / Perfumes': ['perfume','perfumes','colonia','colonias','fragancia','fragancias','eau de parfum','edp','eau de toilette','edt'],
  'Cremas / Cosméticos': ['maquillaje','makeup','cosméticos','cosmeticos','cremas','crema','crema facial','labial','lipstick','base','bb cream','cc cream','sombra','mascara','serum'],
  'Medicamentos': ['ibuprofeno','paracetamol','acetaminofén','acetaminofen','naproxeno','omeprazol','amoxicilina','loratadina','jarabe','antihistamínico','antihistaminico','antibiotico','antibiótico'],
  'Suplementos / Vitaminas': ['suplementos','vitaminas','proteina','proteína','whey','creatina','bcca','colageno','colágeno','omega'],
  'Alimentos / Procesados': ['comida','snack','snacks','papas','chips','galleta','galletas','chocolate','dulce','caramelo','granola','cereal','café','cafe','te','té','mantequilla de mani','peanut butter','enlatado','atun','atún','sardinas','pastas'],
  'Semillas': ['semilla','semillas','chia','linaza','girasol','maiz','maíz','frijol'],
  'Agroquímicos / Fertilizantes': ['fertilizante','pesticida','pesticidas','herbicida','insecticida','glifosato','abono','npk','urea'],
  'Lentes / Líquidos': ['lentes de contacto','lentes','contact lenses','solución para lentes','solucion para lentes','acuvue','air optix','freshlook'],
  'Químicos de laboratorio': ['alcohol isopropilico','alcohol isopropílico','acetona','reactivo','ácido','acido','pipeta','reactivos'],
  'Productos de limpieza': ['detergente','desinfectante','cloro','lejía','lejia','limpiador','wipes','sanitizante'],
  'Bebidas no alcohólicas': ['refresco','soda','sodas','gaseosa','bebida energética','bebida energetica','red bull','pepsi','coca cola','gatorade'],
  'Réplicas / Imitaciones': ['replica','réplica','copia','imitacion','imitación','1:1','aaa','fake','falso','tenis replica','bolso replica'],
  'Documentos': ['documento','papeles','carta','factura'],
  'Piezas automotrices': ['pieza','piezas','repuesto','motor','freno','frenos'],
  'Electrónicos': ['televisor','tv','celular','telefono','teléfono','smartphone','electronico','electrónico','cámara','camera','tablet','laptop','ordenador','cargador']
};

const specialCategoryNames = new Set([
  'Colonias / Perfumes','Cremas / Cosméticos','Medicamentos','Suplementos / Vitaminas','Semillas',
  'Agroquímicos / Fertilizantes','Lentes / Líquidos','Químicos de laboratorio','Productos de limpieza',
  'Bebidas no alcohólicas','Réplicas / Imitaciones','Alimentos / Procesados'
]);

function detectCategoryFromDescription(desc) {
  const t = (desc || '').toLowerCase();
  if (!t) return null;
  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    for (const kw of keywords) {
      if (kw && t.includes(kw.toLowerCase())) return cat;
    }
  }
  return null;
}

function categoryToTariffClass(categoryName, origen) {
  if (!categoryName) return 'General';
  if (categoryName === 'Réplicas / Imitaciones') {
    // Regla existente: Colombia replica -> Especial, otros -> General
    if ((origen || '').toLowerCase().includes('colombia')) return 'Especial';
    return 'General';
  }
  if (specialCategoryNames.has(categoryName)) return 'Especial';
  return 'General';
}

function usesKgForOrigin(origen) {
  const s = (origen || '').toLowerCase();
  return ['colombia', 'méxico', 'mexico'].some(k => s.includes(k));
}

/* =========================================================
 * 10) Lógica de negocio: Datos (tracking / prealerta)
 * ======================================================= */

// Guardar prealerta en hoja Datos (A:I) según especificación
async function savePrealertToDatos({ tracking, clienteNombre, origen, pesoText, comentariosCliente }) {
  const sheets = await getGoogleSheetsClient();
  const row = new Array(9).fill('');
  row[0] = tracking || '';                 // A Tracking
  row[1] = clienteNombre || '';            // B Cliente (NOMBRE real)
  row[2] = '';                             // C Comentarios internos (vacío)
  row[3] = origen || '';                   // D Origen
  row[4] = 'Prealertado';                  // E Estado
  row[5] = pesoText || '';                 // F Peso (vacío si no aplica)
  row[6] = '';                             // G Monto
  row[7] = nowCR();                        // H Fecha prealerta
  row[8] = comentariosCliente || '';       // I Comentarios cliente

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
}

async function getTrackingsByClientNameExact(nombreCliente) {
  const nameKey = normalizeText(nombreCliente).toLowerCase();
  if (!nameKey) return [];

  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I'
  });

  const rows = res.data.values || [];
  const items = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = normalizeText(r[1]).toLowerCase(); // B Cliente
    if (!name || name !== nameKey) continue;

    items.push({
      rowIndex: i + 1,
      tracking: r[0] || '',
      cliente: r[1] || '',
      comentariosInternos: r[2] || '',
      origen: r[3] || '',
      estado: r[4] || '',
      peso: r[5] || '',
      monto: r[6] || '',
      fecha: r[7] || '',
      comentariosCliente: r[8] || ''
    });
  }
  return items;
}

/* =========================================================
 * 11) Guardado de cotización + notificaciones admin
 * ======================================================= */
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
  row[14] = ''; // libre
  row[15] = payload.id || '';
  row[16] = payload.contacto || '';
  row[17] = payload.email || '';

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cotizaciones!A:R',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });

  if (!ADMIN_TELEGRAM_ID) return;

  const adminMsg = [
    '📣 *Nueva cotización*',
    `🆔 ID: *${payload.id}*`,
    `🗓️ Fecha: ${payload.fechaLocal}`,
    `👤 Cliente: ${payload.cliente}`,
    `📍 Origen: ${payload.origen}`,
    `🏷️ Categoría final: ${payload.categoriaFinal || '-'}`,
    `📝 Descripción: ${payload.mercancia || '-'}`,
    `⚖️ Peso declarado: ${payload.peso} ${payload.unidad}`,
    `⚖️ Peso facturable: ${payload.pesoFacturable} ${payload.unidadFacturable}`,
    `💵 Tarifa aplicada: $${payload.tarifaUSD?.toFixed?.(2) ?? payload.tarifaUSD} / ${payload.unidadFacturable}`,
    `🧾 Subtotal: ¢${Math.round(payload.subtotalCRC)}`,
    `🏷️ Descuento: ¢${Math.round(payload.discountAmountCRC)} (${(payload.discountPercent * 100).toFixed(1)}%)`,
    `🚚 Entrega: ¢${Math.round(payload.deliveryCostCRC)}`,
    `✅ Total: ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `💱 Tipo de cambio: ${payload.exchangeRate}`,
    `📞 Tel: ${payload.contacto || '-'}`,
    `✉️ Email: ${payload.email || '-'}`
  ].join('\n');

  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg, { parse_mode: 'Markdown' }).catch(() => {});
}

async function notifyAdmin(title, lines) {
  if (!ADMIN_TELEGRAM_ID) return;
  const msg = [`📣 *${title}*`, ...lines].join('\n');
  await bot.sendMessage(ADMIN_TELEGRAM_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
}

/* =========================================================
 * 12) Motor de cotización (cálculo + mensaje premium)
 * ======================================================= */
function lbToKg(lb) { return lb / 2.20462; }
function kgToLb(kg) { return kg * 2.20462; }

async function calcularCotizacion(chatId, st) {
  const tarifas = await getCachedTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

  const origenRaw = normalizeText(st.origen);
  const origen = origenRaw.toLowerCase();

  const pesoIngresado = safeParseNumber(st.peso);
  const unidadIngresada = (st.unidad || 'lb').toLowerCase();
  const descripcion = st.descripcion || '';

  // PRIORIDAD: descripción > categoría
  const categoriaDetectada = detectCategoryFromDescription(descripcion);
  let categoriaFinal = categoriaDetectada || st.categoriaSeleccionada || 'Otro';
  categoriaFinal = normalizeText(categoriaFinal);

  const tipoMercancia = categoryToTariffClass(categoriaFinal, origenRaw);

  const pesoEnLb = unidadIngresada === 'kg' ? kgToLb(pesoIngresado) : pesoIngresado;
  const pesoEnKg = unidadIngresada === 'lb' ? lbToKg(pesoIngresado) : pesoIngresado;

  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';

  if (['colombia', 'col'].some(k => origen.includes(k))) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
  } else if (origen.includes('mexico') || origen.includes('méxico')) {
    tarifaUSD = tarifas.mexico.tarifa || 0;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
  } else if (origen.includes('china')) {
    tarifaUSD = tarifas.china.tarifa || 0;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else if (['miami', 'estados unidos', 'usa'].some(k => origen.includes(k))) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else if (origen.includes('madrid') || origen.includes('espana') || origen.includes('españa')) {
    tarifaUSD = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  } else {
    tarifaUSD = tarifas.miami?.sinPermiso || 0;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
  }

  tarifaUSD = Number(tarifaUSD) || 0;
  const subtotalUSD = tarifaUSD * (pesoFacturable || 0);
  const subtotalCRC = subtotalUSD * (exchangeRate || 1);

  const discountPercent = getDiscountPercentByPesoFromArr(pesoFacturable, tarifas.discounts || []);
  const discountAmountCRC = subtotalCRC * discountPercent;

  const totalCRC = subtotalCRC - discountAmountCRC;
  const entregaGAM = !!st.entregaGAM;
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;

  const id = 'COT-' + Math.random().toString(36).slice(2, 11).toUpperCase();
  const fechaLocal = nowCR();

  const clienteName = st.client?.nombre || st.nombre || 'Cliente';
  const contacto = st.client?.telefono || st.telefono || '';
  const email = st.client?.correo || st.correo || '';

  const payload = {
    id, fechaLocal,
    cliente: clienteName,
    origen: origenRaw,
    peso: pesoIngresado,
    unidad: unidadIngresada,
    pesoFacturable,
    unidadFacturable,
    tarifaUSD,
    tipoPermiso: tipoMercancia,
    mercancia: descripcion,
    categoriaFinal,
    subtotalCRC,
    discountPercent,
    discountAmountCRC,
    totalCRC,
    deliveryCostCRC: deliveryCost,
    totalWithDeliveryCRC,
    exchangeRate,
    contacto,
    email
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);

  return payload;
}

function buildCotizacionPremiumMessage(payload, categoriaSeleccionada) {
  const sep = '━━━━━━━━━━━━━━━━━━━━';
  const nota = '📝 *Nota:* Los montos son aproximados y pueden variar según el tipo de cambio, el peso final y la clasificación real de la mercancía.';

  return [
    '✅ *Cotización PREMIUM*',
    sep,
    `🆔 *ID:* ${payload.id}`,
    `🗓️ *Fecha:* ${payload.fechaLocal}`,
    sep,
    `📍 *Origen:* ${payload.origen}`,
    `🏷️ *Categoría seleccionada:* ${categoriaSeleccionada || '-'}`,
    `🏷️ *Categoría aplicada (por descripción):* ${payload.categoriaFinal || '-'}`,
    `📝 *Descripción:* ${payload.mercancia || '-'}`,
    sep,
    `⚖️ *Peso ingresado:* ${payload.peso} ${payload.unidad}`,
    `⚖️ *Peso facturable:* ${payload.pesoFacturable} ${payload.unidadFacturable}`,
    `💵 *Tarifa aplicada:* $${payload.tarifaUSD.toFixed(2)} / ${payload.unidadFacturable}`,
    sep,
    `🧾 *Subtotal:* ¢${Math.round(payload.subtotalCRC)}`,
    `🏷️ *Descuento:* ¢${Math.round(payload.discountAmountCRC)} (${(payload.discountPercent * 100).toFixed(1)}%)`,
    `🚚 *Costo de entrega:* ¢${Math.round(payload.deliveryCostCRC)}`,
    `✅ *Total final:* ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `💱 *Tipo de cambio usado:* ${payload.exchangeRate}`,
    sep,
    nota
  ].join('\n');
}

/* =========================================================
 * 13) Helpers de UX: iniciar flujo con teléfono inteligente
 * ======================================================= */
async function promptPhoneOrUseCache(chatId, target) {
  const cached = getCachedPhone(chatId);
  const state = getState(chatId) || {};
  if (cached) {
    setState(chatId, { ...state, modo: 'CONFIRM_USE_CACHED_PHONE', target, menuMessageId: state.menuMessageId, cachedPhone: cached });
    await bot.sendMessage(chatId, `📞 ¿Deseás usar el mismo número (termina en *${maskPhone(cached).slice(-4)}*)?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Sí', callback_data: `PHONE|USE|${target}|SI` },
          { text: 'No', callback_data: `PHONE|USE|${target}|NO` }
        ]]
      }
    });
    return;
  }

  setState(chatId, { ...state, modo: 'ASK_PHONE', target, menuMessageId: state.menuMessageId });
  await bot.sendMessage(chatId, '📞 Escribí tu número de teléfono con el que te registraste (ej: 88885555):', {
    reply_markup: backToMenuInline()
  });
}

/* =========================================================
 * 14) Handlers de callback (INLINE)
 * ======================================================= */
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || '';
  await safeAnswerCallback(query);

  if (!chatId) return;

  try {
    // Navegación básica
    if (data === 'NAV|MENU') {
      return upsertMenu(chatId, { edit: true });
    }


    // Registro (crear casillero)
    if (data === 'FLOW|REGISTRO') {
      const st = getState(chatId) || {};
      setState(chatId, { ...st, modo: 'REG_NOMBRE', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '✅ Registro (crear casillero)\n\nPor favor escribí tu *nombre completo*:', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    }

    // Tracking listado (paginación/detalle)
    if (data.startsWith('TRK|PAGE|')) {
      const page = parseInt(data.split('|')[2] || '1', 10);
      const st = getState(chatId) || {};
      return sendTrackingList(chatId, st.itemsCache || [], page);
    }

    if (data.startsWith('TRK|DET|')) {
      const idx = parseInt(data.split('|')[2] || '0', 10);
      const st = getState(chatId) || {};
      const item = (st.itemsCache || [])[idx];
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado.', { reply_markup: backToMenuInline() });

      const detalle = [
        '📦 *Detalle de paquete*',
        '━━━━━━━━━━━━━━━━━━━━',
        `🔎 *Tracking:* ${item.tracking || '-'}`,
        `📍 *Origen:* ${item.origen || '-'}`,
        `📌 *Estado:* ${item.estado || '-'}`,
        `⚖️ *Peso:* ${item.peso || '-'}`,
        `🗒️ *Comentarios internos:* ${item.comentariosInternos || '-'}`,
        `🗓️ *Fecha:* ${item.fecha || '-'}`,
        '',
        '⬅️ Podés regresar al menú cuando gustés.'
      ].join('\n');

      return bot.sendMessage(chatId, detalle, { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    }
    // Menú principal
    if (data.startsWith('MENU|')) {
      const action = data.split('|')[1];
      if (action === 'TRACKING') return startTracking(chatId);
      if (action === 'COTIZAR') return startCotizar(chatId);
      if (action === 'PREALERTA') return startPrealerta(chatId);
      if (action === 'CASILLERO') return startCasillero(chatId);
      if (action === 'SALDO') return startSaldo(chatId);
      if (action === 'AYUDA') return showAyuda(chatId);
      return upsertMenu(chatId, { edit: true });
    }

    // Teléfono inteligente
    if (data.startsWith('PHONE|USE|')) {
      const parts = data.split('|'); // PHONE USE TARGET SI/NO
      const target = parts[2] || '';
      const ans = (parts[3] || '').toUpperCase();
      const cached = getCachedPhone(chatId);

      if (ans === 'SI' && cached) {
        const st = getState(chatId) || {};
        // disparar flujo con teléfono ya conocido
        return routeAfterPhone(chatId, target, cached, st);
      }

      // NO (o sin cache): pedir teléfono
      const st = getState(chatId) || {};
      setState(chatId, { ...st, modo: 'ASK_PHONE', target, menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '📞 Perfecto, escribí el número de teléfono (ej: 88885555):', { reply_markup: backToMenuInline() });
    }

    // Casillero: país
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      const st = getState(chatId) || {};
      const client = st.client;
      if (!client) {
        await bot.sendMessage(chatId, 'No tengo tu registro activo. Volvé a entrar por *Mi Casillero* desde el menú.', { parse_mode: 'Markdown' });
        return upsertMenu(chatId, { edit: true });
      }

      if (pais === 'colombia') {
        // Colombia depende de descripción (especial/general)
        setState(chatId, { ...st, modo: 'CASILLERO_COL_DESC', menuMessageId: st.menuMessageId });
        return bot.sendMessage(chatId, '📝 Para Colombia, escribí una breve descripción de lo que vas a recibir (ej: "camisetas", "perfume", "zapatos réplica"):', { reply_markup: backToMenuInline() });
      }

      const dire = await getCachedDirecciones(client.nombre || 'Nombre de cliente');
      const nombres = { miami: 'Miami', madrid: 'Madrid', mexico: 'Ciudad de México', china: 'China' };

      let direccion = 'No disponible';
      if (pais === 'miami') direccion = dire.miami;
      else if (pais === 'madrid') direccion = dire.espana;
      else if (pais === 'mexico') direccion = dire.mexico;
      else if (pais === 'china') direccion = dire.china;

      await bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais] || pais}*\n\n${direccion}`, { parse_mode: 'Markdown' });
      return upsertMenu(chatId, { edit: true });
    }

    // Ayuda
    if (data === 'HELP|AGENTE') {
      const cached = getCachedPhone(chatId);
      await notifyAdmin('Solicitud de ayuda / agente', [
        `Chat: ${chatId}`,
        `Usuario: @${query.from?.username || '-'}`,
        `Nombre: ${query.from?.first_name || '-'} ${query.from?.last_name || ''}`.trim(),
        `Tel (cache): ${cached ? cached : '-'}`
      ]);
      await bot.sendMessage(chatId, '✅ Listo. Un agente fue notificado y te contactará lo antes posible.', { reply_markup: backToMenuInline() });
      return;
    }

    // Cotización como invitado (cuando el teléfono no está registrado)
    if (st.modo === 'COT_GUEST_NAME') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor escribí nombre y apellido.', { reply_markup: backToMenuInline() });
      setState(chatId, { ...st, nombre: text, modo: 'COT_GUEST_EMAIL' });
      return bot.sendMessage(chatId, '✉️ Escribí tu correo electrónico:', { reply_markup: backToMenuInline() });
    }

    if (st.modo === 'COT_GUEST_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intentá nuevamente.', { reply_markup: backToMenuInline() });
      setState(chatId, { ...st, correo: text, modo: 'COT_ORIG' });
      return bot.sendMessage(chatId, '📍 Seleccioná el *origen*:', { parse_mode: 'Markdown', reply_markup: originsInline('COT|ORIG') });
    }


    // Registro: afiliada SI/NO
    if (data.startsWith('REG|AFILIADA|')) {
      const ans = data.split('|')[2] || '';
      const st = getState(chatId) || {};
      if (ans === 'SI') {
        setState(chatId, { ...st, modo: 'REG_AFILIADA_CODE', menuMessageId: st.menuMessageId });
        return bot.sendMessage(chatId, '🏢 Escribí el *código de empresa afiliada*:', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      }
      // NO
      setState(chatId, { ...st, codigoEmpresa: '', modo: 'REG_DIRECCION', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '📍 Por último, escribí tu *dirección de entrega* (calle, número, ciudad):', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    }

    // Prealerta: origen
    if (data.startsWith('PRE|ORIG|')) {
      const origen = data.split('|').slice(2).join('|');
      const st = getState(chatId) || {};
      setState(chatId, { ...st, prealertOrigen: origen, modo: 'PRE_HAS_WEIGHT', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '⚖️ ¿Tenés el peso del paquete?', { reply_markup: yesNoInline('PRE|HAS_WEIGHT') });
    }

    // Prealerta: tiene peso SI/NO
    if (data.startsWith('PRE|HAS_WEIGHT|')) {
      const ans = data.split('|')[2] || '';
      const st = getState(chatId) || {};
      if (ans === 'SI') {
        setState(chatId, { ...st, modo: 'PRE_WEIGHT_VALUE', menuMessageId: st.menuMessageId });
        return bot.sendMessage(chatId, '⚖️ Escribí el *peso* (solo el número, por ejemplo: 2.5):', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      }
      // NO
      setState(chatId, { ...st, prePeso: null, preUnidad: null, modo: 'PRE_DESC', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '📝 Escribí una descripción del contenido del paquete (obligatorio):', { reply_markup: backToMenuInline() });
    }

    // Prealerta: unidad lb/kg
    if (data.startsWith('PRE|UNIT|')) {
      const unit = data.split('|')[2] || 'lb';
      const st = getState(chatId) || {};
      setState(chatId, { ...st, preUnidad: unit, modo: 'PRE_DESC', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '📝 Escribí una descripción del contenido del paquete (obligatorio):', { reply_markup: backToMenuInline() });
    }

    // Prealerta: confirmar / cancelar
    if (data.startsWith('PRE|CONFIRM|')) {
      const ans = data.split('|')[2] || '';
      const st = getState(chatId) || {};
      if (ans === 'NO') {
        await bot.sendMessage(chatId, 'Operación cancelada.', { reply_markup: backToMenuInline() });
        return upsertMenu(chatId, { edit: true });
      }

      // Confirmar
      const client = st.client;
      if (!client) {
        await bot.sendMessage(chatId, 'No encuentro tu registro. Iniciá de nuevo desde el menú.', { reply_markup: backToMenuInline() });
        return upsertMenu(chatId, { edit: true });
      }

      const tracking = st.prealertTracking || '';
      const origen = st.prealertOrigen || '';
      const pesoText = (st.prePeso && st.preUnidad) ? `${st.prePeso} ${st.preUnidad}` : '';
      const desc = st.preDesc || '';

      await savePrealertToDatos({
        tracking,
        clienteNombre: client.nombre || 'Cliente',
        origen,
        pesoText,
        comentariosCliente: desc
      });

      await notifyAdmin('Nueva prealerta', [
        `Tracking: *${tracking}*`,
        `Cliente: *${client.nombre || '-'}*`,
        `Origen: ${origen}`,
        `Peso: ${pesoText || '-'}`,
        `Fecha: ${nowCR()}`,
        `Descripción: ${desc || '-'}`
      ]);

      clearState(chatId);
      await bot.sendMessage(chatId, '✅ Prealerta registrada correctamente.', { reply_markup: backToMenuInline() });
      return upsertMenu(chatId, { edit: true });
    }

    // Cotización: categoría
    if (data.startsWith('COT|CAT|')) {
      const cat = data.split('|').slice(2).join('|');
      const st = getState(chatId) || {};
      setState(chatId, { ...st, categoriaSeleccionada: cat, modo: 'COT_DESC', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, `📝 Escribí una descripción del producto (obligatorio).`, { reply_markup: backToMenuInline() });
    }

    // Cotización: origen
    if (data.startsWith('COT|ORIG|')) {
      const origen = data.split('|').slice(2).join('|');
      const st = getState(chatId) || {};
      setState(chatId, { ...st, origen, modo: 'COT_CAT', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '🏷️ Seleccioná la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    // Cotización: unidad
    if (data.startsWith('COT|UNIT|')) {
      const unit = data.split('|')[2] || 'lb';
      const st = getState(chatId) || {};
      setState(chatId, { ...st, unidad: unit, modo: 'COT_DELIV_GAM', menuMessageId: st.menuMessageId });
      return bot.sendMessage(chatId, '📍 ¿La entrega es dentro del GAM?', { reply_markup: yesNoInline('COT|GAM') });
    }

    // Cotización: entrega GAM SI/NO
    if (data.startsWith('COT|GAM|')) {
      const ans = data.split('|')[2] || '';
      const st = getState(chatId) || {};
      const entregaGAM = (ans === 'SI');
      if (!entregaGAM) {
        setState(chatId, { ...st, entregaGAM: false, modo: 'COT_DELIV_METHOD', menuMessageId: st.menuMessageId });
        return bot.sendMessage(chatId, '📦 Seleccioná el método de entrega:', { reply_markup: deliveryMethodInline() });
      }
      setState(chatId, { ...st, entregaGAM: true, deliveryMethod: 'GAM', modo: 'COT_CALC', menuMessageId: st.menuMessageId });
      return finishCotizacion(chatId);
    }

    // Cotización: método entrega (solo cuando NO GAM)
    if (data.startsWith('COT|DELIV_METHOD|')) {
      const method = data.split('|').slice(2).join('|');
      const st = getState(chatId) || {};
      setState(chatId, { ...st, entregaGAM: false, deliveryMethod: method, modo: 'COT_CALC', menuMessageId: st.menuMessageId });
      return finishCotizacion(chatId);
    }

  } catch (err) {
    console.error('callback_query error:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción. Probá de nuevo desde el menú.');
    return upsertMenu(chatId, { edit: true });
  }
});

/* =========================================================
 * 15) Handlers de mensajes (texto) + handler universal
 * ======================================================= */
bot.on('message', async (msg) => {
  try {
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const text = normalizeText(msg.text);
    const st = getState(chatId) || {};

    // Permitir /start y /menu para abrir menú (sin depender de comandos operativos)
    if (text.startsWith('/')) {
      if (/^\/(start|menu|ayuda|help)$/i.test(text)) {
        await upsertMenu(chatId, { edit: false });
      }
      return;
    }

    // 3️⃣ Handler universal fuera de flujo
    if (!st.modo) {
      await bot.sendMessage(chatId, '👋 Bienvenido, para continuar seleccioná una opción del menú principal.', { reply_markup: backToMenuInline() });
      return upsertMenu(chatId, { edit: true });
    }

    // Pidiendo teléfono (para cualquier target)
    if (st.modo === 'ASK_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) {
        return bot.sendMessage(chatId, 'Número inválido. Probá con 7 u 8 dígitos (ej: 88885555).', { reply_markup: backToMenuInline() });
      }
      savePhoneToCache(chatId, phone);
      return routeAfterPhone(chatId, st.target, phone, st);
    }

    // Registro
    if (st.modo === 'REG_NOMBRE') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 3) {
        return bot.sendMessage(chatId, 'Por favor escribí tu *nombre completo* (mínimo 1 nombre y 2 apellidos).', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      }
      setState(chatId, { ...st, nombre: text, modo: 'REG_EMAIL' });
      return bot.sendMessage(chatId, '✉️ Ahora escribí tu *correo electrónico*:', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    }

    if (st.modo === 'REG_EMAIL') {
      if (!text.includes('@')) {
        return bot.sendMessage(chatId, 'Correo inválido. Intentá nuevamente.', { reply_markup: backToMenuInline() });
      }
      setState(chatId, { ...st, correo: text, modo: 'REG_PHONE' });
      return bot.sendMessage(chatId, '📞 Escribí tu *número de contacto* (ej: 88885555):', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    }

    if (st.modo === 'REG_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) {
        return bot.sendMessage(chatId, 'Número inválido. Probá con 7 u 8 dígitos (ej: 88885555).', { reply_markup: backToMenuInline() });
      }
      const existing = await findClientByPhone(phone);
      if (existing) {
        clearState(chatId);
        await bot.sendMessage(chatId, `Ese número ya está registrado a nombre de *${existing.nombre}*.\nSi sos vos, entrá por *Mi Casillero* desde el menú.`, { parse_mode: 'Markdown' });
        await notifyAdmin('Intento de registro duplicado', [`Tel: ${phone}`, `Chat: ${chatId}`]);
        return upsertMenu(chatId, { edit: true });
      }
      savePhoneToCache(chatId, phone);
      setState(chatId, { ...st, telefono: phone, modo: 'REG_AFILIADA_ASK' });
      return bot.sendMessage(chatId, '🏢 ¿Pertenecés a una empresa afiliada?', { reply_markup: yesNoInline('REG|AFILIADA') });
    }

    if (st.modo === 'REG_AFILIADA_CODE') {
      const code = normalizeText(text).toUpperCase();
      if (code === 'NO') {
        setState(chatId, { ...st, codigoEmpresa: '', modo: 'REG_DIRECCION' });
        return bot.sendMessage(chatId, '📍 Por último, escribí tu *dirección de entrega* (calle, número, ciudad):', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      }

      const codes = await getCachedEmpresaCodes();
      if (!codes.has(code)) {
        return bot.sendMessage(chatId, '❌ Ese código no existe.\nPodés intentar de nuevo, o escribir *NO* para continuar sin empresa afiliada.', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      }

      setState(chatId, { ...st, codigoEmpresa: code, modo: 'REG_DIRECCION' });
      return bot.sendMessage(chatId, '✅ Código validado.\n📍 Ahora escribí tu *dirección de entrega*:', { reply_markup: backToMenuInline() });
    }

    if (st.modo === 'REG_DIRECCION') {
      const direccion = text;
      await addClientToSheet({
        nombre: st.nombre,
        correo: st.correo,
        telefono: st.telefono,
        direccion,
        codigoEmpresa: st.codigoEmpresa || ''
      });

      await notifyAdmin('Nuevo registro', [
        `Nombre: *${st.nombre}*`,
        `Tel: ${st.telefono}`,
        `Email: ${st.correo}`,
        `Empresa: ${st.codigoEmpresa || '-'}`
      ]);

      clearState(chatId);
      await bot.sendMessage(chatId, `✅ Registro completado.\nTu casillero fue creado para *${st.nombre}*.`, { parse_mode: 'Markdown' });
      return upsertMenu(chatId, { edit: true });
    }

    // Casillero Colombia: decidir especial/general por descripción
    if (st.modo === 'CASILLERO_COL_DESC') {
      const desc = text;
      const dire = await getCachedDirecciones(st.client?.nombre || 'Nombre de cliente');
      const categoriaDetect = detectCategoryFromDescription(desc);
      const tipo = categoryToTariffClass(categoriaDetect || '', 'Colombia') === 'Especial' ? 'Especial' : 'General';
      const direccion = (tipo === 'Especial') ? dire.colombiaCon : dire.colombiaSin;

      await bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo === 'Especial' ? 'Especial / Réplica' : 'Carga General'})*\n\n${direccion}`, { parse_mode: 'Markdown' });
      return upsertMenu(chatId, { edit: true });
    }

    // Prealerta: tracking
    if (st.modo === 'PRE_TRACKING') {
      setState(chatId, { ...st, prealertTracking: text, modo: 'PRE_ORIG' });
      return bot.sendMessage(chatId, '📍 Seleccioná el *origen* del paquete:', { parse_mode: 'Markdown', reply_markup: originsInline('PRE|ORIG') });
    }

    // Prealerta: peso valor (si aplica)
    if (st.modo === 'PRE_WEIGHT_VALUE') {
      const val = safeParseNumber(text);
      if (!val || val <= 0) {
        return bot.sendMessage(chatId, 'Peso inválido. Escribí solo el número (ej: 2.5).', { reply_markup: backToMenuInline() });
      }
      setState(chatId, { ...st, prePeso: val, modo: 'PRE_WEIGHT_UNIT' });
      return bot.sendMessage(chatId, '⚖️ Seleccioná la unidad:', { reply_markup: weightUnitInline('PRE|UNIT') });
    }

    // Prealerta: descripción
    if (st.modo === 'PRE_DESC') {
      if (!text) return bot.sendMessage(chatId, 'La descripción es obligatoria. Escribila por favor.', { reply_markup: backToMenuInline() });

      const pesoText = (st.prePeso && st.preUnidad) ? `${st.prePeso} ${st.preUnidad}` : '(sin peso)';
      const resumen = [
        '📝 *Confirmación de Prealerta*',
        '━━━━━━━━━━━━━━━━━━━━',
        `📦 *Tracking:* ${st.prealertTracking || '-'}`,
        `📍 *Origen:* ${st.prealertOrigen || '-'}`,
        `⚖️ *Peso:* ${pesoText}`,
        `👤 *Cliente:* ${st.client?.nombre || '-'}`,
        '━━━━━━━━━━━━━━━━━━━━',
        `🗒️ *Descripción:* ${text}`
      ].join('\n');

      setState(chatId, { ...st, preDesc: text, modo: 'PRE_CONFIRM' });
      return bot.sendMessage(chatId, resumen, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Confirmar', callback_data: 'PRE|CONFIRM|SI' },
            { text: '❌ Cancelar', callback_data: 'PRE|CONFIRM|NO' }
          ]]
        }
      });
    }

    // Cotización: descripción
    if (st.modo === 'COT_DESC') {
      if (!text) return bot.sendMessage(chatId, 'La descripción es obligatoria. Escribila por favor.', { reply_markup: backToMenuInline() });

      // prioridad descripción
      const detected = detectCategoryFromDescription(text);
      const categoriaFinal = detected || st.categoriaSeleccionada || 'Otro';

      setState(chatId, {
        ...st,
        descripcion: text,
        categoriaFinal,
        modo: 'COT_PESO',
      });

      return bot.sendMessage(chatId, '⚖️ Escribí el peso (solo el número, por ejemplo: 3.2):', { reply_markup: backToMenuInline() });
    }

    // Cotización: peso valor
    if (st.modo === 'COT_PESO') {
      const val = safeParseNumber(text);
      if (!val || val <= 0) return bot.sendMessage(chatId, 'Peso inválido. Escribí solo el número (ej: 3.2).', { reply_markup: backToMenuInline() });

      setState(chatId, { ...st, peso: val, modo: 'COT_UNIT' });
      return bot.sendMessage(chatId, '⚖️ Seleccioná la unidad:', { reply_markup: weightUnitInline('COT|UNIT') });
    }

    // Si llega aquí, es texto fuera del flujo esperado: volvemos a menú limpio.
    await bot.sendMessage(chatId, '👋 Para continuar, seleccioná una opción del menú principal.', { reply_markup: backToMenuInline() });
    return upsertMenu(chatId, { edit: true });

  } catch (err) {
    console.error('message handler error:', err);
    try { await bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Volvé a intentar desde el menú.'); } catch (_) {}
    return upsertMenu(msg.chat.id, { edit: true });
  }
});

/* =========================================================
 * 16) Arranque de flujos (desde menú)
 * ======================================================= */
async function startTracking(chatId) {
  clearState(chatId);
  const base = getState(chatId) || {};
  setState(chatId, { ...base, modo: null, menuMessageId: base.menuMessageId });
  await promptPhoneOrUseCache(chatId, 'TRACKING');
}

async function startCasillero(chatId) {
  clearState(chatId);
  const base = getState(chatId) || {};
  setState(chatId, { ...base, modo: null, menuMessageId: base.menuMessageId });
  await promptPhoneOrUseCache(chatId, 'CASILLERO');
}

async function startSaldo(chatId) {
  clearState(chatId);
  const base = getState(chatId) || {};
  setState(chatId, { ...base, modo: null, menuMessageId: base.menuMessageId });
  await promptPhoneOrUseCache(chatId, 'SALDO');
}

async function startPrealerta(chatId) {
  clearState(chatId);
  const base = getState(chatId) || {};
  setState(chatId, { ...base, modo: null, menuMessageId: base.menuMessageId });
  await promptPhoneOrUseCache(chatId, 'PREALERTA');
}

async function startCotizar(chatId) {
  clearState(chatId);
  const base = getState(chatId) || {};
  setState(chatId, { ...base, modo: null, menuMessageId: base.menuMessageId });
  await promptPhoneOrUseCache(chatId, 'COTIZAR');
}

async function showAyuda(chatId) {
  const txt = [
    '❓ *Ayuda*',
    '━━━━━━━━━━━━━━━━━━━━',
    '• Usá el menú para consultar tracking, cotizar, prealertar o ver tu casillero.',
    '• Si necesitás un agente, tocá el botón de abajo y te contactamos.',
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  await bot.sendMessage(chatId, txt, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '👤 Hablar con un agente', callback_data: 'HELP|AGENTE' }],
        [{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]
      ]
    }
  });
}

/* =========================================================
 * 17) Router: después de obtener teléfono (por target)
 * ======================================================= */
async function routeAfterPhone(chatId, target, phone, prevState = {}) {
  const client = await findClientByPhone(phone);
  const st = getState(chatId) || prevState;

  // Guardar en estado (si existe)
  const stateBase = { ...st, client: client || null, telefono: phone, menuMessageId: st.menuMessageId };

  if (!client) {
    // Si no está registrado, ofrecemos registro para lo que lo requiera
    if (target === 'COTIZAR') {
      // Cotización permite continuar como invitado, pero pedimos nombre/email
      setState(chatId, { ...stateBase, modo: 'COT_GUEST_NAME' });
      await bot.sendMessage(chatId, 'No encontré ese número registrado.\n¿Querés *cotizar como invitado*? Escribí tu *nombre completo*:', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
      return;
    }

    // Tracking / Casillero / Prealerta requieren estar registrado para evitar cruces
    setState(chatId, { ...stateBase, modo: null });
    await bot.sendMessage(chatId, 'Ese número no está registrado.\nPara continuar, primero creá tu casillero (registro).', { reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Crear Casillero (Registro)', callback_data: 'FLOW|REGISTRO' }],
        [{ text: '⬅️ Regresar', callback_data: 'NAV|MENU' }]
      ]
    }});
    return;
  }

  if (target === 'TRACKING') {
    // Buscar paquetes del cliente (por teléfono -> nombre exacto)
    const items = await getTrackingsByClientNameExact(client.nombre);
    if (!items.length) {
      await bot.sendMessage(chatId, '📦 No encontramos paquetes asociados a tu cuenta por el momento.', { reply_markup: backToMenuInline() });
      return upsertMenu(chatId, { edit: true });
    }
    setState(chatId, { ...stateBase, modo: 'TRACK_LIST', itemsCache: items, page: 1 });
    return sendTrackingList(chatId, items, 1);
  }

  if (target === 'CASILLERO') {
    setState(chatId, { ...stateBase, modo: 'CASILLERO_SELECT' });
    await bot.sendMessage(chatId, `🏷️ Hola *${client.nombre || 'Cliente'}*.\nSeleccioná el país de tu casillero:`, {
      parse_mode: 'Markdown',
      reply_markup: casilleroPaisesInline()
    });
    return;
  }

    if (target === 'SALDO') {
    const nombre = client?.nombre || 'Cliente';
    const saldo = safeParseNumber(client?.saldo || 0);
    const msg = [
      '💳 *Saldo Pendiente*',
      '━━━━━━━━━━━━━━━━━━━━',
      `👤 Cliente: *${nombre}*`,
      `📞 Teléfono: *${maskPhone(phone)}*`,
      `💰 Saldo: *₡${saldo.toLocaleString('es-CR')}*`,
      '',
      'Si necesitás ayuda para cancelar o tenés dudas, elegí *Ayuda* en el menú.'
    ].join('\n');

    clearState(chatId);
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    return upsertMenu(chatId, { edit: true });
  }

if (target === 'PREALERTA') {
    setState(chatId, { ...stateBase, modo: 'PRE_TRACKING' });
    await bot.sendMessage(chatId, '📦 Escribí el *número de tracking*:', { parse_mode: 'Markdown', reply_markup: backToMenuInline() });
    return;
  }

  if (target === 'COTIZAR') {
    setState(chatId, { ...stateBase, modo: 'COT_ORIG' });
    await bot.sendMessage(chatId, '📍 Seleccioná el *origen*:', { parse_mode: 'Markdown', reply_markup: originsInline('COT|ORIG') });
    return;
  }

  // fallback
  await bot.sendMessage(chatId, 'Acción no reconocida. Volvé al menú.', { reply_markup: backToMenuInline() });
  return upsertMenu(chatId, { edit: true });
}

/* =========================================================
 * 19) Finalizar cotización (cálculo + UX premium)
 * ======================================================= */
async function finishCotizacion(chatId) {
  const st = getState(chatId) || {};
  try {
    await bot.sendMessage(chatId, '⏳ Procesando cotización...');
    const payload = await calcularCotizacion(chatId, st);

    const tarifas = await getCachedTarifas();
    const legend = buildDiscountLegend(payload.pesoFacturable, tarifas.discounts || [], payload.origen);

    const msg = buildCotizacionPremiumMessage(payload, st.categoriaSeleccionada) + (legend ? `\n\n${legend}` : '');
    clearState(chatId);

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    return upsertMenu(chatId, { edit: true });
  } catch (err) {
    console.error('finishCotizacion error:', err);
    clearState(chatId);
    await bot.sendMessage(chatId, '❌ Ocurrió un error procesando la cotización. Intentá nuevamente desde el menú.');
    return upsertMenu(chatId, { edit: true });
  }
}



/* =========================================================
 * 21) Tracking listado (paginación)
 * ======================================================= */

/* =========================================================
 * 21) Tracking listado (inline paginado + detalle)
 * ======================================================= */
const TRACKS_PER_PAGE = 5;

async function sendTrackingList(chatId, items, page = 1) {
  if (!items?.length) {
    await bot.sendMessage(chatId, 'No se encontraron paquetes.', { reply_markup: backToMenuInline() });
    return upsertMenu(chatId, { edit: true });
  }

  const totalPages = Math.ceil(items.length / TRACKS_PER_PAGE);
  page = Math.max(1, Math.min(page, totalPages));

  const start = (page - 1) * TRACKS_PER_PAGE;
  const slice = items.slice(start, start + TRACKS_PER_PAGE);

  const lines = slice.map((it, idx) => {
    const n = start + idx + 1;
    const estado = it.estado || '-';
    return `${n}. ${it.tracking || '(sin tracking)'}  |  ${estado}`;
  }).join('\n');

  const buttons = slice.map((_, idx) => ([
    { text: `Ver ${start + idx + 1}`, callback_data: `TRK|DET|${start + idx}` }
  ]));

  const paging = [];
  if (page > 1) paging.push({ text: '◀️ Anterior', callback_data: `TRK|PAGE|${page - 1}` });
  if (page < totalPages) paging.push({ text: 'Siguiente ▶️', callback_data: `TRK|PAGE|${page + 1}` });
  paging.push({ text: '⬅️ Regresar', callback_data: 'NAV|MENU' });

  await bot.sendMessage(chatId, `📦 *Tus paquetes* (Página ${page}/${totalPages})\n\n${lines}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons.concat([paging]) }
  });

  const st = getState(chatId) || {};
  setState(chatId, { ...st, modo: 'TRACK_LIST', itemsCache: items, page, menuMessageId: st.menuMessageId });
}




/* =========================================================
 * 22) Webhook / Server
 * ======================================================= */
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200);
  try { bot.processUpdate(req.body); } catch (e) { console.error('processUpdate error', e); }
});

app.get('/', (req, res) => res.send('✅ Bot de Telegram activo - J.I Asesoría & Courier'));

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
