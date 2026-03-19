/**
 * PDF Purchase Order parser using Claude API.
 * Sends a PDF as base64 document and extracts structured line items.
 * Follows the same Anthropic API pattern as src/pages/api/chat.ts.
 */
import { env } from 'cloudflare:workers';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

export interface ParsedPO {
  supplier_name: string;
  po_number: string;
  line_items: ParsedLineItem[];
}

export interface ParsedLineItem {
  product_name: string;
  sku: string;
  quantity: number;
  unit_cost: number;
  description: string;
}

const SYSTEM_PROMPT = `You are a purchase order parser for a retail store. Extract structured data from supplier invoices and purchase orders.

Return ONLY valid JSON matching this exact schema — no markdown, no code fences, no explanation:

{
  "supplier_name": "string",
  "po_number": "string (the PO or invoice number)",
  "line_items": [
    {
      "product_name": "string (the product name, clean and readable)",
      "sku": "string (SKU, model number, or item number if present, otherwise empty string)",
      "quantity": number,
      "unit_cost": number (wholesale/unit price as a decimal, e.g. 12.99),
      "description": "string (brief description if available, otherwise empty string)"
    }
  ]
}

Rules:
- Extract ALL line items from the document
- If a field is not present, use empty string for strings and 0 for numbers
- For unit_cost, use the per-unit price (not line total)
- Clean up product names: remove excessive codes, normalize capitalization
- If the document is not a purchase order or invoice, return supplier_name as "UNKNOWN" and an empty line_items array`;

export async function parsePurchaseOrderPDF(
  pdfBase64: string,
  filename: string,
): Promise<ParsedPO> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: `Parse this purchase order/invoice PDF (filename: ${filename}). Return the structured JSON.`,
          },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Claude API error:', response.status, errorText);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const result = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = result.content.find(b => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('No text response from Claude');
  }

  // Parse JSON — handle potential code fences
  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed: ParsedPO = JSON.parse(jsonText);

    // Validate structure
    if (!parsed.line_items || !Array.isArray(parsed.line_items)) {
      throw new Error('Invalid response: missing line_items array');
    }

    // Normalize line items
    parsed.supplier_name = parsed.supplier_name || 'Unknown Supplier';
    parsed.po_number = parsed.po_number || '';
    parsed.line_items = parsed.line_items.map(item => ({
      product_name: item.product_name || 'Unknown Product',
      sku: item.sku || '',
      quantity: Math.max(1, Math.round(item.quantity || 1)),
      unit_cost: Math.max(0, Number(item.unit_cost) || 0),
      description: item.description || '',
    }));

    return parsed;
  } catch (err) {
    console.error('Failed to parse Claude response:', jsonText);
    throw new Error(`Failed to parse PDF extraction result: ${err instanceof Error ? err.message : String(err)}`);
  }
}
