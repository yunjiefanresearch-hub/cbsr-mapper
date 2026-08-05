// Authenticated proxy for the Anthropic Messages API.
//
// The mapper POSTs { model, max_tokens, messages, ... } here with only a
// Content-Type header (no key). This Worker adds your API key + anthropic-version
// and forwards to Anthropic, with CORS so a browser can call it.
//
// PROTECTION: the request must hit https://<worker>/<PROXY_SECRET>. Anything else
// gets a 404. This keeps random callers (who ignore CORS anyway) from spending your
// Anthropic credits. Point the mapper's window.__CBSR_LLM_PROXY__ at the full URL
// INCLUDING that secret path segment.
//
// Set these with `wrangler secret put ...` (never hard-code them):
//   ANTHROPIC_API_KEY  - your Anthropic API key
//   PROXY_SECRET       - a long random string used as the URL path
// Optional var (wrangler.toml [vars]): ALLOW_ORIGIN - lock CORS to your site's origin.
//
// HEALTH CHECK: GET https://<worker>/<PROXY_SECRET> returns a small JSON status so you can
// confirm the secret path and the key binding WITHOUT spending a single token. Open it in a
// browser tab; if you get JSON back, the mapper will work when you paste the same URL.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) })
    }

    const url = new URL(request.url)
    // Strip BOTH leading and trailing slashes. A trailing slash on an otherwise correct proxy
    // URL used to 404, which reads to the user as "the proxy is broken".
    const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')

    if (!env.PROXY_SECRET) {
      // Distinguish "setup unfinished" from "wrong URL". This leaks nothing an operator does
      // not already know, and it is the single most common setup mistake.
      return json({ error: 'PROXY_SECRET is not set on this Worker. Run: wrangler secret put PROXY_SECRET' }, 503, env)
    }
    if (path !== env.PROXY_SECRET) {
      return new Response('not found', { status: 404, headers: cors(env) })
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      return json({
        ok: true,
        service: 'cbsr-ai-proxy',
        secret_path: 'matched',
        api_key_configured: !!env.ANTHROPIC_API_KEY,
        allow_origin: (env && env.ALLOW_ORIGIN) || '*',
        hint: env.ANTHROPIC_API_KEY
          ? 'Ready. Paste this exact URL into the mapper.'
          : 'Missing key. Run: wrangler secret put ANTHROPIC_API_KEY',
      }, 200, env)
    }

    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: cors(env) })
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY is not set on this Worker. Run: wrangler secret put ANTHROPIC_API_KEY' }, 503, env)
    }

    const body = await request.text()

    let upstream
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      })
    } catch (e) {
      // Without this, an upstream failure surfaced in the browser as an opaque CORS error,
      // because a thrown Worker exception carries no CORS headers.
      return json({ error: 'upstream fetch failed: ' + (e && e.message ? e.message : String(e)) }, 502, env)
    }

    const headers = new Headers(upstream.headers)
    for (const [k, v] of Object.entries(cors(env))) headers.set(k, v)
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}

function json(obj, status, env) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  for (const [k, v] of Object.entries(cors(env))) headers.set(k, v)
  return new Response(JSON.stringify(obj, null, 2), { status, headers })
}

function cors(env) {
  return {
    'access-control-allow-origin': (env && env.ALLOW_ORIGIN) || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  }
}
