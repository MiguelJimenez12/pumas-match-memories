import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0WcN8AAAAASUVORK5CYII=', 'base64');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

test('records and media survive a restart and can be removed', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pumas-memories-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;

  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, MAX_FILE_MB: '5' },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error('The test server exited before becoming ready.');
      try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* Starting up. */ }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error('The test server did not become ready.');
  }

  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await once(child, 'exit');
  }

  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }

  try {
    await start();
    assert.equal((await api('/api/stats')).data.total, 0);
    assert.equal((await fetch(base)).status, 200);

    const details = { title: 'Demo match', match_date: '2024-07-07', opponent: 'Demo rival', description: 'A test memory', location: 'home', pumas_score: 2, rival_score: 1 };
    const created = await api('/api/memories', 'POST', details);
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.equal((await api('/api/memories?date=2024-07-07&result=win')).data.length, 1);
    assert.equal((await api('/api/memories?year=2023')).data.length, 0);

    const photoResponse = await fetch(`${base}/api/memories/${id}/media`, { method: 'POST', headers: { 'X-File-Name': 'photo.png', 'Content-Type': 'image/png' }, body: png });
    assert.equal(photoResponse.status, 201);
    const photo = await photoResponse.json();
    assert.equal((await fetch(`${base}/media/${photo.id}`, { headers: { Range: 'bytes=0-7' } })).status, 206);

    const videoBytes = Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex');
    const videoResponse = await fetch(`${base}/api/memories/${id}/media`, { method: 'POST', headers: { 'X-File-Name': 'video.mp4', 'Content-Type': 'video/mp4' }, body: videoBytes });
    assert.equal(videoResponse.status, 201);
    const video = await videoResponse.json();
    assert.equal((await fetch(`${base}/api/media/${video.id}/thumbnail`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([255, 216, 255, 0]) })).status, 200);
    assert.equal((await fetch(`${base}/thumb/${video.id}`)).status, 200);

    const invalidFile = await fetch(`${base}/api/memories/${id}/media`, { method: 'POST', headers: { 'X-File-Name': 'invalid.png' }, body: Buffer.from('not an image') });
    assert.equal(invalidFile.status, 415);
    assert.equal((await api(`/api/memories/${id}/order`, 'PUT', { ids: [video.id, photo.id] })).status, 200);
    assert.equal((await api(`/api/memories/${id}/cover`, 'PUT', { mediaId: photo.id })).status, 200);
    assert.equal((await api(`/api/memories/${id}`, 'PUT', { ...details, title: 'Edited demo match', pumas_score: null, rival_score: null })).status, 200);

    await stop();
    await start();
    const reloaded = await api(`/api/memories/${id}`);
    assert.equal(reloaded.data.title, 'Edited demo match');
    assert.deepEqual(reloaded.data.media.map(item => item.id), [video.id, photo.id]);
    assert.equal(reloaded.data.cover_media_id, photo.id);
    assert.equal((await api('/api/stats')).data.pending, 1);

    assert.equal((await api(`/api/memories/${id}`, 'DELETE')).status, 200);
    assert.equal((await api('/api/stats')).data.total, 0);
    assert.equal((await fetch(`${base}/media/${photo.id}`)).status, 404);
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
