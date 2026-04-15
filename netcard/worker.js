/**
 * Cloudflare Worker: IP Signature Card
 * 路由: GET /img?name=xxx&theme=dark&scale=2
 *
 * 部署方式：
 * 1. 创建 Worker，名字如 card.232310.xyz
 * 2. 绑定路由或自定义域名
 * 3. 粘贴本文件内容，保存即可
 */

// ── Pure-JS PNG renderer (no native deps) ─────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = crc32(crcBuf);
  const crcOut = Buffer.alloc(4);
  crcOut.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBytes, data, crcOut]);
}

function zlibDeflate(uncompressed) {
  const pako = require('pako');
  return pako.deflate(uncompressed);
}

function createPNG(width, height, filterRowFn) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = filterRowFn(x, y, width, height);
      const off = 1 + x * 4;
      row[off] = r; row[off + 1] = g; row[off + 2] = b; row[off + 3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlibDeflate(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// ── Canvas ─────────────────────────────────────────────────────

class SimpleCanvas {
  constructor(width, height) {
    this.W = width; this.H = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }
  _idx(x, y) {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return -1;
    return (y * this.W + x) * 4;
  }
  setPixel(x, y, r, g, b, a = 255) {
    const i = this._idx(Math.round(x), Math.round(y));
    if (i < 0) return;
    this.pixels[i] = r; this.pixels[i+1] = g; this.pixels[i+2] = b; this.pixels[i+3] = a;
  }
  fillRect(x, y, w, h, r, g, b, a = 255) {
    const x1 = Math.round(x), y1 = Math.round(y);
    const x2 = Math.round(x + w - 1), y2 = Math.round(y + h - 1);
    for (let py = y1; py <= y2; py++)
      for (let px = x1; px <= x2; px++) {
        const i = this._idx(px, py);
        if (i < 0) continue;
        this.pixels[i] = r; this.pixels[i+1] = g; this.pixels[i+2] = b; this.pixels[i+3] = a;
      }
  }
  drawLine(x0, y0, x1, y1, r, g, b, a = 255) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
    const sx = x0<x1?1:-1, sy = y0<y1?1:-1;
    let err = dx - dy;
    while (true) {
      this.setPixel(x0, y0, r, g, b, a);
      if (x0===x1 && y0===y1) break;
      const e2 = 2*err;
      if (e2>-dy) { err -= dy; x0 += sx; }
      if (e2<dx)  { err += dx; y0 += sy; }
    }
  }
  fillCircle(cx, cy, radius, r, g, b, a = 255) {
    cx = Math.round(cx); cy = Math.round(cy);
    const r2 = radius * radius;
    for (let py = Math.max(0, cy-radius); py <= Math.min(this.H-1, cy+radius); py++) {
      const dx = Math.sqrt(r2 - (py-cy)*(py-cy));
      for (let px = Math.max(0, Math.round(cx-dx)); px <= Math.min(this.W-1, Math.round(cx+dx)); px++) {
        const i = this._idx(px, py);
        if (i < 0) continue;
        this.pixels[i] = r; this.pixels[i+1] = g; this.pixels[i+2] = b; this.pixels[i+3] = a;
      }
    }
  }
  fillRoundRect(x, y, w, h, radius, r, g, b, a = 255) {
    this.fillRect(x+radius, y, w-radius*2, h, r, g, b, a);
    this.fillRect(x, y+radius, w, h-radius*2, r, g, b, a);
    this.fillCircle(x+radius, y+radius, radius, r, g, b, a);
    this.fillCircle(x+w-radius-1, y+radius, radius, r, g, b, a);
    this.fillCircle(x+w-radius-1, y+h-radius-1, radius, r, g, b, a);
    this.fillCircle(x+radius, y+h-radius-1, radius, r, g, b, a);
  }
}

// ── 5x7 Bitmap Font ────────────────────────────────────────────
const FONT = {
  width: 5, height: 7,
  data: {
    'A':[0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'B':[0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
    'C':[0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
    'D':[0b11100,0b10010,0b10001,0b10001,0b10001,0b10010,0b11100],
    'E':[0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
    'F':[0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
    'G':[0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
    'H':[0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'I':[0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
    'J':[0b00111,0b00010,0b00010,0b00010,0b10010,0b10010,0b01100],
    'K':[0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
    'L':[0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
    'M':[0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
    'N':[0b10001,0b11001,0b10101,0b10101,0b10011,0b10001,0b10001],
    'O':[0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'P':[0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
    'Q':[0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
    'R':[0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
    'S':[0b01110,0b10001,0b10000,0b01110,0b00001,0b10001,0b01110],
    'T':[0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    'U':[0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'V':[0b10001,0b10001,0b10001,0b10001,0b01010,0b01010,0b00100],
    'W':[0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
    'X':[0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
    'Y':[0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
    'Z':[0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
    '0':[0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
    '1':[0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
    '2':[0b01110,0b10001,0b00001,0b00110,0b01000,0b10000,0b11111],
    '3':[0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
    '4':[0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
    '5':[0b11111,0b10000,0b10000,0b11110,0b00001,0b00001,0b11110],
    '6':[0b01110,0b10000,0b10000,0b11110,0b10001,0b10001,0b01110],
    '7':[0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
    '8':[0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
    '9':[0b01110,0b10001,0b10001,0b01111,0b00001,0b00001,0b01110],
    '.':[0b00000,0b00000,0b00000,0b00000,0b00000,0b01100,0b01100],
    ',':[0b00000,0b00000,0b00000,0b00000,0b00110,0b00100,0b01000],
    ':':[0b00000,0b01100,0b01100,0b00000,0b01100,0b01100,0b00000],
    '-':[0b00000,0b00000,0b00000,0b11111,0b00000,0b00000,0b00000],
    '_':[0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b11111],
    '/':[0b00001,0b00010,0b00100,0b01000,0b10000,0b00000,0b00000],
    ' ':[0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b00000],
    '!':[0b00100,0b00100,0b00100,0b00100,0b00100,0b00000,0b00100],
    '?':[0b01110,0b10001,0b00001,0b00110,0b00100,0b00000,0b00100],
    "'":[0b00100,0b01000,0b00000,0b00000,0b00000,0b00000,0b00000],
    '"':[0b01010,0b01010,0b00000,0b00000,0b00000,0b00000,0b00000],
    '(':[0b00010,0b00100,0b01000,0b01000,0b01000,0b00100,0b00010],
    ')':[0b01000,0b00100,0b00010,0b00010,0b00010,0b00100,0b01000],
    '[':[0b01100,0b01000,0b01000,0b01000,0b01000,0b01000,0b01100],
    ']':[0b00110,0b00010,0b00010,0b00010,0b00010,0b00010,0b00110],
    '+':[0b00000,0b00100,0b00100,0b11111,0b00100,0b00100,0b00000],
    '=':[0b00000,0b00000,0b11111,0b00000,0b11111,0b00000,0b00000],
    '@':[0b01110,0b10001,0b10011,0b10111,0b10000,0b10001,0b01110],
    '#':[0b01010,0b01010,0b11111,0b01010,0b11111,0b01010,0b01010],
    '&':[0b01100,0b10010,0b10100,0b01000,0b10101,0b10010,0b01101],
    '|':[0b00100,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    '\\':[0b10000,0b01000,0b00100,0b00010,0b00001,0b00000,0b00000],
  }
};

function measureText(text, scale) {
  return text.length * (FONT.width + 1) * scale;
}

function drawText(cvs, text, x, y, r, g, b, scale) {
  const fw = FONT.width, fh = FONT.height;
  let cx = Math.round(x);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const bitmap = FONT.data[ch];
    if (!bitmap) { cx += (fw + 1) * scale; continue; }
    for (let row = 0; row < fh; row++) {
      for (let col = 0; col < fw; col++) {
        if (bitmap[row] & (1 << (fw - 1 - col))) {
          cvs.fillRect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cx += (fw + 1) * scale;
  }
  return cx;
}

function drawTextCentered(cvs, text, cx, y, r, g, b, scale) {
  drawText(cvs, text, cx - measureText(text, scale) / 2, y, r, g, b, scale);
}

function wrapText(text, maxWidth, scale) {
  const lines = [], cur = '';
  let line = '';
  for (const ch of text) {
    const test = line + ch;
    if (measureText(test, scale) > maxWidth && line) {
      lines.push(line); line = ch;
    } else { line = test; }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Gradient fill ─────────────────────────────────────────────
function fillLinearGradient(cvs, x, y, w, h, stops, dir) {
  const n = dir === 'vertical' ? h : w;
  for (let i = 0; i < n; i++) {
    let t = Math.max(0, Math.min(1, i / n));
    let s0 = stops[0], s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j+1][0]) {
        s0 = stops[j]; s1 = stops[j+1];
        t = (t - s0[0]) / (s1[0] - s0[0]);
        break;
      }
    }
    const r = Math.round(s0[1] + (s1[1] - s0[1]) * t);
    const g = Math.round(s0[2] + (s1[2] - s0[2]) * t);
    const b = Math.round(s0[3] + (s1[3] - s1[3]) * t);
    if (dir === 'vertical') cvs.fillRect(x, y + i, w, 1, r, g, b);
    else cvs.fillRect(x + i, y, 1, h, r, g, b);
  }
}

// ── IP Geolocation ────────────────────────────────────────────
async function fetchGeo(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return { status: 'fail', query: ip, country: 'Local', city: 'Local' };
  }
  try {
    const res = await fetch('http://ip-api.com/json/' + ip, {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    return await res.json();
  } catch (_) { return { status: 'fail' }; }
}

function getClientIP(request) {
  const fw = request.headers.get('cf-connecting-ip') ||
             request.headers.get('x-forwarded-for') ||
             request.headers.get('x-real-ip') || '';
  return fw.split(',')[0].trim() || '127.0.0.1';
}

function detectOS(ua) {
  if (!ua) return 'Unknown';
  if (/windows phone/i.test(ua)) return 'Win Phone';
  if (/win/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua) && /iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua) && !/android/i.test(ua)) return 'Linux';
  if (/android/i.test(ua)) return 'Android';
  return 'Unknown';
}

function detectBrowser(ua) {
  if (!ua) return 'Unknown';
  if (/edg/i.test(ua)) return 'Edge';
  if (/chrome/i.test(ua) && /safari/i.test(ua) && !/opr|edge/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/opr|opera/i.test(ua)) return 'Opera';
  if (/micromessenger/i.test(ua)) return 'WeChat';
  return 'Unknown';
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Main generator ────────────────────────────────────────────
async function generateCard(request) {
  const url = new URL(request.url);
  const ip = getClientIP(request);
  const ua = request.headers.get('user-agent') || '';
  const os = detectOS(ua);
  const browser = detectBrowser(ua);
  const name = (url.searchParams.get('name') || '').replace(/[<>]/g, '').substring(0, 20);
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  const scale = Math.max(0.5, Math.min(3, parseFloat(url.searchParams.get('scale')) || 1));

  const W = Math.round(500 * scale);
  const H = Math.round(220 * scale);
  const PAD = Math.round(10 * scale);
  const ACCENT = [249, 115, 22];

  const geo = await fetchGeo(ip);
  const cvs = new SimpleCanvas(W, H);

  // Background
  if (theme === 'dark') {
    fillLinearGradient(cvs, 0, 0, W, H, [[0,15,23,42],[1,30,41,59]], 'vertical');
  } else {
    fillLinearGradient(cvs, 0, 0, W, H, [[0,248,250,252],[1,224,242,254]], 'vertical');
  }

  // Top accent bar
  cvs.fillRect(0, 0, W, Math.round(5 * scale), ACCENT[0], ACCENT[1], ACCENT[2]);

  // Card border
  const bx = PAD, by = PAD, bw = W - PAD*2, bh = H - PAD*2;
  const R = Math.round(14 * scale);
  const borderAlpha = Math.round(20 * scale);
  const bc = theme === 'dark' ? [255,255,255] : [0,0,0];
  cvs.fillRoundRect(bx, by, bw, bh, R, bc[0], bc[1], bc[2], borderAlpha);
  cvs.fillRoundRect(bx+1, by+1, bw-2, bh-2, R-1,
    theme==='dark'?15:248, theme==='dark'?23:250, theme==='dark'?42:252);

  // Avatar
  const ax = Math.round(40 * scale), ay = Math.round(58 * scale), ar = Math.round(30 * scale);
  cvs.fillCircle(ax, ay, ar, 251, 146, 60);
  cvs.fillCircle(ax, ay, Math.round(9 * scale), ax, ay - Math.round(4 * scale), 0, 0, 0, 0);
  // Head
  cvs.fillCircle(ax, ay - Math.round(4 * scale), Math.round(9 * scale), 255, 255, 255, 230);
  // Body arc
  const bodyR = Math.round(14 * scale);
  for (let px = -bodyR; px <= bodyR; px++) {
    const dy = Math.round(Math.sqrt(Math.max(0, bodyR*bodyR - px*px)));
    for (let d = 0; d < dy; d++) cvs.setPixel(ax+px, ay + Math.round(8*scale) + d, 255, 255, 255, 230);
  }

  // Colors
  const titleCol = theme==='dark' ? [241,245,249] : [30,41,59];
  const subCol   = theme==='dark' ? [148,163,184] : [100,116,139];
  const labelCol = theme==='dark' ? [100,116,139] : [148,163,184];
  const valCol   = theme==='dark' ? [241,245,249] : [51,65,85];
  const tagCol   = theme==='dark' ? [71,85,105]  : [203,213,225];

  // Name
  const nameText = name ? 'Visitor · ' + name : "Visitor · Ethan's Page";
  drawText(cvs, nameText, ax + ar + Math.round(12*scale), ay - Math.round(16*scale),
    titleCol[0], titleCol[1], titleCol[2], scale);

  // Time
  const now = new Date();
  const timeStr = pad(now.getFullYear()) + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate())
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  drawText(cvs, '>' + timeStr, ax + ar + Math.round(12*scale), ay - Math.round(4*scale),
    subCol[0], subCol[1], subCol[2], scale);

  // IP
  drawText(cvs, 'IP:' + (geo.query || ip), ax + ar + Math.round(12*scale), ay + Math.round(10*scale),
    ACCENT[0], ACCENT[1], ACCENT[2], scale);

  // Divider
  const divY = Math.round(105 * scale);
  cvs.drawLine(Math.round(18*scale), divY, W - Math.round(18*scale), divY,
    theme==='dark'?100:200, theme==='dark'?116:210, theme==='dark'?134:220);

  // Info row
  const rowY1 = Math.round(116 * scale);
  const colW = Math.round((W - Math.round(36*scale)) / 3);
  const colX = [Math.round(18*scale), Math.round(18*scale)+colW, Math.round(18*scale)+colW*2];
  const locStr = geo.city ? geo.city + ',' + geo.country : (geo.country || 'Unknown');
  const labels = ['Location', 'OS', 'Browser'];
  const values = [locStr, os, browser];

  labels.forEach((lbl, i) => {
    const lx = colX[i] + colW / 2;
    drawTextCentered(cvs, lbl, lx, rowY1, labelCol[0], labelCol[1], labelCol[2], scale);
    const maxVW = colW - Math.round(10 * scale);
    const lines = wrapText(values[i], maxVW, scale);
    lines.forEach((line, li) => {
      drawTextCentered(cvs, line, lx, rowY1 + Math.round(14*scale) + li * Math.round(9*scale),
        valCol[0], valCol[1], valCol[2], scale);
    });
  });

  // Tagline
  drawTextCentered(cvs, 'Powered by 232310.xyz', W/2, H - Math.round(22*scale),
    tagCol[0], tagCol[1], tagCol[2], scale);

  // Encode PNG
  const png = createPNG(W, H, (x, y) => {
    const i = (y * W + x) * 4;
    return [cvs.pixels[i], cvs.pixels[i+1], cvs.pixels[i+2], cvs.pixels[i+3]];
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// ── Preview page ───────────────────────────────────────────────
function renderPreviewPage(request) {
  const url = new URL(request.url);
  const base = url.origin;
  const pname  = (url.searchParams.get('name')  || '').replace(/[<>]/g,'').substring(0,20);
  const pscale = url.searchParams.get('scale')  || '1';
  const ptheme = url.searchParams.get('theme')  || 'light';

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const sel = (v, t) => v === t ? 'selected' : '';

  const imgBase = base + '/img';
  const imgSrc  = imgBase + '?name=' + encodeURIComponent(pname) + '&scale=' + pscale + '&theme=' + ptheme;

  const html = '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'  <title>IP 签名卡片 - 232310.xyz</title>\n' +
'  <style>\n' +
'    *{margin:0;padding:0;box-sizing:border-box}\n' +
'    body{font-family:Inter,-apple-system,sans-serif;background:linear-gradient(135deg,#f8fafc,#e0f2fe);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem 1rem;color:#334155}\n' +
'    h1{font-size:1.8rem;color:#1e293b;margin-bottom:.4rem}\n' +
'    .sub{color:#64748b;margin-bottom:2rem;font-size:.95rem}\n' +
'    .preview{margin-bottom:1.5rem}\n' +
'    .preview img{max-width:min(100%,500px);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.12)}\n' +
'    .controls{display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center;margin-bottom:1.5rem;max-width:620px;width:100%}\n' +
'    .controls label{display:flex;flex-direction:column;font-size:.78rem;color:#64748b;gap:3px}\n' +
'    .controls input{padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:.9rem;outline:none;width:130px}\n' +
'    .controls input:focus,.controls select:focus{border-color:#f97316}\n' +
'    .controls select{padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:.9rem;outline:none}\n' +
'    .controls button{align-self:flex-end;padding:7px 16px;background:#f97316;color:#fff;border:none;border-radius:6px;font-size:.9rem;cursor:pointer;transition:background .2s}\n' +
'    .controls button:hover{background:#ea580c}\n' +
'    .tip{background:#fff7ed;border-left:3px solid #f97316;padding:.75rem 1rem;border-radius:6px;margin-bottom:1.5rem;font-size:.85rem;color:#92400e;max-width:620px;width:100%;line-height:1.6}\n' +
'    .code-section{width:100%;max-width:620px}\n' +
'    .code-section h2{font-size:1.05rem;margin-bottom:.6rem;color:#1e293b}\n' +
'    .code-block{background:#1e293b;color:#e2e8f0;border-radius:10px;padding:1rem 1.25rem;font-family:Courier New,monospace;font-size:.8rem;line-height:1.8;overflow-x:auto;white-space:pre-wrap;word-break:break-all}\n' +
'    .url{color:#c4b5fd}.attr{color:#86efac}.val{color:#fde68a}\n' +
'    .copy-btn{margin-top:.5rem;padding:6px 16px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:.85rem;transition:background .2s}\n' +
'    .copy-btn:hover{background:#475569}.copy-btn.copied{background:#16a34a}\n' +
'    .back-link{margin-top:2rem;color:#f97316;text-decoration:none;font-size:.9rem}\n' +
'    .back-link:hover{text-decoration:underline}\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <h1>IP 签名卡片</h1>\n' +
'  <p class="sub">为博客、论坛签名添加一张实时访客信息卡片</p>\n' +
'  <div class="preview"><img id="img" src="' + esc(imgSrc) + '" alt="IP Signature Card" crossorigin="anonymous"></div>\n' +
'  <div class="controls">\n' +
'    <label>昵称（可选）<input type="text" id="name" maxlength="20" value="' + esc(pname) + '" placeholder="e.g. Ethan"></label>\n' +
'    <label>缩放<select id="scale">\n' +
'      <option value="0.6" ' + sel(pscale,'0.6') + '>0.6x</option>\n' +
'      <option value="1" '   + sel(pscale,'1')   + '>1x</option>\n' +
'      <option value="1.5" ' + sel(pscale,'1.5') + '>1.5x</option>\n' +
'      <option value="2" '  + sel(pscale,'2')   + '>2x</option>\n' +
'    </select></label>\n' +
'    <label>主题<select id="theme">\n' +
'      <option value="light" ' + sel(ptheme,'light') + '>light</option>\n' +
'      <option value="dark" '  + sel(ptheme,'dark')  + '>dark</option>\n' +
'    </select></label>\n' +
'    <button onclick="update()">refresh</button>\n' +
'  </div>\n' +
'  <div class="tip">copy the code below to your blog/forum signature or any HTML page.</div>\n' +
'  <div class="code-section">\n' +
'    <h2>copy code</h2>\n' +
'    <div class="code-block" id="code">&lt;img src="' + base + '/img?name=Ethan&amp;theme=light" alt="IP Signature Card" width="500"></div>\n' +
'    <button class="copy-btn" id="copy-btn" onclick="copyCode()">copy</button>\n' +
'  </div>\n' +
'  <a class="back-link" href="/">&lt;- back to homepage</a>\n' +
'  <script>\n' +
'    var BASE = ' + JSON.stringify(base) + ';\n' +
'    function params() {\n' +
'      return "name=" + encodeURIComponent(document.getElementById("name").value.trim()) +\n' +
'             "&amp;scale=" + document.getElementById("scale").value +\n' +
'             "&amp;theme=" + document.getElementById("theme").value;\n' +
'    }\n' +
'    function update() {\n' +
'      var img = document.getElementById("img");\n' +
'      img.src = BASE + "/img?" + params() + "&amp;_=" + Date.now();\n' +
'      var n = document.getElementById("name").value.trim() || "Ethan";\n' +
'      var s = document.getElementById("scale").value;\n' +
'      var t = document.getElementById("theme").value;\n' +
'      document.getElementById("code").innerHTML = "&lt;img src=\\"" + BASE + "/img?name=" + encodeURIComponent(n) + "&amp;scale=" + s + "&amp;theme=" + t + "\\" alt=\\""IP Signature Card\\" width=\\""500\\">";\n' +
'    }\n' +
'    function copyCode() {\n' +
'      navigator.clipboard.writeText(document.getElementById("code").innerText).then(function() {\n' +
'        var b = document.getElementById("copy-btn");\n' +
'        b.textContent = "copied";\n' +
'        b.classList.add("copied");\n' +
'        setTimeout(function() { b.textContent = "copy"; b.classList.remove("copied"); }, 2000);\n' +
'      });\n' +
'    }\n' +
'    ["name","scale","theme"].forEach(function(id) {\n' +
'      var el = document.getElementById(id);\n' +
'      el.addEventListener("input", update);\n' +
'      el.addEventListener("change", update);\n' +
'    });\n' +
'  </script>\n' +
'</body>\n' +
'</html>';

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Worker entry ───────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (url.pathname === '/img') {
      return await generateCard(request);
    }

    // Everything else → preview page
    return await renderPreviewPage(request);
  }
};
