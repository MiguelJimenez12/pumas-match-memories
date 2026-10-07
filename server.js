import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fs, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const dataDir = resolve(root, process.env.DATA_DIR || './data');
const mediaDir = join(dataDir, 'media');
const thumbDir = join(dataDir, 'thumbnails');
const maxFileBytes = Math.max(1, Number(process.env.MAX_FILE_MB) || 2048) * 1024 * 1024;
const maxStorageBytes = Math.max(1, Number(process.env.MAX_STORAGE_GB) || 50) * 1024 ** 3;
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

for (const path of [dataDir, mediaDir, thumbDir]) mkdirSync(path, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'memories.sqlite'));
db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, match_date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL CHECK (location IN ('stadium','home')),
  opponent TEXT NOT NULL, pumas_score INTEGER, rival_score INTEGER,
  cover_media_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sort_order INTEGER NOT NULL, thumbnail_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_date ON memories(match_date DESC);
CREATE INDEX IF NOT EXISTS idx_media_memory ON media(memory_id, sort_order);`);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function failure(status, message) { const error = new Error(message); error.status = status; throw error; }
async function jsonBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1024 * 1024) failure(413, 'La solicitud es demasiado grande.');
  }
  try { return JSON.parse(text || '{}'); } catch { failure(400, 'El contenido JSON no es válido.'); }
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
function inputMemory(body) {
  const title = String(body.title || '').trim();
  const match_date = String(body.match_date || '');
  const opponent = String(body.opponent || '').trim();
  const description = String(body.description || '').trim();
  const location = body.location;
  const hasPumas = body.pumas_score !== '' && body.pumas_score !== null && body.pumas_score !== undefined;
  const hasRival = body.rival_score !== '' && body.rival_score !== null && body.rival_score !== undefined;
  if (!title || title.length > 150) failure(400, 'Escribe un título de hasta 150 caracteres.');
  if (!validDate(match_date)) failure(400, 'Selecciona una fecha válida.');
  if (!opponent || opponent.length > 100) failure(400, 'Escribe el equipo rival.');
  if (description.length > 10000) failure(400, 'La descripción es demasiado larga.');
  if (!['stadium', 'home'].includes(location)) failure(400, 'Selecciona dónde viste el partido.');
  if (hasPumas !== hasRival) failure(400, 'Completa ambos goles o deja el marcador vacío.');
  const pumas_score = hasPumas ? Number(body.pumas_score) : null;
  const rival_score = hasRival ? Number(body.rival_score) : null;
  if (hasPumas && (!Number.isInteger(pumas_score) || !Number.isInteger(rival_score) || pumas_score < 0 || rival_score < 0 || pumas_score > 99 || rival_score > 99)) failure(400, 'El marcador debe usar números entre 0 y 99.');
  return { title, match_date, opponent, description, location, pumas_score, rival_score };
}
function mediaFor(id) { return db.prepare('SELECT id, memory_id, filename, mime, size, sort_order, thumbnail_name FROM media WHERE memory_id = ? ORDER BY sort_order, created_at').all(id).map(({ thumbnail_name, ...item }) => ({ ...item, url: `/media/${item.id}`, thumbnailUrl: thumbnail_name ? `/thumb/${item.id}` : null })); }
function memoryFor(id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) failure(404, 'Este recuerdo no existe.');
  return { ...row, media: mediaFor(id) };
}
function listMemories(params) {
  const where = [], values = [];
  const q = (params.get('q') || '').trim().slice(0, 150);
  if (q) { where.push('(title LIKE ? OR description LIKE ?)'); values.push(`%${q}%`, `%${q}%`); }
  const year = params.get('year');
  if (year && /^\d{4}$/.test(year)) { where.push('substr(match_date,1,4) = ?'); values.push(year); }
  const date = params.get('date');
  if (date && validDate(date)) { where.push('match_date = ?'); values.push(date); }
  const opponent = params.get('opponent');
  if (opponent) { where.push('opponent = ?'); values.push(opponent); }
  const location = params.get('location');
  if (['stadium', 'home'].includes(location)) { where.push('location = ?'); values.push(location); }
  const result = params.get('result');
  if (result === 'win') where.push('pumas_score > rival_score');
  if (result === 'draw') where.push('pumas_score = rival_score AND pumas_score IS NOT NULL');
  if (result === 'loss') where.push('pumas_score < rival_score');
  if (result === 'pending') where.push('pumas_score IS NULL');
  const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY match_date DESC, created_at DESC`;
  return db.prepare(sql).all(...values).map(row => ({ ...row, media: mediaFor(row.id) }));
}
function stats() {
  const rows = db.prepare('SELECT * FROM memories ORDER BY match_date ASC').all();
  const result = { total: rows.length, stadium: 0, home: 0, win: 0, draw: 0, loss: 0, pending: 0, rivals: [], years: [], first: null, last: null };
  const rivals = new Map(), years = new Map();
  for (const row of rows) {
    result[row.location]++;
    result[row.pumas_score === null ? 'pending' : row.pumas_score > row.rival_score ? 'win' : row.pumas_score < row.rival_score ? 'loss' : 'draw']++;
    rivals.set(row.opponent, (rivals.get(row.opponent) || 0) + 1);
    const year = row.match_date.slice(0, 4); years.set(year, (years.get(year) || 0) + 1);
  }
  result.rivals = [...rivals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, count]) => ({ name, count }));
  result.years = [...years].map(([year, count]) => ({ year, count }));
  if (rows.length) { result.first = { id: rows[0].id, title: rows[0].title, date: rows[0].match_date }; result.last = { id: rows.at(-1).id, title: rows.at(-1).title, date: rows.at(-1).match_date }; }
  return result;
}
function detectType(bytes, extension) {
  if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : null;
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : null;
  if (extension === '.webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (extension === '.mp4' || extension === '.mov') {
    const atom = bytes.toString('ascii', 4, 8);
    if (atom === 'ftyp' || (extension === '.mov' && ['moov', 'wide', 'mdat'].includes(atom))) return extension === '.mov' ? 'video/quicktime' : 'video/mp4';
    return null;
  }
  return null;
}
function usedStorage() { return db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM media').get().total; }
async function upload(req, res, memoryId) {
  memoryFor(memoryId);
  let filename;
  try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { failure(400, 'Nombre de archivo no válido.'); }
  filename = filename.split(/[\\/]/).at(-1).trim().slice(0, 255);
  const extension = extname(filename).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(extension)) failure(415, 'Formato no admitido. Usa JPG, PNG, WEBP, MP4 o MOV.');
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && (length > maxFileBytes || usedStorage() + length > maxStorageBytes)) failure(413, 'El archivo supera los límites de almacenamiento configurados.');
  const id = randomUUID(), stored = `${id}${extension}`, path = join(mediaDir, stored);
  const storageBeforeUpload = usedStorage();
  let size = 0, signature = Buffer.alloc(0), destination;
  try {
    destination = createWriteStream(path, { flags: 'wx' });
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxFileBytes || storageBeforeUpload + size > maxStorageBytes) failure(413, 'El archivo supera los límites de almacenamiento configurados.');
      if (signature.length < 16) signature = Buffer.concat([signature, chunk.subarray(0, 16 - signature.length)]);
      if (!destination.write(chunk)) await new Promise((resolve, reject) => { destination.once('drain', resolve); destination.once('error', reject); });
    }
    await new Promise((resolve, reject) => { destination.end(resolve); destination.once('error', reject); });
    const mime = detectType(signature, extension);
    if (!mime || size === 0) failure(415, 'El contenido del archivo no coincide con un formato admitido.');
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM media WHERE memory_id = ?').get(memoryId).next;
    db.prepare('INSERT INTO media (id,memory_id,filename,stored_name,mime,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, memoryId, filename, stored, mime, size, order, new Date().toISOString());
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), memoryId);
    send(res, 201, { id, memory_id: memoryId, filename, mime, size, sort_order: order, url: `/media/${id}`, thumbnailUrl: null });
  } catch (error) { if (destination && !destination.closed) destination.destroy(); await fs.rm(path, { force: true }).catch(() => {}); throw error; }
}
async function thumbnail(req, res, id) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row || !row.mime.startsWith('video/')) failure(404, 'Video no encontrado.');
  const length = Number(req.headers['content-length']);
  if (!Number.isFinite(length) || length < 1 || length > 2 * 1024 * 1024) failure(413, 'La miniatura debe medir menos de 2 MB.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) failure(413, 'La miniatura debe medir menos de 2 MB.'); chunks.push(chunk); }
  const data = Buffer.concat(chunks);
  if (!(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) failure(415, 'La miniatura debe ser JPG.');
  const name = `${id}.jpg`;
  await fs.writeFile(join(thumbDir, name), data);
  db.prepare('UPDATE media SET thumbnail_name = ? WHERE id = ?').run(name, id);
  send(res, 200, { thumbnailUrl: `/thumb/${id}` });
}
function streamFile(req, res, path, mime, name, cache = 'private, max-age=86400') {
  if (!existsSync(path)) failure(404, 'Archivo no encontrado.');
  const size = statSync(path).size;
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': cache };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}
const staticTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const mutating = !['GET', 'HEAD'].includes(req.method);
    if (mutating && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) failure(403, 'Origen no permitido.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'");
    if (path === '/api/config' && req.method === 'GET') return send(res, 200, { maxFileBytes, maxStorageBytes, usedStorageBytes: usedStorage() });
    if (path === '/api/stats' && req.method === 'GET') return send(res, 200, stats());
    if (path === '/api/memories' && req.method === 'GET') return send(res, 200, listMemories(url.searchParams));
    if (path === '/api/memories' && req.method === 'POST') {
      const item = inputMemory(await jsonBody(req)); const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO memories (id,title,match_date,description,location,opponent,pumas_score,rival_score,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,item.title,item.match_date,item.description,item.location,item.opponent,item.pumas_score,item.rival_score,now,now);
      return send(res, 201, memoryFor(id));
    }
    const memory = /^\/api\/memories\/([a-f0-9-]+)$/.exec(path);
    if (memory) {
      const id = memory[1];
      if (req.method === 'GET') return send(res, 200, memoryFor(id));
      if (req.method === 'PUT') {
        memoryFor(id); const item = inputMemory(await jsonBody(req));
        db.prepare('UPDATE memories SET title=?,match_date=?,description=?,location=?,opponent=?,pumas_score=?,rival_score=?,updated_at=? WHERE id=?').run(item.title,item.match_date,item.description,item.location,item.opponent,item.pumas_score,item.rival_score,new Date().toISOString(),id);
        return send(res, 200, memoryFor(id));
      }
      if (req.method === 'DELETE') {
        const item = memoryFor(id);
        db.prepare('DELETE FROM memories WHERE id = ?').run(id);
        await Promise.all(item.media.flatMap(file => [fs.rm(join(mediaDir, `${file.id}${extname(file.filename).toLowerCase()}`), { force: true }), fs.rm(join(thumbDir, `${file.id}.jpg`), { force: true })]));
        return send(res, 200, { deleted: true });
      }
    }
    const uploadMatch = /^\/api\/memories\/([a-f0-9-]+)\/media$/.exec(path);
    if (uploadMatch && req.method === 'POST') return await upload(req, res, uploadMatch[1]);
    const orderMatch = /^\/api\/memories\/([a-f0-9-]+)\/order$/.exec(path);
    if (orderMatch && req.method === 'PUT') {
      const current = mediaFor(orderMatch[1]); memoryFor(orderMatch[1]);
      const { ids } = await jsonBody(req);
      if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(item => item.id === id))) failure(400, 'Orden de archivos no válido.');
      db.exec('BEGIN');
      try { ids.forEach((id, index) => db.prepare('UPDATE media SET sort_order = ? WHERE id = ?').run(index, id)); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      return send(res, 200, memoryFor(orderMatch[1]));
    }
    const coverMatch = /^\/api\/memories\/([a-f0-9-]+)\/cover$/.exec(path);
    if (coverMatch && req.method === 'PUT') {
      memoryFor(coverMatch[1]); const { mediaId } = await jsonBody(req);
      if (mediaId !== null && !mediaFor(coverMatch[1]).some(item => item.id === mediaId)) failure(400, 'Portada no válida.');
      db.prepare('UPDATE memories SET cover_media_id = ?, updated_at = ? WHERE id = ?').run(mediaId, new Date().toISOString(), coverMatch[1]);
      return send(res, 200, memoryFor(coverMatch[1]));
    }
    const mediaMatch = /^\/api\/media\/([a-f0-9-]+)$/.exec(path);
    if (mediaMatch && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaMatch[1]);
      if (!row) failure(404, 'Archivo no encontrado.');
      db.prepare('UPDATE memories SET cover_media_id = NULL WHERE cover_media_id = ?').run(row.id);
      db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
      await Promise.all([fs.rm(join(mediaDir, row.stored_name), { force: true }), row.thumbnail_name ? fs.rm(join(thumbDir, row.thumbnail_name), { force: true }) : Promise.resolve()]);
      return send(res, 200, { deleted: true });
    }
    const thumbUpload = /^\/api\/media\/([a-f0-9-]+)\/thumbnail$/.exec(path);
    if (thumbUpload && req.method === 'POST') return await thumbnail(req, res, thumbUpload[1]);
    const fileMatch = /^\/(media|thumb)\/([a-f0-9-]+)$/.exec(path);
    if (fileMatch && ['GET', 'HEAD'].includes(req.method)) {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(fileMatch[2]);
      if (!row) failure(404, 'Archivo no encontrado.');
      if (fileMatch[1] === 'thumb') {
        if (!row.thumbnail_name) failure(404, 'Miniatura no encontrada.');
        return streamFile(req, res, join(thumbDir, row.thumbnail_name), 'image/jpeg', `${row.id}.jpg`);
      }
      return streamFile(req, res, join(mediaDir, row.stored_name), row.mime, row.filename);
    }
    if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html', '/app.css', '/app.js', '/favicon.svg', '/stadium.png'].includes(path)) {
      const filePath = join(publicDir, path === '/' ? 'index.html' : path.slice(1));
      if (!existsSync(filePath)) failure(404, 'Página no encontrada.');
      return streamFile(req, res, filePath, staticTypes[extname(filePath)] || 'application/octet-stream', filePath.split(/[\\/]/).at(-1), 'no-store');
    }
    failure(404, 'Ruta no encontrada.');
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if (!error.status || error.status >= 500) console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : 'Ocurrió un error inesperado. Inténtalo de nuevo.' });
  }
});
server.requestTimeout = 0;
server.listen(port, host, () => console.log(`Mis recuerdos con Pumas: http://${host}:${port}`));
