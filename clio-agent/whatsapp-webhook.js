// whatsapp-webhook.js: Meta webhook verification, parsing, and Express routes.
const crypto = require('crypto');

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch { return false; }
}

function parseWebhook(payload) {
  const messages = [];
  const statuses = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c?.profile?.name || '';
      for (const m of v.messages || []) {
        messages.push({
          from: m.from,
          name: names[m.from] || '',
          wa_message_id: m.id,
          body: m.text?.body || (m.type !== 'text' ? `[${m.type}]` : ''),
          type: m.type,
          timestamp: m.timestamp
        });
      }
      for (const s of v.statuses || []) {
        statuses.push({ wa_message_id: s.id, status: s.status, recipient: s.recipient_id });
      }
    }
  }
  return { messages, statuses };
}

// mount(app, deps): deps = { onInbound(msg), onStatus(st) }
function mount(app, deps) {
  app.get('/api/whatsapp/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/api/whatsapp/webhook',
    require('express').raw({ type: 'application/json' }),
    (req, res) => {
      if (!verifySignature(req.body, req.header('x-hub-signature-256'))) {
        return res.sendStatus(401);
      }
      let payload;
      try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
      const { messages, statuses } = parseWebhook(payload);
      // Respond immediately; process async. Meta retries on non-200.
      res.sendStatus(200);
      for (const m of messages) Promise.resolve(deps.onInbound(m)).catch(e => console.error('[wa] inbound err:', e.message));
      for (const s of statuses) Promise.resolve(deps.onStatus(s)).catch(e => console.error('[wa] status err:', e.message));
    });
}

module.exports = { verifySignature, parseWebhook, mount };
