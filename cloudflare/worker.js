export default {
  async fetch(request, env, ctx) {
    // Support both Module Worker (env param) and Service Worker (globals) deployments
    env = this._coerceEnv(env);
    const url = new URL(request.url);
    try {
      // Basic CORS for extension fetches
      if (request.method === 'OPTIONS') {
        return this._cors(new Response(null, { status: 204 }));
      }

      if (url.pathname === '/health' && request.method === 'GET') {
        return this._cors(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.pathname === '/env-ok' && request.method === 'GET') {
        const base = this._baseUrl(url);
        return this._cors(new Response(JSON.stringify({
          hasClientId: !!env.RAINDROP_CLIENT_ID,
          hasClientSecret: !!env.RAINDROP_CLIENT_SECRET,
          hasSessionSecret: !!env.SESSION_SECRET,
          callback: base + '/auth/callback'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.pathname === '/env-keys' && request.method === 'GET') {
        // Debug endpoint: show which env keys are visible (no values)
        const keys = Object.keys(env || {}).filter(k => !k.toLowerCase().includes('secret'));
        const globals = {
          hasGlobalClientId: this._hasGlobal('RAINDROP_CLIENT_ID'),
          hasGlobalClientSecret: this._hasGlobal('RAINDROP_CLIENT_SECRET'),
          hasGlobalSessionSecret: this._hasGlobal('SESSION_SECRET')
        };
        return this._cors(new Response(JSON.stringify({ keys, ...globals }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }

      if (url.pathname === '/auth/start' && request.method === 'GET') {
        return await this._authStart(url, env);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        return await this._authCallback(url, env);
      }
      if (url.pathname === '/auth/fetch' && request.method === 'GET') {
        return await this._authFetch(url, env);
      }
      if (url.pathname === '/token/refresh' && request.method === 'POST') {
        return await this._tokenRefresh(request, env);
      }

      return this._cors(new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    } catch (err) {
      return this._cors(new Response(JSON.stringify({ error: 'server_error', message: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
  },

  async _authStart(url, env) {
    env = this._coerceEnv(env);
    const extRedirect = url.searchParams.get('ext_redirect');
    if (!extRedirect) {
      return this._cors(new Response(JSON.stringify({ error: 'missing_param', param: 'ext_redirect' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    if (!env.RAINDROP_CLIENT_ID || !env.RAINDROP_CLIENT_SECRET) {
      console.log('Missing env vars', {
        hasClientId: !!env.RAINDROP_CLIENT_ID,
        hasClientSecret: !!env.RAINDROP_CLIENT_SECRET,
        hasSessionSecret: !!env.SESSION_SECRET
      });
      return this._cors(new Response(JSON.stringify({ error: 'missing_env', details: {
        RAINDROP_CLIENT_ID: !!env.RAINDROP_CLIENT_ID,
        RAINDROP_CLIENT_SECRET: !!env.RAINDROP_CLIENT_SECRET,
        SESSION_SECRET: !!env.SESSION_SECRET
      }}), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }

    const base = this._baseUrl(url);
    const statePayload = { ext_redirect: extRedirect, nonce: crypto.getRandomValues(new Uint32Array(1))[0].toString(16), t: Date.now() };
    const state = this._b64urlEncode(JSON.stringify(statePayload));

    const authorize = new URL('https://raindrop.io/oauth/authorize');
    authorize.searchParams.set('client_id', env.RAINDROP_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', `${base}/auth/callback`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('state', state);

    return Response.redirect(authorize.toString(), 302);
  },

  async _authCallback(url, env) {
    env = this._coerceEnv(env);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return new Response('Missing code/state', { status: 400 });
    }

    let statePayload;
    try {
      statePayload = JSON.parse(this._b64urlDecode(state));
    } catch {
      return new Response('Invalid state', { status: 400 });
    }
    const extRedirect = statePayload.ext_redirect;
    if (!extRedirect) {
      return new Response('Invalid state: no ext_redirect', { status: 400 });
    }

    // Exchange code for tokens
    const base = this._baseUrl(url);
    const tokenRes = await fetch('https://raindrop.io/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.RAINDROP_CLIENT_ID,
        client_secret: env.RAINDROP_CLIENT_SECRET,
        code,
        redirect_uri: `${base}/auth/callback`,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return new Response(`Token exchange failed: ${tokenRes.status} ${text}`, { status: 502 });
    }
    const token = await tokenRes.json();

    // Build signed session_code (no storage)
    const payload = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
      t: Date.now()
    };
    const sessionCode = await this._signPayload(payload, env.SESSION_SECRET);

    // Redirect back to extension redirect with session_code
    const final = new URL(extRedirect);
    final.searchParams.set('session_code', sessionCode);
    return Response.redirect(final.toString(), 302);
  },

  async _authFetch(url, env) {
    const sessionCode = url.searchParams.get('session_code');
    if (!sessionCode) {
      return this._cors(new Response(JSON.stringify({ error: 'missing_param', param: 'session_code' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }

    console.log('_authFetch: sessionCode received:', sessionCode.substring(0, 20) + '...');

    let payload;
    try {
      payload = await this._verifySessionCode(sessionCode, env.SESSION_SECRET);
      console.log('_authFetch: payload verified:', payload);
    } catch (error) {
      console.log('_authFetch: verification error:', error.message);
      return this._cors(new Response(JSON.stringify({ error: 'invalid_session_code', details: error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }

    if (!payload) {
      console.log('_authFetch: payload is null/undefined');
      return this._cors(new Response(JSON.stringify({ error: 'invalid_session_code' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }

    // Ensure we have required fields
    if (!payload.access_token) {
      console.log('_authFetch: payload missing access_token:', payload);
      return this._cors(new Response(JSON.stringify({ error: 'invalid_payload', payload }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }

    console.log('_authFetch: returning payload with access_token');
    return this._cors(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  },

  async _tokenRefresh(request, env) {
    env = this._coerceEnv(env);
    let body;
    try {
      body = await request.json();
    } catch {
      return this._cors(new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    if (!body || !body.refresh_token) {
      return this._cors(new Response(JSON.stringify({ error: 'missing_param', param: 'refresh_token' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }

    const tokenRes = await fetch('https://raindrop.io/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.RAINDROP_CLIENT_ID,
        client_secret: env.RAINDROP_CLIENT_SECRET,
        refresh_token: body.refresh_token,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return this._cors(new Response(JSON.stringify({ error: 'refresh_failed', status: tokenRes.status, detail: text }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
    }
    const json = await tokenRes.json();
    return this._cors(new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  },

  _cors(res) {
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return new Response(res.body, { status: res.status, headers });
  },

  _coerceEnv(env) {
    try {
      // In Service Worker format, bindings are exposed as globals
      if (typeof RAINDROP_CLIENT_ID !== 'undefined' && !env.RAINDROP_CLIENT_ID) env.RAINDROP_CLIENT_ID = RAINDROP_CLIENT_ID;
      if (typeof RAINDROP_CLIENT_SECRET !== 'undefined' && !env.RAINDROP_CLIENT_SECRET) env.RAINDROP_CLIENT_SECRET = RAINDROP_CLIENT_SECRET;
      if (typeof SESSION_SECRET !== 'undefined' && !env.SESSION_SECRET) env.SESSION_SECRET = SESSION_SECRET;
    } catch (_) {}
    return env || {};
  },

  _hasGlobal(name) {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`return typeof ${name} !== 'undefined'`)();
    } catch (_) {
      return false;
    }
  },

  _baseUrl(url) {
    return `${url.protocol}//${url.host}`;
  },

  _b64urlEncode(s) {
    return btoa(unescape(encodeURIComponent(s))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  _b64urlDecode(s) {
    s = s.replaceAll('-', '+').replaceAll('_', '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  },

  async _signPayload(obj, secret) {
    const json = JSON.stringify(obj);
    const dataB64 = this._b64urlEncode(json);
    const sigB64 = await this._hmacB64(dataB64, secret);
    return `${dataB64}.${sigB64}`;
  },

  async _verifySessionCode(code, secret) {
    const parts = code.split('.');
    if (parts.length !== 2) throw new Error('bad_format');
    const [dataB64, sig] = parts;
    const expected = await this._hmacB64(dataB64, secret);
    if (sig !== expected) throw new Error('bad_sig');
    const json = this._b64urlDecode(dataB64);
    return JSON.parse(json);
  },

  async _hmacB64(data, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    const bytes = new Uint8Array(sig);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return this._b64urlEncode(bin);
  }
};
