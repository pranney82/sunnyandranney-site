/**
 * Every Workers AI call goes through this site's AI Gateway:
 *
 *   ai.run(MODEL, input, viaGateway('chat'))
 *
 * The gateway (Cloudflare → AI → AI Gateway → sunnyandranney-site) counts the
 * store's AI apart from SOARD's, which shares the Cloudflare account, and caps
 * it if something ever loops: calls an hour for the store, dollars a day for the
 * store and for each feature, so a busy chat can't stop the product sync.
 * `feature` is the name shown beside the numbers. Nothing customers type is
 * logged: the gateway's own log setting is off, and collectLog says so again on
 * each call.
 */
const GATEWAY_ID = 'sunnyandranney-site';

/** Cloudflare turned the call away at a cap: 2003 the gateway's calls an hour, 2045 a spend limit */
export const aiCapped = (err: unknown) => /^\s*(2003|2045):/.test(String((err as Error)?.message || ''));

export function viaGateway(feature: string) {
  return {
    gateway: { id: GATEWAY_ID, collectLog: false, metadata: { feature } },
    tags: [`${GATEWAY_ID}:${feature}`],
  };
}
