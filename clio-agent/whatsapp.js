// whatsapp.js: Meta WhatsApp Cloud API sender. Fail-soft: never throws.
const GRAPH_VERSION = 'v20.0';

let _fetch = global.fetch;
function _setFetch(fn) { _fetch = fn; }

function configured() {
  return !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN
    && process.env.WHATSAPP_ENABLED === 'true');
}

function normalizeNumber(n) {
  return String(n || '').replace(/[^\d]/g, '');
}

async function post(payload) {
  if (!configured()) {
    console.warn('[wa] skipped, Meta credentials not configured');
    return null;
  }
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const res = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[wa] API error', res.status, data?.error?.message || '');
      return null;
    }
    return { wa_message_id: data?.messages?.[0]?.id || null, raw: data };
  } catch (err) {
    console.error('[wa] send failed:', err.message);
    return null;
  }
}

async function sendText(to, body) {
  return post({ to: normalizeNumber(to), type: 'text', text: { body } });
}

async function sendTemplate(to, name, language = 'en_US', components = []) {
  return post({
    to: normalizeNumber(to),
    type: 'template',
    template: { name, language: { code: language }, components }
  });
}

module.exports = { sendText, sendTemplate, configured, normalizeNumber, _setFetch };
