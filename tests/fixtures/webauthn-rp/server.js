// Minimal WebAuthn relying party for E2E tests: registers and signs in with
// navigator.credentials and verifies every response with @simplewebauthn/server.
//
//   node tests/fixtures/webauthn-rp/server.js          (PORT=8787, HOST=127.0.0.1)
//   import { startRpServer } from './server.js'; const rp = await startRpServer({ port: 0 });
//
// Open it as http://localhost:<port>/ so the RP ID is "localhost".

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const INDEX = fileURLToPath(new URL('./index.html', import.meta.url));

export async function startRpServer({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '127.0.0.1' } = {}) {
  const users = new Map(); // username -> { id: Uint8Array, credentials: [{ id, publicKey, counter, transports }] }
  const flows = new Map(); // flowId -> { kind, challenge, username }

  const newFlow = (data) => {
    const flowId = randomBytes(12).toString('hex');
    flows.set(flowId, data);
    return flowId;
  };

  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new Error('body too large');
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  async function api(path, body, rp) {
    switch (path) {
      case '/api/register/options': {
        const username = String(body.username || 'alice@example.com');
        let user = users.get(username);
        if (!user) {
          user = { id: new Uint8Array(randomBytes(16)), credentials: [] };
          users.set(username, user);
        }
        const options = await generateRegistrationOptions({
          rpName: 'Akari Test RP',
          rpID: rp.id,
          userName: username,
          userDisplayName: body.displayName ? String(body.displayName) : username.split('@')[0],
          userID: user.id,
          attestationType: 'none',
          excludeCredentials: body.exclude === false ? [] : user.credentials.map((c) => ({ id: c.id, transports: c.transports })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { credProps: true },
        });
        return { flowId: newFlow({ kind: 'register', challenge: options.challenge, username }), options };
      }
      case '/api/register/verify': {
        const flow = flows.get(body.flowId);
        flows.delete(body.flowId);
        if (!flow || flow.kind !== 'register') return { verified: false, error: 'unknown flow' };
        const v = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          requireUserVerification: true,
        });
        if (!v.verified) return { verified: false };
        const { credential, aaguid, userVerified, credentialDeviceType, credentialBackedUp, fmt } = v.registrationInfo;
        users.get(flow.username).credentials.push({
          id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports,
        });
        return { verified: true, credentialId: credential.id, aaguid, fmt, userVerified, credentialDeviceType, credentialBackedUp };
      }
      case '/api/login/options': {
        const username = body.username ? String(body.username) : null;
        const user = username ? users.get(username) : null;
        const options = await generateAuthenticationOptions({
          rpID: rp.id,
          userVerification: 'required',
          allowCredentials: user ? user.credentials.map((c) => ({ id: c.id, transports: c.transports })) : [],
        });
        return { flowId: newFlow({ kind: 'login', challenge: options.challenge, username }), options };
      }
      case '/api/login/verify': {
        const flow = flows.get(body.flowId);
        flows.delete(body.flowId);
        if (!flow || flow.kind !== 'login') return { verified: false, error: 'unknown flow' };
        const id = body.response?.id;
        let owner = null;
        let cred = null;
        for (const [name, u] of users) {
          const c = u.credentials.find((x) => x.id === id);
          if (c) { owner = name; cred = c; break; }
        }
        if (!cred) return { verified: false, error: 'unknown credential' };
        const userHandle = body.response?.response?.userHandle;
        if (userHandle && userHandle !== b64url(users.get(owner).id)) return { verified: false, error: 'userHandle mismatch' };
        const v = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports },
          requireUserVerification: true,
        });
        if (v.verified) cred.counter = v.authenticationInfo.newCounter;
        return { verified: v.verified, username: owner, userVerified: v.authenticationInfo.userVerified };
      }
      case '/api/state':
        return { users: [...users].map(([username, u]) => ({ username, credentials: u.credentials.map((c) => c.id) })) };
      case '/api/reset':
        users.clear();
        flows.clear();
        return {};
      default:
        return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const rp = { id: url.hostname, origin: url.origin };
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(200, 'text/html; charset=utf-8', await readFile(INDEX));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = await api(url.pathname, body, rp);
        if (out) { send(200, 'application/json', JSON.stringify(out)); return; }
      }
      send(404, 'text/plain', 'not found');
    } catch (e) {
      send(400, 'application/json', JSON.stringify({ verified: false, error: String(e?.message || e) }));
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://localhost:${actualPort}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rp = await startRpServer();
  console.log('WebAuthn test RP listening on ' + rp.url);
}
