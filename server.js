#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;

const UPSTREAMS = {
  openf1:  { base: 'https://api.openf1.org/v1' },
  jolpica: { base: 'https://api.jolpi.ca/ergast/f1' },
};

const TTL_RULES = [
  ['location',        3],
  ['position',        5],
  ['intervals',       5],
  ['race_control',   15],
  ['team_radio',     20],
  ['weather',        60],
  ['laps',           20],
  ['stints',         60],
  ['drivers',       600],
  ['sessions',      600],
  ['meetings',      600],
  ['driverstandings',   6 * 3600],
  ['constructorstandings', 6 * 3600],
  ['results',        3600],
  ['current.json',   3600],
];
const DEFAULT_TTL = 120;

function ttlFor(p){
  const low = p.toLowerCase();
  for(const [k, t] of TTL_RULES) if(low.includes(k)) return t * 1000;
  return DEFAULT_TTL * 1000;
}

const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for(const [k, v] of cache) if(v.expires < now) cache.delete(k);
}, 60e3);

const queue = [];
let lastReq = 0, pumping = false;
const SPACING = 2150;

function rawGet(urlStr){
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const search = u.search.replace(/%3E/gi, '>').replace(/%3C/gi, '<');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + search,
      method: 'GET',
      headers: { 'accept': 'application/json', 'user-agent': 'f1-pitwall/1.0' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        ctype: res.headers['content-type'] || 'application/json',
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream timeout')));
    req.end();
  });
}

function limitedFetch(url){
  return new Promise((resolve, reject) => { queue.push({url, resolve, reject}); pump(); });
}
async function pump(){
  if(pumping) return; pumping = true;
  while(queue.length){
    const wait = Math.max(0, lastReq + SPACING - Date.now());
    if(wait) await new Promise(r => setTimeout(r, wait));
    const job = queue.shift(); lastReq = Date.now();
    try{
      const r = await rawGet(job.url);
      job.resolve(r);
    }catch(e){ job.reject(e); }
  }
  pumping = false;
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if(url.pathname === '/api/health'){
    return send(res, 200, JSON.stringify({ ok: true, cache: cache.size }), 'application/json');
  }

  const m = url.pathname.match(/^\/api\/(openf1|jolpica)\/(.*)$/);
  if(m){
    const upstream = UPSTREAMS[m[1]];
    const target = `${upstream.base}/${m[2]}${url.search}`;
    const hit = cache.get(target);
    if(hit && hit.expires > Date.now()){
      return send(res, hit.status, hit.body, hit.ctype, 'HIT');
    }
    try{
      let r = await limitedFetch(target);
      if(r.status === 404 && m[1] === 'openf1'){
        r = { status: 200, body: '[]', ctype: 'application/json' };
      }
      if(r.status === 200){
        cache.set(target, { expires: Date.now() + ttlFor(m[2]), body: r.body, status: 200, ctype: r.ctype });
      }else if(hit){
        return send(res, 200, hit.body, hit.ctype, 'STALE');
      }
      return send(res, r.status, r.body, r.ctype, 'MISS');
    }catch(e){
      if(hit) return send(res, 200, hit.body, hit.ctype, 'STALE');
      return send(res, 502, JSON.stringify({ error: 'upstream unreachable' }), 'application/json');
    }
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(ROOT, file);
  if(!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if(err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

function send(res, status, body, ctype, cacheState){
  res.writeHead(status, {
    'content-type': ctype,
    'access-control-allow-origin': '*',
    ...(cacheState ? { 'x-pitwall-cache': cacheState } : {}),
  });
  res.end(body);
}

server.listen(PORT, () => {
  console.log('-------------------------------------------');
  console.log('  F1 PIT WALL server running');
  console.log(`  ->  http://localhost:${PORT}`);
  console.log('  Press F in the browser for fullscreen,');
  console.log('  D to open the rewatch picker. Ctrl+C stops the server.');
  console.log('-------------------------------------------');
});
