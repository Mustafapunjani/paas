import crypto from 'node:crypto';
import { db, CODE_MINUTES } from '../lib/supabase.js';
import { route, methodNotAllowed, HttpError, clientIp, networkKey } from '../lib/util.js';
import { requireDevice, createDevice, sessionPayload } from '../lib/space.js';

const MAX_WRONG_TRIES = 10;     // per network...
const TRY_WINDOW_MINUTES = 10;  // ...in this many minutes

// POST /api/pair { action: 'create' }              -> new 6-digit code for this device's space
// POST /api/pair { action: 'redeem', code, name }  -> link this device using a code
export default route(async (req, res) => {
  if (req.method !== 'POST') throw methodNotAllowed();
  const body = req.body || {};

  if (body.action === 'create') {
    const auth = await requireDevice(req);

    // Only one live code per space; making a new one cancels the old one.
    const { error: clearError } = await db().from('pair_codes').delete().eq('space_id', auth.spaceId);
    if (clearError) throw clearError;

    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const { error } = await db().from('pair_codes').insert({ code, space_id: auth.spaceId, expires_at: expiresAt });
      if (!error) {
        res.status(200).json({ code, expiresAt });
        return;
      }
      if (error.code !== '23505') throw error; // 23505 = code already taken, try another
    }
    throw new HttpError(503, 'Could not make a code right now. Try again.');
  }

  if (body.action === 'redeem') {
    const network = networkKey(clientIp(req)) || 'unknown';
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'Codes have 6 digits. Check the code and try again.');

    const since = new Date(Date.now() - TRY_WINDOW_MINUTES * 60_000).toISOString();
    const { count, error: countError } = await db()
      .from('pair_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('network', network)
      .gte('created_at', since);
    if (countError) throw countError;
    if ((count || 0) >= MAX_WRONG_TRIES) {
      throw new HttpError(429, `Too many wrong codes from this network. Wait ${TRY_WINDOW_MINUTES} minutes and try again.`);
    }

    // Deleting and returning in one step makes each code usable exactly once,
    // even if two devices type it at the same moment.
    const { data: used, error } = await db()
      .from('pair_codes')
      .delete()
      .eq('code', code)
      .gt('expires_at', new Date().toISOString())
      .select('space_id');
    if (error) throw error;

    if (!used?.length) {
      await db().from('pair_attempts').insert({ network });
      throw new HttpError(400, 'That code is wrong or has expired. Make a new one on your other device.');
    }

    const { token, auth } = await createDevice(used[0].space_id, body.name, network === 'unknown' ? null : network);
    res.status(200).json(await sessionPayload(auth, { token }));
    return;
  }

  throw new HttpError(400, 'Unknown action.');
});
