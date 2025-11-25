// server.js - Bot Telegram + Google Sheets (centralizado, sin correos ni PDFs)
// Dependencias: npm i express node-telegram-bot-api googleapis
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - GOOGLE_CREDENTIALS (JSON o base64)
// - SPREADSHEET_ID (opcional, está por defecto si no la pasas)
// Admin Telegram ID para recibir respaldo de cotizaciones: 7826072133

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ---------------- CONFIG ----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133'; // string o número

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno (JSON o Base64)');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

// estado por usuario
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// ---------------- LISTAS Y CONSTANTES ----------------
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

const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china']; // validación de origen

// ---------------- GOOGLE SHEETS CLIENT ----------------
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS;
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

// ---------------- UTILIDADES ----------------
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

// Normaliza teléfono a formato simple (solo dígitos; si inicia con 506 se quita el prefijo)
// Resultado: string de dígitos sin prefijo + ni 00; ejemplo: '+50688885555' -> '88885555'
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  // eliminar todo lo que no sea dígito
  s = s.replace(/\D+/g, '');
  // si comienza con '506' (Costa Rica) removerlo para almacenar formato simple
  if (s.startsWith('506')) s = s.slice(3);
  return s;
}

// comparador flexible: true si los dos números coinciden (compara sin prefijos)
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  // match endsWith to allow country prefixes in sheet
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

// ---------------- LECTURA DE DIRECCIONES ----------------
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

// ---------------- TECLADOS ----------------
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo', '/contactar']
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
function contactarKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Correo: info@jiasesoria.com', callback_data: 'CONTACT|email' }],
      [{ text: 'WhatsApp', callback_data: 'CONTACT|wa' }],
      [{ text: 'Telegram', callback_data: 'CONTACT|tg' }]
    ]
  };
}

// ---------------- CLASIFICACIÓN ----------------
function classifyProduct(obj) {
  const text = (obj.descripcion || '').toLowerCase();
  const categoriaSeleccionada = (obj.categoriaSeleccionada || '').toLowerCase();
  const origen = (obj.origen || '').toLowerCase();

  for (const w of MERCANCIA_PROHIBIDA) {
    if (text.includes(w)) return { tipo: 'Prohibida', tags: [w] };
  }

  if (categoriaSeleccionada.includes('réplica') || categoriaSeleccionada.includes('replica')) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['replica'] } : { tipo: 'General', tags: ['replica'] };
  }

  const foundSpecial = [];
  for (const w of MERCANCIA_ESPECIAL) {
    if (text.includes(w)) foundSpecial.push(w);
  }
  if (foundSpecial.length) return { tipo: 'Especial', tags: foundSpecial };

  for (const b of KNOWN_BRANDS) {
    if (text.includes(b)) {
      return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
    }
  }

  return { tipo: 'General', tags: [] };
}

// ---------------- SHEETS: Buscar cliente / Añadir cliente ----------------
// Clientes sheet structure expected: A:Nombre, B:Correo, C:unused, D:Contacto, E:F unused, G:Direccion, H:Pendiente
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contactCell = row[3] || ''; // columna D index 3
    if (phoneMatches(contactCell, normalized)) {
      return {
        rowIndex: i+1,
        raw: row,
        nombre: row[0] || '',
        correo: row[1] || '',
        contacto: contactCell || '',
        direccion: row[6] || '',
        saldo: parseFloat(row[7]) || 0 // columna H index 7 (pendiente) -> en colones
      };
    }
  }
  return null;
}

async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  // filas A..H (indices 0..7): A nombre, B correo, C '', D contacto, E '', F '', G direccion, H saldo(0)
  const values = [[ nombre || '', correo || '', '', contacto || '', '', '', direccion || '', 0 ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Clientes!A:H',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

// ---------------- TRACKINGS (desde Datos tab) ----------------
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

// ---------------- TRACKING PAGINADO ----------------
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

// ---------------- MENSAJES / COMMANDS ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() });
});

// Crear casillero - inicia flujo
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero - pide teléfono y devuelve tracking (si existe)
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Para verificar tu casillero, por favor escribe el *número de teléfono* con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});

// consultar_tracking (igual que mi_casillero pero con otra etiqueta)
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
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

// cotizar - inicio flujo (ahora con teclado de orígenes válidos)
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_ORIGEN' });
  // usar teclado simple con orígenes
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

// callbacks inline (categoría, casillero, contactos, tracking pages)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    if (data.startsWith('CATEGORIA|')) {
      const categoria = data.split('|')[1] || '';
      const state = getUserState(chatId) || {};
      state.categoriaSeleccionada = categoria;
      state.modo = 'COTIZAR_DESCRIPCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto.`, { parse_mode: 'Markdown' });
    }
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      if (pais === 'colombia') {
        return bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: { inline_keyboard: [[{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],[{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]] } });
      } else {
        const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
        const dire = await getDirecciones(nombre);
        let direccion = 'No disponible';
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid') direccion = dire.espana || dire.miami;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        const nombres = { miami:'Miami', madrid:'Madrid', mexico:'Ciudad de México', china:'China', colombia:'Colombia' };
        return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
      }
    }
    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDirecciones(nombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('CONTACT|')) {
      const t = data.split('|')[1];
      if (t === 'email') return bot.sendMessage(chatId, 'Escribe a: info@jiasesoria.com');
      if (t === 'wa') return bot.sendMessage(chatId, 'WhatsApp: https://wa.me/50663939073');
      if (t === 'tg') return bot.sendMessage(chatId, 'Telegram: https://web.telegram.org/a/#50663939073');
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
      // crear texto simple y enviar al admin como respaldo (evitamos PDF)
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

// ---------------- MENSAJE LIBRE (flujo: registro, cotizar, consultas) ----------------
bot.on('message', async (msg) => {
  try {
    // No procesamos comandos aquí (los procesa onText)
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // --- CREAR CASILLERO ---
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
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 o más dígitos locales (ej: 88885555).');
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
      return bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
    }

    // --- CHECK CASILLERO (mi_casillero & consultar_tracking) ---
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      if (!client) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      }
      // fetch trackings
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.');
      }
      // enviar paginado
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // --- CHECK SALDO ---
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      // saldo en colones (columna H)
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${(client.saldo || 0).toFixed(0)}`); // entero colones
    }

    // --- COTIZAR FLOW ---
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
      state.modo = 'COTIZAR_GAM';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿La entrega es dentro del GAM? Responde: SI o NO (el cliente debe indicar manualmente).');
    }

    if (state.modo === 'COTIZAR_GAM') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde con "SI" o "NO" (entrega dentro del GAM).');
      state.entregaGAM = ['si','s'].includes(ans);
      state.modo = 'COTIZAR_EMAIL_OR_CLIENT';
      setUserState(chatId, state);
      // pedir correo (opcional) o preguntar si ya está registrado? Vamos a pedir correo para enviarlo en chat (en el mismo chat se mostrará)
      return bot.sendMessage(chatId, 'Ingresa tu correo (opcional) para recibir la cotización por correo si lo deseas, de lo contrario responde "NO".');
    }

    if (state.modo === 'COTIZAR_EMAIL_OR_CLIENT') {
      // si usuario escribe "NO" se omite correo
      const emailText = text.toLowerCase();
      if (emailText === 'no') state.email = null;
      else state.email = text; // lo guardamos aunque no usaremos correo (por ahora campo informativo)
      // mostramos mensaje de "procesando / enviando respaldo"
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      // calcular y registrar (guardado en Sheets y reenvío al admin)
      try {
        const cotizacion = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);

        // mostrar resultados al cliente (en el chat)
        const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const msgResp = `✅ Cotización generada\nID: ${cotizacion.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cotizacion.pesoFacturable} ${cotizacion.unidadFacturable}\nSubtotal: ¢${cotizacion.subtotalCRC.toFixed(0)}\nDescuento: ¢${cotizacion.discountAmountCRC.toFixed(0)} (${(cotizacion.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${cotizacion.deliveryCostCRC.toFixed(0)}\nTotal (con entrega): ¢${cotizacion.totalWithDeliveryCRC.toFixed(0)}\n(Tipo de cambio usado: ${cotizacion.exchangeRate})`;

        await bot.sendMessage(chatId, msgResp);
        return;
      } catch (err) {
        console.error('Error en calcularYRegistrarCotizacionRespaldo:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.');
      }
    }

    // Si llegamos aquí, no hay flujo activo
  } catch (err) {
    console.error('Error en message handler:', err);
  }
});

// ---------------- LECTURA DE TARIFAS ----------------
// lee celdas B2:B15 y J1..J3 para delivery + tipo de cambio
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  // leemos la columna B2:B15 (índices conocidos)
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
  const values = (res.data.values || []).map(r => r[0]);
  const val = idx => parseFloat(values[idx]) || 0;

  // leer J1..J3 (entrega y tipo de cambio - la hoja debe tener J1=delivery en colones, J3=tipo de cambio)
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

// ---------------- GUARDAR EN HISTORIAL (igual) ----------------
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

// ---------------- GUARDAR COTIZACIÓN EN HOJA "Cotizaciones" Y REENVIAR AL ADMIN ----------------
/*
Cotizaciones columns que pediste:
A Fecha Cot (a)
B Cliente (b)
C Origen (c)
D Peso (d)
E Unidad (e)
F Tipo Permiso (f) -> general o especial
G Mercancía (g)
H Sub Total (h)  -- en colones
I Descuento (i)  -- en colones
J Total (j)      -- subtotal - descuento (colones)
K Costo Entrega (k) -- colones
L Total con Entrega (l) -- colones
M Tipo de Cambio (m)
N (vacío)
O ID de cotización (o)  <-- columna O (índice 14)
*/
async function saveCotizacionToSheetAndNotifyAdmin(payload) {
  const sheets = await getGoogleSheetsClient();
  // construir fila con 15 columnas (A..O)
  const row = new Array(15).fill('');
  row[0] = payload.fechaLocal || ''; // A
  row[1] = payload.cliente || ''; // B
  row[2] = payload.origen || ''; // C
  row[3] = payload.peso || ''; // D
  row[4] = payload.unidad || ''; // E
  row[5] = payload.tipoPermiso || ''; // F
  row[6] = payload.mercancia || ''; // G
  row[7] = Math.round(payload.subtotalCRC || 0); // H
  row[8] = Math.round(payload.discountAmountCRC || 0); // I
  row[9] = Math.round(payload.totalCRC || 0); // J
  row[10] = Math.round(payload.deliveryCostCRC || 0); // K
  row[11] = Math.round(payload.totalWithDeliveryCRC || 0); // L
  row[12] = payload.exchangeRate || ''; // M
  row[13] = ''; // N
  row[14] = payload.id || ''; // O

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cotizaciones!A:O',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });

  // preparar mensaje para admin (texto legible)
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
    `Tipo de cambio usado: ${payload.exchangeRate}`
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

// ---------------- CÁLCULO Y RESPALDO DE COTIZACIÓN (sin email, con guardado en sheet y notificación admin) ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  // state contiene: origen, peso, unidad, tipoMercancia, descripcion, entregaGAM (bool), email (opcional), categoriaSeleccionada
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1; // tipo de cambio (USD -> CRC)
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0; // en colones

  const { origen, peso, unidad, tipoMercancia, descripcion, entregaGAM } = state;
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

  // Convertir a colones
  const subtotalCRC = subtotalUSD * exchangeRate;

  // Descuento por peso (usar pesoFacturable en su unidad)
  const discountPercent = getDiscountPercentByPeso(pesoFacturable);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;

  // Costo entrega: si dentro GAM cobrar J1 (colones), si fuera GAM no cobrar y agregar observación
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;

  // ID y fecha local (Costa Rica)
  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });

  // guardar en Historial (opcional) y en "Cotizaciones" y notificar al admin
  const payload = {
    id,
    fechaLocal,
    cliente: state.nombre || state.correo || 'Cliente Telegram',
    origen,
    peso: state.peso,
    unidad: state.unidad,
    tipoPermiso: state.tipoMercancia,
    mercancia: state.descripcion,
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

  // Guardar en hoja "Cotizaciones"
  await saveCotizacionToSheetAndNotifyAdmin({
    ...payload,
    subtotalCRC: subtotalCRC,
    discountAmountCRC: discountAmountCRC,
    totalCRC: totalCRC,
    totalWithDeliveryCRC: totalWithDeliveryCRC,
    exchangeRate
  });

  // Guardar en Historial para rastreo
  await guardarEnHistorial({
    id,
    fecha: new Date().toISOString(),
    chatId,
    email: state.email || '',
    origen,
    destino: 'Costa Rica',
    tipoMercancia: state.tipoMercancia,
    peso: state.peso,
    unidad: state.unidad,
    pesoFacturable,
    tarifa: tarifaUSD,
    subtotal: subtotalUSD,
    discountPercent,
    discountAmount: discountAmountCRC / exchangeRate, // en USD equivalente (opcional)
    total: totalCRC / exchangeRate // en USD equivalente (opcional)
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
