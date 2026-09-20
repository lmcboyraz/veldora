// Exercise the actual production function, or a deployed URL, without signing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const deployed = process.argv[2];
const origin = deployed ? new URL(deployed).origin : 'https://veldora.example';
const output = new URL('../.vercel/output/', import.meta.url);
const app = deployed
  ? null
  : (await import(new URL('functions/__server.func/index.mjs', output)))
      .default;
const request = (path, init) => {
  const req = new Request(new URL(path, origin), init);
  return app ? app.fetch(req) : fetch(req);
};

if (!deployed) {
  const config = JSON.parse(
    await readFile(new URL('config.json', output), 'utf8'),
  );
  assert.equal(config.version, 3);
  assert(
    config.routes.some(
      (route) => route.src === '/(.*)' && route.dest === '/__server',
    ),
  );
  const runtime = JSON.parse(
    await readFile(
      new URL('functions/__server.func/.vc-config.json', output),
      'utf8',
    ),
  );
  assert.equal(runtime.runtime, 'nodejs22.x');
  assert.equal(runtime.maxDuration, 300);
}

const page = await request('/');
assert.equal(page.status, 200);
assert.match(page.headers.get('content-type'), /text\/html/);
const html = await page.text();
assert.match(html, /Veldora/);
const assets = [
  ...new Set(
    [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)/g)].map(
      (m) => m[1],
    ),
  ),
];
assert(assets.some((asset) => asset.endsWith('.css')));
assert(assets.some((asset) => asset.endsWith('.js')));
for (const asset of assets) {
  if (deployed) assert.equal((await request(asset)).status, 200, asset);
  else
    assert(
      (await readFile(new URL(`static${asset}`, output))).length > 0,
      asset,
    );
}
console.log(`PASS SSR and ${assets.length} static assets`);

async function error(path, init, code) {
  const response = await request(path, init);
  assert.equal(response.status, 400, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, code, path);
}
for (const path of ['/api/anchor/demo', '/api/anchor/onramp']) {
  const init = {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: '{}',
  };
  await error(path, init, 'Connect a valid Stellar wallet.');
  await error(
    path,
    {
      ...init,
      headers: { ...init.headers, origin: 'https://untrusted.example' },
    },
    'Origin does not match.',
  );
  await error(
    path,
    { ...init, headers: { ...init.headers, 'sec-fetch-site': 'cross-site' } },
    'Origin does not match.',
  );
  await error(
    path,
    { ...init, headers: { ...init.headers, 'content-type': 'text/plain' } },
    'JSON required.',
  );
  console.log(
    `PASS ${path}: same-origin HTTPS, cross-origin rejection, JSON validation`,
  );
}
await error('/api/anchor/onramp', {}, 'Connect a valid Stellar wallet.');
console.log('PASS onramp GET validation; no transaction signed or submitted');
