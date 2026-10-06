require("dotenv").config();

const { createHash, randomInt } = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = Number(process.env.PORT) || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;
const sessionCodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const sessionCodeLength = 8;
const sessionCodeLifetimeMs = 5 * 60 * 1000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (path.extname(filePath) === ".html") res.setHeader("Cache-Control", "no-cache");
  },
}));

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({ error: "Supabase is not configured on the server." });
    return false;
  }
  return true;
}

async function getAuthenticatedUser(accessToken) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { error: "A Supabase access token is required.", status: 401 };
  }

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    return { error: "The session token is invalid or expired.", status: 401 };
  }

  const googleIdentity = data.user.identities?.find((identity) => identity.provider === "google");
  return { user: data.user, googleId: googleIdentity?.id || null };
}

function getBearerToken(req) {
  return (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
}

// Keep PC download resolution here so storage can be changed without touching the route.
async function getGameDownloadLink(gameId) {
  const { data, error } = await supabase
    .from("games")
    .select("download_url_pc")
    .eq("id", gameId)
    .single();
  if (error) throw error;
  return data.download_url_pc;
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hashSessionCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

function createSessionCode() {
  return Array.from({ length: sessionCodeLength }, () => (
    sessionCodeAlphabet[randomInt(sessionCodeAlphabet.length)]
  )).join("");
}

app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: supabaseUrl || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

app.get("/api/users/username-available", async (req, res) => {
  if (!requireSupabase(res)) return;

  const username = normalizeUsername(req.query.username);
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-24 characters using lowercase letters, numbers, or underscores." });
  }

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .ilike("username", username)
    .maybeSingle();
  if (error) {
    console.error("Could not check username availability:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    if (error.code === "42703") {
      return res.status(503).json({ error: "Email signup is unavailable until the username migration in supabase/schema.sql has been applied." });
    }
    return res.status(500).json({ error: "Could not check username availability." });
  }

  res.json({ available: !data });
});

app.post("/api/login", async (req, res) => {
  if (!requireSupabase(res)) return;

  const result = await getAuthenticatedUser(req.body?.access_token);
  if (result.error) return res.status(result.status).json({ error: result.error });

  const { data: existingProfile, error: profileLookupError } = await supabase
    .from("users")
    .select("username")
    .eq("id", result.user.id)
    .maybeSingle();
  if (profileLookupError) {
    console.error("Could not load user profile:", profileLookupError.message);
    if (["42703", "42P01"].includes(profileLookupError.code)) {
      return res.status(503).json({
        error: "The Supabase user profile schema is missing or out of date. Run supabase/schema.sql in the Supabase SQL Editor, then try again.",
      });
    }
    return res.status(500).json({ error: "Could not load the user profile." });
  }

  const displayName = result.user.user_metadata?.display_name
    || result.user.user_metadata?.full_name
    || result.user.user_metadata?.name
    || result.user.email
    || "Player";
  const username = existingProfile?.username
    || normalizeUsername(result.user.user_metadata?.username)
    || `${normalizeUsername(displayName).replace(/[^a-z0-9_]/g, "_").slice(0, 14) || "player"}_${result.user.id.replaceAll("-", "").slice(0, 8)}`;
  const { data: profile, error } = await supabase
    .from("users")
    .upsert({
      id: result.user.id,
      google_id: result.googleId,
      username,
      display_name: displayName,
      email: result.user.email,
    }, { onConflict: "id" })
    .select("id, username, display_name, email")
    .single();

  if (error) {
    console.error("Could not save user profile:", error.message);
    return res.status(500).json({ error: "Could not save the user profile." });
  }

  res.json({ session_token: req.body.access_token, user: profile });
});

app.get("/api/session/code", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const authorization = req.get("authorization") || "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const result = await getAuthenticatedUser(accessToken);
  if (result.error) return res.status(result.status).json({ error: result.error });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionCodeLifetimeMs).toISOString();
  const { error: cleanupError } = await supabase
    .from("session_login_codes")
    .delete()
    .lt("expires_at", now.toISOString());
  if (cleanupError) {
    console.error("Could not clear expired session codes:", cleanupError.message);
    return res.status(500).json({ error: "Could not create a game login code." });
  }

  const { error: revokeError } = await supabase
    .from("session_login_codes")
    .delete()
    .eq("user_id", result.user.id);
  if (revokeError) {
    console.error("Could not replace previous session code:", revokeError.message);
    return res.status(500).json({ error: "Could not create a game login code." });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = createSessionCode();
    const { error } = await supabase
      .from("session_login_codes")
      .insert({
        code_hash: hashSessionCode(code),
        user_id: result.user.id,
        session_token: accessToken,
        expires_at: expiresAt,
      });

    if (!error) return res.json({ code, expires_in: sessionCodeLifetimeMs / 1000 });
    if (error.code !== "23505") {
      console.error("Could not create session code:", error.message);
      return res.status(500).json({ error: "Could not create a game login code." });
    }
  }

  res.status(503).json({ error: "Could not create a unique game login code. Try again." });
});

app.post("/api/session/redeem", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(code)) {
    return res.status(400).json({ error: "A valid 8-character game login code is required." });
  }

  const { data, error } = await supabase
    .from("session_login_codes")
    .delete()
    .eq("code_hash", hashSessionCode(code))
    .gt("expires_at", new Date().toISOString())
    .select("session_token")
    .maybeSingle();
  if (error) {
    console.error("Could not redeem session code:", error.message);
    return res.status(500).json({ error: "Could not redeem the game login code." });
  }
  if (!data) return res.status(401).json({ error: "The game login code is invalid, expired, or already used." });

  res.json({ session_token: data.session_token });
});

app.post("/api/scores/submit", async (req, res) => {
  if (!requireSupabase(res)) return;

  const result = await getAuthenticatedUser(req.body?.session_token);
  if (result.error) return res.status(result.status).json({ error: result.error });

  const { game_slug: gameSlug, score } = req.body || {};
  if (typeof gameSlug !== "string" || !gameSlug.trim()) {
    return res.status(400).json({ error: "A game_slug is required." });
  }
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    return res.status(400).json({ error: "Score must be a non-negative number." });
  }

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id")
    .eq("slug", gameSlug.trim())
    .maybeSingle();
  if (gameError) {
    console.error("Could not look up game:", gameError.message);
    return res.status(500).json({ error: "Could not look up the game." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { data, error } = await supabase
    .from("scores")
    .upsert({
      user_id: result.user.id,
      game_id: game.id,
      score,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "user_id,game_id",
    })
    .select("score, updated_at")
    .single();
  if (error) {
    console.error("Could not save score:", error.message);
    return res.status(500).json({ error: "Could not save the score." });
  }

  res.json(data);
});

app.get("/api/scores/leaderboard", async (req, res) => {
  if (!requireSupabase(res)) return;

  const gameSlug = typeof req.query.game === "string" ? req.query.game.trim() : "";
  if (!gameSlug) return res.status(400).json({ error: "A game query parameter is required." });

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id")
    .eq("slug", gameSlug)
    .maybeSingle();
  if (gameError) {
    console.error("Could not look up game:", gameError.message);
    return res.status(500).json({ error: "Could not look up the game." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { data, error } = await supabase
    .from("scores")
    .select("score, users!inner(username)")
    .eq("game_id", game.id)
    .order("score", { ascending: false })
    .limit(10);
  if (error) {
    console.error("Could not load leaderboard:", error.message);
    return res.status(500).json({ error: "Could not load the leaderboard." });
  }

  res.json(data.map((entry) => ({ username: entry.users.username, score: entry.score })));
});

app.get("/api/games", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const accessToken = getBearerToken(req);
  let userId = null;
  if (accessToken) {
    const authResult = await getAuthenticatedUser(accessToken);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    userId = authResult.user.id;
  }

  const { data: games, error } = await supabase
    .from("games")
    .select("id, slug, name, download_url_android")
    .order("name", { ascending: true });
  if (error) {
    console.error("Could not load games:", error.message);
    return res.status(500).json({ error: "Could not load games." });
  }

  let ownedGameIds = new Set();
  if (userId) {
    const { data: purchases, error: purchaseError } = await supabase
      .from("purchases")
      .select("game_id")
      .eq("user_id", userId);
    if (purchaseError) {
      console.error("Could not load game ownership:", purchaseError.message);
      return res.status(503).json({ error: "Game ownership is unavailable. Apply the purchases table in supabase/schema.sql." });
    }
    ownedGameIds = new Set(purchases.map((purchase) => purchase.game_id));
  }

  res.json(games.map(({ id, ...game }) => ({ ...game, owned: ownedGameIds.has(id) })));
});

app.post("/api/games/:slug/purchase", async (req, res) => {
  if (!requireSupabase(res)) return;

  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id")
    .eq("slug", req.params.slug)
    .maybeSingle();
  if (gameError) {
    console.error("Could not look up game for purchase:", gameError.message);
    return res.status(500).json({ error: "Could not look up the game." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { error } = await supabase
    .from("purchases")
    .upsert({ user_id: authResult.user.id, game_id: game.id }, {
      onConflict: "user_id,game_id",
      ignoreDuplicates: true,
    });
  if (error) {
    console.error("Could not add game to library:", error.message);
    return res.status(503).json({ error: "Game acquisition is unavailable. Apply the purchases table in supabase/schema.sql." });
  }

  res.json({ owned: true });
});

app.get("/api/games/:slug/download", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id")
    .eq("slug", req.params.slug)
    .maybeSingle();
  if (gameError) {
    console.error("Could not look up game for download:", gameError.message);
    return res.status(500).json({ error: "Could not look up the game." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { data: purchase, error: purchaseError } = await supabase
    .from("purchases")
    .select("game_id")
    .eq("user_id", authResult.user.id)
    .eq("game_id", game.id)
    .maybeSingle();
  if (purchaseError) {
    console.error("Could not check game ownership:", purchaseError.message);
    return res.status(503).json({ error: "Game ownership is unavailable. Apply the purchases table in supabase/schema.sql." });
  }
  if (!purchase) return res.status(403).json({ error: "You need to get this game before downloading it." });

  try {
    const url = await getGameDownloadLink(game.id);
    if (!url) return res.status(404).json({ error: "A PC download is not available for this game." });
    res.json({ url });
  } catch (error) {
    console.error("Could not get game download link:", error.message);
    res.status(500).json({ error: "Could not get the game download link." });
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.listen(port, () => {
  console.log(`Onyx Games is running at http://localhost:${port}`);
  if (!supabase || !process.env.SUPABASE_ANON_KEY) {
    console.warn("Set Supabase environment variables to enable authentication and API data.");
  }
});