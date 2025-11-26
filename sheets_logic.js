const { google } = require('googleapis');

// ---------------- CONFIG & CONSTANTES ----------------
// ¡IMPORTANTE! Asegúrate de tener estas variables de entorno configuradas
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '10Y0tg1kh6UrVtEzSj_0JGsP7GmydRabM5imlEXTwjLM'; 

// --- CONSTANTES ---
const MERCANCIA_ESPECIAL = [ "colonias","perfume","perfumes","cremas","crema","cosmetico","cosmético","cosmeticos","cosméticos","maquillaje","medicamento","medicinas","suplemento","suplementos","vitamina","vitaminas","alimento","alimentos","semilla","semillas","agroquimico","agroquímico","fertilizante","lentes de contacto","quimico","químico","producto de limpieza","limpieza","bebida","bebidas","jarabe","tableta","capsula","cápsula" ];
const MERCANCIA_PROHIBIDA = [ "licor","whisky","vodka","ron","alcohol","animal","vivo","piel","droga","drogas","cannabis","cbd","arma","armas","munición","municiones","explosivo","explosivos","pornograf","falsificado","falso","oro","plata","dinero","inflamable","corrosivo","radiactivo","gas","batería de litio","bateria de litio","tabaco","cigarro","cigarros" ];
const KNOWN_BRANDS = [ "nike","adidas","puma","reebok","gucci","louis vuitton","lv","dior","chanel","tiffany","cartier","bulgari","bvlgari","rolex","pandora","piaget","graff","chopard","tous","david yurman","victoria's secret" ];
// --------------------------------------------------------


// ---------------- GOOGLE SHEETS CLIENT (CON DEPURACIÓN) ----------------
async function getGoogleSheetsClient() {
    let credsRaw = process.env.GOOGLE_CREDENTIALS;
    if (!credsRaw) {
        console.error('ERROR DE CREDENCIALES: GOOGLE_CREDENTIALS no está definida.');
        throw new Error('Falta la variable de credenciales de Google.');
    }
    
    let credentials;
    try {
        // 1. Intentar decodificar si no parece JSON directo
        if (!credsRaw.trim().startsWith('{')) {
            // Asume Base64 si no empieza con {
            console.log('INTENTO DEPURACIÓN: Decodificando GOOGLE_CREDENTIALS (asumiendo Base64)...');
            credsRaw = Buffer.from(credsRaw, 'base64').toString('utf8');
        }
        // 2. Intentar parsear el JSON
        credentials = JSON.parse(credsRaw);
        
        // **DEPURACIÓN: VERIFICAR LECTURA**
        console.log('✅ CREDENCIALES LEÍDAS Y PARSEADAS. ID de Proyecto:', credentials.project_id);
        
    } catch (err) {
        console.error('❌ ERROR GRAVE: Fallo al parsear GOOGLE_CREDENTIALS. ¿Es un JSON válido?', err.message);
        throw new Error('Error de configuración de las credenciales de Google (JSON inválido).');
    }
    
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const client = await auth.getClient();
        
        // **DEPURACIÓN: AUTENTICACIÓN EXITOSA**
        console.log('✅ AUTENTICACIÓN EXITOSA con Google.');

        return google.sheets({ version: 'v4', auth: client });
        
    } catch (err) {
        console.error('❌ ERROR GRAVE: Fallo en la autenticación o conexión a Sheets. Revisa permisos en la hoja de cálculo.', err.message);
        throw new Error('Error de autenticación o permisos con Google Sheets.');
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
async function findClientByPhoneOrEmail(input) {
    const sheets = await getGoogleSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Clientes!A:H' });
    const rows = res.data.values || [];
    const normalizedInputPhone = normalizePhone(input || '');
    const inputLower = (input || '').toString().toLowerCase().trim();

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = row[0] || '';
        const correo = (row[1] || '').toString().toLowerCase(); // Columna B (índice 1)
        const contacto = row[3] || ''; // Columna D (índice 3)

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
    // A:Nombre, B:Correo, C:unused, D:Contacto, G:Direccion, H:Saldo
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
    const normalizedName = nombre.toLowerCase().trim();
    
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[1]||'').toString().trim().toLowerCase(); // Columna B (índice 1)
        if (!name) continue;
        if (name === normalizedName) {
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

// ---------------- COTIZACIONES (Nuevo) ----------------
async function addQuoteToSheet(quote) {
    const sheets = await getGoogleSheetsClient();
    const now = new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' });
    
    // Columnas esperadas en la hoja 'Cotizaciones':
    // A:Fecha, B:Nombre, C:Contacto, D:Correo, E:Origen, F:Peso(kg), G:Valor(USD), H:Categoría, I:Descripción, J:Clasificación, K:Tags
    const values = [[
        now,
        quote.clienteNombre || 'N/A',
        quote.clienteContacto || 'N/A',
        quote.clienteCorreo || 'N/A',
        quote.origen || 'N/A',
        quote.peso || 0,
        quote.valor || 0,
        quote.categoriaSeleccionada || 'N/A',
        quote.descripcion || 'N/A',
        quote.clasificacion.tipo || 'General',
        quote.clasificacion.tags.join(', ')
    ]];

    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Cotizaciones!A:K',
        valueInputOption: 'RAW',
        resource: { values }
    });
}


module.exports = {
    getDirecciones,
    findClientByPhoneOrEmail,
    addClientToSheet,
    getTrackingsByName,
    addQuoteToSheet,
    normalizePhone,
    classifyProduct,
    getGoogleSheetsClient // Exportamos la función de conexión.
};
