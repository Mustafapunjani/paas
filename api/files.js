import { db, BUCKET, MAX_FILE_MB, MAX_FILES_PER_SPACE } from '../lib/supabase.js';
import { route, methodNotAllowed, HttpError, randomToken } from '../lib/util.js';
import { requireDevice, listFiles } from '../lib/space.js';

const UUID = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;

// Files never pass through Vercel (its functions cap request bodies at 4.5 MB).
// Instead the browser uploads straight to Supabase Storage with a one-time signed URL.
//
// GET    /api/files                -> list files
// GET    /api/files?download=ID    -> short-lived download link
// POST   /api/files { action: 'prepare', name, size, type } -> signed upload URL
// POST   /api/files { action: 'confirm', path, name, size, type } -> add finished upload to the list
// DELETE /api/files?id=ID          -> delete a file
export default route(async (req, res) => {
  const auth = await requireDevice(req);
  const storage = db().storage.from(BUCKET);

  if (req.method === 'GET') {
    if (req.query.download) {
      const file = await findFile(auth.spaceId, req.query.download);
      const { data, error } = await storage.createSignedUrl(file.path, 120, { download: file.name });
      if (error) throw error;
      res.status(200).json({ url: data.signedUrl });
      return;
    }
    res.status(200).json({ files: await listFiles(auth.spaceId) });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    if (body.action === 'prepare') {
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'That file is empty.');
      if (size > MAX_BYTES) throw new HttpError(413, `Files can be up to ${MAX_FILE_MB} MB.`);

      const { count, error: countError } = await db()
        .from('files')
        .select('id', { count: 'exact', head: true })
        .eq('space_id', auth.spaceId);
      if (countError) throw countError;
      if ((count || 0) >= MAX_FILES_PER_SPACE) {
        throw new HttpError(409, `This space has ${MAX_FILES_PER_SPACE} files. Delete some to upload more.`);
      }

      const path = `${auth.spaceId}/${randomToken(9)}/${safeFileName(body.name)}`;
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error) throw error;
      res.status(200).json({ bucket: BUCKET, path: data.path, token: data.token });
      return;
    }

    if (body.action === 'confirm') {
      const path = String(body.path || '');
      if (!path.startsWith(`${auth.spaceId}/`) || path.includes('..')) throw new HttpError(400, 'Invalid upload.');

      // Make sure the upload really landed before listing it.
      const slash = path.lastIndexOf('/');
      const { data: objects, error: listError } = await storage.list(path.slice(0, slash), { limit: 10 });
      if (listError) throw listError;
      const object = objects?.find((o) => o.name === path.slice(slash + 1));
      if (!object) throw new HttpError(400, 'The upload did not finish. Try uploading the file again.');

      const { data, error } = await db()
        .from('files')
        .upsert(
          {
            space_id: auth.spaceId,
            path,
            name: String(body.name || 'file').slice(0, 200),
            size: object.metadata?.size ?? (Number(body.size) || 0),
            mime: object.metadata?.mimetype || String(body.type || '') || null,
          },
          { onConflict: 'path' }
        )
        .select('id')
        .single();
      if (error) throw error;
      res.status(200).json({ ok: true, id: data.id });
      return;
    }

    throw new HttpError(400, 'Unknown action.');
  }

  if (req.method === 'DELETE') {
    const file = await findFile(auth.spaceId, req.query.id);
    const { error: removeError } = await storage.remove([file.path]);
    if (removeError) throw removeError;
    const { error } = await db().from('files').delete().eq('id', file.id);
    if (error) throw error;
    res.status(200).json({ ok: true });
    return;
  }

  throw methodNotAllowed();
});

async function findFile(spaceId, id) {
  if (!UUID.test(String(id || ''))) throw new HttpError(400, 'Missing file id.');
  const { data, error } = await db()
    .from('files')
    .select('id, name, path')
    .eq('id', id)
    .eq('space_id', spaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'That file was already deleted.');
  return data;
}

// Storage paths only allow simple characters; the real name is kept in the database.
function safeFileName(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  return cleaned.slice(-100) || 'file';
}
