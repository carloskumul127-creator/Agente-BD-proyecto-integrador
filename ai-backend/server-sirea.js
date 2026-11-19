const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');
const mysql = require('mysql2/promise'); // conexión a MySQL

const app = express();
app.use(express.json());
app.use(cors());

// Inicializar el cliente de OpenAI apuntando a la baseURL de OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tu-sitio-web.com', // Opcional: para rankings en OpenRouter
    'X-Title': 'SIREA Manifiestos',              // Opcional: nombre de tu app
  },
});

// ===========================================================================
// CONEXIÓN A LA BASE DE DATOS (MySQL en WampServer) — esquema SIREA
// ===========================================================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '', // En WampServer, root normalmente no tiene contraseña
  database: process.env.DB_NAME || 'sirea',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // devuelve las fechas tal como están en MySQL, sin convertir zona horaria
});

// ===========================================================================
// HERRAMIENTAS DEL AGENTE (las "manos"): funciones de SOLO LECTURA
// Todas usan las vistas de SIREA:
//   v_destinos_permitidos_por_residuo, v_resumen_manifiesto,
//   v_validacion_manifiesto, v_verificacion_cadena
// ===========================================================================

// Límite para que la IA no pueda pedir miles de filas
const clamp = (valor, min, max, porDefecto) => {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

// Texto opcional: si viene vacío lo convierte en null
const textoONull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// Fecha opcional en formato AAAA-MM-DD
const fechaONull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Número positivo opcional
const numeroONull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ---------------------------------------------------------------------------
// 1) ¿A qué centro de acopio puedo mandar este residuo?
//    Devuelve los centros autorizados HOY y, aparte, los que no pueden y por qué.
// ---------------------------------------------------------------------------
async function centros_para_residuo({ residuo, cantidad, unidad } = {}) {
  const r = textoONull(residuo);
  if (!r) return { error: 'Indica el residuo (nombre o clave, por ejemplo "aceite" o "ACE-01").' };
  const cant = numeroONull(cantidad);
  const uni = textoONull(unidad) || 'kg';

  const [permitidos] = await pool.query(`
    SELECT v.residuo_clave, v.residuo_nombre, v.clave_normativa, v.tipo_residuo_nombre,
           v.centro_clave, v.centro_nombre, v.centro_municipio, v.centro_estado,
           v.numero_autorizacion, v.vigencia_hasta, v.dias_para_vencer,
           v.capacidad_maxima, v.capacidad_consumida, v.capacidad_disponible, v.capacidad_unidad,
           v.periodo_capacidad, v.capacidad_sin_limite,
           CASE WHEN ? IS NULL THEN NULL
                WHEN v.capacidad_sin_limite THEN 1
                ELSE fn_convertir_unidad(?, (SELECT id FROM unidades_medida WHERE clave = ?), v.capacidad_unidad_id)
                     <= v.capacidad_disponible END AS cabe_la_cantidad
    FROM v_destinos_permitidos_por_residuo v
    WHERE v.permitido
      AND (v.residuo_clave = ? OR v.residuo_nombre LIKE CONCAT('%', ?, '%') OR v.clave_normativa = ?)
    ORDER BY cabe_la_cantidad DESC, v.dias_para_vencer IS NULL DESC, v.dias_para_vencer DESC
    LIMIT 50`, [cant, cant, uni, r, r, r]);

  const [no_permitidos] = await pool.query(`
    SELECT v.residuo_clave, v.centro_clave, v.centro_nombre, v.motivo
    FROM v_destinos_permitidos_por_residuo v
    WHERE NOT v.permitido
      AND (v.residuo_clave = ? OR v.residuo_nombre LIKE CONCAT('%', ?, '%') OR v.clave_normativa = ?)
    ORDER BY v.autorizacion_id IS NULL, v.centro_clave
    LIMIT 50`, [r, r, r]);

  const [residuos_encontrados] = await pool.query(`
    SELECT clave, nombre, clave_normativa FROM residuos
    WHERE clave = ? OR nombre LIKE CONCAT('%', ?, '%') OR clave_normativa = ?`, [r, r, r]);

  return {
    residuos_encontrados,
    cantidad_consultada: cant ? `${cant} ${uni}` : null,
    centros_autorizados: permitidos,
    centros_no_autorizados: no_permitidos,
  };
}

// ---------------------------------------------------------------------------
// 2) ¿Qué transportistas (y con qué unidad y chofer) pueden llevar este residuo / tipo?
// ---------------------------------------------------------------------------
async function transportistas_autorizados({ residuo, tipo_residuo } = {}) {
  const r = textoONull(residuo);
  const t = textoONull(tipo_residuo);
  if (!r && !t) return { error: 'Indica un residuo o un tipo de residuo.' };

  const [rows] = await pool.query(`
    SELECT tr.clave AS tipo_clave, tr.nombre AS tipo_residuo,
           t.clave AS transportista_clave, t.razon_social AS transportista,
           ttr.numero_autorizacion, ttr.vigencia_hasta AS autorizacion_vigente_hasta,
           DATEDIFF(ttr.vigencia_hasta, CURDATE()) AS dias_para_vencer,
           (SELECT GROUP_CONCAT(CONCAT(ve.descripcion, ' (', ve.placas, ')') ORDER BY ve.clave SEPARATOR '; ')
              FROM vehiculos ve
              JOIN vehiculo_tipo_residuo vtr ON vtr.vehiculo_id = ve.id AND vtr.tipo_residuo_id = tr.id
             WHERE ve.transportista_id = t.id AND ve.estatus = 'activo' AND vtr.estatus = 'activa'
               AND fn_esta_vigente(vtr.vigencia_desde, vtr.vigencia_hasta, CURDATE())
               AND fn_esta_vigente(NULL, ve.poliza_vigencia_hasta, CURDATE())
               AND fn_esta_vigente(NULL, ve.verificacion_vigencia_hasta, CURDATE())) AS unidades_habilitadas,
           (SELECT GROUP_CONCAT(ch.nombre ORDER BY ch.nombre SEPARATOR ', ')
              FROM choferes ch
             WHERE ch.transportista_id = t.id AND ch.estatus = 'activo'
               AND ch.licencia_vigencia_hasta >= CURDATE()) AS choferes_con_licencia_vigente
    FROM tipos_residuo tr
    JOIN transportista_tipo_residuo ttr ON ttr.tipo_residuo_id = tr.id
    JOIN transportistas t ON t.id = ttr.transportista_id
    WHERE ttr.estatus = 'activa' AND fn_esta_vigente(ttr.vigencia_desde, ttr.vigencia_hasta, CURDATE())
      AND t.estatus = 'activo' AND fn_esta_vigente(t.vigencia_desde, t.vigencia_hasta, CURDATE())
      AND (
            (? IS NOT NULL AND (tr.clave = ? OR tr.nombre LIKE CONCAT('%', ?, '%')))
         OR (? IS NOT NULL AND tr.id IN (SELECT tipo_residuo_id FROM residuos
                                         WHERE clave = ? OR nombre LIKE CONCAT('%', ?, '%') OR clave_normativa = ?))
          )
    ORDER BY tr.clave, t.razon_social`, [t, t, t, r, r, r, r]);

  return rows;
}

// ---------------------------------------------------------------------------
// 3) Autorizaciones que vencen pronto (centros, generadores, transportistas, vehículos)
//    y documentos de choferes / vehículos por vencer
// ---------------------------------------------------------------------------
async function autorizaciones_por_vencer({ dias } = {}) {
  const d = clamp(dias, 1, 365, 30);

  const [autorizaciones] = await pool.query(`
    SELECT a.ambito, a.residuo_o_tipo, a.descripcion, a.contraparte, a.numero_autorizacion, a.vigencia_hasta,
           DATEDIFF(a.vigencia_hasta, CURDATE()) AS dias_restantes
    FROM (
        SELECT 'Centro de acopio - residuo' AS ambito, r.clave AS residuo_o_tipo, r.nombre AS descripcion,
               CONCAT(c.clave, ' ', c.nombre) AS contraparte, x.numero_autorizacion, x.vigencia_hasta
        FROM centro_acopio_residuo x JOIN residuos r ON r.id = x.residuo_id JOIN centros_acopio c ON c.id = x.centro_acopio_id
        WHERE x.estatus = 'activa'
        UNION ALL
        SELECT 'Generador - residuo', r.clave, r.nombre, CONCAT(g.clave, ' ', g.razon_social), x.numero_autorizacion, x.vigencia_hasta
        FROM generador_residuo x JOIN residuos r ON r.id = x.residuo_id JOIN generadores g ON g.id = x.generador_id
        WHERE x.estatus = 'activa'
        UNION ALL
        SELECT 'Transportista - tipo', tr.clave, tr.nombre, CONCAT(t.clave, ' ', t.razon_social), x.numero_autorizacion, x.vigencia_hasta
        FROM transportista_tipo_residuo x JOIN tipos_residuo tr ON tr.id = x.tipo_residuo_id JOIN transportistas t ON t.id = x.transportista_id
        WHERE x.estatus = 'activa'
        UNION ALL
        SELECT 'Vehículo - tipo', tr.clave, tr.nombre, CONCAT(ve.clave, ' ', ve.placas), x.numero_autorizacion, x.vigencia_hasta
        FROM vehiculo_tipo_residuo x JOIN tipos_residuo tr ON tr.id = x.tipo_residuo_id JOIN vehiculos ve ON ve.id = x.vehiculo_id
        WHERE x.estatus = 'activa'
    ) a
    WHERE a.vigencia_hasta BETWEEN CURDATE() AND CURDATE() + INTERVAL ? DAY
    ORDER BY a.vigencia_hasta`, [d]);

  const [documentos] = await pool.query(`
    SELECT 'Licencia de chofer' AS documento, CONCAT(ch.nombre, ' (', t.clave, ')') AS de_quien,
           ch.licencia_vigencia_hasta AS vence, DATEDIFF(ch.licencia_vigencia_hasta, CURDATE()) AS dias_restantes
    FROM choferes ch JOIN transportistas t ON t.id = ch.transportista_id
    WHERE ch.estatus = 'activo' AND ch.licencia_vigencia_hasta <= CURDATE() + INTERVAL ? DAY
    UNION ALL
    SELECT 'Póliza de vehículo', CONCAT(ve.descripcion, ' ', ve.placas), ve.poliza_vigencia_hasta,
           DATEDIFF(ve.poliza_vigencia_hasta, CURDATE())
    FROM vehiculos ve
    WHERE ve.estatus = 'activo' AND ve.poliza_vigencia_hasta <= CURDATE() + INTERVAL ? DAY
    UNION ALL
    SELECT 'Verificación de vehículo', CONCAT(ve.descripcion, ' ', ve.placas), ve.verificacion_vigencia_hasta,
           DATEDIFF(ve.verificacion_vigencia_hasta, CURDATE())
    FROM vehiculos ve
    WHERE ve.estatus = 'activo' AND ve.verificacion_vigencia_hasta <= CURDATE() + INTERVAL ? DAY
    UNION ALL
    SELECT 'Firma de receptor', rp.nombre, rp.firma_vigencia_hasta, DATEDIFF(rp.firma_vigencia_hasta, CURDATE())
    FROM receptores_planta rp
    WHERE rp.estatus = 'activo' AND rp.firma_vigencia_hasta <= CURDATE() + INTERVAL ? DAY
    ORDER BY vence`, [d, d, d, d]);

  return {
    dias_revisados: d,
    autorizaciones_por_vencer: autorizaciones,
    documentos_vencidos_o_por_vencer: documentos, // dias_restantes negativo = ya vencido
  };
}

// ---------------------------------------------------------------------------
// 4) Manifiestos: por folio, generador, estatus, tipo o rango de fechas (con totales)
// ---------------------------------------------------------------------------
async function listar_manifiestos({ folio, generador, estatus, tipo, fecha_desde, fecha_hasta, limite } = {}) {
  const f = textoONull(folio);
  const g = textoONull(generador);
  const est = ['borrador', 'grabado', 'cancelado'].includes(estatus) ? estatus : null;
  const tp = ['entrada', 'salida'].includes(tipo) ? tipo : null;
  const desde = fechaONull(fecha_desde);
  const hasta = fechaONull(fecha_hasta);
  const top = clamp(limite, 1, 50, 20);

  const [rows] = await pool.query(`
    SELECT r.folio_completo AS folio, r.tipo, r.modalidad, r.estatus, r.fecha_emision,
           r.generador_clave, r.generador_razon_social AS generador,
           r.total_partidas, r.total_envases, r.peso_total_kg,
           r.transportista, r.chofer, r.vehiculo, r.vehiculo_placas,
           r.ruta_origen, r.ruta_destino, r.distancia_km,
           r.centro_acopio, r.destino_final, r.receptor_nombre,
           r.total_imagenes, r.grabado_en, r.grabado_por,
           r.notificacion_enviada, r.alertas_abiertas, r.ultimo_evento
    FROM v_resumen_manifiesto r
    WHERE (? IS NULL OR r.folio_completo LIKE CONCAT('%', ?, '%'))
      AND (? IS NULL OR r.generador_clave = ? OR r.generador_razon_social LIKE CONCAT('%', ?, '%'))
      AND (? IS NULL OR r.estatus = ?)
      AND (? IS NULL OR r.tipo = ?)
      AND (? IS NULL OR r.fecha_emision >= ?)
      AND (? IS NULL OR r.fecha_emision <= ?)
    ORDER BY r.fecha_emision DESC, r.folio_completo DESC
    LIMIT ?`, [f, f, g, g, g, est, est, tp, tp, desde, desde, hasta, hasta, top]);

  return rows;
}

// ---------------------------------------------------------------------------
// 5) Detalle e historial de un folio: resumen completo, partidas, imágenes,
//    eventos de trazabilidad (con verificación de la cadena) y alertas
// ---------------------------------------------------------------------------
async function historial_folio({ folio } = {}) {
  const f = textoONull(folio);
  if (!f) return { error: 'Indica el folio (completo o parcial, por ejemplo "0983").' };

  const [resumen] = await pool.query(`
    SELECT * FROM v_resumen_manifiesto
    WHERE folio_completo = ? OR folio_completo LIKE CONCAT('%', ?)
    ORDER BY fecha_emision DESC LIMIT 3`, [f, f]);
  if (resumen.length === 0) return { mensaje: `No existe un manifiesto con folio "${f}".` };

  const ids = resumen.map((m) => m.manifiesto_id);
  const [cadena] = await pool.query(`
    SELECT manifiesto_id, COUNT(*) AS eventos, SUM(integro) AS eventos_integros
    FROM v_verificacion_cadena WHERE manifiesto_id IN (?) GROUP BY manifiesto_id`, [ids]);

  return resumen.map((m) => {
    const c = cadena.find((x) => x.manifiesto_id === m.manifiesto_id);
    return {
      ...m,
      cadena_trazabilidad: c
        ? (Number(c.eventos) === Number(c.eventos_integros) ? 'íntegra' : 'ALTERADA: revisar bitácora')
        : 'sin eventos',
    };
  });
}

// ---------------------------------------------------------------------------
// 6) ¿Se puede grabar este borrador? (validación contra las reglas vigentes)
// ---------------------------------------------------------------------------
async function validar_borrador({ folio } = {}) {
  const f = textoONull(folio);

  const [borradores] = await pool.query(`
    SELECT id, folio_completo FROM manifiestos
    WHERE estatus = 'borrador' AND (? IS NULL OR folio_completo = ? OR folio_completo LIKE CONCAT('%', ?))
    ORDER BY id DESC LIMIT 20`, [f, f, f]);
  if (borradores.length === 0) {
    return { mensaje: f ? `No hay un borrador con folio "${f}" (puede que ya esté grabado o cancelado).` : 'No hay borradores.' };
  }

  const [hallazgos] = await pool.query(`
    SELECT folio_completo, severidad, regla_clave, mensaje
    FROM v_validacion_manifiesto
    WHERE manifiesto_id IN (?)
    ORDER BY folio_completo, FIELD(severidad, 'bloqueante', 'advertencia', 'info'), regla_clave`,
    [borradores.map((b) => b.id)]);

  return borradores.map((b) => {
    const propios = hallazgos.filter((h) => h.folio_completo === b.folio_completo);
    return {
      folio: b.folio_completo,
      se_puede_grabar: !propios.some((h) => h.severidad === 'bloqueante'),
      hallazgos: propios,
    };
  });
}

// ---------------------------------------------------------------------------
// 7) Rankings: quién manda / transporta / recibe más residuos (sólo manifiestos grabados)
// ---------------------------------------------------------------------------
const COLUMNAS_RANKING = {
  generador: 'g.razon_social',
  transportista: 't.razon_social',
  centro_acopio: 'c.nombre',
  destino_final: 'd.razon_social',
  residuo: 'res.nombre',
  tipo_residuo: 'tr.nombre',
};

async function ranking({ agrupar_por, fecha_desde, fecha_hasta } = {}) {
  // Lista blanca: solo se aceptan columnas conocidas (evita inyección SQL)
  const col = COLUMNAS_RANKING[agrupar_por];
  if (!col) return { error: `agrupar_por debe ser uno de: ${Object.keys(COLUMNAS_RANKING).join(', ')}` };
  const desde = fechaONull(fecha_desde);
  const hasta = fechaONull(fecha_hasta);

  const [rows] = await pool.query(`
    SELECT ${col} AS nombre,
           COUNT(DISTINCT m.id) AS total_manifiestos,
           SUM(r.numero_envases) AS total_envases,
           SUM(r.peso_neto_kg) AS peso_total_kg,
           ROUND(SUM(r.peso_neto_kg) / 1000, 2) AS peso_total_ton,
           GROUP_CONCAT(DISTINCT m.folio_completo ORDER BY m.folio_completo SEPARATOR ', ') AS folios
    FROM manifiestos m
    JOIN manifiesto_renglones r ON r.manifiesto_id = m.id
    JOIN residuos res        ON res.id = r.residuo_id
    JOIN tipos_residuo tr    ON tr.id = res.tipo_residuo_id
    JOIN generadores g       ON g.id = m.generador_id
    LEFT JOIN transportistas t   ON t.id = m.transportista_id
    LEFT JOIN centros_acopio c   ON c.id = m.centro_acopio_id
    LEFT JOIN destinos_finales d ON d.id = m.destino_final_id
    WHERE m.estatus = 'grabado'
      AND (? IS NULL OR m.fecha_emision >= ?)
      AND (? IS NULL OR m.fecha_emision <= ?)
    GROUP BY ${col}
    ORDER BY peso_total_kg DESC`, [desde, desde, hasta, hasta]);

  return rows;
}

// ---------------------------------------------------------------------------
// 8) Alertas abiertas de los manifiestos
// ---------------------------------------------------------------------------
async function alertas_abiertas() {
  const [rows] = await pool.query(`
    SELECT m.folio_completo AS folio, a.severidad, a.regla_clave, a.mensaje, a.creada_en
    FROM manifiesto_alertas a
    JOIN manifiestos m ON m.id = a.manifiesto_id
    WHERE a.estatus = 'abierta'
    ORDER BY FIELD(a.severidad, 'bloqueante', 'advertencia', 'info'), a.creada_en DESC
    LIMIT 100`);
  return rows;
}

// Tabla de despacho: nombre que usa la IA -> función real
const funciones = {
  centros_para_residuo,
  transportistas_autorizados,
  autorizaciones_por_vencer,
  listar_manifiestos,
  historial_folio,
  validar_borrador,
  ranking,
  alertas_abiertas,
};

// Ejecuta una herramienta y SIEMPRE devuelve texto (un error también es texto,
// así la IA puede leerlo y explicarlo en lugar de que el servidor se caiga)
async function ejecutarHerramienta(nombre, argumentos) {
  const fn = funciones[nombre];
  if (!fn) return `Herramienta ${nombre} no encontrada.`;
  try {
    const resultado = await fn(argumentos);
    return JSON.stringify(resultado);
  } catch (e) {
    return `Error al consultar la base de datos: ${e.message}`;
  }
}

// ===========================================================================
// EL "MANUAL DE INSTRUCCIONES" PARA LA IA (Tool Schema)
// ===========================================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'centros_para_residuo',
      description:
        'Responde "¿a qué centro de acopio puedo mandar este residuo?". Devuelve los centros autorizados HOY (autorización ' +
        'activa y vigente, centro activo y con capacidad disponible) con su capacidad, y aparte los centros que NO pueden ' +
        'recibirlo con el motivo. Si se indica cantidad, dice si cabe en la capacidad disponible.',
      parameters: {
        type: 'object',
        properties: {
          residuo: { type: 'string', description: 'Nombre, clave interna o clave normativa del residuo (por ejemplo "aceite", "ACE-01" o "RP-08-01").' },
          cantidad: { type: 'number', description: 'Cantidad que se quiere enviar (opcional).' },
          unidad: { type: 'string', enum: ['kg', 't', 'L', 'm3', 'pza'], description: 'Unidad de la cantidad (por defecto kg).' },
        },
        required: ['residuo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transportistas_autorizados',
      description:
        'Transportistas con autorización vigente para un residuo o tipo de residuo, con sus unidades habilitadas y choferes ' +
        'con licencia vigente. Úsala para "¿quién puede transportar X?" o "¿qué camión y chofer uso?".',
      parameters: {
        type: 'object',
        properties: {
          residuo: { type: 'string', description: 'Nombre o clave del residuo.' },
          tipo_residuo: { type: 'string', description: 'Nombre o clave del tipo de residuo (por ejemplo "LOD" o "lodos").' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'autorizaciones_por_vencer',
      description:
        'Autorizaciones de residuos que vencen en los próximos N días (centros de acopio, generadores, transportistas y ' +
        'vehículos) y documentos vencidos o por vencer (licencias de choferes, pólizas y verificaciones de vehículos, firmas ' +
        'de receptores). dias_restantes negativo = ya vencido.',
      parameters: {
        type: 'object',
        properties: { dias: { type: 'integer', description: 'Ventana en días (por defecto 30).' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_manifiestos',
      description:
        'Lista manifiestos con totales (partidas, envases, peso), transporte, ruta, destino, imágenes, notificación y alertas. ' +
        'Filtra por folio, generador (clave o razón social), estatus, tipo y rango de fechas de emisión.',
      parameters: {
        type: 'object',
        properties: {
          folio: { type: 'string', description: 'Folio completo o parcial.' },
          generador: { type: 'string', description: 'Clave (GEN-001) o parte de la razón social del generador.' },
          estatus: { type: 'string', enum: ['borrador', 'grabado', 'cancelado'] },
          tipo: { type: 'string', enum: ['entrada', 'salida'] },
          fecha_desde: { type: 'string', description: 'Fecha mínima AAAA-MM-DD.' },
          fecha_hasta: { type: 'string', description: 'Fecha máxima AAAA-MM-DD.' },
          limite: { type: 'integer', description: 'Máximo de manifiestos (por defecto 20).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'historial_folio',
      description:
        'Todo sobre un folio: encabezado, generador y dirección, partidas, transporte, ruta, destino final, observaciones, ' +
        'imágenes, PDF, eventos de trazabilidad (y si la cadena de hashes está íntegra) y alertas.',
      parameters: {
        type: 'object',
        properties: { folio: { type: 'string', description: 'Folio completo o sus últimos dígitos (por ejemplo "0983").' } },
        required: ['folio'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validar_borrador',
      description:
        'Revisa si un manifiesto en borrador se puede grabar: devuelve los hallazgos bloqueantes y advertencias según las ' +
        'autorizaciones vigentes. Sin folio revisa todos los borradores.',
      parameters: {
        type: 'object',
        properties: { folio: { type: 'string', description: 'Folio del borrador (opcional).' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ranking',
      description:
        'Ranking por peso total (kg y toneladas) y número de manifiestos grabados, agrupado por generador, transportista, ' +
        'centro de acopio, destino final, residuo o tipo de residuo.',
      parameters: {
        type: 'object',
        properties: {
          agrupar_por: { type: 'string', enum: Object.keys(COLUMNAS_RANKING) },
          fecha_desde: { type: 'string', description: 'Fecha mínima AAAA-MM-DD (opcional).' },
          fecha_hasta: { type: 'string', description: 'Fecha máxima AAAA-MM-DD (opcional).' },
        },
        required: ['agrupar_por'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alertas_abiertas',
      description: 'Alertas abiertas de los manifiestos (advertencias generadas al grabar o capturadas a mano).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ===========================================================================
// ENDPOINT DEL CHAT
// ===========================================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    // Fecha de hoy en México, para que la IA sepa contra qué comparar vencimientos
    const hoy = new Date().toLocaleDateString('es-MX', {
      timeZone: 'America/Mexico_City', year: 'numeric', month: 'long', day: 'numeric',
    });

    // Instrucciones del agente (mensaje "system")
    const systemPrompt = {
      role: 'system',
      content:
        'Eres el asistente de SIREA, un sistema de captura de manifiestos de residuos (entrada y salida). ' +
        `Respondes siempre en español. La fecha de hoy es ${hoy}. ` +
        'Tienes herramientas que consultan la base de datos real: residuos, centros de acopio y sus autorizaciones, ' +
        'transportistas, choferes, vehículos, generadores, manifiestos, partidas, imágenes, eventos de trazabilidad y alertas. ' +
        'Para cualquier pregunta sobre esos temas USA las herramientas y nunca inventes datos; si necesitas combinar ' +
        'información, llama a varias herramientas. ' +
        'Las reglas de autorización (qué centro recibe qué residuo, qué transportista lleva qué tipo) están en la base de datos: ' +
        'no apliques reglas normativas de memoria. Si un centro no está autorizado, explica el motivo que devuelve la herramienta. ' +
        'Si la búsqueda de un residuo no encuentra nada en residuos_encontrados, dilo y pide la clave o un nombre más preciso. ' +
        'Un manifiesto puede estar en borrador, grabado (ya no se modifica) o cancelado. ' +
        'Clasificación CRETIB: C=Corrosivo, R=Reactivo, E=Explosivo, T=Tóxico, I=Inflamable, B=Biológico-Infeccioso. ' +
        'Si te preguntan algo que la base de datos no guarda (por ejemplo costos o tarifas), dilo claramente en lugar de suponer. ' +
        'Si una consulta no devuelve resultados, dilo tal cual. ' +
        'Escribe los pesos con separador de miles y su unidad. ' +
        'Presenta los resultados de forma clara y agrega una breve conclusión. ' +
        'No uses formato Markdown; usa texto plano con guiones para las listas. ' +
        'Si el usuario solo conversa o saluda, responde normal sin usar herramientas.',
    };

    // Construir el arreglo de mensajes combinando historial y mensaje actual
    const messages = [systemPrompt, ...(history || []), { role: 'user', content: message }];

    // Bucle del agente (máximo 6 vueltas para evitar un ciclo infinito)
    let reply = '';
    for (let vuelta = 1; vuelta <= 6; vuelta++) {

      // Llamada a la API a través de OpenRouter
      const completion = await openrouter.chat.completions.create({
        model: 'openai/gpt-4o-mini', // Puedes cambiarlo por cualquier modelo soportado por OpenRouter
        messages: messages,
        tools: tools, // le presentamos las herramientas a la IA
      });

      const respuestaIA = completion.choices[0].message;
      messages.push(respuestaIA); // guardamos la respuesta en la memoria

      // ¿La IA decidió usar una herramienta?
      if (respuestaIA.tool_calls && respuestaIA.tool_calls.length > 0) {
        for (const toolCall of respuestaIA.tool_calls) {
          const nombre = toolCall.function.name;

          // La IA envía los parámetros como texto; los convertimos a objeto
          let argumentos = {};
          try {
            argumentos = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            argumentos = {};
          }

          console.log(`\n[Vuelta ${vuelta}] La IA decidió usar: ${nombre}`);
          console.log('Argumentos que envió:', argumentos);

          // Ejecutamos la función real contra la base de datos
          const resultado = await ejecutarHerramienta(nombre, argumentos);
          console.log('Resultado (primeros 200 caracteres):', resultado.slice(0, 200));

          // Le devolvemos el resultado a la IA para la siguiente vuelta
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultado,
          });
        }
      } else {
        // Si NO pidió herramientas, terminó: esta es la respuesta final
        reply = respuestaIA.content;
        break;
      }
    }

    // Por si se agotaron las vueltas sin respuesta final
    if (!reply) {
      reply = 'Lo siento, no pude completar la consulta. Intenta reformular la pregunta.';
    }

    res.json({ reply });
  } catch (error) {
    console.error('Error al comunicarse con OpenRouter:', error);
    res.status(500).json({ error: 'Error interno al procesar la solicitud con la IA' });
  }
});

// Arranca el servidor sólo si se ejecuta directamente (node server-sirea.js)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT} (base: ${process.env.DB_NAME || 'sirea'})`);
  });
}

module.exports = { funciones, ejecutarHerramienta, pool };
