import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { initializeHeroIntro } from "./hero-intro.js";

const accountSlot = document.querySelector("[data-account]");
const gameCodePanel = document.querySelector("[data-game-code]");
const authPanel = document.querySelector("[data-auth-panel]");
const emailAuthForm = document.querySelector("[data-email-auth]");
const toast = document.querySelector("[data-toast]");
let gamesLoaded = false;
let initialAuthResolved = false;
const toastMessage = (message) => {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 4200);
};

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

async function loadGames() {
  const containers = [document.querySelector("[data-featured]"), document.querySelector("[data-games]")].filter(Boolean);
  if (!containers.length || gamesLoaded) return;
  gamesLoaded = true;

  try {
    const response = await fetch("/api/games");
    if (!response.ok) throw new Error("Game library is unavailable.");
    const games = await response.json();
    const count = document.querySelector("[data-game-count]");
    if (count) count.textContent = `${String(games.length).padStart(2, "0")} TITLES`;
    containers.forEach((container) => {
      if (!games.length) {
        container.innerHTML = '<p class="empty-state">No games are available yet.</p>';
        return;
      }
      container.innerHTML = games.map((game, index) => `
        <article class="game-card">
          <div class="game-art game-art-${index % 3}" aria-hidden="true"><span class="game-number">${String(index + 1).padStart(2, "0")}</span><span class="game-eye"><i></i></span><span class="game-art-caption">ONYX ORIGINAL</span></div>
          <div class="game-card-copy"><div><p class="eyebrow">${escapeHtml(game.slug.replaceAll("-", " "))}</p><h2>${escapeHtml(game.name)}</h2></div>
            <div class="download-actions">${downloadButton(game.download_url_pc, "PC", "Windows / PC")}${downloadButton(game.download_url_android, "Android", "Android")}</div>
          </div>
        </article>`).join("");
    });
  } catch (error) {
    containers.forEach((container) => {
      container.innerHTML = `<p class="empty-state">${escapeHtml(error.message)} Check that Supabase is configured and the schema has been applied.</p>`;
    });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function downloadButton(url, label, platform) {
  if (!url) return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Soon</span>`;
  let safeUrl;
  try {
    safeUrl = new URL(url);
  } catch {
    return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Soon</span>`;
  }
  if (!['https:', 'http:'].includes(safeUrl.protocol)) {
    return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Soon</span>`;
  }
  return `<a class="download-link" href="${escapeHtml(safeUrl.href)}" target="_blank" rel="noopener noreferrer" aria-label="Download ${platform}">${label} <span aria-hidden="true">↓</span></a>`;
}

async function initializeAuth() {
  const signupFields = document.querySelector("[data-signup-fields]");
  const authHeading = document.querySelector("[data-auth-heading]");
  const authSubmit = document.querySelector("[data-auth-submit]");
  const authSubmitLabel = document.querySelector("[data-auth-submit-label]");
  const authToggle = document.querySelector("[data-auth-toggle]");
  const authMessage = document.querySelector("[data-auth-message]");
  const passwordInput = emailAuthForm?.elements.password;
  const passwordToggle = document.querySelector("[data-password-toggle]");
  let authPending = false;
  let authMode = "login";

  function setAuthMessage(message, isError = false, isSuccess = false) {
    if (!authMessage) return;
    authMessage.textContent = message;
    authMessage.hidden = !message;
    authMessage.classList.toggle("is-error", isError);
    authMessage.classList.toggle("is-success", isSuccess);
  }

  function setAuthPending(pending) {
    authPending = pending;
    if (authSubmit) {
      authSubmit.disabled = pending;
      authSubmit.setAttribute("aria-busy", String(pending));
      authSubmit.classList.toggle("is-loading", pending);
    }
    if (authToggle) authToggle.disabled = pending;
  }

  function getSignupUsername(formData) {
    if (authMode !== "signup") return "";
    const username = String(formData.get("username") || "").trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      setAuthMessage("Username must be 3-20 characters using letters, numbers, or underscores.", true);
      return null;
    }
    return username.toLowerCase();
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === "signup";
    signupFields.hidden = !isSignup;
    signupFields.querySelectorAll("input").forEach((input) => { input.required = isSignup; });
    emailAuthForm.elements.password.autocomplete = isSignup ? "new-password" : "current-password";
    authHeading.textContent = isSignup ? "Create your account" : "Log in with email";
    authSubmitLabel.textContent = isSignup ? "Create account" : "Log in";
    authToggle.textContent = isSignup ? "Already have an account? Log in" : "Create an account";
    setAuthMessage("");
  }

  function readCachedSession() {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !/^sb-.+-auth-token$/.test(key)) continue;
        const stored = JSON.parse(localStorage.getItem(key) || "null");
        const session = stored?.currentSession || stored;
        if (session?.access_token && session?.user) return session;
      }
    } catch {
      return null;
    }
    return null;
  }

  function resolveInitialAuth(user) {
    if (initialAuthResolved) {
      if (authPanel || user) renderAuthState(user);
      return;
    }
    initialAuthResolved = true;
    if (authPanel || user) renderAuthState(user);
    document.body.classList.remove("auth-pending");
    const loader = document.querySelector("[data-auth-loading]");
    if (loader) {
      requestAnimationFrame(() => loader.classList.add("is-fading"));
      window.setTimeout(() => loader.remove(), 320);
    }
    const wallpaper = new Image();
    wallpaper.onload = () => document.documentElement.classList.add("wallpaper-ready");
    wallpaper.src = "/onyx-background.jpg";
  }

  authToggle?.addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
  passwordToggle?.addEventListener("click", () => {
    const isVisible = passwordInput.type === "text";
    passwordInput.type = isVisible ? "password" : "text";
    passwordToggle.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    passwordToggle.setAttribute("aria-pressed", String(!isVisible));
    passwordToggle.querySelector("[data-password-eye]").hidden = !isVisible;
    passwordToggle.querySelector("[data-password-eye-off]").hidden = isVisible;
  });
  const cachedSession = readCachedSession();
  resolveInitialAuth(cachedSession ? {
    username: cachedSession.user?.user_metadata?.username
      || cachedSession.user?.email?.split("@")[0]
      || "Player",
  } : null);

  const configResponse = await fetch("/api/config");
  const config = await configResponse.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    document.querySelectorAll("[data-sign-in]").forEach((button) => {
      button.addEventListener("click", () => toastMessage("Add your Supabase URL and anon key to .env to enable sign-in."));
    });
    emailAuthForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (getSignupUsername(new FormData(emailAuthForm)) === null) return;
      setAuthMessage("Add your Supabase URL and anon key to .env to enable sign-in.", true);
    });
    if (!authPanel) window.location.replace("/");
    return;
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  document.querySelectorAll("[data-sign-in]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.classList.add("is-loading");
      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
      } catch (error) {
        button.disabled = false;
        button.classList.remove("is-loading");
        toastMessage(error.message || "Could not start Google sign-in.");
      }
    });
  });

  emailAuthForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authPending) return;
    setAuthMessage("");
    const formData = new FormData(emailAuthForm);
    const email = String(formData.get("email")).trim();
    const password = String(formData.get("password"));
    const username = getSignupUsername(formData);
    if (authMode === "signup" && username === null) return;
    setAuthPending(true);
    try {
      if (authMode === "signup") {
        const displayName = String(formData.get("display_name")).trim();
        const availabilityResponse = await fetch(`/api/users/username-available?username=${encodeURIComponent(username)}`);
        const availability = await availabilityResponse.json();
        if (!availabilityResponse.ok) throw new Error(availability.error || "Could not check username availability.");
        if (!availability.available) throw new Error("That username is already taken. Please choose another.");

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username, display_name: displayName },
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) {
          const retryResponse = await fetch(`/api/users/username-available?username=${encodeURIComponent(username)}`);
          const retryResult = await retryResponse.json();
          if (retryResponse.ok && !retryResult.available) {
            throw new Error("That username is already taken. Please choose another.");
          }
          throw error;
        }
        if (data.session) {
          await syncSession(data.session);
          window.location.replace("/");
        } else {
          setAuthMessage("Account created! We sent a confirmation link to your email.", false, true);
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error?.code === "invalid_credentials" || /invalid login credentials/i.test(error?.message || "")) {
          throw new Error("Incorrect email or password.");
        }
        if (error?.code === "email_not_confirmed") {
          throw new Error("Please confirm your email before logging in. Check your inbox and spam folder.");
        }
        if (error) throw error;
        if (data.session) await syncSession(data.session);
      }
    } catch (error) {
      setAuthMessage(error.message || "Could not authenticate.", true);
    } finally {
      setAuthPending(false);
    }
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session) await syncSession(session);
  else if (authPanel) renderAuthState(null, supabase);
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    if (nextSession) window.setTimeout(() => syncSession(nextSession), 0);
    else renderAuthState(null);
  });

  async function syncSession(session) {
    renderAuthState({
      username: session.user?.user_metadata?.username || session.user?.email?.split("@")[0] || "Player",
    }, supabase);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: session.access_token }),
    });
    const result = await response.json();
    if (!response.ok) {
      toastMessage(result.error || "Could not sign in.");
      return;
    }
    renderAuthState(result.user, supabase);
    document.querySelectorAll("[data-auth-note], [data-library-note]").forEach((element) => {
      element.textContent = `Signed in as ${result.user.username}. Your game scores are ready to sync.`;
    });

    try {
      const codeResponse = await fetch("/api/session/code", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const codeResult = await codeResponse.json();
      if (!codeResponse.ok) throw new Error(codeResult.error || "Could not create a game login code.");
      renderGameCode(codeResult.code);
    } catch (error) {
      toastMessage(error.message);
    }
  }
}

function renderGameCode(code) {
  if (!gameCodePanel) return;
  gameCodePanel.hidden = !code;
  if (!code) return;

  const codeValue = gameCodePanel.querySelector("[data-game-code-value]");
  const copyButton = gameCodePanel.querySelector("[data-copy-game-code]");
  codeValue.textContent = code;
  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toastMessage("Game login code copied.");
    } catch {
      toastMessage("Copy is unavailable. Select the code to copy it.");
    }
  };
}

function renderAuthState(user, supabase) {
  if (!authPanel && !user) {
    window.location.replace("/");
    return;
  }
  if (document.body.classList.contains("home-page")) {
    document.body.classList.toggle("auth-required", !user);
    document.querySelector(".hero")?.setAttribute("aria-labelledby", user ? "hero-title" : "auth-heading");
    if (user) loadGames();
  }
  if (authPanel) authPanel.hidden = Boolean(user);
  document.querySelectorAll("[data-sign-in]").forEach((button) => {
    button.hidden = Boolean(user);
  });
  if (!accountSlot) return;
  if (!user) {
    accountSlot.innerHTML = '<span class="account-label">PLAYER 01</span>';
    renderGameCode(null);
    return;
  }
  accountSlot.innerHTML = `<span class="account-name">${escapeHtml(user.username)}</span><button class="sign-out" type="button">Sign out</button>`;
  const signOutButton = accountSlot.querySelector(".sign-out");
  if (!supabase || !signOutButton) return;
  signOutButton.addEventListener("click", async () => {
    await supabase.auth.signOut();
    renderAuthState(null, supabase);
    toastMessage("You have signed out.");
  });
}

if (!authPanel) loadGames();
initializeHeroIntro();
initializeAuth().catch((error) => toastMessage(error.message));