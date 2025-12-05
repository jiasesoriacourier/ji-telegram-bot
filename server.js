// server.js - Bot Telegram + Google Sheets (sin GAS)
// Requisitos: npm i express node-telegram-bot-api googleapis body-parser axios
// Variables de entorno requeridas:
// - TELEGRAM_TOKEN
// - GOOGLE_CREDENTIALS  -> contenido JSON del service account (o Base64 del JSON)
// - SPREADSHEET_ID
// - ADMIN_TELEGRAM_ID (opcional)

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';
if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno (JSON o Base64)');
if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID en variables de entorno');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// ---------------- CONSTANTES Y TECLADOS ----------------
const VALID_ORIGINS = ['miami','madrid','colombia','mexico','china'];
const PREALERT_ORIGINS = { 'estados unidos':'Estados Unidos','usa':'Estados Unidos','colombia':'Colombia','españa':'España','espana':'España','china':'China','mexico':'Mexico' };

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
function volverMenuReply() {
  return { reply_markup: mainMenuKeyboard() };
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

// ---------------- GOOGLE SHEETS CLIENT ----------------
async function getGoogleSheetsClient() {
  let credsRaw = process.env.GOOGLE_CREDENTIALS;
  try {
    // permite recibir JSON directo o Base64
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
  s = s.replace(/\D+/g, '');
  if (s.startsWith('506')) s = s.slice(3); // guarda 8 dígitos si es CR
  return s;
}
function phoneMatches(sheetPhone, userPhone) {
  if (!sheetPhone || !userPhone) return false;
  const a = normalizePhone(sheetPhone);
  const b = normalizePhone(userPhone);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}
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

// ---------------- CLIENTES (BUSCAR / CREAR) ----------------
// Espera que hoja "Clientes" tenga: A:Nombre, B:Correo, C:password(optional), D:Telefono, E:, F:Direccion (ajusta si tu hoja difiere)
async function findClientByPhone(phone) {
  const p = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contactCell = row[3] || '';
    if (phoneMatches(contactCell, p)) {
      return {
        rowIndex: i+1,
        raw: row,
        nombre: row[0] || '',
        correo: row[1] || '',
        contacto: contactCell || '',
        direccion: row[5] || '',
        saldo: parseFloat(row[7]) || 0
      };
    }
  }
  return null;
}
async function findClientByEmail(email) {
  if (!email) return null;
  const e = (email||'').toString().trim().toLowerCase();
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const mail = (row[1]||'').toString().trim().toLowerCase();
    if (mail && mail === e) {
      return {
        rowIndex: i+1,
        raw: row,
        nombre: row[0] || '',
        correo: row[1] || '',
        contacto: row[3] || '',
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
    range: 'Clientes!A:H',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

// ---------------- TRACKINGS (Datos) y PREALERTA ----------------
// getTrackingsByName lee 'Datos' A:F (ajusta índice si tu hoja es distinta)
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
        comentarios: r[8] || r[2] || '',
        origen: r[3] || '',
        estado: r[4] || '',
        peso: r[5] || ''
      });
    }
  }
  return items;
}
async function appendPrealertToDatos({ tracking, clienteNombre, origenVisible, observaciones, tipoMercancia }) {
  // Columnas requeridas por ti:
  // A: Número de tracking
  // B: Cliente (nombre)
  // D: Origen (pais)
  // I: Observaciones (índice I -> columna 9)
  // Además añadiré columna C/E/F vacías para mantener estructura
  const sheets = await getGoogleSheetsClient();
  const row = [
    tracking || '',
    clienteNombre || '',
    '', // C
    origenVisible || '', // D
    '', // E
    '', // F
    '', // G
    '', // H
    ( (tipoMercancia ? `Tipo: ${tipoMercancia}. ` : '') + (observaciones||'') ) // I
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Datos!A:I',
    valueInputOption: 'RAW',
    resource: { values: [row] }
  });
}

// ---------------- PAGINADO y ENVIO TRACKING ----------------
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
  if (items.length > 20) paging.push({ text: 'Exportar', callback_data: `TRACK_EXPORT|all` });
  const inline_keyboard = inline.concat([paging]);
  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n\n${lines}`, { reply_markup: { inline_keyboard } });
  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

// ---------------- MENSAJES / COMMANDS ----------------
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

bot.onText(/\/crear_casillero/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});
bot.onText(/\/mi_casillero/, (msg) => {
  setUserState(msg.chat.id, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(msg.chat.id, 'Para verificar tu casillero, por favor escribe el *número de teléfono* con el que te registraste (ej: 88885555).', { parse_mode: 'Markdown' });
});
bot.onText(/\/consultar_tracking/, (msg) => {
  setUserState(msg.chat.id, { modo: 'CHECK_CASILLERO_PHONE' });
  bot.sendMessage(msg.chat.id, 'Escribe el número de teléfono con el que te registraste para ver tus paquetes (ej: 88885555).');
});
bot.onText(/\/saldo_pagar|\/saldo/, (msg) => {
  setUserState(msg.chat.id, { modo: 'CHECK_SALDO_PHONE' });
  bot.sendMessage(msg.chat.id, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente.');
});
bot.onText(/\/contactar/, (msg) => bot.sendMessage(msg.chat.id, 'Opciones de contacto:', { reply_markup: contactarKeyboard() }));

// cotizar - inicio flujo
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  // inicio: preguntar teléfono o correo para detectar cliente
  setUserState(chatId, { modo: 'COTIZAR_CHECK_CLIENT' });
  bot.sendMessage(chatId, 'Para comenzar, escribe tu *número de teléfono* (88885555) o *correo* con el que estás registrado. Si no estás registrado escribe NO para cotizar sin registro.', { parse_mode: 'Markdown' });
});

// prealertar - flujo
bot.onText(/\/prealertar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'PREALERT_TRACKING' });
  bot.sendMessage(chatId, 'Vamos a prealertar un tracking. Indica el *Número de tracking* (ej: 1Z...):', { parse_mode: 'Markdown' });
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
    if (data.startsWith('CONTACT|')) {
      const t = data.split('|')[1];
      if (t === 'email') return bot.sendMessage(chatId, 'Escribe a: info@jiasesoria.com', volverMenuReply());
      if (t === 'wa') return bot.sendMessage(chatId, 'WhatsApp: https://wa.me/50663939073', volverMenuReply());
      if (t === 'tg') return bot.sendMessage(chatId, 'Telegram: https://t.me/JICourier_bot', volverMenuReply());
    }
  } catch (err) {
    console.error('Error callback_query:', err);
    bot.sendMessage(chatId, 'Error procesando la opción. Intenta nuevamente.', volverMenuReply());
  }
});

// ---------------- MENSAJE LIBRE (flujo) ----------------
bot.on('message', async (msg) => {
  try {
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

    // ---------- CHECK CASILLERO / TRACKINGS ----------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      if (!client) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', volverMenuReply());
      }
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.', volverMenuReply());
      }
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // ---------- CHECK SALDO ----------
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.', volverMenuReply());
      return bot.sendMessage(chatId, `💳 Saldo pendiente: ¢${Math.round(client.saldo || 0)}`, volverMenuReply());
    }

    // ---------- PREALERT FLOW ----------
    if (state.modo === 'PREALERT_TRACKING') {
      state.tracking = text;
      state.modo = 'PREALERT_CONTACT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *número de teléfono* (88885555) o *correo* con el que deseas asociar este tracking (para vincular al cliente). Si no quieres vincular, responde "NO".', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_CONTACT') {
      const contact = text.trim().toLowerCase();
      if (contact === 'no') {
        state.client = { nombre: 'Cliente no registrado', telefono: '', correo: '' };
        state.modo = 'PREALERT_ORIGIN';
        setUserState(chatId, state);
        const kb = { keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
        return bot.sendMessage(chatId, 'Selecciona el origen del paquete (usa una opción):', { reply_markup: kb });
      }
      let client = null;
      if (contact.includes('@')) client = await findClientByEmail(contact);
      if (!client) client = await findClientByPhone(contact);
      if (!client) {
        state.pendingContact = contact;
        state.modo = 'PREALERT_CONTACT_NOTFOUND';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos un cliente con ese dato. ¿Deseas registrar este cliente ahora? Responde SI para registrar o NO para continuar sin registro.');
      }
      state.client = client;
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      const kb2 = { keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
      return bot.sendMessage(chatId, `Cliente vinculado: *${client.nombre}*. Selecciona el origen del paquete:`, { parse_mode: 'Markdown', reply_markup: kb2 });
    }
    if (state.modo === 'PREALERT_CONTACT_NOTFOUND') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI para registrar o NO para continuar sin registro.');
      if (['si','s'].includes(ans)) {
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
      await addClientToSheet({ nombre: state.newClient.nombre, correo: mail, contacto: state.newClient.telefono, direccion: '' });
      state.client = { nombre: state.newClient.nombre, telefono: state.newClient.telefono, correo: mail };
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      const kb = { keyboard: [['Estados Unidos','Colombia'], ['España','China'], ['Mexico','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
      return bot.sendMessage(chatId, `Cliente registrado: *${state.newClient.nombre}*. Selecciona el origen del paquete:`, { parse_mode: 'Markdown', reply_markup: kb });
    }
    if (state.modo === 'PREALERT_ORIGIN') {
      const origin = text.toLowerCase();
      const originMap = { 'estados unidos':'Estados Unidos','usa':'Estados Unidos','miami':'Estados Unidos','colombia':'Colombia','españa':'España','espana':'España','china':'China','mexico':'Mexico' };
      const resolved = originMap[origin] || (PREALERT_ORIGINS[origin] || null);
      if (!resolved && text.toLowerCase() !== 'cancelar') return bot.sendMessage(chatId, 'Origen inválido. Selecciona uno de: Estados Unidos, Colombia, España, China, Mexico (o escribe Cancelar).');
      if (text.toLowerCase() === 'cancelar') { clearUserState(chatId); return bot.sendMessage(chatId, 'Prealerta cancelada.', volverMenuReply()); }
      state.origenPrealert = resolved;
      state.modo = 'PREALERT_TIPO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía / producto* (obligatorio). Ej: Ropa, Electrónica, Perfume, Accesorios, Documentos.');
    }
    if (state.modo === 'PREALERT_TIPO') {
      const tipo = text;
      if (!tipo || tipo.length < 2) return bot.sendMessage(chatId, 'Debes indicar el tipo de mercancía (ej: Ropa, Electrónica).');
      state.tipoMercancia = tipo;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Escribe observaciones adicionales (ej: peso aprox, referencia) o escribe NO si no hay.');
    }
    if (state.modo === 'PREALERT_OBS') {
      const obs = text.toLowerCase() === 'no' ? '' : text;
      // Guardar en Datos
      const clienteNombre = (state.client && state.client.nombre) ? state.client.nombre : (state.newClient && state.newClient.nombre) ? state.newClient.nombre : 'Cliente no registrado';
      try {
        await appendPrealertToDatos({
          tracking: state.tracking,
          clienteNombre,
          origenVisible: state.origenPrealert,
          observaciones: obs,
          tipoMercancia: state.tipoMercancia
        });
        // preguntar si desea registrar otro
        setUserState(chatId, { modo: null });
        await bot.sendMessage(chatId, `✅ Prealerta registrada para *${clienteNombre}*.\nTracking: ${state.tracking}\nOrigen: ${state.origenPrealert}\nTipo: ${state.tipoMercancia}\nObs: ${obs || '-'}`, { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, '¿Deseas registrar otro tracking? Responde SI para continuar o NO para volver al menú.');
      } catch (e) {
        console.error('appendPrealertToDatos error:', e && e.message);
        setUserState(chatId, null);
        return bot.sendMessage(chatId, 'Ocurrió un error registrando la prealerta. Intenta nuevamente más tarde.', volverMenuReply());
      }
    }
    if (text.toLowerCase() === 'si' && state.modo === null) {
      // posible respuesta al "registrar otro"
      // iniciar nuevo prealert
      setUserState(chatId, { modo: 'PREALERT_TRACKING' });
      return bot.sendMessage(chatId, 'Indica el *Número de tracking* (ej: 1Z...):', { parse_mode: 'Markdown' });
    }
    if (text.toLowerCase() === 'no' && state.modo === null) {
      return bot.sendMessage(chatId, 'Perfecto, regresando al menú.', volverMenuReply());
    }

    // ---------- COTIZAR FLOW (validación de cliente y continuación) ----------
    if (state.modo === 'COTIZAR_CHECK_CLIENT') {
      const contact = text.trim();
      if (contact.toLowerCase() === 'no') {
        // cotizar sin registro -> solicitar nombre, telefono, correo obligatorios
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Estás cotizando sin registro. Escribe tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
      // intentar encontrar cliente
      let client = null;
      if (contact.includes('@')) client = await findClientByEmail(contact);
      if (!client) client = await findClientByPhone(contact);
      if (!client) {
        // NO encontrado -> preguntar registrar o cotizar sin registro
        state.pendingContact = contact;
        state.modo = 'COTIZAR_CLIENT_NOTFOUND';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese dato. ¿Deseas registrarte ahora? Responde SI para registrarte o NO para continuar sin registro.');
      }
      // cliente encontrado -> continuar flujo cotizar
      state.client = client;
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      const kb = { keyboard: [['miami','madrid'], ['colombia','mexico'], ['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
      return bot.sendMessage(chatId, `Bien ${client.nombre}. Comenzamos la cotización. Selecciona el ORIGEN:`, { reply_markup: kb });
    }
    if (state.modo === 'COTIZAR_CLIENT_NOTFOUND') {
      const ans = text.toLowerCase();
      if (!['si','s','no','n'].includes(ans)) return bot.sendMessage(chatId, 'Responde SI para registrarte o NO para continuar sin registro.');
      if (['si','s'].includes(ans)) {
        state.modo = 'COTIZAR_REGISTER_NAME';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'OK. Ingresa tu *Nombre completo* para registrarte.', { parse_mode: 'Markdown' });
      } else {
        state.modo = 'COTIZAR_UNREG_NOMBRE';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Continuando sin registro. Ingresa tu *Nombre completo* (obligatorio).', { parse_mode: 'Markdown' });
      }
    }
    if (state.modo === 'COTIZAR_REGISTER_NAME' || state.modo === 'COTIZAR_UNREG_NOMBRE') {
      const name = text;
      if (!name || name.split(/\s+/).length < 2) return bot.sendMessage(chatId, 'Ingresa tu nombre completo (mínimo 2 palabras).');
      state.nombre = name;
      state.modo = (state.modo === 'COTIZAR_REGISTER_NAME') ? 'COTIZAR_REGISTER_EMAIL' : 'COTIZAR_UNREG_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu correo (o escribe NO si no tienes).');
    }
    if (state.modo === 'COTIZAR_REGISTER_EMAIL') {
      if (text.toLowerCase() !== 'no' && !text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Ingresa nuevamente o escribe NO.');
      state.correo = (text.toLowerCase() === 'no') ? '' : text;
      state.modo = 'COTIZAR_REGISTER_PHONE';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Ingresa tu número de contacto (ej: 88885555).');
    }
    if (state.modo === 'COTIZAR_REGISTER_PHONE' || state.modo === 'COTIZAR_UNREG_PHONE') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con 7 u 8 dígitos locales (ej: 88885555).');
      state.telefono = phone;
      if (state.modo === 'COTIZAR_REGISTER_PHONE') {
        // registrar cliente
        await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: '' });
        state.client = { nombre: state.nombre, correo: state.correo, telefono: state.telefono };
      }
      state.modo = 'COTIZAR_ORIGEN';
      setUserState(chatId, state);
      const kb = { keyboard: [['miami','madrid'], ['colombia','mexico'], ['china','Cancelar']], resize_keyboard: true, one_time_keyboard: true };
      return bot.sendMessage(chatId, 'Perfecto. Selecciona el ORIGEN (miami, madrid, colombia, mexico, china):', { reply_markup: kb });
    }

    // ORIGEN seleccionado (validación)
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
      // clasificación (puedes mantener tu función classifyProduct si la tienes)
      // simple check de prohibidos (dejé fuera lista por brevedad)
      state.tipoMercancia = 'General';
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
        state.modo = 'COTIZAR_DELIVERY_METHOD';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, '¿El envío fuera del GAM será por "Encomienda" o "Correos de C.R"? Escribe Encomienda o Correos.');
      } else {
        state.modo = 'COTIZAR_EMAIL_OR_CLIENT';
        setUserState(chatId, state);
        return bot.sendMessage(chatId, 'Procesando cotización... (esto puede tardar unos segundos).');
      }
    }
    if (state.modo === 'COTIZAR_DELIVERY_METHOD') {
      const m = text.toLowerCase();
      if (!['encomienda','correos','correos de c.r','correos de cr','correos de cr.'].includes(m) && m !== 'correos') return bot.sendMessage(chatId, 'Responde Encomienda o Correos.');
      state.deliveryMethod = (m.includes('encomienda') ? 'Encomienda' : 'Correos de C.R');
      state.modo = 'COTIZAR_EMAIL_OR_CLIENT';
      setUserState(chatId, state);
      await bot.sendMessage(chatId, 'Procesando cotización y guardando respaldo, por favor espera un momento...');
      // continuar abajo hacia cálculo y guardado
    }
    if (state.modo === 'COTIZAR_EMAIL_OR_CLIENT') {
      // state may contain client or unregistered info
      try {
        const cotizacion = await calcularYRegistrarCotizacionRespaldo(chatId, state);
        clearUserState(chatId);
        const fechaLocal = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
        const msgResp = `✅ Cotización generada\nID: ${cotizacion.id}\nFecha: ${fechaLocal}\nOrigen: ${state.origen}\nPeso facturable: ${cotizacion.pesoFacturable} ${cotizacion.unidadFacturable}\nSubtotal: ¢${Math.round(cotizacion.subtotalCRC)}\nDescuento: ¢${Math.round(cotizacion.discountAmountCRC)}\nCosto entrega: ¢${Math.round(cotizacion.deliveryCostCRC)}\nTotal (con entrega): ¢${Math.round(cotizacion.totalWithDeliveryCRC)}\n(Tipo de cambio usado: ${cotizacion.exchangeRate})`;
        await bot.sendMessage(chatId, msgResp, volverMenuReply());
        return;
      } catch (err) {
        console.error('Error calculando cotizacion:', err && err.message);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error procesando la cotización. Intenta nuevamente más tarde.', volverMenuReply());
      }
    }

    // Si llegamos aquí, no hay flujo activo
  } catch (err) {
    console.error('Error en message handler:', err && err.message);
  }
});

// ---------------- LECTURA DE TARIFAS / SAVE COTIZACIONES ----------------
// Lee tu hoja Tarifas e implementa el guardado en Cotizaciones A..Q
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

/*
Cotizaciones A..Q mapping:
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

// ---------------- CALCULO Y REGISTRO DE COTIZACION ----------------
async function calcularYRegistrarCotizacionRespaldo(chatId, state) {
  const tarifas = await leerTarifas();
  const exchangeRate = tarifas.j.exchangeRate || 1;
  const deliveryCostCRC = tarifas.j.deliveryCRC || 0;
  const { origen, peso, unidad, tipoMercancia = 'General', descripcion = '' } = state;
  let tarifaUSD = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotalUSD = 0;
  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = (origen || '').toLowerCase();

  if (origenLower === 'colombia') {
    tarifaUSD = tarifas.colombia.conPermiso || tarifas.colombia.sinPermiso;
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
    tarifaUSD = tarifas.miami.conPermiso || tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotalUSD = tarifaUSD * pesoFacturable;
  } else if (origenLower === 'madrid' || origenLower === 'espana') {
    tarifaUSD = tarifas.espana.conPermiso || tarifas.espana.sinPermiso;
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

  const clienteName = (state.client && state.client.nombre) ? state.client.nombre : (state.nombre || 'Cliente Telegram');
  const contacto = (state.client && state.client.telefono) ? state.client.telefono : (state.telefono || '');
  const email = (state.client && state.client.correo) ? state.client.correo : (state.correo || '');

  const payload = {
    id, fechaLocal, cliente: clienteName, origen, peso, unidad,
    tipoPermiso: tipoMercancia,
    mercancia: (descripcion || '') + (state.deliveryMethod ? `\nMétodo envío: ${state.deliveryMethod}` : ''),
    subtotalCRC, discountPercent, discountAmountCRC, totalCRC,
    deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate,
    pesoFacturable, unidadFacturable, contacto, email
  };

  // Guardar y notificar
  await saveCotizacionToSheetAndNotifyAdmin(payload);
  await guardarEnHistorial({
    id, fecha: new Date().toISOString(), chatId, email, origen, destino: 'Costa Rica',
    tipoMercancia, peso, unidad, pesoFacturable, tarifa: tarifaUSD, subtotal: subtotalUSD,
    discountPercent, discountAmount: discountAmountCRC / (exchangeRate || 1), total: totalCRC / (exchangeRate || 1)
  });

  return {
    id, subtotalCRC, discountPercent, discountAmountCRC, totalCRC,
    deliveryCostCRC: deliveryCost, totalWithDeliveryCRC, exchangeRate,
    pesoFacturable, unidadFacturable
  };
}

// ---------------- GUARDAR EN HISTORIAL ----------------
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
    console.error('Error configurando webhook (setWebHook):', err && err.message);
  }
});
