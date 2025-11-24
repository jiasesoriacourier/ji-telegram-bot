// server.js - Bot Telegram + Google Sheets (actualizado con registro, cotizar, tracking paginado, saldo)

// === DEPENDENCIAS ===
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

// === CONFIGURACIÓN ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jiasesoriacourier@gmail.com';
const ADMIN_EMAIL_PASSWORD = process.env.ADMIN_EMAIL_PASSWORD;

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno (JSON o Base64)');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
const userStates = new Map();

// --- listas (sin cambios) ---
const MERCANCIA_ESPECIAL = [ /* ...igual que antes... */ "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje","medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas","alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante","lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula"];
const MERCANCIA_PROHIBIDA = [ /* ...igual que antes... */ "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd","arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso","oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros"];
const KNOWN_BRANDS = [ /* ...igual que antes... */ "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier","bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret"];

// --- utilidades estado ---
function setUserState(chatId, state) { userStates.set(chatId, state); }
function getUserState(chatId) { return userStates.get(chatId); }
function clearUserState(chatId) { userStates.delete(chatId); }

// --- Google Sheets client ---
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

// --- helpers para rangos / extracción ---
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

// --- direcciones (igual que antes) ---
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

// --- teclados (actualizado nombres) ---
function mainMenuKeyboard() {
  return {
    keyboard: [
      ['/mi_casillero', '/crear_casillero'],
      ['/cotizar', '/consultar_tracking'],
      ['/saldo', '/banner']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}
function categoriaInlineKeyboard() { /* mismo que antes, callback_data */ 
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
      [{ text: '🇪🇸 Madrid', callback_data: 'CASILLERO|espana' }],
      [{ text: '🇨🇴 Colombia', callback_data: 'CASILLERO|colombia' }],
      [{ text: '🇲🇽 México', callback_data: 'CASILLERO|mexico' }],
      [{ text: '🇨🇳 China', callback_data: 'CASILLERO|china' }]
    ]
  };
}
function colombiaPermisoKeyboard() {
  return { inline_keyboard: [[{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],[{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]] };
}

// --- clasificación (igual) ---
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
  for (const b of KNOWN_BRANDS) if (text.includes(b)) {
    return origen === 'colombia' ? { tipo: 'Especial', tags: ['brand:'+b] } : { tipo: 'General', tags: ['brand:'+b] };
  }
  return { tipo: 'General', tags: [] };
}

// --- rutas / webhook ---
app.post(`/${TELEGRAM_TOKEN}`, (req, res) => { res.sendStatus(200); try { bot.processUpdate(req.body); } catch (err) { console.error('processUpdate error', err); } });
app.get('/', (req, res) => res.send('✅ Bot activo - J.I Asesoría & Courier'));

// --- util: normalizar teléfono (solo números, quitar espacios/guiones) ---
function normalizePhone(p) {
  if (!p) return '';
  return p.toString().replace(/[^0-9+]/g, '').replace(/^00/, '+');
}

// --- BUSCAR CLIENTE POR TELEFONO en hoja "Clientes" (colContacto = E -> index 4) ---
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I' });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contact = normalizePhone(row[4] || '');
    if (contact && contact.endsWith(normalized) || normalized.endsWith(contact)) { // match flexible (endsWith)
      return { rowIndex: i+1, raw: row, nombre: row[0] || '', correo: row[1] || '', contacto: row[4] || '', direccion: row[6] || '', saldo: parseFloat(row[8]) || 0 };
    }
  }
  return null;
}

// --- AÑADIR CLIENTE en Clientes (A: Nombre, B: Correo, E: Contacto, G: Direccion, I: saldo) ---
async function addClientToSheet({ nombre, correo, contacto, direccion }) {
  const sheets = await getGoogleSheetsClient();
  const values = [[ nombre || '', correo || '', '', '', contacto || '', '', direccion || '', '', 0 ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:I', valueInputOption: 'RAW', resource: { values } });
}

// --- OBTENER TRACKINGS POR NOMBRE desde Datos (A: tracking, B: nombre, C: comentarios, D: origen, E: estado, F: peso) ---
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

// --- PAGINACIÓN: enviar listado de trackings (5 por página) ---
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

  // inline buttons: detail per item + prev/next
  const inline = slice.map((it, idx) => [{ text: `Ver ${start+idx+1}`, callback_data: `TRACK_DETAIL|${start+idx}` }]);
  // paging buttons
  const paging = [];
  if (page > 1) paging.push({ text: '◀️ Anterior', callback_data: `TRACK_PAGE|${page-1}` });
  if (page < totalPages) paging.push({ text: 'Siguiente ▶️', callback_data: `TRACK_PAGE|${page+1}` });
  if (items.length > 20) paging.push({ text: 'Exportar PDF', callback_data: `TRACK_EXPORT|all` });

  // flatten inline keyboard: first rows: item detail buttons (one per row), final row: paging
  const inline_keyboard = inline.concat([paging]);

  await bot.sendMessage(chatId, `📦 Paquetes (${items.length}) — Página ${page}/${totalPages}\n\n${lines}`, {
    reply_markup: { inline_keyboard }
  });

  // store last listing in memory so callback can look up by index (simple approach)
  setUserState(chatId, { modo: 'TRACKING_LIST', itemsCache: items, page });
}

// --- MANEJO COMANDOS / MENÚS ---
bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  const chatId = msg.chat.id;
  const name = (msg.from && msg.from.first_name) ? msg.from.first_name : 'Cliente';
  bot.sendMessage(chatId, `Hola ${name} 👋\nUsa /menu para ver las opciones.`, { reply_markup: mainMenuKeyboard() });
});
bot.onText(/\/menu/, (msg) => bot.sendMessage(msg.chat.id, 'Menú principal:', { reply_markup: mainMenuKeyboard() }));

// --- CREAR CASILLERO: iniciar flujo ---
bot.onText(/\/crear_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  // check if already registered by asking for phone (best-effort)
  setUserState(chatId, { modo: 'CREAR_NOMBRE' });
  bot.sendMessage(chatId, 'Vamos a crear tu casillero. Primero, escribe tu *Nombre completo* (mínimo 1 nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

// --- MI CASILLERO: exige registro previo (verifica por teléfono) ---
bot.onText(/\/mi_casillero/, async (msg) => {
  const chatId = msg.chat.id;
  // We'll ask user to provide the phone to verify (unless they already have active session)
  const state = getUserState(chatId) || {};
  state.modo = 'CHECK_CASILLERO_PHONE';
  setUserState(chatId, state);
  bot.sendMessage(chatId, 'Para verificar tu casillero, por favor escribe el *número de teléfono* con el que te registraste (ej: +50688885555).', { parse_mode: 'Markdown' });
});

// --- CONSULTAR TRACKING comando ---
bot.onText(/\/consultar_tracking/, async (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: null }); // reset
  bot.sendMessage(chatId, 'Para consultar tus paquetes, escribe el número de teléfono con el que te registraste (ej: +50688885555).');
});

// --- SALDO pendiente comando (/saldo) ---
bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Por favor escribe el número de teléfono con el que te registraste para verificar tu saldo pendiente.');
  setUserState(chatId, { modo: 'CHECK_SALDO_PHONE' });
});

// --- COTIZAR: iniciar flujo (ahora no pide destino) ---
bot.onText(/\/cotizar/, (msg) => {
  const chatId = msg.chat.id;
  setUserState(chatId, { modo: 'COTIZAR_ORIGEN' });
  bot.sendMessage(chatId, 'Comenzamos la cotización. ¿Cuál es el ORIGEN? (miami, madrid, colombia, mexico, china)');
});

// banner stays same
bot.onText(/\/banner/, async (msg) => {
  try { await bot.sendPhoto(msg.chat.id, 'https://i.imgur.com/qJnTEVD.jpg'); } catch { bot.sendMessage(msg.chat.id, 'No pudimos enviar el banner.'); }
});

// --- CALLBACKS (categoría, casillero, colombia permiso, tracking pagination/detail) ---
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
      bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto.`, { parse_mode: 'Markdown' });
    }
    else if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1];
      if (pais === 'colombia') {
        bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: colombiaPermisoKeyboard() });
      } else {
        const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
        const dire = await getDirecciones(nombre);
        let direccion = 'No disponible';
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'espana') direccion = dire.espana;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        const nombres = { miami:'Miami', espana:'Madrid', mexico:'Ciudad de México', china:'China' };
        bot.sendMessage(chatId, `📍 *Dirección en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown' });
      }
    }
    else if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const nombre = (query.from && query.from.first_name) ? query.from.first_name : 'Cliente';
      const dire = await getDirecciones(nombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      bot.sendMessage(chatId, `📍 *Dirección en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown' });
    }
    else if (data.startsWith('TRACK_PAGE|')) {
      const page = parseInt(data.split('|')[1]||'1',10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      await sendTrackingList(chatId, items, page);
    }
    else if (data.startsWith('TRACK_DETAIL|')) {
      const idx = parseInt(data.split('|')[1]||'0',10);
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      const item = items[idx];
      if (!item) return bot.sendMessage(chatId, 'Elemento no encontrado o expiró la lista. Vuelve a consultar.');
      const text = `📦 *Tracking:* ${item.tracking}\n*Origen:* ${item.origen}\n*Estado:* ${item.estado}\n*Peso:* ${item.peso}\n*Comentarios:* ${item.comentarios || '-'}`;
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }
    else if (data.startsWith('TRACK_EXPORT|')) {
      // generar PDF de todos los items en cache
      const st = getUserState(chatId) || {};
      const items = st.itemsCache || [];
      if (!items.length) return bot.sendMessage(chatId, 'No hay paquetes para exportar.');
      const pdf = await generarListadoTrackingsPDF(items);
      await bot.sendDocument(chatId, pdf, {}, { filename: 'trackings.pdf', contentType: 'application/pdf' });
    }
  } catch (err) {
    console.error('Error callback_query:', err);
    bot.sendMessage(chatId, 'Error procesando la opción. Intenta nuevamente.');
  }
});

// --- mensaje libre flow: manejar crear casillero, cotizar y consultas ---
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const state = getUserState(chatId) || {};

    // ------------- CREAR CASILLERO FLOW -------------
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
      return bot.sendMessage(chatId, 'Ingresa ahora tu *número de contacto* (ej: +50688885555).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_TELEFONO') {
      const phone = normalizePhone(text);
      if (!phone || phone.length < 7) return bot.sendMessage(chatId, 'Número inválido. Intenta con formato internacional (ej: +50688885555).');
      // check existing
      const existing = await findClientByPhone(phone);
      if (existing) return bot.sendMessage(chatId, `Ya existe un registro con ese número bajo el nombre: *${existing.nombre}*. Si es tuyo, usa /mi_casillero.`, { parse_mode: 'Markdown' });
      state.telefono = phone;
      state.modo = 'CREAR_DIRECCION';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Por último, indica tu *dirección de entrega* (calle, número, ciudad).', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'CREAR_DIRECCION') {
      state.direccion = text;
      // save to sheet
      await addClientToSheet({ nombre: state.nombre, correo: state.correo, contacto: state.telefono, direccion: state.direccion });
      clearUserState(chatId);
      return bot.sendMessage(chatId, `✅ Registro completado. Hemos creado tu casillero para *${state.nombre}*.`, { parse_mode: 'Markdown' });
    }

    // ------------- CHECK CASILLERO (cuando piden teléfono para ver casillero) -------------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      if (!client) {
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      }
      // fetch trackings
      const items = await getTrackingsByName(client.nombre);
      if (!items || items.length === 0) return bot.sendMessage(chatId, 'No encontramos paquetes asociados a tu casillero.');
      await sendTrackingList(chatId, items, 1);
      return;
    }

    // ------------- CHECK SALDO -------------
    if (state.modo === 'CHECK_SALDO_PHONE') {
      const phone = normalizePhone(text);
      const client = await findClientByPhone(phone);
      clearUserState(chatId);
      if (!client) return bot.sendMessage(chatId, 'No encontramos un registro con ese número. Usa /crear_casillero para registrarte.');
      return bot.sendMessage(chatId, `💳 Saldo pendiente: $${(client.saldo || 0).toFixed(2)}`);
    }

    // ------------- CONSULTAR_TRACKING (cuando piden teléfono) -------------
    if ((state.modo || '').startsWith('TRACKING_REQ') || (getUserState(chatId) && getUserState(chatId).modo === null && text.match(/^\+?\d/))) {
      // handled earlier by specific flows; ignore here
    }

    // ------------- COTIZAR FLOW -------------
    if (state.modo === 'COTIZAR_ORIGEN') {
      state.origen = text.toLowerCase();
      // immediately ask category (no DESTINO)
      state.modo = 'COTIZAR_CATEGORIA';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona la categoría de tu mercancía:', { reply_markup: categoriaInlineKeyboard() });
    }
    if (state.modo === 'COTIZAR_DESCRIPCION') {
      state.descripcion = text;
      const classification = classifyProduct({ descripcion: state.descripcion, categoriaSeleccionada: state.categoriaSeleccionada, origen: state.origen });
      if (classification.tipo === 'Prohibida') { clearUserState(chatId); return bot.sendMessage(chatId, '⚠️ Mercancía prohibida. No podemos aceptarla.'); }
      state.tipoMercancia = classification.tipo;
      state.modo = 'COTIZAR_PESO';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Indica el PESO (ej: 2.3 kg, 4 lb, 3 libras, 5 kilos).');
    }
    if (state.modo === 'COTIZAR_PESO') {
      // aceptar kilos / kilos / kg / libras / lb / lbs
      const pesoMatch = text.match(/([\d.]+)\s*(kg|kgs|kilos|kilo|kilogramos|lb|lbs|libras|libra)/i);
      if (!pesoMatch) return bot.sendMessage(chatId, 'No entendí el peso. Usa: 2.5 kg, 3 kilos, 3 lb o 4 libras');
      const rawUnit = pesoMatch[2].toLowerCase();
      const unit = /kg|kilo|kilos|kgs|kilogramos/.test(rawUnit) ? 'kg' : 'lb';
      state.peso = parseFloat(pesoMatch[1]);
      state.unidad = unit;
      state.modo = 'COTIZAR_EMAIL';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, `Resumen:\nOrigen: ${state.origen}\nTipo: ${state.tipoMercancia}\nDescripción: ${state.descripcion}\nPeso: ${state.peso} ${state.unidad}\n\nIndica tu correo para enviar la cotización.`);
    }
    if (state.modo === 'COTIZAR_EMAIL') {
      if (!text.includes('@')) return bot.sendMessage(chatId, 'Correo inválido. Intenta nuevamente.');
      state.email = text;
      bot.sendMessage(chatId, 'Procesando cotización...');
      try {
        const cotizacion = await calcularYRegistrarCotizacion(chatId, state);
        clearUserState(chatId);
        return bot.sendMessage(chatId, `✅ Cotización:\nID: ${cotizacion.id}\nSubtotal: $${cotizacion.subtotal.toFixed(2)}\nDescuento: ${ (cotizacion.discountPercent*100).toFixed(1) }%\nTotal: $${cotizacion.total.toFixed(2)}`);
      } catch (err) {
        console.error('Error calculando cotización', err);
        clearUserState(chatId);
        return bot.sendMessage(chatId, 'Ocurrió un error calculando la cotización. Intenta nuevamente más tarde.');
      }
    }

  } catch (err) {
    console.error('Error en message handler:', err);
  }
});

// --- CÁLCULOS Y REGISTRO (incluye descuento por tramos) ---
function getDiscountPercentByPeso(peso) {
  // peso: number in unit already facturable (kg or lb depending)
  if (peso >= 75) return 0.15;
  if (peso >= 50) return 0.12;
  if (peso >= 35) return 0.10;
  if (peso >= 25) return 0.07;
  if (peso >= 15) return 0.05;
  return 0.00;
}

async function calcularYRegistrarCotizacion(chatId, state) {
  const tarifas = await leerTarifas();
  const { origen, peso, unidad, tipoMercancia, email } = state;
  let tarifa = 0;
  let pesoFacturable = 0;
  let unidadFacturable = 'lb';
  let subtotal = 0;

  const pesoEnLb = unidad === 'kg' ? peso * 2.20462 : peso;
  const pesoEnKg = unidad === 'lb' ? peso / 2.20462 : peso;
  const origenLower = origen.toLowerCase();

  if (origenLower === 'colombia') {
    tarifa = (tipoMercancia === 'Especial' || tipoMercancia==='Replica') ? tarifas.colombia.conPermiso : tarifas.colombia.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotal = tarifa * pesoFacturable;
  } else if (origenLower === 'mexico') {
    tarifa = tarifas.mexico.tarifa;
    pesoFacturable = Math.ceil(pesoEnKg);
    unidadFacturable = 'kg';
    subtotal = tarifa * pesoFacturable;
  } else if (origenLower === 'china') {
    tarifa = tarifas.china.tarifa;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  } else if (origenLower === 'miami' || origenLower === 'usa') {
    tarifa = (tipoMercancia === 'Especial') ? tarifas.miami.conPermiso : tarifas.miami.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  } else if (origenLower === 'espana' || origenLower === 'madrid') {
    tarifa = (tipoMercancia === 'Especial') ? tarifas.espana.conPermiso : tarifas.espana.sinPermiso;
    pesoFacturable = Math.ceil(pesoEnLb);
    unidadFacturable = 'lb';
    subtotal = tarifa * pesoFacturable;
  } else {
    throw new Error('Origen no soportado');
  }

  // descuento según peso facturable (usar la unidadFacturable relevante)
  const discountPercent = getDiscountPercentByPeso(pesoFacturable);
  const discountAmount = subtotal * discountPercent;
  const total = Math.round((subtotal - discountAmount) * 100) / 100;

  const id = 'COT-' + Math.random().toString(36).substr(2,9).toUpperCase();
  const fecha = new Date().toISOString();

  // guardar en historial (añadimos campos de descuento)
  await guardarEnHistorial({
    id, fecha, chatId, email, origen, destino: 'Costa Rica', tipoMercancia, peso, unidad,
    pesoFacturable, tarifa, subtotal, discountPercent, discountAmount, total
  });

  // generar PDF y enviar por correo (no bloquear si falla)
  try {
    const pdfBuffer = await generarPDFBuffer(id, fecha, { ...state, pesoFacturable, unidadFacturable, tarifa, subtotal, discountPercent, discountAmount, total });
    await enviarPDF(email, id, pdfBuffer);
  } catch (err) {
    console.error('Error enviando PDF/Email:', err);
    // no lanzamos error, ya que queremos mostrar la cotización en el chat igualmente
  }

  return { id, subtotal, discountPercent, total };
}

// --- leerTarifas (igual) ---
async function leerTarifas() {
  const sheets = await getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Tarifas!B2:B15' });
  const values = (res.data.values || []).map(r => r[0]);
  const val = idx => parseFloat(values[idx]) || 0;
  return {
    miami: { sinPermiso: val(0) || 6.0, conPermiso: val(1) || 7.0 },
    colombia: { sinPermiso: val(4) || 9.0, conPermiso: val(5) || 16.0 },
    espana: { sinPermiso: val(8) || 8.5, conPermiso: val(9) || 9.9 },
    china: { tarifa: val(11) || 10.0 },
    mexico: { tarifa: val(13) || 12.0 }
  };
}

// --- guardarEnHistorial ahora incluye descuento ---
async function guardarEnHistorial(data) {
  const sheets = await getGoogleSheetsClient();
  const now = new Date().toISOString();
  const values = [[
    data.id, data.fecha || now, data.chatId, 'Cliente', data.email, data.origen, data.destino,
    data.tipoMercancia, data.peso, data.unidad, data.pesoFacturable, data.tarifa,
    data.subtotal, data.discountAmount || 0, data.total, JSON.stringify(data)
  ]];
  await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Historial!A:Z', valueInputOption: 'RAW', resource: { values } });
}

// --- generar PDF cotizacion (igual, pero incluye descuento) ---
function generarPDFBuffer(id, fecha, c) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.fontSize(16).text('Cotización - J.I Asesoría & Courier', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`ID: ${id}`);
      doc.text(`Fecha: ${fecha}`);
      doc.moveDown();
      doc.text(`Origen: ${c.origen}`);
      doc.text(`Destino: Costa Rica`);
      doc.text(`Tipo: ${c.tipoMercancia}`);
      doc.text(`Descripción: ${c.descripcion || '-'}`);
      doc.text(`Peso declarado: ${c.peso} ${c.unidad}`);
      doc.text(`Peso facturable: ${c.pesoFacturable} ${c.unidadFacturable}`);
      doc.moveDown();
      doc.text(`Tarifa aplicada: ${c.tarifa}`);
      doc.text(`Subtotal: $${(c.subtotal || 0).toFixed(2)}`);
      doc.text(`Descuento: $${(c.discountAmount || 0).toFixed(2)} (${((c.discountPercent||0)*100).toFixed(1)}%)`);
      doc.text(`Total: $${(c.total || 0).toFixed(2)}`);
      doc.end();
    } catch (err) { reject(err); }
  });
}

// --- enviar PDF por correo (igual, envía copia al admin) ---
async function enviarPDF(email, id, pdfBuffer) {
  if (!ADMIN_EMAIL_PASSWORD) { console.warn('No se envió correo: falta ADMIN_EMAIL_PASSWORD'); return; }
  const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user: ADMIN_EMAIL, pass: ADMIN_EMAIL_PASSWORD } });
  const mailClient = { from: ADMIN_EMAIL, to: email, subject: `Cotización J.I - ${id}`, html:`<p>Adjuntamos la cotización (ID ${id}).</p>`, attachments:[{ filename:`${id}.pdf`, content: pdfBuffer }] };
  const mailAdmin = { from: ADMIN_EMAIL, to: ADMIN_EMAIL, subject: `Copia - Cotización ${id}`, html:`<p>Copia enviada a ${email}</p>`, attachments:[{ filename:`${id}.pdf`, content: pdfBuffer }] };
  await transporter.sendMail(mailClient);
  await transporter.sendMail(mailAdmin);
}

// --- generar PDF listados trackings (export) ---
function generarListadoTrackingsPDF(items) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const bufs = [];
      doc.on('data', bufs.push.bind(bufs));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.fontSize(16).text('Listado de Paquetes', { align: 'center' }); doc.moveDown();
      items.forEach((it, i) => {
        doc.fontSize(12).text(`${i+1}. Tracking: ${it.tracking}`);
        doc.text(`   Origen: ${it.origen}   Estado: ${it.estado}   Peso: ${it.peso}`);
        doc.text(`   Comentarios: ${it.comentarios || '-'}`); doc.moveDown();
      });
      doc.end();
    } catch (err) { reject(err); }
  });
}

// --- getTrackingsByName: ya implementado arriba ---

// --- INICIAR SERVIDOR Y WEBHOOK ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Bot activo en puerto ${PORT}`);
  const webhookUrl = `${url}/${TELEGRAM_TOKEN}`;
  try { await bot.setWebHook(webhookUrl); console.log(`🔗 Webhook configurado: ${webhookUrl}`); } catch (err) { console.error('Error configurando webhook:', err); }
});
