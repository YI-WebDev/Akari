import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, extensionMessenger, MASTER } from './helpers.js';

let ext, send;

before(async () => {
  ext = await launch();
  ({ send } = await extensionMessenger(ext));
});
after(async () => ext && ext.close());

test('setup → save → lock → unlock', async () => {
  let r = await send('vault/status');
  assert.deepEqual(r, { ok: true, data: { initialized: false, locked: true } });

  r = await send('vault/setup', { masterPassword: MASTER });
  assert.equal(r.ok, true, JSON.stringify(r));

  r = await send('vault/saveItem', {
    item: { type: 'login', title: 'example.com', url: 'https://example.com/login', username: 'haruka', password: 'pw-1', vault: 'personal' },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const id = r.data.item.id;
  assert.ok(id);

  r = await send('vault/getAll');
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.vaults.length, 3);

  const local = await ext.sw.evaluate(() => chrome.storage.local.get(null));
  assert.ok(!JSON.stringify(local).includes('pw-1'));

  await send('vault/lock');
  r = await send('vault/getAll');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LOCKED');

  r = await send('vault/unlock', { masterPassword: 'wrong password' });
  assert.equal(r.error.code, 'BAD_PASSWORD');

  r = await send('vault/unlock', { masterPassword: MASTER });
  assert.equal(r.ok, true);
  r = await send('vault/getAll');
  assert.equal(r.data.items[0].password, 'pw-1');
});
