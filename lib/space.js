import { db, BUCKET, NETWORK_JOIN_HOURS, publicConfig } from './supabase.js';
import { HttpError, bearerToken, clientIp, networkKey, randomToken, sha256, cleanName } from './util.js';

// Finds the device behind the request's token, or throws 401.
// Also records which network the device is on, so other devices on the
// same WiFi can find this space later.
export async function requireDevice(req) {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'This device is not linked to a space.');

  const { data, error } = await db()
    .from('devices')
    .select('id, space_id, name, last_seen, last_network')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(401, 'This device was removed from its space.');

  const network = networkKey(clientIp(req));
  const minuteOld = Date.now() - new Date(data.last_seen).getTime() > 60_000;
  if (minuteOld || (network && network !== data.last_network)) {
    const { error: updateError } = await db()
      .from('devices')
      .update({ last_seen: new Date().toISOString(), last_network: network || data.last_network })
      .eq('id', data.id);
    if (updateError) console.error(updateError);
  }

  return { deviceId: data.id, spaceId: data.space_id, name: data.name, network };
}

export async function createSpace() {
  const { data, error } = await db()
    .from('spaces')
    .insert({ channel_key: randomToken(24) })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function createDevice(spaceId, name, network) {
  const token = randomToken(32);
  const { data, error } = await db()
    .from('devices')
    .insert({
      space_id: spaceId,
      token_hash: sha256(token),
      name: cleanName(name),
      last_network: network || null,
    })
    .select('id, name')
    .single();
  if (error) throw error;
  return { token, auth: { deviceId: data.id, spaceId, name: data.name, network } };
}

// The most recently active space on this network that allows joining without a code.
export async function findNetworkSpace(network) {
  if (!network) return null;
  const since = new Date(Date.now() - NETWORK_JOIN_HOURS * 3600_000).toISOString();
  const { data, error } = await db()
    .from('devices')
    .select('space_id, last_seen, spaces!inner(allow_network_join)')
    .eq('last_network', network)
    .eq('spaces.allow_network_join', true)
    .gte('last_seen', since)
    .order('last_seen', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.space_id || null;
}

export async function listDevices(spaceId) {
  const { data, error } = await db()
    .from('devices')
    .select('id, name, last_seen, created_at')
    .eq('space_id', spaceId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data.map((d) => ({ id: d.id, name: d.name, lastSeen: d.last_seen }));
}

const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;

export async function listFiles(spaceId) {
  const { data, error } = await db()
    .from('files')
    .select('id, name, path, size, mime, created_at')
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  // Signed preview links for images, valid for one hour.
  const previews = {};
  const images = data.filter((f) => PREVIEWABLE.test(f.mime || ''));
  if (images.length) {
    const { data: signed, error: signError } = await db()
      .storage.from(BUCKET)
      .createSignedUrls(images.map((f) => f.path), 3600);
    if (signError) console.error(signError);
    for (const item of signed || []) {
      if (item.signedUrl) previews[item.path] = item.signedUrl;
    }
  }

  return data.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    type: f.mime,
    createdAt: f.created_at,
    previewUrl: previews[f.path] || null,
  }));
}

// Everything a linked device needs to show the app.
export async function sessionPayload(auth, extra = {}) {
  const { data: space, error } = await db()
    .from('spaces')
    .select('id, channel_key, content, updated_at, allow_network_join')
    .eq('id', auth.spaceId)
    .single();
  if (error) throw error;

  const [devices, files] = await Promise.all([listDevices(auth.spaceId), listFiles(auth.spaceId)]);

  return {
    linked: true,
    config: publicConfig(),
    space: {
      channelKey: space.channel_key,
      content: space.content,
      updatedAt: space.updated_at,
      allowNetworkJoin: space.allow_network_join,
    },
    device: { id: auth.deviceId, name: auth.name },
    devices,
    files,
    ...extra,
  };
}

// Changing the channel key cuts a removed device off from live sync.
export async function rotateChannelKey(spaceId) {
  const { error } = await db().from('spaces').update({ channel_key: randomToken(24) }).eq('id', spaceId);
  if (error) throw error;
}
