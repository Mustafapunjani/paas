import { db } from '../lib/supabase.js';
import { route, methodNotAllowed, HttpError, cleanName } from '../lib/util.js';
import { requireDevice, listDevices, rotateChannelKey } from '../lib/space.js';

const UUID = /^[0-9a-f-]{36}$/i;

// GET    /api/devices          -> devices in this space
// PATCH  /api/devices { name } -> rename this device
// DELETE /api/devices?id=...   -> remove a device (or this one, to leave)
export default route(async (req, res) => {
  const auth = await requireDevice(req);

  if (req.method === 'GET') {
    res.status(200).json({ devices: await listDevices(auth.spaceId) });
    return;
  }

  if (req.method === 'PATCH') {
    const name = cleanName(req.body?.name, '');
    if (!name) throw new HttpError(400, 'Give the device a name.');
    const { error } = await db().from('devices').update({ name }).eq('id', auth.deviceId);
    if (error) throw error;
    res.status(200).json({ ok: true, name });
    return;
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!UUID.test(id)) throw new HttpError(400, 'Missing device id.');

    const { data: removed, error } = await db()
      .from('devices')
      .delete()
      .eq('id', id)
      .eq('space_id', auth.spaceId)
      .select('id');
    if (error) throw error;
    if (!removed?.length) throw new HttpError(404, 'That device is not in this space.');

    // New channel key, so the removed device stops receiving live updates.
    await rotateChannelKey(auth.spaceId);
    res.status(200).json({ ok: true, removedSelf: id === auth.deviceId });
    return;
  }

  throw methodNotAllowed();
});
