/**
 * Connecting through Gusto's MCP server, which is how a Gusto customer reaches
 * their own company. It needs PKCE. Apart from reads, the admin uses only two
 * permissions: adding time sheets, and setting hours on a draft payroll.
 */
export const MCP_HOSTS = {
  demo: 'https://mcp.api.gusto-demo.com',
  production: 'https://mcp.api.gusto.com',
};

export const MCP_SCOPES = [
  'companies:read',
  'compensations:read',
  'employees:read',
  'employments:read',
  'jobs:read',
  'pay_schedules:read',
  'payrolls:read',
  'time_sheet:read',
  'time_sheet:write',
  'payrolls:write',
].join(' ');

/** Lets the admin add approved shifts to Gusto's time tracking. */
export const SEND_HOURS_SCOPE = 'time_sheet:write';

/** Lets the admin set hours on a draft payroll. Running or submitting payroll is `payrolls:run`, never accepted. */
export const FILL_PAYROLL_SCOPE = 'payrolls:write';

const toBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createVerifier() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Gusto adds these to every sign-in, and its screen has no box to remove them.
 * Anything else that isn't a read permission, or adding time sheets, means a
 * Write box the store doesn't need was left ticked.
 */
const ALWAYS_GRANTED = new Set([
  'company_reports:write:excludes_sensitive_columns',
  'public',
  'retirement_plan_applications:create',
  'salary_estimates:write',
  'secure_gusto_session:create',
  'webhook_subscriptions:write',
]);

/**
 * Gusto has no box for time sheets alone. Its Write "Team data" box, the only
 * one that adds time sheets, also grants these (checked on the demo company,
 * 2026-11-07). Peter accepted them on 2026-11-07 so hours can be sent. The
 * client never calls a tool that uses them.
 */
const TEAM_DATA_EXTRAS = new Set(['contractors:write', 'employees:write', 'signatories:manage']);

/**
 * Likewise, Gusto's Write "Payment data" box, the only one that edits draft
 * payrolls, also grants changing pay rates (checked on the demo company,
 * 2026-11-07). Peter accepted it on 2026-11-07 so hours land on the payroll.
 * The client never calls a tool that uses it.
 */
const PAYMENT_DATA_EXTRAS = new Set(['compensations:write']);

/** Granted permissions the admin refuses to hold. Each box's extras only pass alongside the permission the admin uses from it. */
export function blockedScopes(scopes) {
  const sendsHours = scopes.includes(SEND_HOURS_SCOPE);
  const fillsPayroll = scopes.includes(FILL_PAYROLL_SCOPE);
  return scopes.filter(
    (scope) =>
      !/:read(:|$)/.test(scope) &&
      !ALWAYS_GRANTED.has(scope) &&
      scope !== SEND_HOURS_SCOPE &&
      scope !== FILL_PAYROLL_SCOPE &&
      !(sendsHours && TEAM_DATA_EXTRAS.has(scope)) &&
      !(fillsPayroll && PAYMENT_DATA_EXTRAS.has(scope)),
  );
}

/** Whether a sign-in can add hours to Gusto, or only read. */
export function canSendHours(scopes) {
  return Array.isArray(scopes) && scopes.includes(SEND_HOURS_SCOPE);
}

/** Whether a sign-in can also put those hours on the draft payroll. */
export function canFillPayroll(scopes) {
  return canSendHours(scopes) && scopes.includes(FILL_PAYROLL_SCOPE);
}
