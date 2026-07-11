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
//   ANTHROPIC_API_KEY  – your Anthropic API key
//   PROXY_SECRET       – a long random string used as the URL path
// Optional var (wrangler.toml [vars]): ALLOW_ORIGIN – lock CORS to your site's origin.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) })
    }

    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/+/, '')
    if (!env.PROXY_SECRET || path !== env.PROXY_SECRET) {
      return new Response('not found', { status: 404, headers: cors(env) })
    }

    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: cors(env) })
    }

    const body = await request.text()
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    })

    const headers = new Headers(upstream.headers)
    for (const [k, v] of Object.entries(cors(env))) headers.set(k, v)
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}

function cors(env) {
  return {
    'access-control-allow-origin': (env && env.ALLOW_ORIGIN) || '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }
}
