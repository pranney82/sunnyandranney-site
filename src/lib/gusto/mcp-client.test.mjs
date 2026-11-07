import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_TOOLS, createMcpClient, identifyCompany } from './mcp-client.mjs';
import { GustoError } from './oauth.mjs';

const jsonReply = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json' } });
const toolReply = (id, value) => jsonReply(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });

/** A fake server: `tools` maps a tool name to what it answers for those arguments. */
function server(tools, { getToken = async () => 'tok', status, sendsHours = false, fillsPayroll = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const message = JSON.parse(init.body);
    calls.push({ url, message, headers: init.headers });
    if (status) {
      const code = status(calls.length, message);
      if (code) return new Response('', { status: code });
    }
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (message.method === 'initialize') return jsonReply(message.id, { protocolVersion: '2025-06-18' });
    const { name, arguments: args } = message.params;
    return toolReply(message.id, tools[name](args));
  };
  return { client: createMcpClient({ base: 'https://mcp.test', companyUuid: 'co', getToken, sendsHours, fillsPayroll, fetchImpl }), calls, fetchImpl };
}

test('nothing that changes data is on the allowed list', () => {
  for (const tool of READ_TOOLS) assert.match(tool, /^(get|list)_/);
  for (const tool of ['run_payroll', 'update_payroll', 'record_time', 'manage_company_members', 'pay_contractors']) {
    assert.equal(READ_TOOLS.has(tool), false);
  }
});

test('a tool off the list is refused before anything is sent', async () => {
  const { client, calls } = server({});
  await assert.rejects(client.callTool('run_payroll', { payroll_uuid: 'p' }), GustoError);
  assert.equal(calls.length, 0);
});

test('adding hours is refused unless the sign-in granted it, and nothing else opens up', async () => {
  const readOnly = server({ record_time: () => ({ uuid: 's1' }) });
  assert.equal(readOnly.client.readOnly, true);
  await assert.rejects(readOnly.client.recordTime({ company_member_uuid: 'e' }), GustoError);
  assert.equal(readOnly.calls.length, 0);

  const sending = server({ record_time: (args) => ({ uuid: 's1', args }) }, { sendsHours: true });
  assert.equal(sending.client.readOnly, false);
  const answer = await sending.client.recordTime({ company_member_uuid: 'e' });
  assert.equal(answer.uuid, 's1');
  assert.equal(answer.args.company_uuid, 'co');
  for (const tool of ['run_payroll', 'update_payroll', 'manage_company_members', 'pay_contractors']) {
    await assert.rejects(sending.client.callTool(tool, {}), GustoError);
  }
});

test('payroll hours need both permissions, and only an employee and hour lines ever reach Gusto', async () => {
  const sentArgs = [];
  const tools = {
    update_payroll: (args) => {
      sentArgs.push(args);
      return { success: true, after: { employee_compensations: [{ employee_uuid: 'e1' }] } };
    },
  };
  const withoutPayroll = server(tools, { sendsHours: true });
  assert.equal(withoutPayroll.client.fillsPayroll, false);
  await assert.rejects(withoutPayroll.client.setPayrollHours('p', []), GustoError);
  await assert.rejects(withoutPayroll.client.prepareDraft('p'), GustoError);
  await assert.rejects(withoutPayroll.client.callTool('update_payroll', {}), GustoError);

  const filling = server(tools, { sendsHours: true, fillsPayroll: true });
  assert.equal(filling.client.fillsPayroll, true);
  assert.deepEqual(await filling.client.prepareDraft('p'), [{ employee_uuid: 'e1' }]);
  await filling.client.setPayrollHours('p', [
    {
      employee_uuid: 'e1',
      excluded: true,
      reimbursements: [{ amount: '500' }],
      hourly_compensations: [{ name: 'Regular Hours', hours: '24.500', job_uuid: 'j1', extra: 'x' }],
    },
  ]);
  assert.deepEqual(sentArgs.at(-1), {
    company_uuid: 'co',
    payroll_uuid: 'p',
    employee_compensations: [{ employee_uuid: 'e1', hourly_compensations: [{ name: 'Regular Hours', hours: '24.500', job_uuid: 'j1' }] }],
  });
  await assert.rejects(
    filling.client.setPayrollHours('p', [{ employee_uuid: 'e1', hourly_compensations: [{ name: 'Regular Hours', hours: '-3', job_uuid: 'j1' }] }]),
    GustoError,
  );
  // Running payroll stays out of reach whatever the sign-in holds.
  await assert.rejects(filling.client.callTool('run_payroll', {}), GustoError);
});

test('starts the session once, then calls tools with the token', async () => {
  const { client, calls } = server({ get_token_info: () => ({ scope: 'a:read' }) });
  await client.callTool('get_token_info');
  await client.callTool('get_token_info');
  assert.deepEqual(calls.map((call) => call.message.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  assert.equal(calls[2].headers.Authorization, 'Bearer tok');
  assert.equal(calls[2].url, 'https://mcp.test/');
});

test('reads an answer that arrives as an event stream', async () => {
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    if (!('id' in message)) return new Response(null, { status: 202 });
    const result = message.method === 'initialize' ? {} : { content: [{ type: 'text', text: '{"ok":true}' }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const client = createMcpClient({ base: 'https://mcp.test', companyUuid: 'co', getToken: async () => 'tok', fetchImpl });
  assert.deepEqual(await client.callTool('get_company'), { ok: true });
});

test('an expired token earns one fresh token', async () => {
  const seen = [];
  const { client } = server(
    { get_company: () => ({ ok: true }) },
    {
      getToken: async (options) => {
        seen.push(options?.rejected ?? 'first');
        return options?.rejected ? 'new' : 'old';
      },
      status: (count) => (count === 1 ? 401 : 0),
    },
  );
  await client.callTool('get_company');
  assert.ok(seen.includes('old'));
});

test('a refused tool call is an error, not an empty answer', async () => {
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (message.method === 'initialize') return jsonReply(message.id, {});
    return jsonReply(message.id, { isError: true, content: [{ type: 'text', text: 'No such payroll' }] });
  };
  const client = createMcpClient({ base: 'https://mcp.test', companyUuid: 'co', getToken: async () => 'tok', fetchImpl });
  await assert.rejects(client.callTool('get_payroll', { payroll_uuid: 'x' }), /No such payroll/);
});

test('listPayrolls reads every page, in either shape Gusto uses', async () => {
  const pages = { 1: Array.from({ length: 100 }, (_, i) => ({ uuid: `p${i}` })), 2: { payrolls: [{ uuid: 'last' }], note: 'shortened' } };
  const { client, calls } = server({ list_payrolls: ({ page }) => pages[page] });
  const rows = await client.listPayrolls({ processing_statuses: 'processed' });
  assert.equal(rows.length, 101);
  assert.equal(calls.at(-1).message.params.arguments.company_uuid, 'co');
  assert.equal(calls.at(-1).message.params.arguments.processing_statuses, 'processed');
});

test('an unrecognised list is an error, never an empty list', async () => {
  const { client } = server({ list_employees: () => ({ something: 'else' }) });
  await assert.rejects(client.listEmployees(), /unreadable list/);
});

test('getPayroll gathers a payroll that arrives in pages', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ employee_uuid: `e${i}` }));
  const { client } = server({
    get_payroll: ({ employee_compensations_page: page = 1 }) => ({ uuid: 'p', employee_compensations: page === 1 ? full : [{ employee_uuid: 'last' }] }),
  });
  assert.equal((await client.getPayroll('p')).employee_compensations.length, 101);
});

const config = { base: 'https://mcp.test' };
const signIn = (info) => identifyCompany(config, { accessToken: 'tok', scopes: [] }, server({ get_token_info: () => info }).fetchImpl);
const company = { resource: { type: 'Company', uuid: 'co' }, accessible_resources: [{ uuid: 'co', name: 'Store' }] };

test('identifyCompany accepts a sign-in with no write boxes ticked, as read only', async () => {
  const found = await signIn({ ...company, scope: 'payrolls:read employees:read public secure_gusto_session:create' });
  assert.deepEqual(found, {
    companyUuid: 'co',
    companyName: 'Store',
    scopes: ['payrolls:read', 'employees:read', 'public', 'secure_gusto_session:create'],
    sendsHours: false,
    fillsPayroll: false,
  });
});

test('identifyCompany accepts adding time sheets, and marks the sign-in as able to send hours', async () => {
  const found = await signIn({
    ...company,
    scope: 'payrolls:read time_sheet:read time_sheet:write contractors:write employees:write signatories:manage public',
  });
  assert.equal(found.companyUuid, 'co');
  assert.equal(found.sendsHours, true);
});

test('identifyCompany turns away a sign-in that kept a write permission', async () => {
  assert.deepEqual(await signIn({ ...company, scope: 'payrolls:read payrolls:run' }), { problem: 'scopes' });
  assert.deepEqual(await signIn({ ...company, scope: 'employees:read employees:write' }), { problem: 'scopes' });
  assert.deepEqual(await signIn({ ...company, scope: 'time_sheet:write payrolls:write payrolls:run' }), { problem: 'scopes' });
  assert.deepEqual(await signIn({ ...company, scope: 'payrolls:read employees:write' }), { problem: 'scopes' });
});

test('identifyCompany turns away a sign-in with no company or no permissions listed', async () => {
  assert.deepEqual(await signIn({ scope: 'payrolls:read' }), { problem: 'company' });
  assert.deepEqual(await signIn({ ...company }), { problem: 'scopes' });
});
