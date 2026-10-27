import { db, BUCKET, FILE_DAYS } from '../lib/supabase.js';
import { route, HttpError } from '../lib/util.js';

// Runs once a day (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
// Deletes files older than FILE_DAYS, expired codes, devices unused for 90 days,
// and spaces with no devices left.
export default route(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    throw new HttpError(401, 'Not allowed.');
  }

  const cutoff = new Date(Date.now() - FILE_DAYS * 86_400_000).toISOString();
  const { data: oldFiles, error } = await db()
    .from('files')
    .select('id, path')
    .lt('created_at', cutoff)
    .limit(1000);
  if (error) throw error;

  if (oldFiles.length) {
    await removeFromStorage(oldFiles.map((f) => f.path));
    const { error: deleteError } = await db().from('files').delete().in('id', oldFiles.map((f) => f.id));
    if (deleteError) throw deleteError;
  }

  const { data: spacePaths, error: cleanupError } = await db().rpc('paas_cleanup');
  if (cleanupError) throw cleanupError;
  const paths = (spacePaths || []).map((p) => (typeof p === 'string' ? p : p?.paas_cleanup)).filter(Boolean);
  if (paths.length) await removeFromStorage(paths);

  res.status(200).json({ ok: true, oldFilesRemoved: oldFiles.length, deletedSpaceFilesRemoved: paths.length });
});

async function removeFromStorage(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await db().storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}
