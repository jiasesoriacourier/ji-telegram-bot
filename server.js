const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { getDirecciones, findClientByPhoneOrEmail, addClientToSheet, getTrackingsByName, addQuoteToSheet, normalizePhone, classifyProduct } = require('./sheets_logic'); 
// IMPORTAR getGoogleSheetsClient DE sheets_logic para usarlo en el flujo de prealerta
const { google } = require('googleapis'); 

// ---------------- CONFIG & VALIDACIÓN DE ENTORNO ----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '7826072133';
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/webhook/${TELEGRAM_TOKEN}`;

if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN en variables de entorno');
if (!process.env.GOOGLE_CREDENTIALS) throw new Error('Falta GOOGLE_CREDENTIALS en variables de entorno');
if (!WEBHOOK_URL) throw new Error('Falta RENDER_EXTERNAL_URL en variables de entorno (necesario para el webhook)');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// estado por usuario
const userStates = new Map();
function setUserState(chatId, state) { userStates.set(String(chatId), state); }
function getUserState(chatId) { return userStates.get(String(chatId)); }
function clearUserState(chatId) { userStates.delete(String(chatId)); }

// Funciones de teclado
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


// ---------------- COMANDOS ----------------
bot.onText(/\/menu|\/start/, (msg) => {
    clearUserState(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Selecciona una opción:', { reply_markup: mainMenuKeyboard() });
});

bot.onText(/\/crear_casillero/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'CREAR_NOMBRE' });
    bot.sendMessage(msg.chat.id, 'Iniciaremos el proceso de registro. Ingresa tu *Nombre completo* (nombre + 2 apellidos).', { parse_mode: 'Markdown' });
});

bot.onText(/\/mi_casillero/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'CHECK_CASILLERO_PHONE' });
    bot.sendMessage(msg.chat.id, 'Ingresa el *número de teléfono* o *correo electrónico* con el que está registrado tu casillero:', { parse_mode: 'Markdown' });
});

bot.onText(/\/cotizar/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'COTIZAR_CHECK_CLIENT' });
    bot.sendMessage(msg.chat.id, 'Para cotizar, ingresa tu número de teléfono/correo. Si no estás registrado, responde NO.', { parse_mode: 'Markdown' });
});

bot.onText(/\/consultar_tracking/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'CHECK_TRACKING_PHONE' });
    bot.sendMessage(msg.chat.id, 'Ingresa tu *número de teléfono* o *correo electrónico* para ver tus paquetes:', { parse_mode: 'Markdown' });
});

bot.onText(/\/prealertar/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'PREALERT_TRACKING' });
    bot.sendMessage(msg.chat.id, 'Iniciaremos la prealerta. Ingresa el *número de tracking* del paquete:', { parse_mode: 'Markdown' });
});

bot.onText(/\/saldo/, (msg) => {
    clearUserState(msg.chat.id);
    setUserState(msg.chat.id, { modo: 'CHECK_SALDO_PHONE' });
    bot.sendMessage(msg.chat.id, 'Ingresa tu *número de teléfono* o *correo electrónico* para consultar tu saldo:', { parse_mode: 'Markdown' });
});

bot.onText(/\/contactar/, (msg) => {
    clearUserState(msg.chat.id);
    bot.sendMessage(msg.chat.id, '¿Cómo deseas contactarnos?', { reply_markup: contactarKeyboard() });
});


// ---------------- CALLBACKS ----------------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(()=>{});
  try {
    if (data.startsWith('CATEGORIA|')) {
      // ... (Lógica de cotización, no afectada)
        const categoria = data.split('|')[1] || '';
        const state = getUserState(chatId) || {};
        state.categoriaSeleccionada = categoria;
        state.modo = 'COTIZAR_DESCRIPCION';
        setUserState(chatId, state);
        // Eliminar el teclado inline
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: `✅ ${categoria} seleccionada`, callback_data: 'ignore' }]] },
          { chat_id: chatId, message_id: query.message.message_id }
        ).catch(()=>{});
        return bot.sendMessage(chatId, `Has seleccionado *${categoria}*. Ahora describe el producto (breve).`, { parse_mode: 'Markdown' });
    }
    
    if (data.startsWith('CASILLERO|')) {
      const pais = data.split('|')[1] || '';
      const currentState = getUserState(chatId) || {};
      // CORRECCIÓN APLICADA: Usar clienteNombre del estado, que se guarda al verificar el teléfono/correo
      const clienteNombre = currentState.clienteNombre ? currentState.clienteNombre : 'Cliente'; 

      if (pais === 'colombia') {
        return bot.sendMessage(chatId, '¿Tu mercancía requiere permiso de importación?', { reply_markup: { inline_keyboard: [[{ text: '📦 Con permiso o réplicas', callback_data: 'COL_CASILLERO|con' }],[{ text: '📦 Sin permiso', callback_data: 'COL_CASILLERO|sin' }]] } });
      } else {
        
        const dire = await getDirecciones(clienteNombre); // Usar el nombre de Sheets
        let direccion = 'No disponible';
        if (pais === 'miami') direccion = dire.miami;
        else if (pais === 'madrid') direccion = dire.espana || dire.miami;
        else if (pais === 'mexico') direccion = dire.mexico;
        else if (pais === 'china') direccion = dire.china;
        
        const nombres = { miami:'Estados Unidos (Miami)', madrid:'España (Madrid)', mexico:'México', china:'China', colombia:'Colombia' };
        return bot.sendMessage(chatId, `📍 *Dirección de ${clienteNombre} en ${nombres[pais]}*:\n\n${direccion}`, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
      }
    }
    
    if (data.startsWith('COL_CASILLERO|')) {
      const tipo = data.split('|')[1];
      const currentState = getUserState(chatId) || {};
      // CORRECCIÓN APLICADA: Usar clienteNombre del estado
      const clienteNombre = currentState.clienteNombre ? currentState.clienteNombre : 'Cliente'; 

      const dire = await getDirecciones(clienteNombre);
      const direccion = tipo === 'con' ? dire.colombiaCon : dire.colombiaSin;
      return bot.sendMessage(chatId, `📍 *Dirección de ${clienteNombre} en Colombia (${tipo==='con'?'Con permiso':'Sin permiso'})*:\n\n${direccion}`, { parse_mode: 'Markdown', ...volverMenuKeyboard() });
    }

    // ... (resto de callbacks: CONTACT|, TRACK_PAGE|, TRACK_DETAIL|, TRACK_EXPORT|)
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

    // ---------- CREAR CASILLERO (Flujo original) ----------
    // ... (Flujo de CREAR_NOMBRE, CREAR_EMAIL, CREAR_TELEFONO, CREAR_DIRECCION - no afectados)
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

    // ---------- MI_CASILLERO: mostrar direcciones (Corregido) ----------
    if (state.modo === 'CHECK_CASILLERO_PHONE') {
      const input = text;
      const client = await findClientByPhoneOrEmail(input);
      clearUserState(chatId); // Limpiar el estado de petición de datos (CHECK_CASILLERO_PHONE)
      if (!client) {
        return bot.sendMessage(chatId, 'No encontramos un registro con ese número o correo. Usa /crear_casillero para registrarte o intenta nuevamente.', volverMenuKeyboard());
      }
      // Guardar el nombre del cliente encontrado de Sheets para el callback
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

    // ---------- PREALERT FLOW (Corregido) ----------
    if (state.modo === 'PREALERT_TRACKING') {
      state.pre_tracking = text;
      state.modo = 'PREALERT_CONTACT';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, '¿Con qué número de teléfono o correo deseas registrar este tracking? (escribe o responde NO si no estás registrado).');
    }
    if (state.modo === 'PREALERT_CONTACT') {
      // ... (Lógica de verificación de cliente - no afectada)
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
        state.pre_cliente = 'Cliente (sin registro)';
        state.pre_contacto = input;
        state.pre_correo = '';
      }
      state.modo = 'PREALERT_ORIGIN';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Selecciona el ORIGEN del envío (escribe una opción): Estados Unidos, Colombia, España, China, Mexico');
    }
    if (state.modo === 'PREALERT_ORIGIN') {
      // ... (Lógica de origen - no afectada)
      const oRaw = text.toLowerCase();
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
      // CAMBIO: Obligatorio
      return bot.sendMessage(chatId, 'Indica el *tipo de mercancía/producto* (obligatorio). Ej: Ropa, Electrónicos, Perfume, etc.', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_MERCANCIA') {
      // CAMBIO: Validación Obligatoria
      if (!text || text.length < 3) return bot.sendMessage(chatId, '⚠️ Es *obligatorio* indicar una descripción detallada de la mercancía/producto. Intenta nuevamente.', { parse_mode: 'Markdown' });
      state.pre_mercancia = text;
      state.modo = 'PREALERT_OBS';
      setUserState(chatId, state);
      return bot.sendMessage(chatId, 'Agrega *observaciones* (opcional). Si no hay, responde "NO".', { parse_mode: 'Markdown' });
    }
    if (state.modo === 'PREALERT_OBS') {
      state.pre_observaciones = (text.toLowerCase() === 'no') ? '' : text;
      try {
        // Importar getGoogleSheetsClient para su uso local
         const { getGoogleSheetsClient } = require('./sheets_logic');
        const sheets = await getGoogleSheetsClient();
         
         // Corrección de Columnas de Hoja Datos:
         // A:Tracking (0), B:Cliente (1), C:Comentarios (2), D:Origen (3), E:Estado (4), F:Peso (5), G:Mercancía (6)
         
         // Columna C (Comentarios) usaremos la descripción de la mercancía.
         // Columna D (Origen) usaremos el país de origen.
         
        const values = [[ 
            state.pre_tracking || '', // Col A: Tracking
            state.pre_cliente || '',  // Col B: Nombre de Cliente
            state.pre_mercancia || '', // Col C: Mercancía/Descripción
            state.pre_origen || '',    // **Col D: Origen (Corregido)**
            '',                        // Col E: Estado (vacío, lo llena el asesor)
            '',                        // Col F: Peso (vacío, lo llena el asesor)
            state.pre_observaciones || '' // Col G: Observaciones (Opcional)
         ]];
         
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID, // Usar SPREADSHEET_ID directamente
          range: 'Datos!A:G', // Ajustar el rango de append
          valueInputOption: 'RAW',
          resource: { values }
        });
        // notify admin with summary
        const adminTxt = `📥 Nueva prealerta\n*Tracking:* ${state.pre_tracking}\n*Cliente:* ${state.pre_cliente}\n*Contacto:* ${state.pre_contacto || '-'}\n*Correo:* ${state.pre_correo || '-'}\n*Origen:* ${state.pre_origen}\n*Mercancía (Col C):* ${state.pre_mercancia}\n*Observaciones (Col G):* ${state.pre_observaciones || '-'}`;
        await bot.sendMessage(ADMIN_TELEGRAM_ID, adminTxt, { parse_mode: 'Markdown' });
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
    
    // ... (El resto de flujos de cotizar COTIZAR_CHECK_CLIENT, COTIZAR_UNREG_NAME, COTIZAR_ORIGEN, etc. no han sido modificados)

    // Si no hay estado, es un mensaje libre
    if (!state.modo) {
      return bot.sendMessage(chatId, 'Mensaje no reconocido. Usa /menu para ver las opciones.');
    }

  } catch (err) {
    console.error('Error en onMessage:', err);
    bot.sendMessage(msg.chat.id, 'Ocurrió un error inesperado.', volverMenuKeyboard());
  }
});

// ---------------- INICIO DE SERVIDOR EN EXPRESS ----------------

// Endpoint del Webhook
app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200); // Crucial: siempre responder 200 OK inmediatamente
});

// Ruta de "Health Check"
app.get('/', (req, res) => {
    res.send('Bot de Telegram + Google Sheets está activo.');
});

// Listener del servidor
app.listen(PORT, async () => {
    console.log(`Express server escuchando en puerto ${PORT}`);
    
    // Configurar el Webhook en Telegram al iniciar
    try {
        const fullWebhookUrl = `${WEBHOOK_URL}${WEBHOOK_PATH}`;
        await bot.setWebHook(fullWebhookUrl);
        console.log(`✅ Webhook establecido en: ${fullWebhookUrl}`);
    } catch (error) {
        console.error("❌ Error al establecer el webhook:", error.message);
    }
});

// Manejo de errores de Telegram
bot.on('webhook_error', (error) => {
    console.error("Error de Webhook:", error.code);
});

bot.on('error', (error) => {
    console.error("Error general del bot:", error);
});
