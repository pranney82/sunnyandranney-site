/**
 * Every Workers AI call goes through this site's AI Gateway:
 *
 *   ai.run(MODEL, input, viaGateway('chat'))
 *
 * The gateway (Cloudflare → AI → AI Gateway → sunnyandranney-site) counts the
 * store's AI apart from SOARD's, which shares the Cloudflare account, and caps
 * it an hour at a time if something ever loops. `feature` is the name shown
 * beside the numbers. Nothing customers type is logged: the gateway's own log
 * setting is off, and collectLog says so again on each call.
 */
const GATEWAY_ID = 'sunnyandranney-site';

export function viaGateway(feature: string) {
  return {
    gateway: { id: GATEWAY_ID, collectLog: false, metadata: { feature } },
    tags: [`${GATEWAY_ID}:${feature}`],
  };
}
