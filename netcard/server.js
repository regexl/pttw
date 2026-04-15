'use strict';
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Pure-JS PNG renderer (no native deps) ──────────────────────

const IP_API_URL = 'http://ip-api.com/json/';

function fetchGeoData(ip) {
  return new Promise((resolve) => {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      resolve({ status: 'fail', query: ip });
      return;
    }
    const proto = http;
    proto.get(IP_API_URL + ip, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ status: 'fail' }); }
      });
    }).on('error', () => resolve({ status: 'fail' })).end();
  });
}

function getClientIP(req) {
  const fw = req.headers['x-forwarded-for'];
  if (fw) return fw.split(',')[0].trim();
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  return req.socket?.remoteAddress?.replace('::ffff:', '') || '127.0.0.1';
}

function detectOS(ua) {
  if (!ua) return 'Unknown';
  if (/windows phone/i.test(ua)) return 'Windows Phone';
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

function getDeviceType(ua) {
  if (!ua) return 'Desktop';
  if (/mobile|android|iphone|ipad|ipod|windows phone/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

// ── Minimal 32-bit CRC ────────────────────────────────────────
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
  const crcBuf2 = Buffer.alloc(4);
  crcBuf2.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBytes, data, crcBuf2]);
}

function adler32(buf) {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s1 = (s1 + buf[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function zlibDeflate(uncompressed) {
  // Raw deflate with zlib header/checksum
  const zlib = require('zlib');
  return zlib.deflateSync(uncompressed, { level: 9 });
}

function createPNG(width, height, filterRowFn) {
  // Build raw pixel rows (RGBA)
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = filterRowFn(x, y, width, height);
      const off = 1 + x * 4;
      row[off] = r; row[off + 1] = g; row[off + 2] = b; row[off + 3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);

  // Compress with zlib
  const compressed = zlibDeflate(raw);

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Canvas-like drawing primitives ────────────────────────────

class SimpleCanvas {
  constructor(width, height) {
    this.W = width;
    this.H = height;
    // Pre-allocate pixel buffer (RGBA)
    this.pixels = Buffer.alloc(width * height * 4);
  }

  // Set pixel (clipped)
  _px(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    const off = (y * this.W + x) * 4;
    return { r: off, g: off + 1, b: off + 2, a: off + 3 };
  }

  setPixel(x, y, r, g, b, a = 255) {
    const p = this._px(x, y);
    if (!p) return;
    this.pixels[p.r] = r; this.pixels[p.g] = g;
    this.pixels[p.b] = b; this.pixels[p.a] = a;
  }

  fillRect(x, y, w, h, r, g, b, a = 255) {
    const x1 = Math.round(x), y1 = Math.round(y);
    const x2 = Math.round(x + w - 1), y2 = Math.round(y + h - 1);
    for (let py = y1; py <= y2; py++) {
      for (let px = x1; px <= x2; px++) {
        const p = this._px(px, py);
        if (!p) continue;
        this.pixels[p.r] = r; this.pixels[p.g] = g;
        this.pixels[p.b] = b; this.pixels[p.a] = a;
      }
    }
  }

  // Draw a line using Bresenham
  drawLine(x0, y0, x1, y1, r, g, b, a = 255) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      this.setPixel(x0, y0, r, g, b, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx)  { err += dx; y0 += sy; }
    }
  }

  // Draw an unfilled circle (Bresenham)
  drawCircle(cx, cy, radius, r, g, b, a = 255) {
    cx = Math.round(cx); cy = Math.round(cy);
    let x = radius, y = 0, err = 0;
    while (x >= y) {
      this.setPixel(cx + x, cy + y, r, g, b, a);
      this.setPixel(cx + y, cy + x, r, g, b, a);
      this.setPixel(cx - y, cy + x, r, g, b, a);
      this.setPixel(cx - x, cy + y, r, g, b, a);
      this.setPixel(cx - x, cy - y, r, g, b, a);
      this.setPixel(cx - y, cy - x, r, g, b, a);
      this.setPixel(cx + y, cy - x, r, g, b, a);
      this.setPixel(cx + x, cy - y, r, g, b, a);
      y++;
      err += 1 + 2 * y;
      if (2 * (err - x) + 1 > 0) { x--; err += 1 - 2 * x; }
    }
  }

  // Draw a filled arc (for avatar)
  fillArc(cx, cy, radius, r, g, b, a = 255) {
    cx = Math.round(cx); cy = Math.round(cy);
    const r2 = radius * radius;
    const yMin = cy - radius, yMax = cy + radius;
    for (let py = Math.max(0, yMin); py <= Math.min(this.H - 1, yMax); py++) {
      const dx = Math.sqrt(r2 - (py - cy) * (py - cy));
      const xMin = Math.max(0, Math.round(cx - dx));
      const xMax = Math.min(this.W - 1, Math.round(cx + dx));
      for (let px = xMin; px <= xMax; px++) {
        const p = this._px(px, py);
        if (!p) continue;
        this.pixels[p.r] = r; this.pixels[p.g] = g;
        this.pixels[p.b] = b; this.pixels[p.a] = a;
      }
    }
  }

  // Rounded-rect fill helper
  fillRoundRect(x, y, w, h, radius, r, g, b, a = 255) {
    const x2 = Math.round(x), y2 = Math.round(y);
    const r2 = Math.round(radius);
    // Main body
    this.fillRect(x2 + r2, y2, w - r2 * 2, h, r, g, b, a);
    this.fillRect(x2, y2 + r2, w, h - r2 * 2, r, g, b, a);
    // Corner quads
    this.fillCircleQuadrant(x2 + r2, y2 + r2, r2, 1, r, g, b, a);
    this.fillCircleQuadrant(x2 + w - r2 - 1, y2 + r2, r2, 2, r, g, b, a);
    this.fillCircleQuadrant(x2 + w - r2 - 1, y2 + h - r2 - 1, r2, 3, r, g, b, a);
    this.fillCircleQuadrant(x2 + r2, y2 + h - r2 - 1, r2, 4, r, g, b, a);
  }

  fillCircleQuadrant(cx, cy, radius, quadrant, r, g, b, a = 255) {
    cx = Math.round(cx); cy = Math.round(cy);
    const r2 = radius * radius;
    for (let py = 0; py <= radius; py++) {
      for (let px = 0; px <= radius; px++) {
        if (px * px + py * py > r2) continue;
        const rx = quadrant <= 2 ? cx + px : cx - px;
        const ry = quadrant === 1 || quadrant === 2 ? cy + py : cy - py;
        const p = this._px(rx, ry);
        if (!p) continue;
        this.pixels[p.r] = r; this.pixels[p.g] = g;
        this.pixels[p.b] = b; this.pixels[p.a] = a;
      }
    }
  }
}

// ── Simple raster font ─────────────────────────────────────────

// 5x7 bitmap font (printable ASCII 0x20–0x7e)
const FONT_5X7 = {
  width: 5, height: 7,
  chars: {
    'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
    'C': [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
    'D': [0b11100,0b10010,0b10001,0b10001,0b10001,0b10010,0b11100],
    'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
    'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
    'G': [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
    'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'I': [0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
    'J': [0b00111,0b00010,0b00010,0b00010,0b10010,0b10010,0b01100],
    'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
    'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
    'M': [0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
    'N': [0b10001,0b11001,0b10101,0b10101,0b10011,0b10001,0b10001],
    'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
    'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
    'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
    'S': [0b01110,0b10001,0b10000,0b01110,0b00001,0b10001,0b01110],
    'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'V': [0b10001,0b10001,0b10001,0b10001,0b01010,0b01010,0b00100],
    'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
    'X': [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
    'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
    'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
    '0': [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
    '1': [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
    '2': [0b01110,0b10001,0b00001,0b00110,0b01000,0b10000,0b11111],
    '3': [0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
    '4': [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
    '5': [0b11111,0b10000,0b10000,0b11110,0b00001,0b00001,0b11110],
    '6': [0b01110,0b10000,0b10000,0b11110,0b10001,0b10001,0b01110],
    '7': [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
    '8': [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
    '9': [0b01110,0b10001,0b10001,0b01111,0b00001,0b00001,0b01110],
    '.': [0b00000,0b00000,0b00000,0b00000,0b00000,0b01100,0b01100],
    ',': [0b00000,0b00000,0b00000,0b00000,0b00110,0b00100,0b01000],
    ':': [0b00000,0b01100,0b01100,0b00000,0b01100,0b01100,0b00000],
    ';': [0b00110,0b00100,0b00000,0b00110,0b00100,0b01000,0b00000],
    '-': [0b00000,0b00000,0b00000,0b11111,0b00000,0b00000,0b00000],
    '_': [0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b11111],
    '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0b00000,0b00000],
    ' ': [0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b00000],
    '!': [0b00100,0b00100,0b00100,0b00100,0b00100,0b00000,0b00100],
    '?': [0b01110,0b10001,0b00001,0b00110,0b00100,0b00000,0b00100],
    "'": [0b00100,0b01000,0b00000,0b00000,0b00000,0b00000,0b00000],
    '"': [0b01010,0b01010,0b00000,0b00000,0b00000,0b00000,0b00000],
    '(': [0b00010,0b00100,0b01000,0b01000,0b01000,0b00100,0b00010],
    ')': [0b01000,0b00100,0b00010,0b00010,0b00010,0b00100,0b01000],
    '[': [0b01100,0b01000,0b01000,0b01000,0b01000,0b01000,0b01100],
    ']': [0b00110,0b00010,0b00010,0b00010,0b00010,0b00010,0b00110],
    '{': [0b00100,0b01000,0b01000,0b00100,0b01000,0b01000,0b00100],
    '}': [0b00100,0b00010,0b00010,0b00100,0b00010,0b00010,0b00100],
    '+': [0b00000,0b00100,0b00100,0b11111,0b00100,0b00100,0b00000],
    '=': [0b00000,0b00000,0b11111,0b00000,0b11111,0b00000,0b00000],
    '~': [0b00000,0b00000,0b00000,0b00100,0b01010,0b10001,0b00000],
    '#': [0b01010,0b01010,0b11111,0b01010,0b11111,0b01010,0b01010],
    '@': [0b01110,0b10001,0b10011,0b10111,0b10000,0b10001,0b01110],
    '$': [0b01110,0b10000,0b10000,0b01110,0b00001,0b00001,0b01110],
    '%': [0b11001,0b11010,0b00100,0b00100,0b00100,0b01011,0b10011],
    '^': [0b00100,0b01010,0b01010,0b00000,0b00000,0b00000,0b00000],
    '*': [0b00000,0b00100,0b10101,0b01110,0b10101,0b00100,0b00000],
    '&': [0b01100,0b10010,0b10100,0b01000,0b10101,0b10010,0b01101],
    '|': [0b00100,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    '\\': [0b10000,0b01000,0b00100,0b00010,0b00001,0b00000,0b00000],
  }
};

// ASCII code → char key (for printable range)
function charKey(code) {
  if (code >= 32 && code <= 126) return String.fromCharCode(code);
  return null;
}

function drawText(cvs, text, x, y, r, g, b, scale = 1) {
  const { width: fw, height: fh, chars } = FONT_5X7;
  const sw = fw * scale, sh = fh * scale;
  let cx = Math.round(x);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const bitmap = chars[ch];
    if (!bitmap) { cx += sw + scale; continue; }
    for (let row = 0; row < fh; row++) {
      for (let col = 0; col < fw; col++) {
        if (bitmap[row] & (1 << (fw - 1 - col))) {
          cvs.fillRect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cx += sw + scale;
  }
  return cx;
}

function measureText(text, scale = 1) {
  return text.length * (FONT_5X7.width + 1) * scale;
}

function drawTextCentered(cvs, text, cx, y, r, g, b, scale = 1) {
  const w = measureText(text, scale);
  drawText(cvs, text, cx - w / 2, y, r, g, b, scale);
}

// Word-wrap text into lines fitting maxWidth
function wrapText(text, maxWidth, scale = 1) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    const test = cur + ch;
    if (measureText(test, scale) > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── Gradient helper ────────────────────────────────────────────
function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function fillLinearGradient(cvs, x, y, w, h, colorStops, direction = 'vertical') {
  const n = Math.max(w, h);
  for (let i = 0; i < n; i++) {
    let t = direction === 'vertical' ? i / h : i / w;
    t = Math.max(0, Math.min(1, t));
    // Find surrounding stops
    let s0 = colorStops[0], s1 = colorStops[colorStops.length - 1];
    for (let j = 0; j < colorStops.length - 1; j++) {
      if (t >= colorStops[j][0] && t <= colorStops[j + 1][0]) {
        s0 = colorStops[j]; s1 = colorStops[j + 1];
        t = (t - s0[0]) / (s1[0] - s0[0]);
        break;
      }
    }
    const [r, g, b] = lerpColor(s0[1], s1[1], t);
    if (direction === 'vertical') {
      cvs.fillRect(x, y + i, w, 1, r, g, b);
    } else {
      cvs.fillRect(x + i, y, 1, h, r, g, b);
    }
  }
}

// ── Main card generator ────────────────────────────────────────

async function generateCard(req, res, params = {}) {
  const ip = getClientIP(req);
  const ua = req.headers['user-agent'] || '';
  const os = detectOS(ua);
  const browser = detectBrowser(ua);
  const device = getDeviceType(ua);
  const name = (params.name || '').replace(/[<>\"'&]/g, '').substring(0, 20);
  const theme = params.theme === 'dark' ? 'dark' : 'light';
  const scale = Math.max(0.5, Math.min(3, parseFloat(params.scale) || 1));

  // Base dimensions (will be scaled)
  const BW = Math.round(500 * scale);
  const BH = Math.round(220 * scale);
  const PAD = Math.round(10 * scale);
  const R = Math.round(14 * scale);
  const ACCENT = [249, 115, 22];   // #f97316
  const W = BW, H = BH;

  const geo = await fetchGeoData(ip);

  const cvs = new SimpleCanvas(W, H);

  // ── Background gradient ────────────────────────────────────────
  if (theme === 'dark') {
    fillLinearGradient(cvs, 0, 0, W, H, [
      [0,   [15,  23,  42]],
      [1,   [30,  41,  59]],
    ]);
  } else {
    fillLinearGradient(cvs, 0, 0, W, H, [
      [0,   [248, 250, 252]],
      [1,   [224, 242, 254]],
    ]);
  }

  // ── Top accent bar ─────────────────────────────────────────────
  cvs.fillRect(0, 0, W, Math.round(5 * scale), ACCENT[0], ACCENT[1], ACCENT[2]);

  // ── Card border ─────────────────────────────────────────────────
  const bx = PAD, by = PAD, bw = W - PAD * 2, bh = H - PAD * 2;
  // Draw a rounded rect outline
  cvs.fillRoundRect(bx, by, bw, bh, R, 0, 0, 0, 0); // fill placeholder
  // Since SimpleCanvas doesn't have stroke, we'll just use the alpha border trick
  // Draw border pixels with low alpha
  const borderColor = theme === 'dark' ? [255, 255, 255] : [0, 0, 0];
  const ba = Math.round(20 * scale);
  cvs.fillRoundRect(bx, by, bw, bh, R, borderColor[0], borderColor[1], borderColor[2], ba);
  // Cover inner area with background again
  cvs.fillRoundRect(bx + 1, by + 1, bw - 2, bh - 2, R - 1,
    theme === 'dark' ? 15 : 248, theme === 'dark' ? 23 : 250,
    theme === 'dark' ? 42 : 252);

  // ── Avatar ───────────────────────────────────────────────────────
  const ax = Math.round(40 * scale);
  const ay = Math.round(58 * scale);
  const ar = Math.round(30 * scale);

  // Gradient avatar bg
  cvs.fillArc(ax, ay, ar, 251, 146, 60); // orange-400
  cvs.drawCircle(ax, ay, ar, 234, 88, 12); // orange-600 outline

  // User silhouette (head)
  const hr = Math.round(9 * scale);
  cvs.fillArc(ax, ay - Math.round(4 * scale), hr, 255, 255, 255, 230);
  // Body arc
  for (let px = -Math.round(14 * scale); px <= Math.round(14 * scale); px++) {
    const dy = Math.round(Math.sqrt(Math.max(0, (Math.round(14 * scale) ** 2) - px * px)));
    for (let d = 0; d < dy; d++) {
      cvs.setPixel(ax + px, ay + Math.round(8 * scale) + d, 255, 255, 255, 230);
    }
  }

  // ── Colors based on theme ───────────────────────────────────────
  const titleCol = theme === 'dark' ? [241, 245, 249] : [30, 41, 59];
  const subCol    = theme === 'dark' ? [148, 163, 184] : [100, 116, 139];
  const labelCol  = theme === 'dark' ? [100, 116, 139] : [148, 163, 184];
  const valCol    = theme === 'dark' ? [241, 245, 249] : [51, 65, 85];
  const tagCol    = theme === 'dark' ? [71, 85, 105]   : [203, 213, 225];

  // ── Name / site title ───────────────────────────────────────────
  const nameText = name ? `Visitor · ${name}` : 'Visitor · Ethan\'s Page';
  const titleFS = Math.round(13 * scale);
  drawText(cvs, nameText, ax + ar + Math.round(12 * scale), ay - Math.round(16 * scale),
    titleCol[0], titleCol[1], titleCol[2], scale);

  // ── Time ────────────────────────────────────────────────────────
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const timeFS = Math.round(10 * scale);
  drawText(cvs, '>' + timeStr, ax + ar + Math.round(12 * scale), ay - Math.round(4 * scale),
    subCol[0], subCol[1], subCol[2], scale);

  // ── IP ──────────────────────────────────────────────────────────
  const ipText = 'IP:' + (geo?.query || ip);
  const ipFS = Math.round(11 * scale);
  drawText(cvs, ipText, ax + ar + Math.round(12 * scale), ay + Math.round(10 * scale),
    ACCENT[0], ACCENT[1], ACCENT[2], scale);

  // ── Divider ─────────────────────────────────────────────────────
  const divY = Math.round(105 * scale);
  cvs.drawLine(Math.round(18 * scale), divY, W - Math.round(18 * scale), divY,
    theme === 'dark' ? 100 : 200, theme === 'dark' ? 116 : 210, theme === 'dark' ? 134 : 220);

  // ── Info row ────────────────────────────────────────────────────
  const rowY1 = Math.round(116 * scale);
  const fsLabel = Math.round(9 * scale);
  const fsValue = Math.round(11 * scale);

  const cols = 3;
  const colW = Math.round((W - Math.round(36 * scale)) / cols);
  const colX = [Math.round(18 * scale), Math.round(18 * scale) + colW, Math.round(18 * scale) + colW * 2];

  const locStr = geo?.city ? `${geo.city},${geo.country}` : (geo?.country || 'Unknown');

  const labels = ['Location', 'OS', 'Browser'];
  const values = [locStr, os, browser];

  labels.forEach((lbl, i) => {
    // Label
    const lx = colX[i] + colW / 2;
    drawTextCentered(cvs, lbl, lx, rowY1, labelCol[0], labelCol[1], labelCol[2], fsLabel / FONT_5X7.height);
    // Value (may wrap)
    const maxVW = colW - Math.round(10 * scale);
    const lines = wrapText(values[i], maxVW, scale);
    lines.forEach((line, li) => {
      const vy = rowY1 + Math.round(14 * scale) + li * Math.round(9 * scale);
      drawTextCentered(cvs, line, lx, vy, valCol[0], valCol[1], valCol[2], scale);
    });
  });

  // ── Bottom tagline ──────────────────────────────────────────────
  const tagFS = Math.round(9 * scale);
  const tagY = H - Math.round(22 * scale);
  const tagText = 'Powered by 232310.xyz';
  const tagW = measureText(tagText, scale);
  drawTextCentered(cvs, tagText, W / 2, tagY, tagCol[0], tagCol[1], tagCol[2], scale);

  // ── Encode PNG ──────────────────────────────────────────────────
  const png = createPNG(W, H, (x, y) => {
    const off = (y * W + x) * 4;
    return [cvs.pixels[off], cvs.pixels[off+1], cvs.pixels[off+2], cvs.pixels[off+3]];
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(png);
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Routes ──────────────────────────────────────────────────────

// GET /netcard/img — returns PNG image
app.get('/netcard/img', async (req, res) => {
  try {
    await generateCard(req, res, req.query);
  } catch (err) {
    console.error('Card error:', err);
    res.status(500).type('text/plain').send('Error: ' + err.message);
  }
});

// GET /netcard — preview page
app.get('/netcard', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  const p = req.query;
  const pname  = (p.name  || '').replace(/[<>]/g, '').substring(0, 20);
  const pscale = p.scale  || '1';
  const ptheme = p.theme  || 'light';

  const escAttr = function(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  };

  const initParams = 'name=' + encodeURIComponent(pname) + '&scale=' + pscale + '&theme=' + ptheme;
  const previewSrc = base + '/netcard/img?' + initParams;

  const isSel = function(val, target) { return val === target ? 'selected' : ''; };

  const staticCode = '&lt;!-- 基础用法 --&gt;\n' +
    '&lt;img src="<span class="url">' + base + '/netcard/img</span>" <span class="attr">alt</span>=<span class="val">"IP Signature Card"</span> <span class="attr">width</span>=<span class="val">"500"</span>&gt;\n\n' +
    '&lt;!-- 带昵称和参数 --&gt;\n' +
    '&lt;img src="<span class="url">' + base + '/netcard/img?name=Ethan&amp;theme=light</span>" <span class="attr">alt</span>=<span class="val">"IP Signature Card"</span> <span class="attr">width</span>=<span class="val">"500"</span>&gt;';

  const html = '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
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
'    .tag{color:#7dd3fc}.attr{color:#86efac}.val{color:#fde68a}.url{color:#c4b5fd}\n' +
'    .copy-btn{margin-top:.5rem;padding:6px 16px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:.85rem;transition:background .2s}\n' +
'    .copy-btn:hover{background:#475569}.copy-btn.copied{background:#16a34a}\n' +
'    .back-link{margin-top:2rem;color:#f97316;text-decoration:none;font-size:.9rem}\n' +
'    .back-link:hover{text-decoration:underline}\n' +
'    @media(max-width:480px){.controls{flex-direction:column;align-items:stretch}.controls label{width:100%}.controls input,.controls select{width:100%}.controls button{width:100%}}\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <h1>IP 签名卡片</h1>\n' +
'  <p class="sub">为博客、论坛签名添加一张实时访客信息卡片</p>\n' +
'\n' +
'  <div class="preview"><img id="img" src="' + escAttr(previewSrc) + '" alt="IP 签名卡片预览"></div>\n' +
'\n' +
'  <div class="controls">\n' +
'    <label>昵称（可选）<input type="text" id="name" placeholder="e.g. Ethan" maxlength="20" value="' + escAttr(pname) + '"></label>\n' +
'    <label>缩放<select id="scale">\n' +
'      <option value="0.6" ' + isSel(pscale,'0.6') + '>0.6x 小</option>\n' +
'      <option value="1" ' + isSel(pscale,'1') + '>1x 标准</option>\n' +
'      <option value="1.5" ' + isSel(pscale,'1.5') + '>1.5x 大</option>\n' +
'      <option value="2" ' + isSel(pscale,'2') + '>2x Retina</option>\n' +
'    </select></label>\n' +
'    <label>主题<select id="theme">\n' +
'      <option value="light" ' + isSel(ptheme,'light') + '>light</option>\n' +
'      <option value="dark" ' + isSel(ptheme,'dark') + '>dark</option>\n' +
'    </select></label>\n' +
'    <button onclick="update()">refresh</button>\n' +
'  </div>\n' +
'\n' +
'  <div class="tip">\n' +
'    copy the code below and paste it into your blog/forum signature or any web page HTML. the card will automatically show the current visitor\'s real-time info on each page load.\n' +
'  </div>\n' +
'\n' +
'  <div class="code-section">\n' +
'    <h2>copy code</h2>\n' +
'    <div class="code-block" id="code">' + staticCode + '</div>\n' +
'    <button class="copy-btn" id="copy-btn" onclick="copyCode()">copy</button>\n' +
'  </div>\n' +
'\n' +
'  <a class="back-link" href="/">&lt;- back to Ethan\'s page</a>\n' +
'\n' +
'  <script>\n' +
'    var NETCARD_BASE = ' + JSON.stringify(base) + ';\n' +
'    function getParams() {\n' +
'      var n = document.getElementById("name").value.trim();\n' +
'      var s = document.getElementById("scale").value;\n' +
'      var t = document.getElementById("theme").value;\n' +
'      return "name=" + encodeURIComponent(n) + "&amp;scale=" + s + "&amp;theme=" + t;\n' +
'    }\n' +
'    function update() {\n' +
'      var img = document.getElementById("img");\n' +
'      img.src = NETCARD_BASE + "/netcard/img?" + getParams() + "&amp;_=" + Date.now();\n' +
'      var n = document.getElementById("name").value.trim() || "Ethan";\n' +
'      var s = document.getElementById("scale").value;\n' +
'      var t = document.getElementById("theme").value;\n' +
'      var nameEnc = encodeURIComponent(document.getElementById("name").value.trim());\n' +
'      var np = nameEnc ? "name=" + nameEnc : "";\n' +
'      var extra = "&amp;scale=" + s + "&amp;theme=" + t;\n' +
'      var codeEl = document.getElementById("code");\n' +
'      codeEl.innerHTML =\n' +
'        "&lt;!-- basic --&gt;\\n" +\n' +
'        \'&lt;img src="<span class="url">\' + NETCARD_BASE + "/netcard/img?" + getParams() + \'</span>" <span class="attr">alt</span>=<span class="val">"IP Signature Card"</span> <span class="attr">width</span>=<span class="val">"500"</span>&gt;\';\n' +
'    }\n' +
'    function copyCode() {\n' +
'      var txt = document.getElementById("code").innerText;\n' +
'      navigator.clipboard.writeText(txt).then(function() {\n' +
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

  res.type('html').send(html);
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Serve existing static homepage at root
app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
  console.log(`\n🎴 IP 签名卡片服务已启动`);
  console.log(`   主页:    http://localhost:${PORT}/`);
  console.log(`   预览页:  http://localhost:${PORT}/netcard`);
  console.log(`   图片API: http://localhost:${PORT}/netcard/img?name=xxx&theme=dark&scale=1\n`);
});
