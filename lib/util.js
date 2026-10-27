import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps an API route so thrown errors become clean JSON responses.
export function route(fn) {
  return async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.' });
    }
  };
}

export function methodNotAllowed() {
  return new HttpError(405, 'This method is not supported here.');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function clientIp(req) {
  // Vercel sets these headers itself and overwrites anything the visitor sends.
  const real = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const first = (value) => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
  return first(real) || first(forwarded) || req.socket?.remoteAddress || '';
}

// Devices on one WiFi share a single public IPv4 address. With IPv6, though,
// each device gets its own address inside the network's /64 prefix, so we
// group IPv6 visitors by their first four blocks instead of the full address.
export function networkKey(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (!value) return '';
  value = value.split('%')[0];
  if (value.startsWith('::ffff:') && value.includes('.')) return value.slice(7);
  if (!value.includes(':')) return value;
  const blocks = expandIPv6(value);
  if (!blocks) return value;
  return blocks.slice(0, 4).map((b) => b.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function expandIPv6(ip) {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  if (parts.length === 1) return head.length === 8 ? head : null;
  const tail = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail];
}

export function cleanName(name, fallback = 'Device') {
  const text = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return text || fallback;
}
