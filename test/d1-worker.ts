/**
 * Minimal Worker entry for the Cloudflare Vitest pool.
 * Tests import package modules directly; this file only satisfies Wrangler.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("scheduler-d1-tests");
  },
};
