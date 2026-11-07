/**
 * Reaches the connected company through Gusto's MCP server. That server also has
 * tools that change data, including running payroll, so this client refuses any
 * tool that isn't listed here. It writes only two ways, each through its own
 * method that builds the arguments itself: adding a shift, and setting hour
 * lines on a draft payroll. Each needs the sign-in to have granted it.
 */
import { blockedScopes, canFillPayroll, canSendHours } from './mcp-oauth.mjs';
import { GustoError } from './oauth.mjs';

export const READ_TOOLS = new Set([
  'get_company',
  'get_payroll',
  'get_token_info',
  'list_employee_jobs',
  'list_employees',
  'list_payrolls',
  'list_pay_periods',
  'list_pay_schedules',
  'list_time_records',
]);

/** Adds a shift to Gusto's time tracking. */
export const SEND_HOURS_TOOL = 'record_time';

/** Edits a draft payroll. Can't run or submit one; this client only ever sends hour lines. */
export const FILL_PAYROLL_TOOL = 'update_payroll';

const MAX_PER_PAYROLL_UPDATE = 100;

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** The reply is either plain JSON or a stream of `data:` lines holding the same message. */
async function readMessage(res, id) {
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text);
  const messages = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)));
  return messages.find((message) => message.id === id) ?? null;
}

function toolOutput(result, name) {
  const text = (result?.content ?? []).find((part) => part.type === 'text')?.text ?? '';
  if (result?.isError) throw new GustoError(text.slice(0, 300) || `Gusto could not run ${name}.`, { definite: true });
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    throw new GustoError(`Gusto sent an unreadable answer to ${name}.`);
  }
}

export function createMcpClient({ base, companyUuid, getToken, sendsHours = false, fillsPayroll = false, fetchImpl = fetch }) {
  let nextId = 1;
  let sessionId = null;
  let starting = null;

  function send(message, token) {
    return fetchImpl(`${base}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function post(message) {
    let res;
    try {
      const token = await getToken();
      res = await send(message, token);
      // Gusto can revoke a token early, so one 401 earns one fresh token.
      if (res.status === 401) res = await send(message, await getToken({ rejected: token }));
    } catch (err) {
      if (err instanceof GustoError) throw err;
      throw new GustoError('Could not reach Gusto.');
    }
    if (res.status === 429) throw new GustoError('Gusto is busy. Try again in a minute.', { status: 429 });
    if (!res.ok) throw new GustoError(`Gusto answered ${res.status}.`, { status: res.status, definite: res.status < 500 });
    return res;
  }

  async function rpc(method, params) {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    let message;
    try {
      message = await readMessage(res, id);
    } catch {
      throw new GustoError('Gusto sent an unreadable answer.');
    }
    if (message?.error) throw new GustoError(message.error.message ?? 'Gusto refused the request.', { definite: true });
    if (!message) throw new GustoError('Gusto sent no answer.');
    return message.result;
  }

  function start() {
    starting ??= (async () => {
      await rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sunny-and-ranney-admin', version: '1.0.0' },
      });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((err) => {
      starting = null;
      throw err;
    });
    return starting;
  }

  async function invoke(name, args) {
    await start();
    return toolOutput(await rpc('tools/call', { name, arguments: args }), name);
  }

  /** Reads only. The two writes go through recordTime and setPayrollHours. */
  async function callTool(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new GustoError(`The admin does not allow ${name}.`, { definite: true });
    return invoke(name, args);
  }

  function requireWrite(granted, name) {
    if (!granted) throw new GustoError(`The admin does not allow ${name}.`, { definite: true });
  }

  /** The draft's roster. An empty update is how Gusto prepares a draft nobody has opened yet. */
  async function prepareDraft(payrollUuid) {
    requireWrite(fillsPayroll, FILL_PAYROLL_TOOL);
    const answer = await invoke(FILL_PAYROLL_TOOL, { company_uuid: companyUuid, payroll_uuid: payrollUuid, employee_compensations: [] });
    const roster = answer?.after?.employee_compensations;
    if (!Array.isArray(roster)) throw new GustoError('Gusto did not return the draft payroll.');
    return roster;
  }

  /**
   * Sets hour lines on a draft payroll. Gusto replaces the hours named, so
   * sending the same totals twice changes nothing. Only an employee and their
   * hour lines are passed on; bonuses, reimbursements and the rest never are.
   * @returns employees Gusto skipped
   */
  async function setPayrollHours(payrollUuid, updates) {
    requireWrite(fillsPayroll, FILL_PAYROLL_TOOL);
    const clean = updates.map((update) => ({
      employee_uuid: String(update.employee_uuid),
      hourly_compensations: update.hourly_compensations.map((line) => {
        if (!/^\d+(\.\d+)?$/.test(String(line.hours))) throw new GustoError('Refusing to send hours that are not a number.', { definite: true });
        return { name: String(line.name), hours: String(line.hours), job_uuid: String(line.job_uuid) };
      }),
    }));
    const notApplied = [];
    for (let i = 0; i < clean.length; i += MAX_PER_PAYROLL_UPDATE) {
      const answer = await invoke(FILL_PAYROLL_TOOL, {
        company_uuid: companyUuid,
        payroll_uuid: payrollUuid,
        employee_compensations: clean.slice(i, i + MAX_PER_PAYROLL_UPDATE),
      });
      if (answer?.success !== true) throw new GustoError('Gusto did not confirm the payroll hours.');
      notApplied.push(...(answer.not_applied?.employee_uuids ?? []));
    }
    return notApplied;
  }

  /** Every page of a list, so a long list can't come back silently cut off. */
  async function listAll(tool, key, args) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await callTool(tool, { ...args, company_uuid: companyUuid, page, per: PAGE_SIZE });
      const batch = Array.isArray(answer) ? answer : answer?.[key];
      if (!Array.isArray(batch)) throw new GustoError('Gusto sent an unreadable list.');
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
    throw new GustoError('That list is too long to read at once. Narrow the dates.');
  }

  /** A payroll over 100 people arrives in pages, and a short one must not pass for a whole one. */
  async function getPayroll(uuid) {
    const payroll = await callTool('get_payroll', { payroll_uuid: uuid, company_uuid: companyUuid, employee_compensations_per: PAGE_SIZE });
    let batch = payroll?.employee_compensations;
    for (let page = 2; Array.isArray(batch) && batch.length === PAGE_SIZE; page++) {
      if (page > MAX_PAGES) throw new GustoError('That payroll is too long to read.');
      const next = await callTool('get_payroll', {
        payroll_uuid: uuid,
        company_uuid: companyUuid,
        employee_compensations_per: PAGE_SIZE,
        employee_compensations_page: page,
      });
      batch = next?.employee_compensations ?? [];
      payroll.employee_compensations.push(...batch);
    }
    return payroll;
  }

  return {
    route: 'mcp',
    companyUuid,
    readOnly: !sendsHours,
    fillsPayroll: sendsHours && fillsPayroll,
    callTool,
    listEmployees: () => listAll('list_employees', 'employees'),
    listPayrolls: (query) => listAll('list_payrolls', 'payrolls', query),
    getPayroll,
    /** Gusto's own clock-ins and any time sheets, for a date range. */
    listTimeRecords: ({ start, end }) => callTool('list_time_records', { company_uuid: companyUuid, start_date: start, end_date: end }),
    recordTime: async (shift) => {
      requireWrite(sendsHours, SEND_HOURS_TOOL);
      return invoke(SEND_HOURS_TOOL, { company_uuid: companyUuid, ...shift });
    },
    prepareDraft,
    setPayrollHours,
  };
}

/**
 * Who a new sign-in belongs to, and what it may do. Gusto ticks every
 * permission by default and ignores what was requested, so a sign-in that kept
 * a Write box beyond adding time sheets is turned away.
 */
export async function identifyCompany(config, tokens, fetchImpl = fetch) {
  const client = createMcpClient({ base: config.base, companyUuid: '', getToken: async () => tokens.accessToken, fetchImpl });
  const info = await client.callTool('get_token_info');
  const scopes = typeof info?.scope === 'string' ? info.scope.split(/\s+/).filter(Boolean) : tokens.scopes;
  const blocked = blockedScopes(scopes);
  if (scopes.length === 0 || blocked.length > 0) {
    console.warn('Gusto sign-in refused. Permissions it kept:', blocked.join(' ') || '(none reported)');
    return { problem: 'scopes' };
  }

  const companyUuid = info?.resource?.type === 'Company' ? info.resource.uuid : null;
  if (!companyUuid) return { problem: 'company' };
  const listed = (info.accessible_resources ?? []).find((resource) => resource.uuid === companyUuid);
  return { companyUuid, companyName: listed?.name ?? null, scopes, sendsHours: canSendHours(scopes), fillsPayroll: canFillPayroll(scopes) };
}
