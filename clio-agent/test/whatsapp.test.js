// test/whatsapp.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const wa = require('../whatsapp');

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
  process.env.WHATSAPP_ACCESS_TOKEN = 'testtoken';
  process.env.WHATSAPP_ENABLED = 'true';
});

test('sendText posts to the Graph API with the right payload', async () => {
  let captured;
  wa._setFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.ABC' }] }) };
  });
  const result = await wa.sendText('+966501234567', 'hello');
  assert.strictEqual(captured.url, 'https://graph.facebook.com/v20.0/111222333/messages');
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.to, '966501234567');
  assert.strictEqual(body.text.body, 'hello');
  assert.strictEqual(captured.opts.headers.Authorization, 'Bearer testtoken');
  assert.strictEqual(result.wa_message_id, 'wamid.ABC');
});

test('sendTemplate builds a template payload', async () => {
  let captured;
  wa._setFetch(async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.T' }] }) }; });
  await wa.sendTemplate('+966501234567', 'hello_world', 'en_US', []);
  assert.strictEqual(captured.type, 'template');
  assert.strictEqual(captured.template.name, 'hello_world');
});

test('returns null and does not throw when unconfigured', async () => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  const result = await wa.sendText('+966501234567', 'hello');
  assert.strictEqual(result, null);
});

test('returns null on API error responses', async () => {
  wa._setFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad token' } }) }));
  const result = await wa.sendText('+966501234567', 'hello');
  assert.strictEqual(result, null);
});

test('kill switch: sendText resolves null without calling fetch when WHATSAPP_ENABLED is unset', async () => {
  delete process.env.WHATSAPP_ENABLED;
  wa._setFetch(async () => { throw new Error('fetch should not be called'); });
  const result = await wa.sendText('+966501234567', 'hello');
  assert.strictEqual(result, null);
});
