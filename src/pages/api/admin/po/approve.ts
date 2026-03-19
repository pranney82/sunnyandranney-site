import type { APIRoute } from 'astro';
import { getPurchaseOrder, updatePurchaseOrder, updateLineItem } from '@/lib/po-db';
import {
  createProduct,
  createStagedUpload,
  uploadToStagedTarget,
  attachProductMedia,
  adjustInventory,
  getPrimaryLocationId,
} from '@/lib/shopify-admin';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { poId } = await request.json() as { poId: string };
    if (!poId) {
      return new Response(
        JSON.stringify({ error: 'Missing poId' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const po = await getPurchaseOrder(poId);
    if (!po) {
      return new Response(
        JSON.stringify({ error: 'Purchase order not found' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }

    if (po.status === 'completed') {
      return new Response(
        JSON.stringify({ error: 'Purchase order already completed' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Mark as approved (in progress)
    await updatePurchaseOrder(poId, { status: 'approved' });

    const locationId = await getPrimaryLocationId();
    const results: Array<{
      line_item_id: string;
      product_name: string;
      action: string;
      success: boolean;
      error?: string;
      shopify_product_id?: string;
    }> = [];

    for (const item of po.items) {
      // Skip items marked as skipped
      if (item.match_status === 'skipped') {
        results.push({
          line_item_id: item.id,
          product_name: item.product_name,
          action: 'skipped',
          success: true,
        });
        continue;
      }

      // Skip already-created items
      if (item.match_status === 'created') {
        results.push({
          line_item_id: item.id,
          product_name: item.product_name,
          action: 'already_created',
          success: true,
        });
        continue;
      }

      try {
        if (item.match_status === 'new' || item.match_status === 'unmatched') {
          // Create new product in Shopify
          const product = await createProduct({
            title: item.product_name,
            descriptionHtml: item.description ? `<p>${item.description}</p>` : '',
            variants: [{
              price: String(item.retail_price || item.unit_cost || '0'),
              sku: item.sku || undefined,
              inventoryManagement: 'SHOPIFY',
            }],
          });

          const variantNode = product.variants.edges[0]?.node;

          // Upload image if available
          if (item.image_url) {
            try {
              // Fetch the image
              const imgResponse = await fetch(item.image_url);
              if (imgResponse.ok) {
                const imgBuffer = await imgResponse.arrayBuffer();
                const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
                const ext = mimeType.split('/')[1] || 'jpg';
                const filename = `${item.sku || item.product_name.replace(/\s+/g, '-')}.${ext}`;

                const staged = await createStagedUpload(filename, mimeType, imgBuffer.byteLength);
                const resourceUrl = await uploadToStagedTarget(staged, imgBuffer, mimeType);
                await attachProductMedia(product.id, resourceUrl, item.product_name);
              }
            } catch (imgErr) {
              console.error(`Image upload failed for "${item.product_name}":`, imgErr);
              // Non-fatal: product still created
            }
          }

          // Adjust inventory
          if (variantNode?.inventoryItem?.id && item.quantity > 0) {
            try {
              await adjustInventory(variantNode.inventoryItem.id, locationId, item.quantity);
            } catch (invErr) {
              console.error(`Inventory adjust failed for "${item.product_name}":`, invErr);
            }
          }

          // Update line item in D1
          await updateLineItem(item.id, {
            match_status: 'created',
            shopify_product_id: product.id,
            shopify_variant_id: variantNode?.id || '',
          });

          results.push({
            line_item_id: item.id,
            product_name: item.product_name,
            action: 'created',
            success: true,
            shopify_product_id: product.id,
          });

        } else if (item.match_status === 'matched' && item.shopify_variant_id) {
          // Adjust inventory for existing matched product
          // Need to get the inventory item ID from the variant
          // The variant ID is a GID, we need the inventory item ID
          // For matched items, we stored the variant ID but not the inventory item ID
          // We'll search again to get it
          try {
            const { searchProducts } = await import('@/lib/shopify-admin');
            const products = await searchProducts(`id:${item.shopify_product_id.replace('gid://shopify/Product/', '')}`);
            const matchedProduct = products[0];
            const matchedVariant = matchedProduct?.variants.edges.find(
              v => v.node.id === item.shopify_variant_id,
            )?.node;

            if (matchedVariant?.inventoryItem?.id && item.quantity > 0) {
              await adjustInventory(matchedVariant.inventoryItem.id, locationId, item.quantity);
            }

            await updateLineItem(item.id, { match_status: 'created' });

            results.push({
              line_item_id: item.id,
              product_name: item.product_name,
              action: 'inventory_updated',
              success: true,
              shopify_product_id: item.shopify_product_id,
            });
          } catch (matchErr: any) {
            console.error(`Inventory update failed for matched "${item.product_name}":`, matchErr);
            results.push({
              line_item_id: item.id,
              product_name: item.product_name,
              action: 'inventory_update_failed',
              success: false,
              error: matchErr?.message || 'Inventory update failed',
            });
          }
        }
      } catch (err: any) {
        console.error(`Approve error for "${item.product_name}":`, err?.message);
        results.push({
          line_item_id: item.id,
          product_name: item.product_name,
          action: 'error',
          success: false,
          error: err?.message || 'Unknown error',
        });
      }

      // Small delay between Shopify API calls to avoid throttling
      await new Promise(r => setTimeout(r, 500));
    }

    // Check if all succeeded
    const allSuccess = results.every(r => r.success);
    await updatePurchaseOrder(poId, {
      status: allSuccess ? 'completed' : 'failed',
    });

    return new Response(
      JSON.stringify({ status: allSuccess ? 'completed' : 'partial_failure', results }),
      { headers: JSON_HEADERS },
    );
  } catch (err: any) {
    console.error('PO approve error:', err?.message);
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to approve purchase order' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
