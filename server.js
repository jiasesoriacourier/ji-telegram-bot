// server.js - Bot Telegram + Google Sheets (final, completo)
// Dependencias: npm i express node-telegram-bot-api googleapis
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - GOOGLE_CREDENTIALS (JSON o base64)
// - SPREADSHEET_ID (opcional)
// Admin Telegram ID para recibir respaldo de cotizaciones: 7826072133

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

/// ---------------- CONFIG ----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno (JSON o Base64)');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

/// ---------------- Estado por usuario ----------------
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

/// ---------------- Constantes / listas ----------------
const MERCANCIA_ESPECIAL = [ "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje","medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas","alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante","lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula" ];
const MERCANCIA_PROHIBIDA = [ "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd","arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso","oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros" ];
const KNOWN_BRANDS = [ "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier","bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret" ];

const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china']; // usadas en cotizaciones
const PREALERT_ORIGINS = ['Estados Unidos','Colombia','España','China','Mexico']; // para prealerta (mostrar al usuario)

/** UTIL: Google Sheets client **/
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS;
  try {
    if (!credsRaw.trim().startsWith('{')) credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
    const credentials = JSON.parse(credsRaw);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (err) {
    console.error('Error parseando GOOGLE_CREDENTIALS:', err);
    throw err;
  }
}

/// ---------------- UTILIDADES ----------------
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

// Normaliza teléfono asumiento formato preferido: 8 dígitos (Formato 1).
// El usuario confirmó: Formato 1 (solo 8 dígitos). Aceptamos input con o sin +506 y limpiamos.
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, ''); // solo dígitos
  // si viene con prefijo 506, quitarlo
  if (s.startsWith('506') && s.length > 8) s = s.slice(3);
  // si viene con 0 delante (raro) quitar
  if (s.length > 8 && s.startsWith('0')) s = s.replace(/^0+/, '');
  // tomar últimos 8 dígitos si por accidente trajeron prefijos
  if (s.length > 8) s = s.slice(-8);
  return s;
}

// comparador flexible: terminaWith para admitir coincidencias (sheet tiene 8 dígitos)
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

/// ---------------- DIRECCIONES ----------------
async function getDirecciones(nombreCliente = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const sheetVals = sheets.spreadsheets.values;
  const range = 'Direcciones!A:Z';
  const res = await sheetVals.get({ spreadsheetId: SPREADSHEET_ID, range });
  const data = res.data.values || [];
  const replaceName = (text) => text.replace(/Nombre de cliente/gi, nombreCliente);

  return {
    miami: replaceName(extractRange(data, 1, 4, 1, 3)),
    espana: replaceName(extractRange(data, 16, 20, 1, 3)),
    colombiaCon: replaceName(extractRange(data, 0, 6, 6, 9)),
    colombiaSin: replaceName(extractRange(data, 10, 16, 6, 9)),
    mexico: replaceName(extractRange(data, 23, 28, 1, 3)),
    china: replaceName(extractRange(data, 23, 28, 6, 9))
  };
}

/// ---------------- TECLADOS ----------------
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo', '/contactar', '/prealertar']
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
      [{ text: '🇪🇸 Madrid', callback_data: 'CASILLERO|madrid' }],
      [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }]
    ]
  };
}
function colombiaPermisoKeyboard() {
  return { inline_keyboard: [[{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],[{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]] };
}
function yesNoKeyboard() {
  return { keyboard: [['SI','NO']], one_time_keyboard: true, resize_keyboard: true };
}
function continueKeyboard() {
  return { keyboard: [['Registrar otro tracking','Volver al /menu']], one_time_keyboard: true, resize_keyboard: true };
}

function contactarKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Correo: info@jiasesoria.com', callback_data: 'CONTACT|email' }],
      [{ text: 'WhatsApp', callback_data: 'CONTACT|wa' }],
      [{ text: 'Telegram', callback_data: 'CONTACT|tg' }]
    ]
  };
}

/// ---------------- CLASIFICACIÓN ----------------
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
  for (const b of KNOWN_BRANDS) if (text.includes(b)) return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
  return { tipo: 'General', tags: [] };
}

/// ---------------- SHEETS: Buscar cliente / Añadir cliente ----------------
// Estructura clientes (según tus últimas indicaciones):
// A: Nombre, B: Correo, C: Contraseña web (no usada aquí), D: Telefono, F: Direccion, H?: Saldo (si existe)
async function findClientByPhone(phoneOrMaybeEmail) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  const normalizedInput = normalizePhone(phoneOrMaybeEmail);
  const emailInput = (phoneOrMaybeEmail || '').toString().trim().toLowerCase();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0] || '';
    const email = (row[1] || '').toString().trim().toLowerCase();
    const phoneCell = (row[3] || '').toString().trim(); // columna D
    const direccion = row[5] || row[6] || ''; // tentativa
    const saldo = parseFloat(row[7]) || 0;

    // match by phone if input looks numeric
    if (normalizedInput) {
      if (phoneMatches(phoneCell, normalizedInput)) {
        return { rowIndex: i+1, raw: row, nombre: name, correo: email, contacto: phoneCell, direccion, saldo };
      }
    }
    // else match by email
    if (emailInput && email && emailInput === email) {
      return { rowIndex: i+1, raw: row, nombre: name, correo: email, contacto: phoneCell, direccion, saldo };
    }
  }
  return null;
}

async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  // A: nombre, B: correo, C: '', D: contacto, E:'', F:'', G:direccion, H:saldo(0)
  const values = [[ nombre || '', correo || '', '', contacto || '', '', '', direccion || '', 0 ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H', valueInputOption: 'RAW', resource: { values } });
}

/// ---------------- TRACKINGS (desde Datos tab) ----------------
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

/// ---------------- TRACKING PAGINADO ----------------
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

/// ---------------- MENSAJES / COMMANDS ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

// Crear casillero
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero -> ahora solicita teléfono y luego muestra casillero (direcciones) del cliente encontrado
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Para verificar tu casillero, por favor escribe el *número de teléfono* con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});

// consultar_tracking -> solicita teléfono y luego muestra trackings (separado de mi_casillero)
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_TRACKING_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});

// saldo pendiente
bot.onText(/\/saldo/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente.');
});

// contactar
bot.onText(/\/contactar/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Opciones de contacto:', { reply_markup: contactarKeyboard() });
});

// prealertar: registrar tracking manual del cliente (nuevo flujo)
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_TRACKING_START' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Escribe el *Número de tracking* (ej: 123456789).', { parse_mode: 'Markdown' });
});

// cotizar: inicio flujo (teclado con orígenes)
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_ORIGEN' });
  const kb = {
    keyboard: [
      ['miami','madrid'],
      ['colombia','mexico'],
      ['china','Cancelar']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
  bot.sendMessage(chatId, 'Comenzamos la cotización. Selecciona el ORIGEN (toca una opción):', { reply_markup: kb });
});

/// ---------------- CALLBACKS (inline) ----------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    // CATEGORIA -> set category and ask for description
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto.`, { parse_mode: 'Markdown' });
    }

    // CASILLERO -> show directions using the CLIENT NAME retrieved previously
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      const st = getUserState(chatId) || {};
      const client = st.client || null;
      const clientName = client ? client.nombre : (query.from && query.from.first_name ? query.from.first_name : 'Cliente');
      const dire = await getDirecciones(clientName);
      if (pais === 'colombia') {
        return bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: colombiaPermisoKeyboard() });
      } else {
        let direccion = 'No disponible';
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid' || pais === 'espana') direccion = dire.espana || dire.miami;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        const nombres = { miami:'Miami', espana:'Madrid', mexico:'Ciudad de México', china:'China', colombia:'Colombia' };
        return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}* (casillero de: *${clientName}*):\n\n${direccion}`, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
      }
    }

    // COL_CASILLERO (colombia con/sin)
    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const st = getUserState(chatId) || {};
      const client = st.client || null;
      const clientName = client ? client.nombre : (query.from && query.from.first_name ? query.from.first_name : 'Cliente');
      const dire = await getDirecciones(clientName);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})* (casillero de: *${clientName}*):\n\n${direccion}`, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    }

    // CONTACT
    if (data.startsWith('CONTACT|')) {
      const t = data.split('|')[1];
      if (t === 'email') return bot.sendMessage(chatId, 'Escribe a: info@jiasesoria.com', { reply_markup: mainMenuKeyboard() });
      if (t === 'wa') return bot.sendMessage(chatId, 'WhatsApp: https://wa.me/50663939073', { reply_markup: mainMenuKeyboard() });
      if (t === 'tg') return bot.sendMessage(chatId, 'Telegram: https://web.telegram.org/a/#50663939073', { reply_markup: mainMenuKeyboard() });
    }

    // TRACK_PAGE / TRACK_DETAIL / TRACK_EXPORT (respaldo)
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
      return bot.sendMessage(chatId, 'Listado enviado como respaldo al administrador.', { reply_markup: mainMenuKeyboard() });
    }

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.');
  }
});

/// ---------------- MENSAJE LIBRE (flujo: registro, cotizar, prealerta, consultas) ----------------
bot.on('message', async (msg) => {
  try {
    // Ignore commands here (handled by onText)
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    /////// --- CREAR CASILLERO FLOW ---
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
      return bot.sendMessage(chatId, 'Ingresa ahora tu *número de contacto* (solo 8 dígitos, ej: 88885555).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length !== 8) return bot.sendMessage(chatId, 'Número inválido. Ingresa solo 8 dígitos locales (ej: 88885555).');
      const existing = await findClientByPhone(phone);
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
      return bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    }

    /////// --- CHECK CASILLERO (mostrar direcciones) ---
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      if (!phone) { clearUserState(chatId); return bot.sendMessage(chatId, 'Número inválido. Usa solo 8 dígitos.'); }
      const client = await findClientByPhone(phone);
      if (!client) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', { reply_markup: mainMenuKeyboard() });
      }
      // store client in state and show casillero country selection
      setUserState(chatId, { modo: 'AWAIT_CASILLERO_SELECT', client });
      return bot.sendMessage(chatId, `Hola *${client.nombre}*. Selecciona el país de tu casillero:`, { parse_mode: 'Markdown', reply_markup: casilleroPaisesKeyboard() });
    }

    /////// --- CHECK TRACKING (mostrar trackings) ---
    if (state.modo === 'CHECK_TRACKING_PHONE') {
      const phone = normalizePhone(text);
      if (!phone) { clearUserState(chatId); return bot.sendMessage(chatId, 'Número inválido. Usa solo 8 dígitos.'); }
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', { reply_markup: mainMenuKeyboard() });
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.', { reply_markup: mainMenuKeyboard() });
      await sendTrackingList(chatId, items, 1);
      return;
    }

    /////// --- CHECK SALDO ---
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', { reply_markup: mainMenuKeyboard() });
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`, { reply_markup: mainMenuKeyboard() });
    }

    /////// --- PREALERT TRACKING FLOW ---
    if (state.modo === 'PREALERT_TRACKING_START') {
      // user provided tracking number
      state.tracking = text;
      state.modo = 'PREALERT_TRACKING_ORIGIN';
      setUserState(chatId, state);
      // ask origin (use choices)
      const kb = {
        keyboard: [ ['Estados Unidos','Colombia','España'], ['China','Mexico','Cancelar'] ],
        one_time_keyboard: true,
        resize_keyboard: true
      };
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del paquete (toca una opción):', { reply_markup: kb });
    }

    if (state.modo === 'PREALERT_TRACKING_ORIGIN') {
      const origin = text;
      if (!PREALERT_ORIGINS.includes(origin)) return bot.sendMessage(chatId, `Origen inválido. Selecciona uno de: ${PREALERT_ORIGINS.join(', ')}`);
      state.prealertOrigen = origin;
      state.modo = 'PREALERT_TRACKING_PRODUCT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía / producto* (obligatorio).', { parse_mode: 'Markdown' });
    }

    if (state.modo === 'PREALERT_TRACKING_PRODUCT') {
      const producto = text;
      if (!producto || producto.length < 2) return bot.sendMessage(chatId, 'Indica una descripción válida del producto (obligatorio).');
      state.producto = producto;
      state.modo = 'PREALERT_TRACKING_IDENT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *número de teléfono* (8 dígitos) o *correo* con el que quieres asociar este tracking. Si no estás registrado, escribe "NO".', { parse_mode: 'Markdown' });
    }

    if (state.modo === 'PREALERT_TRACKING_IDENT') {
      const ident = text;
      if (ident.toLowerCase() === 'no') {
        // guest flow: require name, phone, email
        state.modo = 'PREALERT_TRACKING_GUEST_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No hay problema — Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      } else {
        // try to find client by phone or email
        const client = await findClientByPhone(ident);
        if (!client) {
          // not found -> ask to register or continue as guest
          state.modo = 'PREALERT_TRACKING_NOTFOUND';
          state.pendingIdent = ident;
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No encontramos un cliente con ese dato. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para continuar como invitado.', { reply_markup: yesNoKeyboard() });
        }
        // found: save tracking to Datos sheet
        const clienteName = client.nombre || 'Cliente';
        await appendPrealertToDatos({ tracking: state.tracking, cliente: clienteName, origen: state.prealertOrigen, observaciones: `Producto: ${state.producto}` });
        // ask if wants to add another
        setUserState(chatId, null);
        await bot.sendMessage(chatId, `✅ Prealerta registrada correctamente para *${clienteName}*.\n¿Deseas registrar otro tracking?`, { parse_mode: 'Markdown', reply_markup: continueKeyboard() });
        return;
      }
    }

    // guest registration for prealert
    if (state.modo === 'PREALERT_TRACKING_GUEST_NAME') {
      const nombre = text;
      state.guest_nombre = nombre;
      state.modo = 'PREALERT_TRACKING_GUEST_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu *número de contacto* (8 dígitos) para asociar el tracking.', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_TRACKING_GUEST_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length !== 8) return bot.sendMessage(chatId, 'Número inválido. Ingresa solo 8 dígitos locales (ej: 88885555).');
      state.guest_phone = phone;
      state.modo = 'PREALERT_TRACKING_GUEST_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu *correo electrónico* (obligatorio).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_TRACKING_GUEST_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.guest_email = text;
      // Save guest as a minimal record? The user requested that prealerts attach to client if possible.
      // We'll save prealert in Datos with the provided guest name.
      const clienteName = state.guest_nombre || 'Cliente Invitado';
      await appendPrealertToDatos({ tracking: state.tracking, cliente: clienteName, origen: state.prealertOrigen, observaciones: `Producto: ${state.producto} | Contacto: ${state.guest_phone} | Email: ${state.guest_email}` });
      setUserState(chatId, null);
      await bot.sendMessage(chatId, `✅ Prealerta registrada como *${clienteName}*.\n¿Deseas registrar otro tracking?`, { parse_mode: 'Markdown', reply_markup: continueKeyboard() });
      return;
    }

    // NOT FOUND decision (register or continue guest)
    if (state.modo === 'PREALERT_TRACKING_NOTFOUND') {
      const ans = text.toLowerCase();
      if (['si','s'].includes(ans)) {
        // start registration flow but keep pending prealert info
        state.modo = 'CREAR_NOMBRE_FROM_PREALERT';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Ingresa tu *Nombre completo* (para registrarte).', { parse_mode: 'Markdown' });
      } else {
        // proceed as guest requiring name/phone/email
        state.modo = 'PREALERT_TRACKING_GUEST_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuemos como invitado. Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
    }

    // Registration flow coming from PREALERT
    if (state.modo === 'CREAR_NOMBRE_FROM_PREALERT') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu *Nombre completo* (al menos 2 palabras).', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_EMAIL_FROM_PREALERT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (para el registro).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_EMAIL_FROM_PREALERT') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO_FROM_PREALERT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (8 dígitos).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_TELEFONO_FROM_PREALERT') {
      const phone = normalizePhone(text);
      if (!phone || phone.length !== 8) return bot.sendMessage(chatId, 'Número inválido. Ingresa solo 8 dígitos (ej: 88885555).');
      state.telefono = phone;
      // create client
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: '' });
      // append prealert to Datos referencing the new client name
      const clienteName = state.nombre;
      await appendPrealertToDatos({ tracking: state.tracking, cliente: clienteName, origen: state.prealertOrigen, observaciones: `Producto: ${state.producto}` });
      setUserState(chatId, null);
      await bot.sendMessage(chatId, `✅ Registrado y prealerta guardada para *${clienteName}*.`, { parse_mode: 'Markdown', reply_markup: continueKeyboard() });
      return;
    }

    // ContinueKeyboard choices after recording prealert
    if (text === 'Registrar otro tracking') {
      setUserState(chatId, { modo: 'PREALERT_TRACKING_START' });
      return bot.sendMessage(chatId, 'Escribe el *Número de tracking* que deseas registrar.', { parse_mode: 'Markdown' });
    }
    if (text === 'Volver al /menu' || text.toLowerCase() === '/menu') {
      clearUserState(chatId);
      return bot.sendMessage(chatId, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
    }

    /////// --- COTIZAR FLOW (mejor control de registro) ---
    if (state.modo === 'COTIZAR_ORIGEN') {
      const origin = text.toLowerCase();
      if (!VALID_ORIGINS.includes(origin)) {
        return bot.sendMessage(chatId, 'Origen inválido. Selecciona uno de: miami, madrid, colombia, mexico, china');
      }
      state.origen = origin;
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }

    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada || '', origen: state.origen || '' });
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.', { reply_markup: mainMenuKeyboard() }); }
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
      state.modo = 'COTIZAR_GAM';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM? Responde: SI o NO (el cliente debe indicar manualmente).', { reply_markup: yesNoKeyboard() });
    }

    if (state.modo === 'COTIZAR_GAM') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde con "SI" o "NO" (entrega dentro del GAM).');
      state.entregaGAM = ['si','s'].includes(ans);
      // if NO -> ask if envio será por encomienda o correos de C.R
      if (!state.entregaGAM) {
        state.modo = 'COTIZAR_ENVIO_EXTERIOR';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿El envío fuera del GAM será por "Encomienda" o "Correos de C.R"? Escribe Encomienda o Correos.', { reply_markup: { keyboard: [['Encomienda','Correos de C.R']], one_time_keyboard: true, resize_keyboard: true } });
      } else {
        // continue to identification step
        state.modo = 'COTIZAR_IDENTIFICAR';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Por favor indica tu *número de teléfono* (8 dígitos) o correo con el que estás registrado. Si no estás registrado escribe "NO".', { parse_mode: 'Markdown' });
      }
    }

    if (state.modo === 'COTIZAR_ENVIO_EXTERIOR') {
      const envio = text.toLowerCase();
      if (!envio.includes('encom') && !envio.includes('corre')) return bot.sendMessage(chatId, 'Responde "Encomienda" o "Correos de C.R".');
      state.envioFueraGAM = envio.includes('encom') ? 'Encomienda' : 'Correos de C.R';
      state.modo = 'COTIZAR_IDENTIFICAR';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Por favor indica tu *número de teléfono* (8 dígitos) o correo con el que estás registrado. Si no estás registrado escribe "NO".', { parse_mode: 'Markdown' });
    }

    // Identify client or ask to register/collect details
    if (state.modo === 'COTIZAR_IDENTIFICAR') {
      const ident = text;
      if (ident.toLowerCase() === 'no') {
        // require nombre, telefono y correo
        state.modo = 'COTIZAR_GUEST_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No estás registrado. Para continuar necesito tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      } else {
        const client = await findClientByPhone(ident);
        if (!client) {
          // ask if register or continue guest
          state.modo = 'COTIZAR_IDENT_NOTFOUND';
          state.pendingIdent = ident;
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No encontramos un cliente con ese dato. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para cotizar sin registro.', { reply_markup: yesNoKeyboard() });
        }
        // client matched -> proceed to calculate and save cotizacion using client data
        state.client = client;
        state.modo = 'COTIZAR_CONFIRMAR';
        setUserState(chatId, state);
        // proceed to calculate immediately (no email)
        await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
        try {
          const cot = await calcularYRegistrarCotizacionRespaldoFinal(chatId, state);
          clearUserState(chatId);
          const msgResp = `✅ Cotización generada\nID: ${cot.id}\nFecha: ${cot.fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cot.pesoFacturable} ${cot.unidadFacturable}\nSubtotal: ¢${Math.round(cot.subtotalCRC)}\nDescuento: ¢${Math.round(cot.discountAmountCRC)} (${(cot.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${Math.round(cot.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cot.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cot.exchangeRate})`;
          return bot.sendMessage(chatId, msgResp, { reply_markup: mainMenuKeyboard() });
        } catch (err) {
          console.error('Error cotizacion cliente registrado:', err);
          clearUserState(chatId);
          return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', { reply_markup: mainMenuKeyboard() });
        }
      }
    }

    // Guest cotizar steps
    if (state.modo === 'COTIZAR_GUEST_NOMBRE') {
      const nombre = text;
      state.guest_nombre = nombre;
      state.modo = 'COTIZAR_GUEST_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu *número de contacto* (8 dígitos).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'COTIZAR_GUEST_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length !== 8) return bot.sendMessage(chatId, 'Número inválido. Ingresa solo 8 dígitos.');
      state.guest_phone = phone;
      state.modo = 'COTIZAR_GUEST_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu *correo electrónico* (obligatorio).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'COTIZAR_GUEST_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.guest_email = text;
      // Proceed to calculate & save using guest data (and save guest info into Cotizaciones P/Q)
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      try {
        const cot = await calcularYRegistrarCotizacionRespaldoFinal(chatId, state, { guest: true });
        clearUserState(chatId);
        const msgResp = `✅ Cotización generada\nID: ${cot.id}\nFecha: ${cot.fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cot.pesoFacturable} ${cot.unidadFacturable}\nSubtotal: ¢${Math.round(cot.subtotalCRC)}\nDescuento: ¢${Math.round(cot.discountAmountCRC)} (${(cot.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${Math.round(cot.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cot.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cot.exchangeRate})`;
        return bot.sendMessage(chatId, msgResp, { reply_markup: mainMenuKeyboard() });
      } catch (err) {
        console.error('Error cotizacion guest:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', { reply_markup: mainMenuKeyboard() });
      }
    }

    // If request was "SI/NO" to register at cotizar notfound
    if (state.modo === 'COTIZAR_IDENT_NOTFOUND') {
      const ans = text.toLowerCase();
      if (['si','s'].includes(ans)) {
        // start registration flow (collect name -> email -> phone)
        state.modo = 'CREAR_NOMBRE_FROM_COTIZAR';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ok, vamos a registrarte. Ingresa tu *Nombre completo*.', { parse_mode: 'Markdown' });
      } else {
        // guest flow
        state.modo = 'COTIZAR_GUEST_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuemos sin registro. Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
    }

    // Registering user from cotizar
    if (state.modo === 'CREAR_NOMBRE_FROM_COTIZAR') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu *Nombre completo* (al menos 2 palabras).', { parse_mode: 'Markdown' });
      state.nombre = text;
      state.modo = 'CREAR_EMAIL_FROM_COTIZAR';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (para registro).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_EMAIL_FROM_COTIZAR') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO_FROM_COTIZAR';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (8 dígitos).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_TELEFONO_FROM_COTIZAR') {
      const phone = normalizePhone(text);
      if (!phone || phone.length !== 8) return bot.sendMessage(chatId, 'Número inválido. Ingresa solo 8 dígitos (ej: 88885555).');
      state.telefono = phone;
      // create client and proceed to calculate
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: '' });
      // set client and continue to calculate
      await bot.sendMessage(chatId, 'Registro completado. Ahora procesaremos tu cotización y guardaremos respaldo...');
      try {
        const cot = await calcularYRegistrarCotizacionRespaldoFinal(chatId, state);
        clearUserState(chatId);
        const msgResp = `✅ Cotización generada\nID: ${cot.id}\nFecha: ${cot.fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cot.pesoFacturable} ${cot.unidadFacturable}\nSubtotal: ¢${Math.round(cot.subtotalCRC)}\nDescuento: ¢${Math.round(cot.discountAmountCRC)} (${(cot.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${Math.round(cot.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cot.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cot.exchangeRate})`;
        return bot.sendMessage(chatId, msgResp, { reply_markup: mainMenuKeyboard() });
      } catch (err) {
        console.error('Error cotizacion after register:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', { reply_markup: mainMenuKeyboard() });
      }
    }

    // If none of the above matched, offer menu prompt
    return bot.sendMessage(chatId, 'No te entendí. Usa /menu para ver las opciones.', { reply_markup: mainMenuKeyboard() });

  } catch (err) {
    console.error('Error en message handler:', err);
    try { bot.sendMessage(msg.chat.id, 'Ocurrió un error interno. Intenta nuevamente.'); } catch (e) {}
  }
});

/// ---------------- LECTURA DE TARIFAS ----------------
// lee celdas B2:B15 y J1..J3 para delivery + tipo de cambio
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
  const values = (res.data.values || []).map(r => r[0]);
  const val = idx => parseFloat(values[idx]) || 0;

  let jVals = {};
  try {
    const r2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!J1:J3' });
    const arr = (r2.data.values || []).map(r => r[0]);
    jVals.deliveryCRC = parseFloat(arr[0]) || 0; // J1
    jVals.exchangeRate = parseFloat(arr[2]) || 1; // J3
  } catch (e) {
    console.warn('No se pudo leer Tarifa J1/J3: ', e);
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

/// ---------------- GUARDAR EN HISTORIAL ----------------
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

/// ---------------- GUARDAR COTIZACIÓN EN HOJA "Cotizaciones" Y REENVIAR AL ADMIN ----------------
/*
Columnas Cotizaciones (A..Q):
A Fecha Cot (a)
B Cliente (b)
C Origen (c)
D Peso (d)
E Unidad (e)
F Tipo Permiso (f)
G Mercancía (g)
H Sub Total (h)  -- en colones
I Descuento (i)  -- en colones
J Total (j)
K Costo Entrega (k)
L Total con Entrega (l)
M Tipo de Cambio (m)
N (vacío)
O ID de cotización (o)
P Numero Contacto (p)
Q Correo (q)
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
  row[15] = payload.contacto || ''; // P
  row[16] = payload.email || '';    // Q

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
    `Contacto: ${payload.contacto || ''}`,
    `Correo: ${payload.email || ''}`,
    `Origen: ${payload.origen}`,
    `Peso declarado: ${payload.peso} ${payload.unidad}`,
    `Peso facturable: ${payload.pesoFacturable} ${payload.unidadFacturable}`,
    `Tipo: ${payload.tipoPermiso}`,
    `Mercancía: ${payload.mercancia}`,
    `Subtotal: ¢${Math.round(payload.subtotalCRC)}`,
    `Descuento: ¢${Math.round(payload.discountAmountCRC)} (${(payload.discountPercent*100).toFixed(1)}%)`,
    `Costo entrega: ¢${Math.round(payload.deliveryCostCRC)}`,
    `Total (con entrega): ¢${Math.round(payload.totalWithDeliveryCRC)}`,
    `Tipo de cambio usado: ${payload.exchangeRate}`
  ].join('\n');

  await bot.sendMessage(ADMIN_TELEGRAM_ID, adminMsg);
}

/// ---------------- DESCUENTO POR PESO ----------------
function getDiscountPercentByPeso(peso) {
  if (peso >= 75) return 0.15;
  if (peso >= 50) return 0.12;
  if (peso >= 35) return 0.10;
  if (peso >= 25) return 0.07;
  if (peso >= 15) return 0.05;
  return 0.00;
}

/// ---------------- CÁLCULO Y RESPALDO DE COTIZACIÓN (sin email) ----------------
async function calcularYRegistrarCotizacionRespaldoBase(state) {
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

  const { origen, peso, unidad, tipoMercancia } = state;
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

  const deliveryCost = state.entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;

  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });

  return {
    id, fechaLocal, subtotalCRC, discountPercent, discountAmountCRC, totalCRC, deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate, pesoFacturable, unidadFacturable, tarifaUSD, subtotalUSD
  };
}

// Wrapper to save cotizacion, historial and notify admin. Accepts optional guest flag
async function calcularYRegistrarCotizacionRespaldoFinal(chatId, state, opts = {}) {
  const calc = await calcularYRegistrarCotizacionRespaldoBase(state);
  const id = calc.id;
  const fechaLocal = calc.fechaLocal;

  // determine cliente/contacto/email to save in sheet
  let clienteName = 'Cliente Telegram';
  let contacto = '';
  let email = '';
  if (state.client) {
    clienteName = state.client.nombre || clienteName;
    contacto = state.client.contacto || '';
    email = state.client.correo || '';
  } else if (opts.guest) {
    clienteName = state.guest_nombre || (state.nombre || 'Cliente Invitado');
    contacto = state.guest_phone || '';
    email = state.guest_email || '';
  } else if (state.nombre && state.telefono) { // from register just done
    clienteName = state.nombre;
    contacto = state.telefono;
    email = state.correo || '';
  }

  const payload = {
    id,
    fechaLocal,
    cliente: clienteName,
    contacto,
    email,
    origen: state.origen,
    peso: state.peso,
    unidad: state.unidad,
    tipoPermiso: state.tipoMercancia,
    mercancia: state.descripcion,
    subtotalCRC: calc.subtotalCRC,
    discountPercent: calc.discountPercent,
    discountAmountCRC: calc.discountAmountCRC,
    totalCRC: calc.totalCRC,
    deliveryCostCRC: calc.deliveryCostCRC,
    totalWithDeliveryCRC: calc.totalWithDeliveryCRC,
    exchangeRate: calc.exchangeRate,
    pesoFacturable: calc.pesoFacturable,
    unidadFacturable: calc.unidadFacturable
  };

  await saveCotizacionToSheetAndNotifyAdmin(payload);

  await guardarEnHistorial({
    id,
    fecha: new Date().toISOString(),
    chatId,
    email: payload.email || '',
    origen: payload.origen,
    destino: 'Costa Rica',
    tipoMercancia: payload.tipoPermiso,
    peso: payload.peso,
    unidad: payload.unidad,
    pesoFacturable: payload.pesoFacturable,
    tarifa: calc.tarifaUSD || 0,
    subtotal: calc.subtotalUSD || 0,
    discountPercent: calc.discountPercent,
    discountAmount: calc.discountAmountCRC / (calc.exchangeRate || 1),
    total: calc.totalCRC / (calc.exchangeRate || 1)
  });

  return { ...calc, id, fechaLocal, subtotalCRC: calc.subtotalCRC, discountAmountCRC: calc.discountAmountCRC, discountPercent: calc.discountPercent, totalWithDeliveryCRC: calc.totalWithDeliveryCRC, deliveryCostCRC: calc.deliveryCostCRC, exchangeRate: calc.exchangeRate, pesoFacturable: calc.pesoFacturable, unidadFacturable: calc.unidadFacturable };
}

/// ---------------- APPEND PREALERT to Datos sheet ----------------
async function appendPrealertToDatos({ tracking, cliente, origen, observaciones }) {
  const sheets = await getGoogleSheetsClient();
  // We must write to Datos: A: tracking, B: cliente, C..H empty, I observaciones (index 8)
  const row = [ tracking || '', cliente || '', '', '', '', '', '', '', observaciones || '' ];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Datos!A:I', valueInputOption: 'RAW', resource: { values: [row] } });
}

/// ---------------- INICIALIZAR SERVIDOR Y WEBHOOK ----------------
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
