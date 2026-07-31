# Motor de Cooling Score — Inalcar

Backend real (no simulado) que evalúa cada lead conversado con "Nico" y dispara
acciones automáticas por WhatsApp cuando el lead se está enfriando.

## Qué hace

1. El bot reporta cada intercambio a `POST /track` (nombre, interés, presupuesto,
   tipo, etapa, score de compra).
2. Un Cron Trigger corre cada 30 minutos, calcula el **cooling score** de cada
   lead activo combinando:
   - score de compra (del LLM)
   - horas sin responder (con 2h de gracia antes de empezar a descontar)
   - número de interacciones (más mensajes = más comprometido, suma puntos)
   - si ya agendó visita (en ese caso el lead se considera convertido y deja
     de evaluarse)
3. Según el tier al que cae (CALIENTE / TIBIO / FRÍO / CONGELADO), dispara **una
   sola vez por tier** una acción real vía WhatsApp Cloud API:
   - **TIBIO** sin responder ≥6h → recordatorio automático al cliente.
   - **FRÍO** y el lead llegó a tener score ≥60 en algún momento → alerta al
     ejecutivo (`EXEC_PHONE`) para que llame.
   - **CONGELADO** (score muy bajo / inactividad prolongada) → mensaje único
     de reactivación al cliente y luego se archiva (deja de evaluarse).

La fórmula y los umbrales están en `cooling-worker.js` (constantes `GRACE_HOURS`,
`DECAY_PER_HOUR`, `MAX_DECAY`, `MAX_ENGAGEMENT_BOOST`, `TIERS`) — son un punto
de partida razonable, no un valor definitivo; conviene ajustarlos con datos
reales una vez que haya volumen de leads.

## Requisitos para desplegar

- Cuenta Cloudflare con Workers + D1 habilitado.
- Un número de WhatsApp Business con **WhatsApp Cloud API** (Meta) — el bot
  demo actual (`index.html`) es solo una simulación en el navegador y **no**
  está conectado a un número real de WhatsApp. Para que las acciones de este
  motor lleguen de verdad a un cliente, el flujo de conversación real (inbound
  + outbound) tiene que correr sobre WhatsApp Cloud API, no sobre el demo.

## Deploy

```bash
cd worker
npx wrangler d1 create inalcar-leads       # copiar el database_id a wrangler.toml
npx wrangler d1 execute inalcar-leads --file=./schema.sql --remote

npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put EXEC_PHONE
npx wrangler secret put TRACK_SECRET        # secreto compartido para autenticar /track

npx wrangler deploy
```

## Reportar un lead desde el bot

```js
fetch('https://inalcar-cooling.SU-USUARIO.workers.dev/track', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TRACK_SECRET}`,
  },
  body: JSON.stringify({
    id: telefonoE164,        // identificador único del lead
    nombre, interes, presupuesto, tipo, etapa,
    score,                   // score de compra que devolvió el LLM
    now: Date.now(),
  }),
});
```

`index.html` (el demo del navegador) ya hace este POST como ejemplo de
integración, apuntando a un `WORKER_URL` placeholder — no está desplegado.
