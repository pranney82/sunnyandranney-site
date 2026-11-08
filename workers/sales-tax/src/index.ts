/**
 * Sales tax worker: last month's Georgia sales tax numbers to the store, from
 * 8 AM Eastern on the 1st, with Shopify's report attached.
 *
 * The cron runs every 30 minutes; src/lib/sales-tax/run.mjs decides whether
 * there's anything to do, so most runs read one D1 row and stop. The admin's
 * Sales tax page (/admin/sales-tax/) shows what this last did.
 */

// @ts-ignore: plain JS module shared with the admin and its tests
import { maybeRunSalesTax } from '../../../src/lib/sales-tax/run.mjs';

export default {
  async scheduled(_controller: unknown, env: Record<string, unknown>): Promise<void> {
    const result = await maybeRunSalesTax(env);
    if (result.ran || result.why === 'error') console.log(JSON.stringify(result));
  },
};
