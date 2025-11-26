// server.js - Bot Telegram + Google Sheets (completo)
// Dependencias: npm i express node-telegram-bot-api googleapis
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - GOOGLE_CREDENTIALS (JSON o base64)
// - SPREADSHEET_ID (opcional)

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

// ---------------- CONSTANTES ----------------
const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china'];
const PREALERT_ORIGINS = { 'estados unidos':'Estados Unidos','usa':'Estados Unidos','colombia':'Colombia','españa':'España','espana':'España','china':'China','mexico':'Mexico' };

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
function normalizePhone(p) {
  if (!p) return '';
  let s = p.toString().trim();
  s = s.replace(/\D+/g, ''); // keep digits
  if (s.startsWith('506')) s = s.slice(3); // store as local 8-digit when possible
  return s;
}
function phoneMatches(sheetPhone, userPhone) {
  if (!sheetPhone || !userPhone) return false;
  const a = normalizePhone(sheetPhone);
  const b = normalizePhone(userPhone);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

// extraer rangos tipo texto (helper para direcciones)
function extractRange(data, startRow, endRow, startCol, endCol) {
  const lines = [];
  for (let r = startRow; r <= endRow; r++) {
    if (r >= data.length) continue;
    const row = data[r] || [];
    const parts = [];
    for (let c = startCol; c <= endCol; c++) {
      const v = (row[c] || '').toString().trim();
      if (v) parts.push(v);
    }
    if (parts.length) lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

// ---------------- TECLADOS ----------------
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo_pagar', '/prealertar']
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
function volverMenuReply() {
  return {
    reply_markup: mainMenuKeyboard()
  };
}

// ---------------- LECTURA DIRECCIONES ----------------
async function getDirecciones(nombreCliente = 'Nombre de cliente') {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Direcciones!A:Z' });
  const data = res.data.values || [];
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

// ---------------- CLIENTES: buscar / agregar ----------------
// Supuesto: hoja Clientes con columnas:
// A: Nombre, B: Correo, C: contraseña (web), D: Telefono, E: (vacío), F: Direccion, G: (vacío), H: Saldo pendiente
async function findClientByPhone(phone) {
  if (!phone) return null;
  const norm = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetPhone = (row[3] || '').toString();
    if (phoneMatches(sheetPhone, norm)) {
      return {
        rowIndex: i+1,
        nombre: row[0] || '',
        correo: row[1] || '',
        telefono: sheetPhone || '',
        direccion: row[5] || '',
        saldo: parseFloat(row[7]) || 0
      };
    }
  }
  return null;
}
async function findClientByEmail(email) {
  if (!email) return null;
  const e = email.toString().trim().toLowerCase();
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetEmail = (row[1] || '').toString().trim().toLowerCase();
    if (sheetEmail && sheetEmail === e) {
      return {
        rowIndex: i+1,
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
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H', valueInputOption: 'RAW', resource: { values } });
}

// ---------------- TRACKINGS (Datos) ----------------
// obtener trackings por nombre (igual que antes)
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

// función para agregar prealerta (escribe en Datos: A tracking, B cliente, D origen, I observaciones)
async function addPrealertaToDatos({ tracking, cliente, origen, observaciones, tipoMercancia }) {
  const sheets = await getGoogleSheetsClient();
  // A..I -> indices 0..8
  const row = [];
  row[0] = tracking || '';
  row[1] = cliente || '';
  row[2] = tipoMercancia || ''; // guardamos tipo en C (comentarios/mercancía)
  row[3] = origen || '';
  // 4..7 left blank
  row[8] = observaciones || ''; // columna I (index 8)
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
}

// ---------------- TRACKING PAGINADO ----------------
const TRACKS_PER_PAGE = 5;
async function sendTrackingList(chatId, items, page = 1) {
  if (!items || items.length === 0) return bot.sendMessage(chatId, 'No se encontraron paquetes para tu casillero.', volverMenuReply());
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

// ---------------- TECLA - MENÚ / COMANDOS ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

// crear casillero
bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// mi_casillero -> muestra direcciones de casillero (no trackings)
bot.onText(/\/mi_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'MI_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Para ver las direcciones de tu casillero, por favor escribe el *número de teléfono* con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});

// consultar_tracking -> show trackings
bot.onText(/\/consultar_tracking/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(chatId, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});

// saldo_pagar (opción C solicitada)
bot.onText(/\/saldo_pagar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente (ej: 88885555).');
});

// contactar (simple)
bot.onText(/\/contactar/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Opciones de contacto:\nCorreo: info@jiasesoria.com\nWhatsApp: https://wa.me/50663939073\nTelegram: https://web.telegram.org/a/#50663939073', volverMenuReply());
});

// cotizar - nuevo flujo: primero validar cliente (por teléfono o correo)
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_CHECK' });
  bot.sendMessage(chatId, 'Para comenzar, escribe tu *número de teléfono* (ej: 88885555) o tu *correo* para verificar si estás registrado. Si no estás registrado, podrás cotizar igualmente (se pedirán datos).', { parse_mode: 'Markdown' });
});

// prealertar - nuevo comando para registrar tracking (prealerta)
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_TRACKING' });
  bot.sendMessage(chatId, 'Iniciaremos la prealerta. Escribe el *número de tracking* (ej: 1Z999...).', { parse_mode: 'Markdown' });
});

// callbacks inline (categoria, casillero, tracking pages, etc.)
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
      // For mi_casillero we used stored client in state; fallback to message from query.from
      const st = getUserState(chatId) || {};
      const nombreCliente = (st && st.client && st.client.nombre) ? st.client.nombre : (query.from && query.from.first_name ? query.from.first_name : 'Cliente');
      const dire = await getDirecciones(nombreCliente);
      let direccion = 'No disponible';
      if (pais === 'miami') direccion = dire.miami;
      else if (pais === 'madrid' || pais === 'espana') direccion = dire.espana || dire.miami;
      else if (pais === 'mexico') direccion = dire.mexico;
      else if (pais === 'china') direccion = dire.china;
      const nombres = { miami:'Estados Unidos', espana:'España', mexico:'México', china:'China', colombia:'Colombia' };
      return bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown', ...volverMenuReply() });
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
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado o expiró la lista. Vuelve a consultar.', volverMenuReply());
      const text = `📦 *Tracking:* ${item.tracking}\n*Origen:* ${item.origen}\n*Estado:* ${item.estado}\n*Peso:* ${item.peso}\n*Comentarios:* ${item.comentarios || '-'}`;
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...volverMenuReply() });
    }

    if (data.startsWith('TRACK_EXPORT|')) {
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      if (!items.length) return bot.sendMessage(chatId, 'No hay paquetes para exportar.', volverMenuReply());
      let txt = `Respaldo de trackings (${items.length}):\n`;
      items.forEach((it,i)=> { txt += `\n${i+1}. ${it.tracking} — ${it.origen} — ${it.estado} — ${it.peso}\nComentarios: ${it.comentarios||'-'}\n`; });
      await bot.sendMessage(ADMIN_TELEGRAM_ID, txt);
      return bot.sendMessage(chatId, 'Listado enviado como respaldo al administrador.', volverMenuReply());
    }

  } catch (err) {
    console.error('Error en callback_query:', err);
    bot.sendMessage(chatId, 'Ocurrió un error al procesar la opción.', volverMenuReply());
  }
});

// ---------------- MENSAJE LIBRE / FLOWS ----------------
bot.on('message', async (msg) => {
  try {
    // Ignore commands (handled elsewhere)
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // ---------- CREAR CASILLERO ----------
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
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos locales (ej: 88885555).');
      const existing = await findClientByPhone(phone);
      if (existing) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, `Ya existe un registro con ese número bajo el nombre: *${existing.nombre}*. Si es tuyo, usa /mi_casillero.`, { parse_mode: 'Markdown', ...volverMenuReply() });
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
      return bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown', ...volverMenuReply() });
    }

    // ---------- MI_CASILLERO: mostrar direcciones ----------
    if (state.modo === 'MI_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) {
        // offer registration
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', volverMenuReply());
      }
      // store client in state for use in casillero callbacks
      setUserState(chatId, { modo: null, client });
      await bot.sendMessage(chatId, `Hola *${client.nombre}*. Selecciona el país de tu casillero:`, { parse_mode: 'Markdown', reply_markup: casilleroPaisesKeyboard() });
      return;
    }

    // ---------- CONSULTAR_TRACKING: show trackings ----------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', volverMenuReply());
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.', volverMenuReply());
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // ---------- SALDO PENDIENTE (/saldo_pagar) ----------
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', volverMenuReply());
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${Math.round(client.saldo || 0)}`, volverMenuReply());
    }

    // ---------- PREALERT TRACKING ----------
    if (state.modo === 'PREALERT_TRACKING') {
      // step: expect tracking number
      state.tracking = text;
      state.modo = 'PREALERT_CONTACT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *número de teléfono* (88885555) o *correo* con el que deseas asociar este tracking (para vincular al cliente). Si no quieres vincular, responde "NO".', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_CONTACT') {
      const contact = text.toLowerCase();
      if (contact === 'no') {
        state.client = { nombre: 'Cliente no registrado', telefono: '', correo: '' };
        state.modo = 'PREALERT_ORIGIN';
        setUserState(chatId, state);
        // ask origin selection (user-friendly)
        const kb = {
          keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']],
          resize_keyboard: true,
          one_time_keyboard: true
        };
        return bot.sendMessage(chatId, 'Selecciona el origen del paquete (usa una opción):', { reply_markup: kb });
      }
      // try email then phone
      let client = null;
      if (contact.includes('@')) client = await findClientByEmail(contact);
      if (!client) client = await findClientByPhone(contact);
      if (!client) {
        // not found -> ask if continue unregistered or register
        state.pendingContact = contact;
        state.modo = 'PREALERT_CONTACT_NOTFOUND';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos un cliente con ese dato. ¿Deseas registrar este cliente ahora? Responde SI para registrar o NO para continuar sin registro.');
      }
      // found
      state.client = client;
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      const kb2 = {
        keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']],
        resize_keyboard: true,
        one_time_keyboard: true
      };
      return bot.sendMessage(chatId, `Cliente vinculado: *${client.nombre}*. Selecciona el origen del paquete:`, { parse_mode: 'Markdown', reply_markup: kb2 });
    }
    if (state.modo === 'PREALERT_CONTACT_NOTFOUND') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI para registrar o NO para continuar sin registro.');
      if (['si','s'].includes(ans)) {
        // start quick registration: ask name
        state.modo = 'PREALERT_REGISTER_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ok, registra el *Nombre completo* del cliente.', { parse_mode: 'Markdown' });
      } else {
        state.client = { nombre: 'Cliente no registrado', telefono: state.pendingContact || '', correo: '' };
        state.modo = 'PREALERT_ORIGIN';
        setUserState(chatId, state);
        const kb = { keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
        return bot.sendMessage(chatId, 'Selecciona el origen del paquete:', { reply_markup: kb });
      }
    }
    if (state.modo === 'PREALERT_REGISTER_NAME') {
      const name = text;
      state.newClient = { nombre: name, correo: '', telefono: state.pendingContact || '' };
      state.modo = 'PREALERT_REGISTER_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa el correo del cliente (o escribe NO si no tiene).');
    }
    if (state.modo === 'PREALERT_REGISTER_EMAIL') {
      if (text.toLowerCase() !== 'no' && !text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente o escribe NO.');
      const mail = text.toLowerCase() === 'no' ? '' : text;
      // register client quickly
      await addClientToSheet({ nombre: state.newClient.nombre, correo: mail, contacto: state.newClient.telefono, direccion: '' });
      state.client = { nombre: state.newClient.nombre, telefono: state.newClient.telefono, correo: mail };
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      const kb = { keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
      return bot.sendMessage(chatId, `Cliente registrado: *${state.newClient.nombre}*. Ahora selecciona el origen:`, { parse_mode: 'Markdown', reply_markup: kb });
    }
    if (state.modo === 'PREALERT_ORIGIN') {
      const originText = text.toLowerCase();
      // normalize a few possible inputs
      let origen = '';
      if (originText.includes('estados') || originText.includes('usa') || originText.includes('miami') || originText.includes('unidos')) origen = 'Estados Unidos';
      else if (originText.includes('colomb')) origen = 'Colombia';
      else if (originText.includes('espa')) origen = 'España';
      else if (originText.includes('china')) origen = 'China';
      else if (originText.includes('mex')) origen = 'Mexico';
      else return bot.sendMessage(chatId, 'Origen inválido. Selecciona una opción: Estados Unidos, Colombia, España, China o Mexico.');
      state.origenPrealert = origen;
      state.modo = 'PREALERT_TIPO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía* (obligatorio). Ej: Ropa, Electrónicos, Perfumería, etc.');
    }
    if (state.modo === 'PREALERT_TIPO') {
      if (!text || text.length < 2) return bot.sendMessage(chatId, 'Debes indicar el tipo de mercancía (ej: Ropa, Electrónicos).');
      state.tipoMercanciaPrealert = text;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Agrega observaciones adicionales (si no hay, escribe NO).');
    }
    if (state.modo === 'PREALERT_OBS') {
      const obs = text.toLowerCase() === 'no' ? '' : text;
      // compose cliente nombre
      const clienteNombre = (state.client && state.client.nombre) ? state.client.nombre : (state.newClient && state.newClient.nombre) ? state.newClient.nombre : 'Cliente no registrado';
      await addPrealertaToDatos({
        tracking: state.tracking,
        cliente: clienteNombre,
        origen: state.origenPrealert,
        observaciones: obs,
        tipoMercancia: state.tipoMercanciaPrealert
      });
      // ask if wants to add another
      setUserState(chatId, { modo: null });
      await bot.sendMessage(chatId, `✅ Prealerta registrada para *${clienteNombre}*.\nTracking: ${state.tracking}\nOrigen: ${state.origenPrealert}\nTipo: ${state.tipoMercanciaPrealert}\nObservaciones: ${obs || '-'}`, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, '¿Deseas registrar otro tracking? Responde SI para continuar o NO para volver al menú.');
      setUserState(chatId, { modo: 'PREALERT_CONTINUAR' });
      return;
    }
    if (state.modo === 'PREALERT_CONTINUAR') {
      const ans = text.toLowerCase();
      if (['si','s'].includes(ans)) {
        setUserState(chatId, { modo: 'PREALERT_TRACKING' });
        return bot.sendMessage(chatId, 'Escribe el número de tracking (ej: 1Z999...).');
      } else {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Perfecto. Volviendo al menú.', volverMenuReply());
      }
    }

    // ---------- COTIZAR FLOW (verificar cliente primero) ----------
    if (state.modo === 'COTIZAR_CHECK') {
      const contact = text;
      // check email or phone
      let client = null;
      if (contact.includes('@')) client = await findClientByEmail(contact);
      if (!client) client = await findClientByPhone(contact);
      if (client) {
        // client found -> store and continue asking origin
        state.client = client;
        state.nombreCliente = client.nombre;
        state.correoCliente = client.correo;
        state.telefonoCliente = client.telefono;
        state.modo = 'COTIZAR_ORIGEN';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, `Encontramos tu registro como *${client.nombre}*. Ahora selecciona el ORIGEN (miami, madrid, colombia, mexico, china).`, { parse_mode: 'Markdown' });
      } else {
        // not found -> ask whether register or continue unregistered
        state.pendingContactForCot = contact;
        state.modo = 'COTIZAR_NOT_FOUND';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos tu registro. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para cotizar sin registro (se pedirán Nombre, Teléfono y Correo).');
      }
    }
    if (state.modo === 'COTIZAR_NOT_FOUND') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI para registrarte o NO para continuar sin registro.');
      if (['si','s'].includes(ans)) {
        state.modo = 'CREAR_NOMBRE_FROM_COT';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. Ingresa tu *Nombre completo* para registrarte.', { parse_mode: 'Markdown' });
      } else {
        // collect mandatory name, phone, email then proceed
        state.modo = 'COTIZAR_UNREGISTERED_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
    }
    if (state.modo === 'CREAR_NOMBRE_FROM_COT') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Nombre inválido. Ingresa Nombre completo con al menos 2 palabras.');
      state.nombre = text;
      state.modo = 'CREAR_TELEFONO_FROM_COT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'CREAR_TELEFONO_FROM_COT') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos (ej: 88885555).');
      state.telefono = phone;
      state.modo = 'CREAR_CORREO_FROM_COT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (ej: ejemplo@dominio.com).');
    }
    if (state.modo === 'CREAR_CORREO_FROM_COT') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      // register client
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: '' });
      state.client = { nombre: state.nombre, correo: state.correo, telefono: state.telefono };
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Registro completado como *${state.nombre}*. Ahora selecciona el ORIGEN (miami, madrid, colombia, mexico, china).`, { parse_mode: 'Markdown' });
    }
    if (state.modo === 'COTIZAR_UNREGISTERED_NAME') {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2) return bot.sendMessage(chatId, 'Nombre inválido. Ingresa Nombre completo con al menos 2 palabras.');
      state.nombre = text;
      state.modo = 'COTIZAR_UNREGISTERED_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_UNREGISTERED_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Ingresa un número válido (ej: 88885555).');
      state.telefono = phone;
      state.modo = 'COTIZAR_UNREGISTERED_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (ej: ejemplo@dominio.com).');
    }
    if (state.modo === 'COTIZAR_UNREGISTERED_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente.');
      state.correo = text;
      // proceed to origin selection
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Gracias. Ahora selecciona el ORIGEN (miami, madrid, colombia, mexico, china).');
    }

    // flow continues: origin -> category -> description -> peso -> GAM -> envio -> finalize
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
      // classify (lightly)
      const foundProhibida = false; // keep simple or reuse classifyProduct if desired
      if (foundProhibida) { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
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
        state.modo = 'COTIZAR_ENVIO_FORA_GAM';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿El envío fuera del GAM será por Encomienda o por Correos de C.R? Responde: ENCOMIENDA o CORREOS.');
      } else {
        state.modo = 'COTIZAR_FINAL_CONFIRM';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Procesando cotización, por favor espera un momento...');
      }
    }
    if (state.modo === 'COTIZAR_ENVIO_FORA_GAM') {
      const v = text.toLowerCase();
      if (!['encomienda','correos','correos de c.r','correos de cr','correos de c.r.','correos de cr.'].some(x => v.includes(x)) && !v.includes('encom')) {
        return bot.sendMessage(chatId, 'Responde ENCOMIENDA o CORREOS (para Correos de C.R.).');
      }
      state.deliveryMethod = v.includes('encom') ? 'Encomienda' : 'Correos de C.R.';
      state.modo = 'COTIZAR_FINAL_CONFIRM';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Procesando cotización, por favor espera un momento...');
    }
    if (state.modo === 'COTIZAR_FINAL_CONFIRM') {
      // compute and register cotizacion (uses tarifas sheet)
      await bot.sendMessage(chatId, 'Calculando cotización y guardando respaldo, por favor espera...');
      try {
        const cotizacion = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);
        // prepare response: include tipo de cambio and totals in colones
        const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
        const telefonoOut = (state.client && state.client.telefono) ? state.client.telefono : (state.telefono || '');
        const correoOut = (state.client && state.client.correo) ? state.client.correo : (state.correo || '');
        const msgResp = `✅ Cotización generada\nID: ${cotizacion.id}\nFecha: ${fechaLocal}\nCliente: ${clienteName}\nOrigen: ${state.origen}\nPeso facturable: ${cotizacion.pesoFacturable} ${cotizacion.unidadFacturable}\nSubtotal: ¢${Math.round(cotizacion.subtotalCRC)}\nDescuento: ¢${Math.round(cotizacion.discountAmountCRC)} (${(cotizacion.discountPercent*100).toFixed(1)}%)\nCosto entrega: ¢${Math.round(cotizacion.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cotizacion.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cotizacion.exchangeRate})`;
        await bot.sendMessage(chatId, msgResp, volverMenuReply());
        return;
      } catch (err) {
        console.error('Error calculando cotizacion:', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', volverMenuReply());
      }
    }

    // ---------- si llegamos aquí: no flujo activo ----------
    // give a hint
    // (do nothing)
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
    jVals.deliveryCRC = parseFloat(arr[0]) || 0;
    jVals.exchangeRate = parseFloat(arr[2]) || 1;
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

// ---------------- GUARDAR COTIZACION EN SHEET "Cotizaciones" Y ENVIAR AL ADMIN ----------------
/*
A..Q columns mapping:
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
  row[13] = ''; // N
  row[14] = payload.id || '';
  row[15] = payload.contacto || ''; // P
  row[16] = payload.email || ''; // Q

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cotizaciones!A:Q',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });

  // mensaje legible para admin
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

// ---------------- DESCUENTO POR PESO ----------------
function getDiscountPercentByPeso(peso) {
  if (peso >= 75) return 0.15;
  if (peso >= 50) return 0.12;
  if (peso >= 35) return 0.10;
  if (peso >= 25) return 0.07;
  if (peso >= 15) return 0.05;
  return 0.00;
}

// ---------------- CALCULO Y REGISTRO DE COTIZACION (sin email, con guardado en sheet y notificación admin) ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  // state may contain client info (client), or unregistered fields (nombre, telefono, correo)
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

  // Convertir a colones
  const subtotalCRC = subtotalUSD * exchangeRate;

  // Descuento por peso
  const discountPercent = getDiscountPercentByPeso(pesoFacturable);
  const discountAmountCRC = subtotalCRC * discountPercent;
  const totalCRC = subtotalCRC - discountAmountCRC;

  // Delivery cost
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

  // Save in Cotizaciones sheet and notify admin
  await saveCotizacionToSheetAndNotifyAdmin(payload);

  // Save in historial (USD approx)
  await guardarEnHistorial({
    id,
    fecha: new Date().toISOString(),
    chatId,
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
