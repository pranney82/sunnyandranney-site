import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedScopes, canFillPayroll, canSendHours, challengeFor, createVerifier } from './mcp-oauth.mjs';

test('the PKCE challenge is the standard hash of the verifier', async () => {
  // The worked example from RFC 7636, appendix B.
  assert.equal(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.match(createVerifier(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createVerifier(), createVerifier());
});

test('blockedScopes lets through reads, adding time sheets and the extras Gusto always adds, and nothing unknown', () => {
  const allowed = ['payrolls:read', 'company_reports:read:excludes_sensitive_columns', 'public', 'webhook_subscriptions:write', 'time_sheet:write'];
  assert.deepEqual(blockedScopes(allowed), []);
  assert.deepEqual(blockedScopes(['payrolls:read', 'payrolls:run', 'employees:write']), ['payrolls:run', 'employees:write']);
  assert.deepEqual(blockedScopes(['time_sheet:write', 'something:new']), ['something:new']);
  assert.deepEqual(blockedScopes(['payrolls:run', 'company_bank_accounts:write']), ['payrolls:run', 'company_bank_accounts:write']);
});

test("Gusto's Payment data box passes as a whole, but running payroll never does", () => {
  // Exactly what the Payment data write box granted on the demo company.
  const paymentData = ['payrolls:write', 'compensations:write'];
  assert.deepEqual(blockedScopes(['payrolls:read', ...paymentData]), []);
  assert.deepEqual(blockedScopes(['payrolls:read', 'compensations:write']), ['compensations:write']);
  assert.deepEqual(blockedScopes([...paymentData, 'payrolls:run']), ['payrolls:run']);
});

test('filling the payroll needs both adding time sheets and editing payroll drafts', () => {
  assert.equal(canFillPayroll(['time_sheet:write', 'payrolls:write']), true);
  assert.equal(canFillPayroll(['payrolls:write']), false);
  assert.equal(canFillPayroll(['time_sheet:write']), false);
});

test("Gusto's Team data box passes as a whole, but its extras never pass without adding time sheets", () => {
  // Exactly what the Team data write box granted on the demo company.
  const teamData = ['time_sheet:write', 'contractors:write', 'employees:write', 'signatories:manage'];
  assert.deepEqual(blockedScopes(['payrolls:read', ...teamData]), []);
  assert.deepEqual(blockedScopes(['payrolls:read', 'employees:write', 'signatories:manage']), ['employees:write', 'signatories:manage']);
  // Pay rates, payroll and bank stay refused even alongside it.
  assert.deepEqual(blockedScopes([...teamData, 'compensations:write', 'payrolls:run', 'company_bank_accounts:write']), [
    'compensations:write',
    'payrolls:run',
    'company_bank_accounts:write',
  ]);
});

test('only a sign-in holding the time-sheet write permission can send hours', () => {
  assert.equal(canSendHours(['payrolls:read', 'time_sheet:write']), true);
  assert.equal(canSendHours(['payrolls:read', 'time_sheet:read']), false);
  assert.equal(canSendHours(null), false);
});
