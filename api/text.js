import { db, MAX_TEXT_CHARS } from '../lib/supabase.js';
import { route, methodNotAllowed, HttpError } from '../lib/util.js';
import { requireDevice } from '../lib/space.js';

// POST /api/text { content } -> save the shared text
export default route(async (req, res) => {
  if (req.method !== 'POST') throw methodNotAllowed();
  const auth = await requireDevice(req);

  const content = req.body?.content;
  if (typeof content !== 'string') throw new HttpError(400, 'content must be text.');
  if (content.length > MAX_TEXT_CHARS) {
    throw new HttpError(413, `The text is over ${MAX_TEXT_CHARS.toLocaleString('en')} characters. Upload it as a file instead.`);
  }

  const updatedAt = new Date().toISOString();
  const { error } = await db().from('spaces').update({ content, updated_at: updatedAt }).eq('id', auth.spaceId);
  if (error) throw error;

  res.status(200).json({ ok: true, updatedAt });
});
