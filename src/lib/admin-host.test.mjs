import assert from 'node:assert/strict';
import test from 'node:test';
import { adminHostRedirect } from './admin-host.mjs';

const at = (href, method = 'GET') => adminHostRedirect(new URL(href), method);

test('the admin address opens on the admin and serves nothing else', () => {
  assert.equal(at('https://admin.sunnyandranney.com/'), 'https://admin.sunnyandranney.com/admin/');
  assert.equal(at('https://admin.sunnyandranney.com/shop/'), 'https://admin.sunnyandranney.com/admin/');
  assert.equal(at('https://admin.sunnyandranney.com/admin/hours/'), null);
  assert.equal(at('https://admin.sunnyandranney.com/api/admin/gusto/callback/?code=x'), null);
});

test('an admin page asked for on a store address moves to the admin address', () => {
  assert.equal(at('https://sunnyandranney.com/admin/hours/?week=2026-11-01'), 'https://admin.sunnyandranney.com/admin/hours/?week=2026-11-01');
  assert.equal(at('https://www.sunnyandranney.com/ADMIN'), 'https://admin.sunnyandranney.com/ADMIN');
});

test('the store itself, API calls, posts and other addresses are left alone', () => {
  assert.equal(at('https://sunnyandranney.com/'), null);
  assert.equal(at('https://sunnyandranney.com/administration-tips'), null);
  assert.equal(at('https://sunnyandranney.com/api/admin/hours/'), null);
  assert.equal(at('https://sunnyandranney.com/admin/', 'POST'), null);
  assert.equal(at('https://admin.sunnyandranney.com/', 'POST'), null);
  assert.equal(at('https://sunnyandranney-site.pages.dev/admin/'), null);
  assert.equal(at('http://localhost:4321/admin/'), null);
});
