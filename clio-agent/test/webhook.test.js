// test/webhook.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifySignature, parseWebhook } = require('../whatsapp-webhook');

test('verifySignature accepts a valid HMAC and rejects a bad one', () => {
  process.env.WHATSAPP_APP_SECRET = 'shh';
  const raw = Buffer.from('{"a":1}');
  const good = 'sha256=' + crypto.createHmac('sha256', 'shh').update(raw).digest('hex');
  assert.strictEqual(verifySignature(raw, good), true);
  assert.strictEqual(verifySignature(raw, 'sha256=' + '0'.repeat(64)), false);
  assert.strictEqual(verifySignature(raw, undefined), false);
});

test('parseWebhook extracts inbound messages', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: 'Sara' }, wa_id: '966501234567' }],
    messages: [{ from: '966501234567', id: 'wamid.IN1', timestamp: '1723960000', text: { body: 'On my way' }, type: 'text' }]
  } }] }] };
  const out = parseWebhook(payload);
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0].from, '966501234567');
  assert.strictEqual(out.messages[0].body, 'On my way');
  assert.strictEqual(out.messages[0].name, 'Sara');
});

test('parseWebhook extracts status updates', () => {
  const payload = { entry: [{ changes: [{ value: {
    statuses: [{ id: 'wamid.OUT1', status: 'delivered', recipient_id: '966501234567' }]
  } }] }] };
  const out = parseWebhook(payload);
  assert.strictEqual(out.statuses.length, 1);
  assert.strictEqual(out.statuses[0].wa_message_id, 'wamid.OUT1');
  assert.strictEqual(out.statuses[0].status, 'delivered');
});
