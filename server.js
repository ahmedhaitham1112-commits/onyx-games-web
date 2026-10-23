require("dotenv").config();

const { createHash, randomBytes, randomInt } = require("node:crypto");
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
const deviceLinkLifetimeMs = 10 * 60 * 1000;
const gameSessionLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const devicePollRateLimits = new Map();
const questClaimRateLimits = new Map();
const gameFileSizes = new Map([
  ["stare-at-a-guy-simulator", 154521006],
]);

app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  if (!["/api/device/start", "/api/device/poll"].includes(req.path)) return next();
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1y",
  immutable: true,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(extension)) return;
    res.setHeader("Cache-Control", "no-cache");
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

function logDeviceLinkError(action, error) {
  const redact = (value) => {
    if (typeof value !== "string") return value ?? null;
    return value
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]")
      .replace(/((?:device_code|session_token|access_token|api[_ -]?key|secret)\s*[:=]\s*)["']?[^,\s"']+/gi, "$1[REDACTED]");
  };
  console.error(`Device-link ${action} failed:`, {
    code: redact(error?.code),
    message: redact(error?.message),
    details: redact(error?.details),
    hint: redact(error?.hint),
  });
}

function withDeviceLinkErrorLogging(action, publicMessage, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      logDeviceLinkError(action, error);
      return res.status(500).json({ error: publicMessage });
    }
  };
}

function createSessionCode() {
  return Array.from({ length: sessionCodeLength }, () => (
    sessionCodeAlphabet[randomInt(sessionCodeAlphabet.length)]
  )).join("");
}

async function getSessionUser(accessToken) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { error: "A session token is required.", status: 401 };
  }

  const { data: gameSession, error } = await supabase
    .from("game_sessions")
    .select("user_id")
    .eq("token_hash", hashSessionCode(accessToken))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) {
    if (["42P01", "PGRST205"].includes(error.code)) return getAuthenticatedUser(accessToken);
    console.error("Could not validate game session:", error.code);
    return { error: "Could not validate the session token.", status: 500 };
  }

  if (gameSession) {
    const { error: updateError } = await supabase
      .from("game_sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", hashSessionCode(accessToken));
    if (updateError) {
      console.error("Could not update game session activity:", updateError.code);
      return { error: "Could not validate the session token.", status: 500 };
    }

    const { data, error: userError } = await supabase.auth.admin.getUserById(gameSession.user_id);
    if (userError || !data.user) return { error: "The session token is invalid or expired.", status: 401 };
    const googleIdentity = data.user.identities?.find((identity) => identity.provider === "google");
    return { user: data.user, googleId: googleIdentity?.id || null };
  }

  return getAuthenticatedUser(accessToken);
}

function takeDevicePollRateLimit(key) {
  const now = Date.now();
  let entry = devicePollRateLimits.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    entry = { startedAt: now, count: 0 };
    devicePollRateLimits.set(key, entry);
  }
  entry.count += 1;
  if (devicePollRateLimits.size > 10_000) {
    for (const [rateKey, rateEntry] of devicePollRateLimits) {
      if (now - rateEntry.startedAt >= 60_000) devicePollRateLimits.delete(rateKey);
    }
  }
  return entry.count <= 120;
}

function takeQuestClaimRateLimit(key) {
  const now = Date.now();
  let entry = questClaimRateLimits.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    entry = { startedAt: now, count: 0 };
    questClaimRateLimits.set(key, entry);
  }
  entry.count += 1;
  if (questClaimRateLimits.size > 10_000) {
    for (const [rateKey, rateEntry] of questClaimRateLimits) {
      if (now - rateEntry.startedAt >= 60_000) questClaimRateLimits.delete(rateKey);
    }
  }
  return entry.count <= 12;
}

async function getGameBySlug(gameSlug) {
  const { data, error } = await supabase
    .from("games")
    .select("id, slug")
    .eq("slug", gameSlug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function recordQuestProgress(userId, gameId, includeGameSignin = false) {
  const { data: quests, error: questError } = await supabase
    .from("quests")
    .select("id, title, position, metric, target")
    .eq("game_id", gameId)
    .order("position");
  if (questError) throw questError;

  const scoreQuests = quests.filter((quest) => quest.metric === "score");
  let lifetimeScore = null;
  if (scoreQuests.length) {
    const { data: score, error: scoreError } = await supabase
      .from("scores")
      .select("score")
      .eq("user_id", userId)
      .eq("game_id", gameId)
      .maybeSingle();
    if (scoreError) throw scoreError;
    lifetimeScore = score?.score ?? null;
  }

  const eligible = quests.filter((quest) => (
    (quest.metric === "game_signin" && includeGameSignin)
    || (quest.metric === "score" && lifetimeScore !== null && Number(lifetimeScore) >= Number(quest.target))
  ));
  if (!eligible.length) return [];

  const { data: inserted, error: completionError } = await supabase
    .from("quest_completions")
    .upsert(eligible.map((quest) => ({ user_id: userId, quest_id: quest.id })), {
      onConflict: "user_id,quest_id",
      ignoreDuplicates: true,
    })
    .select("quest_id");
  if (completionError) throw completionError;

  const newlyCompletedIds = new Set((inserted || []).map((completion) => completion.quest_id));
  return eligible
    .filter((quest) => newlyCompletedIds.has(quest.id))
    .map(({ id, title, position }) => ({ id, title, position }));
}

function logQuestError(action, error) {
  console.error(`Quest ${action} failed:`, {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
  });
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

app.post("/api/device/start", withDeviceLinkErrorLogging("start", "Could not start device sign-in.", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const gameSlug = typeof req.body?.game_slug === "string" && req.body.game_slug.trim()
    ? req.body.game_slug.trim()
    : "stare-at-a-guy-simulator";
  const game = await getGameBySlug(gameSlug);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const expiresAt = new Date(Date.now() + deviceLinkLifetimeMs).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = createSessionCode();
    const { error } = await supabase.from("device_links").insert({
      device_code_hash: hashSessionCode(deviceCode),
      user_code: userCode,
      game_id: game.id,
      status: "pending",
      expires_at: expiresAt,
    });
    if (!error) {
      return res.status(201).json({
        device_code: deviceCode,
        user_code: userCode,
        verification_url: `https://onyx-games-production.up.railway.app/link.html?code=${userCode}`,
        expires_in: deviceLinkLifetimeMs / 1000,
      });
    }
    logDeviceLinkError("start", error);
    if (error.code !== "23505") {
      return res.status(500).json({ error: "Could not start device sign-in." });
    }
  }
  res.status(503).json({ error: "Could not create a unique device link. Try again." });
}));

app.post("/api/device/poll", withDeviceLinkErrorLogging("poll", "Could not check device sign-in.", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const deviceCode = typeof req.body?.device_code === "string" ? req.body.device_code : "";
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(deviceCode)) {
    return res.status(400).json({ error: "A valid device_code is required." });
  }
  const deviceCodeHash = hashSessionCode(deviceCode);
  if (!takeDevicePollRateLimit(deviceCodeHash)) {
    res.set("Retry-After", "1");
    return res.status(429).json({ error: "Device sign-in polling is temporarily rate limited." });
  }

  const { data, error } = await supabase.rpc("poll_device_link", { p_device_code_hash: deviceCodeHash });
  if (error) {
    logDeviceLinkError("poll", error);
    return res.status(500).json({ error: "Could not check device sign-in." });
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || !["pending", "expired", "denied", "approved"].includes(result.status)) {
    return res.status(500).json({ error: "Could not check device sign-in." });
  }
  if (result.status !== "approved") return res.json({ status: result.status });

  const { data: notification, error: notificationError } = await supabase
    .from("device_links")
    .update({ newly_completed_quests: null })
    .eq("device_code_hash", deviceCodeHash)
    .not("newly_completed_quests", "is", null)
    .select("newly_completed_quests")
    .maybeSingle();
  if (notificationError) throw notificationError;
  res.json({
    status: "approved",
    session_token: result.session_token,
    expires_in: gameSessionLifetimeMs / 1000,
    newly_completed_quests: notification?.newly_completed_quests || [],
  });
}));

app.post("/api/device/approve", withDeviceLinkErrorLogging("approve", "Could not approve device sign-in.", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const userCode = typeof req.body?.user_code === "string" ? req.body.user_code.trim().toUpperCase() : "";
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(userCode)) {
    return res.status(400).json({ error: "A valid user_code is required." });
  }
  const { data, error } = await supabase.rpc("approve_device_link", {
    p_user_code: userCode,
    p_user_id: authResult.user.id,
  });
  if (error) {
    logDeviceLinkError("approve", error);
    return res.status(500).json({ error: "Could not approve device sign-in." });
  }
  if (!Array.isArray(data) || !data.length) return res.status(409).json({ error: "This device link has expired or is no longer pending." });
  res.json({ approved: true });
}));

app.post("/api/device/deny", withDeviceLinkErrorLogging("deny", "Could not cancel device sign-in.", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const userCode = typeof req.body?.user_code === "string" ? req.body.user_code.trim().toUpperCase() : "";
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(userCode)) {
    return res.status(400).json({ error: "A valid user_code is required." });
  }
  const { data, error } = await supabase
    .from("device_links")
    .update({ status: "denied", user_id: authResult.user.id })
    .eq("user_code", userCode)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("user_code")
    .maybeSingle();
  if (error) {
    logDeviceLinkError("deny", error);
    return res.status(500).json({ error: "Could not cancel device sign-in." });
  }
  if (!data) return res.status(409).json({ error: "This device link has expired or is no longer pending." });
  res.json({ denied: true });
}));

app.post("/api/session/revoke", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const token = getBearerToken(req) || req.body?.session_token;
  if (typeof token !== "string" || !token) {
    return res.status(400).json({ error: "A session token is required." });
  }
  const { error } = await supabase
    .from("game_sessions")
    .delete()
    .eq("token_hash", hashSessionCode(token));
  if (error) {
    console.error("Could not revoke game session:", error.code);
    return res.status(500).json({ error: "Could not sign out the game session." });
  }
  res.json({ revoked: true });
});

app.get("/api/session/me", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: "A Supabase access token is required." });
  }
  if (!requireSupabase(res)) return;

  const result = await getSessionUser(accessToken);
  if (result.error) return res.status(result.status).json({ error: result.error });

  const { data: profile, error } = await supabase
    .from("users")
    .select("id, username, display_name")
    .eq("id", result.user.id)
    .maybeSingle();
  if (error) {
    console.error("Could not load user profile:", error.message);
    return res.status(500).json({ error: "Could not load the user profile." });
  }

  const displayName = profile?.display_name
    || result.user.user_metadata?.display_name
    || result.user.user_metadata?.full_name
    || result.user.user_metadata?.name
    || result.user.email
    || "Player";
  const username = profile?.username
    || normalizeUsername(result.user.user_metadata?.username)
    || `${normalizeUsername(displayName).replace(/[^a-z0-9_]/g, "_").slice(0, 14) || "player"}_${result.user.id.replaceAll("-", "").slice(0, 8)}`;

  res.json({ id: result.user.id, username, display_name: displayName, email: result.user.email || "" });
});

app.put("/api/account", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  if (!displayName || displayName.length > 80) {
    return res.status(400).json({ error: "Display name must be between 1 and 80 characters." });
  }

  const { error: profileError } = await supabase
    .from("users")
    .update({ display_name: displayName })
    .eq("id", authResult.user.id);
  if (profileError) {
    console.error("Could not update display name:", profileError.message);
    return res.status(500).json({ error: "Could not update your display name." });
  }

  const { error: authError } = await supabase.auth.admin.updateUserById(authResult.user.id, {
    user_metadata: { ...authResult.user.user_metadata, display_name: displayName },
  });
  if (authError) {
    console.error("Could not update account metadata:", authError.message);
    return res.status(500).json({ error: "Your profile was updated, but account details could not be synchronized." });
  }

  res.json({ display_name: displayName });
});

app.delete("/api/account", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const authResult = await getAuthenticatedUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  const confirmation = typeof req.body?.confirm_username === "string"
    ? normalizeUsername(req.body.confirm_username)
    : "";
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("username")
    .eq("id", authResult.user.id)
    .maybeSingle();
  if (profileError || !profile) {
    console.error("Could not verify account deletion:", profileError?.message || "Profile not found.");
    return res.status(500).json({ error: "Could not verify your account. Please try again." });
  }
  if (!confirmation || confirmation !== normalizeUsername(profile.username)) {
    return res.status(400).json({ error: "The username confirmation does not match." });
  }

  const { error: deleteError } = await supabase.auth.admin.deleteUser(authResult.user.id);
  if (deleteError) {
    console.error("Could not delete account:", deleteError.message);
    return res.status(500).json({ error: "Could not delete your account. Please try again." });
  }

  res.json({ deleted: true });
});

// TODO: Remove the legacy session-code endpoints once the new installer is public.
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

  const result = await getSessionUser(req.body?.session_token);
  if (result.error) return res.status(result.status).json({ error: result.error });

  const { game_slug: gameSlug, score } = req.body || {};
  if (typeof gameSlug !== "string" || !gameSlug.trim()) {
    return res.status(400).json({ error: "A game_slug is required." });
  }
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    return res.status(400).json({ error: "Score must be a non-negative number." });
  }

  let game;
  try {
    game = await getGameBySlug(gameSlug.trim());
  } catch (error) {
    console.error("Could not look up game:", error.message);
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

  try {
    const newlyCompletedQuests = await recordQuestProgress(result.user.id, game.id);
    res.json({ ...data, newly_completed_quests: newlyCompletedQuests });
  } catch (error) {
    logQuestError("progress", error);
    res.status(500).json({ error: "The score was saved, but quest progress could not be updated." });
  }
});

app.get("/api/quests/:gameSlug", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  let game;
  try {
    game = await getGameBySlug(req.params.gameSlug);
  } catch (error) {
    logQuestError("lookup", error);
    return res.status(500).json({ error: "Could not load quests." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  const bearerToken = getBearerToken(req);
  let userId = null;
  if (bearerToken) {
    const authResult = await getSessionUser(bearerToken);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    userId = authResult.user.id;
  }

  try {
    if (userId) await recordQuestProgress(userId, game.id);
    const { data: quests, error: questError } = await supabase
      .from("quests")
      .select("id, position, title, description, metric, target")
      .eq("game_id", game.id)
      .order("position");
    if (questError) throw questError;

    let completedIds = [];
    if (userId && quests.length) {
      const { data: completions, error: completionError } = await supabase
        .from("quest_completions")
        .select("quest_id")
        .eq("user_id", userId)
        .in("quest_id", quests.map((quest) => quest.id));
      if (completionError) throw completionError;
      completedIds = completions.map((completion) => completion.quest_id);
    }

    const completedSet = new Set(completedIds);
    res.json({
      game_slug: game.slug,
      quests: quests.map((quest) => ({ ...quest, completed: completedSet.has(quest.id) })),
      progress: userId ? { completed_quest_ids: completedIds } : null,
    });
  } catch (error) {
    logQuestError("load", error);
    res.status(500).json({ error: "Could not load quests." });
  }
});

app.get("/api/platform-quests", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;

  const authResult = await getSessionUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });

  try {
    const { data: games, error: gamesError } = await supabase.from("games").select("id");
    if (gamesError) throw gamesError;
    await Promise.all(games.map((game) => recordQuestProgress(authResult.user.id, game.id)));

    const [
      { count: completedCount, error: completionError },
      { data: nodes, error: nodeError },
      { data: claims, error: claimError },
    ] = await Promise.all([
      supabase.from("quest_completions").select("quest_id", { count: "exact", head: true }).eq("user_id", authResult.user.id),
      supabase.from("platform_reward_nodes").select("node_index, quests_required, shards, is_mystery").order("node_index"),
      supabase.from("platform_reward_claims").select("node_index").eq("user_id", authResult.user.id),
    ]);
    if (completionError) throw completionError;
    if (nodeError) throw nodeError;
    if (claimError) throw claimError;

    const claimedNodes = new Set(claims.map((claim) => claim.node_index));
    res.json({
      completed_count: completedCount || 0,
      milestones: nodes.map((node) => {
        const claimed = claimedNodes.has(node.node_index);
        return {
          node_index: node.node_index,
          quests_required: node.quests_required,
          is_mystery: node.is_mystery,
          claimed,
          claimable: !claimed && (completedCount || 0) >= node.quests_required,
          ...(!node.is_mystery || claimed ? { shards: node.shards } : {}),
        };
      }),
    });
  } catch (error) {
    logQuestError("platform load", error);
    res.status(500).json({ error: "Could not load platform quests." });
  }
});

app.post("/api/platform-quests/claim", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const authResult = await getSessionUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
  if (!takeQuestClaimRateLimit(authResult.user.id)) {
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "Reward claims are temporarily rate limited." });
  }

  const nodeIndex = req.body?.node_index;
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 1) {
    return res.status(400).json({ error: "A valid node_index is required." });
  }

  const { data, error } = await supabase.rpc("claim_platform_quest_reward", {
    p_user_id: authResult.user.id,
    p_node_index: nodeIndex,
  });
  if (error) {
    if (error.code === "P0001") return res.status(409).json({ error: error.message });
    logQuestError("platform claim", error);
    return res.status(500).json({ error: "Could not claim this reward." });
  }
  const result = Array.isArray(data) ? data[0] : data;
  res.json({ claimed: result.claimed, shards: result.shards, balance: result.balance });
});

app.post("/api/quests/:gameSlug/claim", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const authResult = await getSessionUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
  if (!takeQuestClaimRateLimit(authResult.user.id)) {
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "Reward claims are temporarily rate limited." });
  }

  const nodeIndex = req.body?.node_index;
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 1) {
    return res.status(400).json({ error: "A valid node_index is required." });
  }
  let game;
  try {
    game = await getGameBySlug(req.params.gameSlug);
  } catch (error) {
    logQuestError("lookup", error);
    return res.status(500).json({ error: "Could not look up the game." });
  }
  if (!game) return res.status(404).json({ error: "Game not found." });

  try {
    await recordQuestProgress(authResult.user.id, game.id);
  } catch (error) {
    logQuestError("progress", error);
    return res.status(500).json({ error: "Could not verify quest progress." });
  }

  const { data, error } = await supabase.rpc("claim_quest_reward", {
    p_user_id: authResult.user.id,
    p_game_id: game.id,
    p_node_index: nodeIndex,
  });
  if (error) {
    if (error.code === "P0001") return res.status(409).json({ error: error.message });
    logQuestError("claim", error);
    return res.status(500).json({ error: "Could not claim this reward." });
  }
  const result = Array.isArray(data) ? data[0] : data;
  res.json({ claimed: result.claimed, shards: result.shards, balance: result.balance });
});

app.get("/api/wallet", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!requireSupabase(res)) return;
  const authResult = await getSessionUser(getBearerToken(req));
  if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
  const { data, error } = await supabase
    .from("shard_wallets")
    .select("balance")
    .eq("user_id", authResult.user.id)
    .maybeSingle();
  if (error) {
    logQuestError("wallet", error);
    return res.status(500).json({ error: "Could not load your shard balance." });
  }
  res.json({ balance: data?.balance || 0 });
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
    const authResult = await getSessionUser(accessToken);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    userId = authResult.user.id;
  }

  const { data: games, error } = await supabase
    .from("games")
    .select("id, slug, name, download_url_pc, download_url_android")
    .order("name", { ascending: true });
  if (error) {
    console.error("Could not load games:", error.message);
    return res.status(500).json({ error: "Could not load games." });
  }

  let ownedGameIds = new Set();
  let installedGameIds = new Set();
  let downloadedGameIds = new Set();
  const downloadDatesByGameId = new Map();
  if (userId) {
    const [
      { data: purchases, error: purchaseError },
      { data: approvedLinks, error: linkError },
      { data: downloadEvents, error: downloadError },
    ] = await Promise.all([
      supabase.from("purchases").select("game_id").eq("user_id", userId),
      supabase.from("device_links").select("game_id").eq("user_id", userId).eq("status", "approved"),
      supabase.from("download_events").select("game_id, requested_at").eq("user_id", userId).eq("allowed", true).order("requested_at", { ascending: false }),
    ]);
    if (purchaseError) {
      console.error("Could not load game ownership:", purchaseError.message);
      return res.status(503).json({ error: "Game ownership is unavailable. Apply the purchases table in supabase/schema.sql." });
    }
    if (linkError) {
      console.error("Could not load installed game states:", linkError.message);
      return res.status(503).json({ error: "Installed game states are unavailable. Apply supabase/quests-update.sql." });
    }
    if (downloadError) {
      console.error("Could not load download states:", downloadError.message);
      return res.status(503).json({ error: "Download states are unavailable. Apply supabase/quests-update.sql." });
    }
    ownedGameIds = new Set(purchases.map((purchase) => purchase.game_id));
    installedGameIds = new Set(approvedLinks.map((link) => link.game_id));
    downloadedGameIds = new Set(downloadEvents.map((download) => download.game_id));
    for (const download of downloadEvents) {
      if (!downloadDatesByGameId.has(download.game_id)) {
        downloadDatesByGameId.set(download.game_id, download.requested_at);
      }
    }
  }

  res.json(games.map(({ id, download_url_pc: downloadUrl, ...game }) => {
    const version = downloadUrl?.match(/\/releases\/download\/v?([^/]+)\//)?.[1] || null;
    return {
      ...game,
      version,
      file_size_bytes: gameFileSizes.get(game.slug) || null,
      owned: ownedGameIds.has(id),
      installed: installedGameIds.has(id),
      downloaded: downloadedGameIds.has(id),
      downloaded_at: downloadDatesByGameId.get(id) || null,
      download_platform: downloadedGameIds.has(id) ? "Windows PC" : null,
    };
  }));
});

app.post("/api/games/:slug/purchase", async (req, res) => {
  if (!requireSupabase(res)) return;

  const authResult = await getSessionUser(getBearerToken(req));
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

  const authResult = await getSessionUser(getBearerToken(req));
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
    const { data: rateLimitRows, error: rateLimitError } = await supabase.rpc("request_game_download", {
      p_user_id: authResult.user.id,
      p_game_id: game.id,
    });
    if (rateLimitError) {
      console.error("Could not record download link request:", rateLimitError.message);
      return res.status(503).json({ error: "Download link requests are unavailable. Apply supabase/quests-update.sql." });
    }
    const rateLimit = Array.isArray(rateLimitRows) ? rateLimitRows[0] : rateLimitRows;
    if (!rateLimit?.allowed) {
      const retryAfter = Math.max(1, Number(rateLimit?.retry_after_seconds) || 60);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: rateLimit?.message || "Please wait before requesting another download link." });
    }
    res.json({ url });
  } catch (error) {
    console.error("Could not get game download link:", error.message);
    res.status(500).json({ error: "Could not get the game download link." });
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, "public", "404.html")));

app.listen(port, () => {
  console.log(`Onyx Games is running at http://localhost:${port}`);
  if (!supabase || !process.env.SUPABASE_ANON_KEY) {
    console.warn("Set Supabase environment variables to enable authentication and API data.");
  }
});