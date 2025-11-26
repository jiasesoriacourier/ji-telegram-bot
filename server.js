// server.js - Bot Telegram + Google Sheets (completo, listo para Render)
// Dependencias: npm i express node-telegram-bot-api googleapis
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - GOOGLE_CREDENTIALS (JSON o base64)
// - SPREADSHEET_ID (opcional)
// Admin Telegram ID para recibir respaldo de cotizaciones: 7826072133 (o setea ADMIN_TELEGRAM_ID)

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ---------------- CONFIG ----------------
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

// estado por usuario
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// ---------------- CONSTANTES / LISTAS ----------------
const MERCANCIA_ESPECIAL = [ /* ... */ "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje","medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas","alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante","lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula" ];
const MERCANCIA_PROHIBIDA = [ /* ... */ "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd","arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso","oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros" ];
const KNOWN_BRANDS = [ /* ... */ "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier","bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret" ];

const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china'];

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

// ---------------- DIRECCIONES ----------------
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
      ['/prealertar', '/saldo'],
      ['/contactar', '/menu']
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
      [{ text: '🇺🇸 Estados Unidos', callback_data: 'CASILLERO|miami' }],
      [{ text: '🇪🇸 España', callback_data: 'CASILLERO|madrid' }],
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
function volverMenuKeyboard() {
  return { reply_markup: { keyboard: [['/menu']], resize_keyboard: true, one_time_keyboard: true } };
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
  for (const w of MERCANCIA_ESPECIAL) if (text.includes(w)) foundSpecial.push(w);
  if (foundSpecial.length) return { tipo: 'Especial', tags: foundSpecial };
  for (const b of KNOWN_BRANDS) if (text.includes(b)) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
  }
  return { tipo: 'General', tags: [] };
}

// ---------------- SHEETS: Buscar cliente / Añadir cliente ----------------
// Espera hoja Clientes: A:Nombre, B:Correo, C:unused, D:Contacto, G:Direccion, H:Saldo (colones)
async function findClientByPhoneOrEmail(input) {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  const normalizedInputPhone = normalizePhone(input || '');
  const inputLower = (input || '').toString().toLowerCase().trim();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0] || '';
    const correo = (row[1] || '').toString().toLowerCase();
    const contacto = row[3] || '';
    if (correo && correo === inputLower) {
      return { rowIndex: i+1, raw: row, nombre: name, correo: row[1] || '', contacto: contacto, direccion: row[6] || '', saldo: parseFloat(row[7]) || 0 };
    }
    if (contacto && phoneMatches(contacto, normalizedInputPhone)) {
      return { rowIndex: i+1, raw: row, nombre: name, correo: row[1] || '', contacto: contacto, direccion: row[6] || '', saldo: parseFloat(row[7]) || 0 };
    }
  }
  return null;
}

async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
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

// ---------------- PAGINADO y visualización de trackings ----------------
const TRACKS_PER_PAGE = 5;
async function sendTrackingList(chatId, items, page = 1) {
  if (!items || items.length === 0) return bot.sendMessage(chatId, 'No se encontraron paquetes para tu casillero.', volverMenuKeyboard());
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
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

// Crear casillero - inicia flujo
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre y 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero - pide teléfono y devuelve DIRECCIONES de casillero (no trackings)
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Para ver las direcciones de casillero, por favor escribe el *número de teléfono* o correo con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});

// consultar_tracking - pide teléfono y devuelve trackings
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_TRACKING_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono o correo con el que te registraste para ver tus paquetes (ej: 88885555).');
});

// prealertar (nuevo) - iniciar flujo prealerta tracking
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_TRACKING' });
  bot.sendMessage(chatId, 'Prealerta: Ingresa el *número de tracking* que deseas registrar.', { parse_mode: 'Markdown' });
});

// saldo pendiente
bot.onText(/\/saldo/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono o correo con el que te registraste para verificar tu saldo pendiente.');
});

// contactar
bot.onText(/\/contactar/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Opciones de contacto:', { reply_markup: contactarKeyboard() });
});

// cotizar - inicio flujo: primero verificar registro (telefono o correo) o NO
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_CHECK_CLIENT' });
  bot.sendMessage(chatId, 'Para comenzar, escribe tu *número de teléfono* o *correo* si estás registrado. Si NO estás registrado responde "NO" (sin comillas).', { parse_mode: 'Markdown' });
});

// ---------------- CALLBACKS (categoría, casillero, contactos, tracking pages) ----------------
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
      return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (breve).`, { parse_mode: 'Markdown' });
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
        const nombres = { miami:'Estados Unidos (Miami)', madrid:'España (Madrid)', mexico:'México', china:'China', colombia:'Colombia' };
        return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
      }
    }
    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDirecciones(nombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
    }

    if (data.startsWith('CONTACT|')) {
      const t = data.split('|')[1];
      if (t === 'email') return bot.sendMessage(chatId, 'Escribe a: info@jiasesoria.com', volverMenuKeyboard());
      if (t === 'wa') return bot.sendMessage(chatId, 'WhatsApp: https://wa.me/50663939073', volverMenuKeyboard());
      if (t === 'tg') return bot.sendMessage(chatId, 'Telegram: https://web.telegram.org/a/#50663939073', volverMenuKeyboard());
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
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado o expiró la lista. Vuelve a consultar.', volverMenuKeyboard());
      const text = `📦 *Tracking:* ${item.tracking}\n*Origen:* ${item.origen}\n*Estado:* ${item.estado}\n*Peso:* ${item.peso}\n*Comentarios:* ${item.comentarios || '-'}`;
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
    }
    if (data.startsWith('TRACK_EXPORT|')) {
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      if (!items.length) return bot.sendMessage(chatId, 'No hay paquetes para exportar.', volverMenuKeyboard());
      let txt = `Respaldo de trackings (${items.length}):\n`;
      items.forEach((it,i)=> { txt += `\n${i+1}. ${it.tracking} — ${it.origen} — ${it.estado} — ${it.peso}\nComentarios: ${it.comentarios||'-'}\n`; });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, txt);
      return bot.sendMessage(chatId, 'Listado enviado como respaldo al administrador.', volverMenuKeyboard());
    }

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.', volverMenuKeyboard());
  }
});

// ---------------- MENSAJES LIBRES (todos los flujos) ----------------
bot.on('message', async (msg) => {
  try {
    // evitar procesar comandos aquí
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // ---------- CREAR CASILLERO ----------
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
      return bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
    }

    // ---------- MI_CASILLERO: mostrar direcciones ----------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const input = text;
      const client = await findClientByPhoneOrEmail(input);
      clearUserState(chatId);
      if (!client) {
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número o correo. Usa /crear_casillero para registrarte o intenta nuevamente.', volverMenuKeyboard());
      }
      // mostrar teclado con países de casillero, recordando nombre del cliente para sustituir en direcciones
      setUserState(chatId, { modo: 'SHOW_CASILLERO', clienteNombre: client.nombre });
      return bot.sendMessage(chatId, `Hola *${client.nombre}*. Selecciona el país de tu casillero:`, { parse_mode: 'Markdown', reply_markup: casilleroPaisesKeyboard() });
    }

    // ---------- CONSULTAR_TRACKING: mostrar trackings ----------
    if (state.modo === 'CHECK_TRACKING_PHONE') {
      const input = text;
      const client = await findClientByPhoneOrEmail(input);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número o correo. Usa /crear_casillero para registrarte.', volverMenuKeyboard());
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.', volverMenuKeyboard());
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // ---------- CHECK SALDO ----------
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const input = text;
      const client = await findClientByPhoneOrEmail(input);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número o correo. Usa /crear_casillero para registrarte.', volverMenuKeyboard());
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${Math.round(client.saldo || 0)}`, volverMenuKeyboard());
    }

    // ---------- PREALERT FLOW ----------
    if (state.modo === 'PREALERT_TRACKING') {
      state.pre_tracking = text;
      state.modo = 'PREALERT_CONTACT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿Con qué número de teléfono o correo deseas registrar este tracking? (escribe o responde NO si no estás registrado).');
    }
    if (state.modo === 'PREALERT_CONTACT') {
      const input = text;
      const client = await findClientByPhoneOrEmail(input);
      if (client) {
        state.pre_cliente = client.nombre;
        state.pre_contacto = client.contacto || '';
        state.pre_correo = client.correo || '';
      } else if (input.toLowerCase() === 'no') {
        state.pre_cliente = 'Cliente Telegram';
        state.pre_contacto = '';
        state.pre_correo = '';
      } else {
        // treat as manual contact, save as contacto field
        state.pre_cliente = 'Cliente (sin registro)';
        state.pre_contacto = input;
        state.pre_correo = '';
      }
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del envío (escribe una opción): Estados Unidos, Colombia, España, China, Mexico');
    }
    if (state.modo === 'PREALERT_ORIGIN') {
      const oRaw = text.toLowerCase();
      // normalize to keys used in sheet
      let origen = '';
      if (oRaw.includes('estados') || oRaw.includes('miami') || oRaw.includes('usa') || oRaw.includes('unidos')) origen = 'Estados Unidos';
      else if (oRaw.includes('colombia')) origen = 'Colombia';
      else if (oRaw.includes('espa') || oRaw.includes('madrid')) origen = 'España';
      else if (oRaw.includes('china')) origen = 'China';
      else if (oRaw.includes('mex')) origen = 'Mexico';
      else return bot.sendMessage(chatId, 'Origen inválido. Escribe: Estados Unidos, Colombia, España, China o Mexico');
      state.pre_origen = origen;
      state.modo = 'PREALERT_MERCANCIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía/producto* (obligatorio). Ej: Ropa, Electrónicos, Perfume, etc.', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_MERCANCIA') {
      if (!text || text.length < 2) return bot.sendMessage(chatId, 'Es obligatorio indicar el tipo de mercancía/producto. Intenta nuevamente.');
      state.pre_mercancia = text;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Agrega *observaciones* (opcional). Si no hay, responde "NO".', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_OBS') {
      state.pre_observaciones = (text.toLowerCase() === 'no') ? '' : text;
      // Guardar en "Datos": A tracking, B cliente, C origen, I observaciones (col I index 8)
      try {
        const sheets = await getGoogleSheetsClient();
        const values = [[ state.pre_tracking || '', state.pre_cliente || '', state.pre_origen || '', '', '', '', '', '', state.pre_observaciones || '' ]];
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Datos!A:I',
          valueInputOption: 'RAW',
          resource: { values }
        });
        // notify admin with summary
        const adminTxt = `📥 Nueva prealerta\nTracking: ${state.pre_tracking}\nCliente: ${state.pre_cliente}\nContacto: ${state.pre_contacto || '-'}\nCorreo: ${state.pre_correo || '-'}\nOrigen: ${state.pre_origen}\nMercancía: ${state.pre_mercancia}\nObservaciones: ${state.pre_observaciones || '-'}`;
        await bot.sendMessage(ADMIN_TELEGRAM_ID, adminTxt);
        // clear and offer to add another
        setUserState(chatId, {});
        await bot.sendMessage(chatId, `✅ Prealerta registrada correctamente.\n¿Deseas registrar otro tracking? Responde SI o NO.`, volverMenuKeyboard());
        // set quick state to catch yes/no
        setUserState(chatId, { modo: 'PREALERT_DONE' });
        return;
      } catch (err) {
        console.error('Error guardando prealerta:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error guardando la prealerta. Intenta nuevamente más tarde.', volverMenuKeyboard());
      }
    }
    if (state.modo === 'PREALERT_DONE') {
      const ans = text.toLowerCase();
      clearUserState(chatId);
      if (['si','s','yes'].includes(ans)) {
        setUserState(chatId, { modo: 'PREALERT_TRACKING' });
        return bot.sendMessage(chatId, 'Perfecto. Ingresa el número de tracking a registrar.');
      } else {
        return bot.sendMessage(chatId, 'Ok. Volviendo al menú.', { reply_markup: mainMenuKeyboard() });
      }
    }

    // ---------- COTIZAR FLOW: verificación de cliente ----------
    if (state.modo === 'COTIZAR_CHECK_CLIENT') {
      const input = text;
      if (input.toLowerCase() === 'no') {
        // user not registered -> require name, contact, email
        state.modo = 'COTIZAR_UNREG_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Entendido. Para cotizar sin registro, por favor escribe tu *Nombre completo* (1 nombre + 1-2 apellidos).', { parse_mode: 'Markdown' });
      } else {
        // check match by phone or email
        const client = await findClientByPhoneOrEmail(input);
        if (!client) {
          // not found: ask if wants to register or continue unregistered
          state.modo = 'COTIZAR_NOTFOUND_ASK';
          state.candidateInput = input;
          setUserState(chatId, state);
          return bot.sendMessage(chatId, 'No encontramos ese número/correo. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para continuar sin registro.');
        } else {
          // matched client
          state.registered = true;
          state.clienteNombre = client.nombre;
          state.clienteContacto = client.contacto;
          state.clienteCorreo = client.correo;
          state.modo = 'COTIZAR_ORIGEN';
          setUserState(chatId, state);
          return bot.sendMessage(chatId, `Bien ${client.nombre}. Comencemos. Selecciona el ORIGEN (miami, madrid, colombia, mexico, china).`);
        }
      }
    }
    if (state.modo === 'COTIZAR_NOTFOUND_ASK') {
      const ans = text.toLowerCase();
      if (['si','s'].includes(ans)) {
        // start registration flow
        state.modo = 'CREAR_NOMBRE_FROM_COT';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Ingresa tu *Nombre completo* para registrarte.', { parse_mode: 'Markdown' });
      } else if (['no','n'].includes(ans)) {
        state.modo = 'COTIZAR_UNREG_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuemos sin registro. Ingresa tu *Nombre completo*.', { parse_mode: 'Markdown' });
      } else {
        return bot.sendMessage(chatId, 'Responde SI o NO.');
      }
    }

    // registration triggered from cotizar flow
    if (state.modo === 'CREAR_NOMBRE_FROM_COT') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa *Nombre completo* válido.');
      state.nombre = text;
      state.modo = 'CREAR_EMAIL_FROM_COT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo electrónico.');
    }
    if (state.modo === 'CREAR_EMAIL_FROM_COT') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      state.modo = 'CREAR_TELEFONO_FROM_COT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa ahora tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'CREAR_TELEFONO_FROM_COT') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido.');
      // save client
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: phone, direccion: '' });
      // fill as registered
      state.registered = true;
      state.clienteNombre = state.nombre;
      state.clienteContacto = phone;
      state.clienteCorreo = state.correo;
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Registro completado. Ahora comencemos la cotización. Selecciona ORIGEN (miami, madrid, colombia, mexico, china).`);
    }

    // unregistered cotization data collection
    if (state.modo === 'COTIZAR_UNREG_NAME') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Por favor ingresa tu nombre completo.');
      state.unreg_nombre = text;
      state.modo = 'COTIZAR_UNREG_CONTACT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREG_CONTACT') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido.');
      state.unreg_contacto = phone;
      state.modo = 'COTIZAR_UNREG_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo electrónico (obligatorio).');
    }
    if (state.modo === 'COTIZAR_UNREG_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.unreg_email = text;
      // proceed to origin
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Perfecto. Ahora selecciona ORIGEN (miami, madrid, colombia, mexico, china).');
    }

    // COTIZAR_ORIGEN - common for registered/unregistered
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
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.', volverMenuKeyboard()); }
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
      if (!state.entregaGAM) {
        // ask how will the envio be done
        state.modo = 'COTIZAR_ENVIO_FORA_GAM';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿El envío fuera del GAM será por "Encomienda" o "Correos"? Escribe Encomienda o Correos.');
      } else {
        // go next: if registered don't ask email; if unregistered we already have data
        state.modo = 'COTIZAR_FINAL_CONFIRM';
        setUserState(chatId, state);
        // proceed to compute
      }
    }

    if (state.modo === 'COTIZAR_ENVIO_FORA_GAM') {
      const opt = text.toLowerCase();
      if (!['encomienda','correos','encomienda.','correos.'].some(x=>opt.includes(x))) return bot.sendMessage(chatId, 'Responde "Encomienda" o "Correos".');
      state.envioFueraGAM = opt.includes('encomienda') ? 'Encomienda' : 'Correos';
      state.modo = 'COTIZAR_FINAL_CONFIRM';
      setUserState(chatId, state);
    }

    if (state.modo === 'COTIZAR_FINAL_CONFIRM') {
      // At this point: gather data and run calcularYRegistrarCotizacionRespaldo
      // Ensure we have client info for sheet: if registered use client; if unregistered use provided
      // If user registered earlier (state.registered true) we should have state.clienteNombre/contacto/correo
      // If not registered, we should have state.unreg_* fields.
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      try {
        const cotizacion = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);
        const fechaLocal = cotizacion.fechaLocal || new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const clienteName = state.registered ? (state.clienteNombre || 'Cliente Telegram') : (state.unreg_nombre || state.nombre || 'Cliente Telegram');
        const clienteContacto = state.registered ? (state.clienteContacto || '') : (state.unreg_contacto || '');
        const clienteCorreo = state.registered ? (state.clienteCorreo || '') : (state.unreg_email || '');
        const msgResp = `✅ Cotización generada\nID: ${cotizacion.id}\nFecha: ${fechaLocal}\nCliente: ${clienteName}\nOrigen: ${state.origen}\nPeso facturable: ${cotizacion.pesoFacturable} ${cotizacion.unidadFacturable}\nSubtotal: ¢${Math.round(cotizacion.subtotalCRC)}\nDescuento: ¢${Math.round(cotizacion.discountAmountCRC)} (${(cotizacion.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${Math.round(cotizacion.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cotizacion.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cotizacion.exchangeRate})`;
        await bot.sendMessage(chatId, msgResp, volverMenuKeyboard());
        return;
      } catch (err) {
        console.error('Error en calcularYRegistrarCotizacionRespaldo:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', volverMenuKeyboard());
      }
    }

    // Si llegamos aquí, no había flujo conocido
    // ofrecer /menu si no hay más pasos
  } catch (err) {
    console.error('Error en message handler:', err);
  }
});

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

// ---------------- GUARDAR EN HISTORIAL ----------------
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
  A..O = indices 0..14
  P (index 15) = numero Contacto
  Q (index 16) = correo
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

  const adminMsg = [
    `📣 Nueva cotización (respaldo)`,
    `ID: ${payload.id}`,
    `Fecha: ${payload.fechaLocal}`,
    `Cliente: ${payload.cliente}`,
    `Contacto: ${payload.contacto || '-'}`,
    `Correo: ${payload.email || '-'}`,
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

// ---------------- CÁLCULO Y RESPALDO DE COTIZACIÓN (sin email) ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;

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

  const subtotalCRC = subtotalUSD * exchangeRate;
  const discountPercent = getDiscountPercentByPeso(pesoFacturable);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;
  const deliveryCost = entregaGAM ? deliveryCostCRC : 0;
  const totalWithDeliveryCRC = totalCRC + deliveryCost;

  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });

  const clienteName = state.registered ? (state.clienteNombre || 'Cliente Telegram') : (state.unreg_nombre || state.nombre || 'Cliente Telegram');
  const clienteContacto = state.registered ? (state.clienteContacto || '') : (state.unreg_contacto || '');
  const clienteCorreo = state.registered ? (state.clienteCorreo || '') : (state.unreg_email || '');

  const payload = {
    id,
    fechaLocal,
    cliente: clienteName,
    contacto: clienteContacto,
    email: clienteCorreo,
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

  // Guardar en hoja "Cotizaciones" y notificar admin
  await saveCotizacionToSheetAndNotifyAdmin({
    ...payload,
    subtotalCRC,
    discountAmountCRC,
    totalCRC,
    totalWithDeliveryCRC,
    exchangeRate
  });

  // Guardar en historial (opcional)
  await guardarEnHistorial({
    id,
    fecha: new Date().toISOString(),
    chatId,
    email: clienteCorreo || '',
    origen,
    destino: 'Costa Rica',
    tipoMercancia: state.tipoMercancia,
    peso: state.peso,
    unidad: state.unidad,
    pesoFacturable,
    tarifa: tarifaUSD,
    subtotal: subtotalUSD,
    discountPercent,
    discountAmount: discountAmountCRC / (exchangeRate || 1),
    total: totalCRC / (exchangeRate || 1)
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
    unidadFacturable,
    fechaLocal
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
