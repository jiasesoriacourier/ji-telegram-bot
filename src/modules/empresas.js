// ===========================================================
// MÓDULO: EMPRESAS AFILIADAS
// Lee y valida códigos desde la hoja "Empresas"
// ===========================================================

const { getSheet } = require("../services/sheetsService");

// Estructura esperada en la hoja "Empresas":
// Col A: Nombre empresa
// Col B: Tipo de empresa
// Col C: Correo corporativo
// Col D: Teléfono
// Col E: Contacto
// Col F: Abreviatura (CÓDIGO)

// ===========================================================
// Obtener todas las empresas
// ===========================================================
async function getEmpresas() {
  const sheet = await getSheet("Empresas");
  if (!sheet || sheet.length < 2) return [];

  const empresas = [];

  for (let i = 1; i < sheet.length; i++) {
    const row = sheet[i];
    if (!row || !row[0]) continue;

    empresas.push({
      nombre: row[0],
      tipo: row[1] || "",
      correo: row[2] || "",
      telefono: row[3] || "",
      contacto: row[4] || "",
      codigo: (row[5] || "").trim().toUpperCase()
    });
  }

  return empresas;
}

// ===========================================================
// Validar si existe un código
// ===========================================================
async function validarCodigoEmpresa(codigo) {
  if (!codigo) return null;

  const empresas = await getEmpresas();
  const cod = codigo.trim().toUpperCase();

  return empresas.find(e => e.codigo === cod) || null;
}

// ===========================================================
// Resumen profesional para guardar en "Clientes"
// ===========================================================
function generarReferenciaEmpresa(empresa) {
  if (!empresa) return "";
  return `${empresa.codigo} - ${empresa.nombre}`;
}

module.exports = {
  getEmpresas,
  validarCodigoEmpresa,
  generarReferenciaEmpresa
};