/**
 * Inalcar — Motor de Cooling Score
 *
 * Recibe eventos de conversación desde el bot "Nico" (POST /track) y,
 * vía un Cron Trigger, evalúa periódicamente cada lead activo para
 * detectar cuándo se está "enfriando" y disparar acciones reales:
 *   - recordatorio automático por WhatsApp al cliente
 *   - alerta por WhatsApp a un ejecutivo humano
 *   - mensaje final de reactivación antes de archivar el lead
 *
 * Requiere (wrangler secrets):
 *   WHATSAPP_TOKEN            token de acceso de WhatsApp Cloud API (Meta)
 *   WHATSAPP_PHONE_NUMBER_ID  phone_number_id del número de WhatsApp Business
 *   EXEC_PHONE                número (E.164) del ejecutivo que recibe alertas
 *   TRACK_SECRET              secreto compartido para autenticar el POST /track
 *
 * Requiere (wrangler.toml): binding D1 "DB" + cron trigger.
 */

// ---- Fórmula de cooling score --------------------------------------------
//
// cooling_score (0-100) estima qué tan "vivo" sigue el lead ahora mismo:
//   base       = último score de compra reportado por el LLM (0-100)
//   engagement = bonus por cantidad de interacciones (más mensajes = más
//                comprometido), tope +15
//   decay      = penalización por horas sin responder, con 2h de gracia
//                antes de empezar a enfriar, tope -85
//   agendo_visita = si ya agendó, se considera convertido: cooling_score
//                fijo en 100 y deja de evaluarse.
const GRACE_HOURS = 2;
const DECAY_PER_HOUR = 3;
const MAX_DECAY = 85;
const MAX_ENGAGEMENT_BOOST = 15;

const TIERS = {
  CALIENTE: 70,
  TIBIO: 40,
  FRIO: 15,
  // < 15 => CONGELADO
};

function coolingScore({ scoreCompra, horasInactivo, interacciones, agendoVisita }) {
  if (agendoVisita) return 100;
  const engagementBoost = Math.min(interacciones * 1.5, MAX_ENGAGEMENT_BOOST);
  const decay = horasInactivo > GRACE_HOURS
    ? Math.min((horasInactivo - GRACE_HOURS) * DECAY_PER_HOUR, MAX_DECAY)
    : 0;
  return Math.max(0, Math.min(100, Math.round(scoreCompra + engagementBoost - decay)));
}

function tierFor(score) {
  if (score >= TIERS.CALIENTE) return 'CALIENTE';
  if (score >= TIERS.TIBIO) return 'TIBIO';
  if (score >= TIERS.FRIO) return 'FRIO';
  return 'CONGELADO';
}

// ---- WhatsApp Cloud API ----------------------------------------------------

async function sendWhatsAppText(env, to, body) {
  const url = `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// ---- Mensajes por acción ---------------------------------------------------

function mensajeRecordatorioCliente(lead) {
  const nombre = lead.nombre ? lead.nombre.split(' ')[0] : '';
  const interes = lead.interes || 'el vehículo que conversamos';
  return `Hola${nombre ? ' ' + nombre : ''}, soy Nico de Inalcar 👋 ¿Sigue interesado en ${interes}? ` +
    `Puedo ayudarle a agendar una visita cuando le acomode.`;
}

function mensajeAlertaEjecutivo(lead) {
  return `⚠️ Lead enfriándose: ${lead.nombre || lead.id} (${lead.id}). ` +
    `Score de compra máx: ${lead.score_compra_max}. Interés: ${lead.interes || 's/i'}. ` +
    `Sin responder hace ${Math.round((Date.now() - lead.ultima_interaccion) / 3600000)}h. ` +
    `Se recomienda contacto directo.`;
}

function mensajeReactivacionFinal(lead) {
  const nombre = lead.nombre ? lead.nombre.split(' ')[0] : '';
  return `Hola${nombre ? ' ' + nombre : ''}, antes de cerrar su consulta en Inalcar: ` +
    `si retoma el interés, escríbanos y con gusto revisamos condiciones especiales vigentes. ¡Que esté muy bien!`;
}

// ---- /track: el frontend reporta cada intercambio de mensaje --------------

async function handleTrack(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (env.TRACK_SECRET && auth !== `Bearer ${env.TRACK_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.json();
  const { id, nombre, interes, presupuesto, tipo, etapa, score } = body;
  if (!id) return new Response('Missing id', { status: 400 });

  const now = body.now || Date.now(); // el frontend envía el timestamp (Workers no permite Date.now() determinístico en algunos runtimes de test, pero en producción es fine)
  const agendoVisita = etapa === 'listo_para_visita' ? 1 : 0;

  const existing = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();

  if (!existing) {
    await env.DB.prepare(`
      INSERT INTO leads (id, nombre, interes, presupuesto, tipo, etapa, score_compra, score_compra_max,
        interacciones, agendo_visita, primera_interaccion, ultima_interaccion, cooling_score, temperatura, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).bind(id, nombre, interes, presupuesto, tipo, etapa, score || 0, score || 0,
      agendoVisita, now, now, score || 0, tierFor(score || 0), now).run();
    return Response.json({ ok: true, created: true });
  }

  const scoreCompraMax = Math.max(existing.score_compra_max, score || 0);
  await env.DB.prepare(`
    UPDATE leads SET nombre = ?, interes = ?, presupuesto = ?, tipo = ?, etapa = ?,
      score_compra = ?, score_compra_max = ?, interacciones = interacciones + 1,
      agendo_visita = ?, ultima_interaccion = ?, updated_at = ?
    WHERE id = ?
  `).bind(nombre, interes, presupuesto, tipo, etapa, score || 0, scoreCompraMax,
    agendoVisita, now, now, id).run();

  return Response.json({ ok: true, created: false });
}

// ---- Cron: evalúa todos los leads activos y dispara acciones --------------

async function evaluateLeads(env, now) {
  const { results } = await env.DB.prepare('SELECT * FROM leads WHERE archivado = 0').all();
  let evaluated = 0, actioned = 0;

  for (const lead of results) {
    evaluated++;
    const horasInactivo = (now - lead.ultima_interaccion) / 3_600_000;
    const score = coolingScore({
      scoreCompra: lead.score_compra,
      horasInactivo,
      interacciones: lead.interacciones,
      agendoVisita: !!lead.agendo_visita,
    });
    const tier = tierFor(score);

    let accion = null;
    let mensaje = null;
    let destinatario = null;

    if (lead.agendo_visita) {
      // Convertido: no se evalúa más, pero se deja registrado.
    } else if (tier === 'TIBIO' && lead.ultima_accion_tier !== 'TIBIO' && horasInactivo >= 6) {
      accion = 'recordatorio_cliente';
      mensaje = mensajeRecordatorioCliente(lead);
      destinatario = lead.id;
    } else if (tier === 'FRIO' && lead.ultima_accion_tier !== 'FRIO' && lead.score_compra_max >= 60) {
      accion = 'alerta_ejecutivo';
      mensaje = mensajeAlertaEjecutivo(lead);
      destinatario = env.EXEC_PHONE;
    } else if (tier === 'CONGELADO' && lead.ultima_accion_tier !== 'CONGELADO') {
      accion = 'reactivacion_final';
      mensaje = mensajeReactivacionFinal(lead);
      destinatario = lead.id;
    }

    if (accion && destinatario) {
      try {
        await sendWhatsAppText(env, destinatario, mensaje);
        await env.DB.prepare(`
          INSERT INTO lead_actions (lead_id, tier, accion, detalle, created_at) VALUES (?, ?, ?, ?, ?)
        `).bind(lead.id, tier, accion, mensaje, now).run();
        actioned++;
      } catch (err) {
        await env.DB.prepare(`
          INSERT INTO lead_actions (lead_id, tier, accion, detalle, created_at) VALUES (?, ?, ?, ?, ?)
        `).bind(lead.id, tier, `${accion}_error`, String(err), now).run();
      }
    }

    const archivar = tier === 'CONGELADO' && accion === null && lead.ultima_accion_tier === 'CONGELADO';
    await env.DB.prepare(`
      UPDATE leads SET cooling_score = ?, temperatura = ?, ultima_accion_tier = ?, archivado = ?, updated_at = ?
      WHERE id = ?
    `).bind(score, tier, accion ? tier : lead.ultima_accion_tier, archivar ? 1 : 0, now, lead.id).run();
  }

  return { evaluated, actioned };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/track') {
      return handleTrack(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(evaluateLeads(env, Date.now()));
  },
};

export { coolingScore, tierFor };
