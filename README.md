# Onyx Games

An Express website and API backed by Supabase Auth and Postgres. The browser uses the Supabase anon key for Google and email/password sign-in; Supabase Auth securely stores password hashes, and the server uses the service-role key for verified profile and score writes.

## Run locally

1. Install Node.js 20 or newer.
2. Create a Supabase project and follow [Google OAuth setup](#google-oauth-setup). Enable email sign-ups in Supabase Authentication settings if they are disabled.
3. In the Supabase SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql). Re-run it on existing projects to apply the username migration and Auth profile trigger.
4. Run [`supabase/device-link.sql`](supabase/device-link.sql) in the Supabase SQL Editor to enable device linking and long-lived game sessions.
5. Copy `.env.example` to `.env` and fill in the project URL, anon key, and service-role key from Supabase Project Settings → API. In PowerShell, use `Copy-Item .env.example .env`.
6. From the project folder, install and start the app:

   ```powershell
   npm.cmd install
   npm.cmd run dev
   ```

6. Open <http://localhost:3000>. Use `npm.cmd start` for a normal (non-watch) start.

The game appears in the library after the schema is applied. PC downloads require the user to select **Get** first; the server checks ownership before returning the configured PC URL. Set the PC URL in Supabase:

```sql
update public.games
set download_url_pc = 'https://your-host/your-windows-build.zip'
where slug = 'stare-at-a-guy-simulator';
```

## Google OAuth setup

1. In Google Cloud Console, create or select a project, configure the OAuth consent screen, and create an OAuth client ID of type **Web application**.
2. In Supabase Dashboard → Authentication → Providers → Google, enable Google and paste the Google client ID and client secret.
3. In that provider page, copy the Supabase callback URL (typically `https://<project-ref>.supabase.co/auth/v1/callback`) into the Google OAuth client's **Authorized redirect URIs**. Google will reject the provider setup if this callback does not match exactly.
4. In Supabase Dashboard → Authentication → URL Configuration, add `http://localhost:3000` to the allowed redirect URLs. The website redirects Google sign-in back to this origin.
5. In Supabase Project Settings → API, copy the Project URL and anon/public key into `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Copy the service-role key into `SUPABASE_SERVICE_ROLE_KEY`. Keep the service-role key private and never put it in browser code or commit `.env`.

## Deploy on Render

The included [`render.yaml`](render.yaml) defines a Render web service using its free plan where available. Push this project to a Git repository, create a new Blueprint in Render from that repository, and enter the three Supabase environment values when prompted. After deployment, set the generated HTTPS URL as Supabase's Site URL and add it to the allowed redirect URLs. The Google OAuth client's authorized redirect URI remains the Supabase callback URL. Free-tier availability, limits, and sleep behavior are controlled by Render and can change.

## API

- `GET /api/games` returns the game catalog and, when authenticated, per-user ownership. It does not expose the PC download URL.
- `POST /api/games/:slug/purchase` requires `Authorization: Bearer <Supabase access token>` and adds the currently free game to the user's library.
- `GET /api/games/:slug/download` requires the same bearer token and returns the download URL only when the user owns the game.
- `POST /api/login` accepts `{ "access_token": "<Supabase access token>" }`. It verifies the token, upserts the local profile, and returns `{ "session_token": "...", "user": { ... } }`. The session token is the Supabase access token; the game client should treat it as a bearer secret and send it as `session_token` to score submission.
- `GET /api/users/username-available?username=<username>` checks whether a username is available for signup.
- `GET /api/session/code` requires `Authorization: Bearer <Supabase access token>` and returns an eight-character, one-time code that expires after five minutes. The website displays this code after Google sign-in.
- `POST /api/session/redeem` accepts `{ "code": "..." }` and returns `{ "session_token": "<Supabase access token>" }`. Redemption consumes the code; the game should keep the returned token secret and use it for authenticated API requests.
- `POST /api/device/start` requires no login and returns a private `device_code`, a short `user_code`, and a verification URL. The device code expires after 10 minutes.
- `POST /api/device/poll` accepts `{ "device_code": "..." }` and returns `pending`, `expired`, `denied`, or `approved`. The first approved poll returns a random game session token valid for 90 days; that approval can only be redeemed once. Polling is rate limited.
- `POST /api/device/approve` and `POST /api/device/deny` require `Authorization: Bearer <Supabase access token>` and `{ "user_code": "..." }`. Players use the link page to authenticate and approve or cancel.
- `POST /api/session/revoke` accepts `Authorization: Bearer <game session token>` (or `{ "session_token": "..." }`) and deletes the hashed game session so the game can sign out.
- `GET /api/session/me`, score submission, game ownership, and downloads accept either a game session token or a Supabase access token. Game session tokens are stored only as SHA-256 hashes.
- `POST /api/scores/submit` accepts `{ "session_token": "...", "game_slug": "stare-at-a-guy-simulator", "score": 123 }`. The supplied score replaces the user's current total for that game.
- `GET /api/scores/leaderboard?game=stare-at-a-guy-simulator` returns the top 10 `{ "username", "score" }` entries in descending score order.