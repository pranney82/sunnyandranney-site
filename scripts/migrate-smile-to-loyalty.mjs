#!/usr/bin/env node
/**
 * One-time Smile.io → custom loyalty migration.
 *
 * Reads a CSV with columns: email,points,lifetime_earned (case-insensitive headers)
 * Optional column: vip_tier (recomputed from lifetime_earned if absent)
 *
 * Usage:
 *   node scripts/migrate-smile-to-loyalty.mjs \
 *     --csv ./smile-export.csv \
 *     --shop e89vsg-er.myshopify.com \
 *     --token <ADMIN_API_TOKEN> \
 *     [--dry-run]
 *
 * Steps:
 *   1. Bulk-export every customer from Shopify to build an email → GID map.
 *   2. Read the Smile CSV, join against the map, build metafieldsSet JSONL.
 *   3. Stage-upload the JSONL to Shopify.
 *   4. Kick off `bulkOperationRunMutation` wrapping metafieldsSet.
 *   5. Poll until DONE/FAILED/CANCELED.
 *
 * Rate-limit math: doing 5000 individual metafieldsSet calls at 2/s = 40min;
 * one bulk operation = a few minutes. Worth the staging dance.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';

const API_VERSION = '2026-04';

function parseArgs(arr) {
  const out = {};
  for (let i = 2; i < arr.length; i++) {
    const a = arr[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = arr[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

const args = parseArgs(argv);
if (!args.csv || !args.shop || !args.token) {
  console.error('Required: --csv <path> --shop <domain> --token <admin token> [--dry-run]');
  exit(1);
}

const GQL_URL = `https://${args.shop}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': args.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ─── Step 1: bulk-export every customer to build email → GID map ────────────

async function exportCustomers() {
  console.log('[1/4] Starting customer bulk export…');
  await gql(`mutation {
    bulkOperationRunQuery(query: """
      { customers { edges { node { id email } } } }
    """) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`);

  let op;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const data = await gql(`{ currentBulkOperation { id status errorCode url objectCount } }`);
    op = data.currentBulkOperation;
    process.stdout.write(`\r       status=${op.status} count=${op.objectCount ?? 0}    `);
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(op.status)) break;
  }
  console.log('');
  if (op.status !== 'COMPLETED') {
    throw new Error(`Customer export ${op.status}: ${op.errorCode ?? 'unknown'}`);
  }
  if (!op.url) {
    console.log('       (no customers found)');
    return new Map();
  }

  console.log(`[1/4] Downloading ${op.objectCount} customer rows…`);
  const res = await fetch(op.url);
  const text = await res.text();
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.email && row.id) {
      map.set(row.email.toLowerCase().trim(), row.id);
    }
  }
  console.log(`       Indexed ${map.size} customers by email.`);
  return map;
}

// ─── Step 2: build metafieldsSet JSONL ──────────────────────────────────────

function csvToRows(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const idx = {
    email: header.indexOf('email'),
    points: header.indexOf('points'),
    lifetime: header.indexOf('lifetime_earned'),
    tier: header.indexOf('vip_tier'),
  };
  if (idx.email === -1 || idx.points === -1) {
    throw new Error('CSV must have at minimum: email,points columns');
  }
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    return {
      lineNo: i + 2,
      email: cells[idx.email]?.toLowerCase().trim(),
      points: parseInt(cells[idx.points] || '0', 10) || 0,
      lifetime: idx.lifetime >= 0 ? parseInt(cells[idx.lifetime] || '0', 10) || 0 : null,
      tier: idx.tier >= 0 ? cells[idx.tier]?.trim() : null,
    };
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function computeTier(lifetime) {
  if (lifetime >= 2000) return 'Gold';
  if (lifetime >= 500) return 'Silver';
  return 'Bronze';
}

function buildJsonl(rows, emailMap) {
  const lines = [];
  const skipped = [];
  for (const row of rows) {
    if (!row.email) {
      skipped.push({ ...row, reason: 'no_email' });
      continue;
    }
    const gid = emailMap.get(row.email);
    if (!gid) {
      skipped.push({ ...row, reason: 'no_shopify_customer' });
      continue;
    }
    const lifetime = row.lifetime ?? row.points;
    const tier = row.tier ?? computeTier(lifetime);

    const metafields = [
      { ownerId: gid, namespace: '$app:loyalty', key: 'points', type: 'number_integer', value: String(row.points) },
      { ownerId: gid, namespace: '$app:loyalty', key: 'lifetime_earned', type: 'number_integer', value: String(lifetime) },
      { ownerId: gid, namespace: '$app:loyalty', key: 'vip_tier', type: 'single_line_text_field', value: tier },
    ];
    for (const m of metafields) {
      lines.push(JSON.stringify({ input: m }));
    }
  }
  return { jsonl: lines.join('\n') + '\n', skipped, importedCount: rows.length - skipped.length };
}

// ─── Step 3 + 4: stage upload, kick off bulk mutation, poll ────────────────

async function stageUpload(jsonl) {
  console.log('[3/4] Requesting staged upload target…');
  const staged = await gql(
    `mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "loyalty-import.jsonl",
        mimeType: "text/jsonl",
        httpMethod: POST
      }]) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
  );
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('stagedUploadsCreate returned no targets');

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), 'loyalty-import.jsonl');

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Staged upload failed: ${up.status} ${await up.text()}`);
  return target.resourceUrl;
}

async function runBulkMutation(stagedPath) {
  console.log('[4/4] Starting bulk metafieldsSet…');
  const mutation = `
    mutation call($input: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $input) {
        metafields { id }
        userErrors { field message }
      }
    }
  `.trim();

  const data = await gql(
    `mutation Bulk($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { mutation, stagedUploadPath: stagedPath },
  );

  const errs = data.bulkOperationRunMutation.userErrors;
  if (errs.length > 0) throw new Error(`bulkOperationRunMutation: ${JSON.stringify(errs)}`);

  let op;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = await gql(`{ currentBulkOperation(type: MUTATION) { id status errorCode url objectCount } }`);
    op = cur.currentBulkOperation;
    process.stdout.write(`\r       status=${op.status} processed=${op.objectCount ?? 0}    `);
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(op.status)) break;
  }
  console.log('');
  return op;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const csv = await readFile(args.csv, 'utf8');
  const rows = csvToRows(csv);
  console.log(`Parsed ${rows.length} rows from ${args.csv}`);

  const emailMap = await exportCustomers();

  console.log('[2/4] Building metafieldsSet JSONL…');
  const { jsonl, skipped, importedCount } = buildJsonl(rows, emailMap);
  console.log(`       Will write metafields for ${importedCount} customers. Skipped ${skipped.length}.`);
  if (skipped.length > 0) {
    const sample = skipped.slice(0, 5).map((s) => `${s.email || '(blank)'} - ${s.reason}`).join('\n         ');
    console.log(`       First skip reasons:\n         ${sample}`);
  }

  if (args.dryRun) {
    console.log('Dry run — not uploading. First 5 lines of JSONL:');
    console.log(jsonl.split('\n').slice(0, 5).join('\n'));
    return;
  }

  const stagedPath = await stageUpload(jsonl);
  const op = await runBulkMutation(stagedPath);
  if (op.status !== 'COMPLETED') {
    console.error(`Bulk operation ${op.status}: ${op.errorCode ?? ''}`);
    if (op.url) console.error(`Result file: ${op.url}`);
    exit(2);
  }
  console.log(`Done. Bulk operation ${op.id} completed; processed ${op.objectCount} mutations.`);
  if (op.url) console.log(`Result/error file: ${op.url}`);
}

main().catch((err) => {
  console.error('Migration failed:', err.message || err);
  exit(1);
});
