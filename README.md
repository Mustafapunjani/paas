# Paas

Share text and files between your devices, on any network. Type on your laptop and it appears on your phone as you type. No account, no app.

The difference from ssavr.com: a device belongs to a **space**, not to an IP address. Once a device is linked, it stays linked on any WiFi or mobile data. Linking a device on another network takes one step: scan a QR code or type a 6-digit code.

## Set it up (about 15 minutes)

### 1. Create the database on Supabase

1. Sign up at [supabase.com](https://supabase.com) and create a new project (the free plan is enough). Pick a region close to your users, such as Mumbai or Singapore for Pakistan.
2. In the project, open **SQL Editor**, click **New query**, paste everything from `supabase/schema.sql`, and click **Run**. You should see "Success. No rows returned".
3. Open **Project Settings > API** and keep the tab open. You need three values from it: the **Project URL**, the **anon public** key, and the **service_role** key (click Reveal). The service_role key is a secret: never put it in frontend code or commit it to GitHub.

### 2. Put the code on GitHub

Create a new repository (for example `paas`) and push this folder to it. The `.gitignore` already keeps `node_modules` and `.env` out.

### 3. Deploy on Vercel

1. In Vercel, click **Add New > Project** and import the repository. Leave the framework as **Other**; `vercel.json` already sets everything up.
2. Before deploying, open **Environment Variables** and add these four:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL from Supabase |
   | `SUPABASE_ANON_KEY` | anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
   | `CRON_SECRET` | any long random text you make up |

3. Click **Deploy**. Open the link, tap **Start a new space**, then **Add device** and scan the QR code with your phone.

If you add or change environment variables later, redeploy (Deployments > ... > Redeploy) so they take effect.

### Testing on your computer (optional)

```bash
npm install
npm install -g vercel
cp .env.example .env      # then fill in your Supabase values
vercel dev
```

Open http://localhost:3000. To test "same WiFi" joining you need the deployed site, because on localhost every device looks the same.

## How it works

```
Browser (public/)                Vercel functions (api/)            Supabase
─────────────────                ───────────────────────            ────────
index.html, app.js  ── fetch ──> session, pair, text,     ── SQL ─> spaces, devices,
                                 devices, files, cron               pair_codes, files
       │                                                             Storage bucket "files"
       └──────────── live typing (Realtime broadcast) ─────────────> Realtime
       └──────────── file bytes (signed upload URL) ───────────────> Storage
```

**Identity.** When a device joins a space, the server gives it a random token, which the browser keeps in `localStorage`. The database only stores a hash of it. Every API call sends the token, so the device stays in its space whatever network it's on.

**Linking another device.** "Add device" makes a 6-digit code that works once and expires after 5 minutes. The QR code is just a link to `/join/<code>`, so scanning it with the phone camera links the phone with no typing. Each network gets 10 wrong guesses per 10 minutes, so codes can't be brute-forced.

**Same-WiFi shortcut.** The server records each device's network: its public IPv4 address, or for IPv6 the first half of the address (the /64 prefix), because every device on one WiFi gets a different IPv6 address within the same prefix. A new visitor from a network where a device was active in the last 24 hours sees "Your devices on this WiFi already have a space. Join it". Anyone can turn this off in the Devices panel, and you should if you use Paas on shared WiFi (office, university, café) or on mobile data, where many strangers can share one public IP.

**Live typing.** Text is broadcast through a Supabase Realtime channel as you type, and saved to the database 0.7 seconds after you stop. The channel name is a long random secret only linked devices receive. When a device is removed, the server changes that secret and the other devices fetch the new one, so the removed device stops getting updates.

**Files.** Vercel functions can't receive bodies over 4.5 MB, so files never pass through them. The browser asks `/api/files` for a one-time signed upload URL and uploads straight to Supabase Storage. Downloads use signed links that last 2 minutes.

**Cleanup.** `vercel.json` runs `/api/cron` once a day. It deletes files older than 7 days, expired codes, devices unused for 90 days, and spaces with no devices left.

**Security.** Every table has row level security turned on with no policies, so the public anon key in the browser can't read or write any data. Only the API routes, using the service_role key, can.

## Changing things

- **Name and look:** text is in `public/index.html`, colors are the variables at the top of `public/style.css`.
- **Limits** (file size, file lifetime, text length, code lifetime): `lib/supabase.js`. If you change the file size limit, also change `file_size_limit` in `supabase/schema.sql` or in Supabase under **Storage > files > Edit bucket**.
- **Code length or wrong-guess limit:** `api/pair.js`.

## Troubleshooting

- **"Paas isn't set up yet"**: an environment variable is missing on Vercel. Add it and redeploy.
- **Stuck on "Connecting…" or "Reconnecting…"**: in Supabase, open **Realtime > Settings** and make sure public channel access is allowed (it is by default). Text still saves without it; only live updates stop.
- **Upload fails**: check the `files` bucket exists under **Storage**. If not, run `schema.sql` again.
- **Error 500**: in Vercel, open the deployment's **Logs** to see the real error.

## Ideas for next steps

- A browser extension or Android share-sheet target to send text to Paas in one tap.
- Upload progress bars for large files.
- Secret notes that self-destruct after reading, like ssavr's.
- Edit history so an accidental "Clear" can be undone.
