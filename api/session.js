import { db, publicConfig } from '../lib/supabase.js';
import { route, methodNotAllowed, HttpError, bearerToken, clientIp, networkKey } from '../lib/util.js';
import { requireDevice, createSpace, createDevice, findNetworkSpace, sessionPayload } from '../lib/space.js';

// GET  /api/session                          -> the device's space, or join options if not linked
// POST /api/session { action: 'create' }       -> start a new space on this device
// POST /api/session { action: 'join-network' } -> join the space already open on this WiFi
// POST /api/session { action: 'settings' }     -> change space settings
export default route(async (req, res) => {
  const network = networkKey(clientIp(req));

  if (req.method === 'GET') {
    if (bearerToken(req)) {
      try {
        const auth = await requireDevice(req);
        res.status(200).json(await sessionPayload(auth));
        return;
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 401)) throw err;
        // Token no longer valid: fall through and show the join screen.
      }
    }
    const networkSpace = await findNetworkSpace(network);
    res.status(200).json({ linked: false, config: publicConfig(), networkSpace: Boolean(networkSpace) });
    return;
  }

  if (req.method !== 'POST') throw methodNotAllowed();
  const body = req.body || {};

  if (body.action === 'create') {
    const spaceId = await createSpace();
    const { token, auth } = await createDevice(spaceId, body.name, network);
    res.status(200).json(await sessionPayload(auth, { token }));
    return;
  }

  if (body.action === 'join-network') {
    const spaceId = await findNetworkSpace(network);
    if (!spaceId) {
      throw new HttpError(404, 'No open space found on this network. Use a code from one of your devices instead.');
    }
    const { token, auth } = await createDevice(spaceId, body.name, network);
    res.status(200).json(await sessionPayload(auth, { token }));
    return;
  }

  if (body.action === 'settings') {
    const auth = await requireDevice(req);
    if (typeof body.allowNetworkJoin !== 'boolean') throw new HttpError(400, 'allowNetworkJoin must be true or false.');
    const { error } = await db()
      .from('spaces')
      .update({ allow_network_join: body.allowNetworkJoin })
      .eq('id', auth.spaceId);
    if (error) throw error;
    res.status(200).json({ ok: true, allowNetworkJoin: body.allowNetworkJoin });
    return;
  }

  throw new HttpError(400, 'Unknown action.');
});
