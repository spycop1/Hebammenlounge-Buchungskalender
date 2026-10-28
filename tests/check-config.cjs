// CI guard: only public Supabase credentials may be shipped to GitHub Pages.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const configSource = fs.readFileSync('config.js', 'utf8');
const context = { window: {} };
vm.runInNewContext(configSource, context, { timeout: 1000 });
const conf = context.window.LOUNGE_CONFIG;
assert(conf && typeof conf === 'object', 'LOUNGE_CONFIG fehlt');
const key = String(conf.supabaseKey || '');
const url = String(conf.supabaseUrl || '');
assert(/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url), 'Nur Supabase HTTPS Project URLs');
assert(!/\b(secret|service_role|sb_secret_)\b/i.test(key), 'Secret/Service Role Key gefunden!');
if (key.startsWith('eyJ')) {
  const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
  assert.notEqual(payload.role, 'service_role', 'SERVICE_ROLE im Frontend ist verboten!');
  assert.equal(payload.role, 'anon', 'Nur ANON JWT darf ins Frontend');
} else if (!key.includes('HIER_')) {
  assert(/^sb_publishable_/.test(key), 'Nur Supabase Publishable Key erlaubt');
}
console.log('Frontend-Key-Sicherheitsprüfung: OK');
