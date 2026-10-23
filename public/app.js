import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { initializeHeroIntro } from "./hero-intro.js?v=20261024";

const accountSlot = document.querySelector("[data-account]");
const gameCodePanel = document.querySelector("[data-game-code]");
const platformQuestBar = document.querySelector("[data-platform-quests]");
const googleConsentRows = document.querySelectorAll("[data-google-consent]");
const googleConsentPendingKey = "onyx-google-consent-pending";
const authPanel = document.querySelector("[data-auth-panel]");
const emailAuthForm = document.querySelector("[data-email-auth]");
const toast = document.querySelector("[data-toast]");
let initialAuthResolved = false;
let currentAccessToken = "";
let gamesLoadSequence = 0;
let questPanelRequest = 0;
let platformQuestRequest = 0;
const visitorPlatform = detectVisitorPlatform();
const toastMessage = (message) => {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 4200);
};

function isGoogleConsentPending() {
  try {
    return localStorage.getItem(googleConsentPendingKey) === "true";
  } catch {
    return false;
  }
}

function clearGoogleConsentPending() {
  try {
    localStorage.removeItem(googleConsentPendingKey);
  } catch {
    // The account metadata remains the persistent consent record.
  }
}

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

async function loadGames(accessToken = currentAccessToken) {
  const containers = [document.querySelector("[data-featured]"), document.querySelector("[data-games]")].filter(Boolean);
  if (!containers.length) return;
  const requestSequence = ++gamesLoadSequence;

  try {
    const response = await fetch("/api/games", {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!response.ok) throw new Error("Game library is unavailable.");
    const games = await response.json();
    if (requestSequence !== gamesLoadSequence) return;
    const questDataBySlug = new Map();
    await Promise.all(games.map(async (game) => {
      try {
        const questResponse = await fetch(`/api/quests/${encodeURIComponent(game.slug)}`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        });
        if (questResponse.ok) questDataBySlug.set(game.slug, await questResponse.json());
      } catch {
        // Quest availability should not block the game library.
      }
    }));
    if (requestSequence !== gamesLoadSequence) return;
    const count = document.querySelector("[data-game-count]");
    if (count) count.textContent = `${String(games.length).padStart(2, "0")} TITLES`;
    containers.forEach((container) => {
      if (!games.length) {
        container.innerHTML = '<p class="empty-state">No games are available yet.</p>';
        return;
      }
      const includeQuests = container.hasAttribute("data-games");
      container.innerHTML = games.map((game, index) => {
        const quests = questDataBySlug.get(game.slug);
        const homeDescription = "Hold your gaze, build your score, and see how long you can keep staring.";
        return `
        <article class="game-card${includeQuests ? "" : " featured-game-card"}">
          ${includeQuests ? `<div class="game-art game-art-${index % 3}" aria-hidden="true"><span class="game-number">${String(index + 1).padStart(2, "0")}</span><span class="game-eye"><i></i></span><span class="game-art-caption">ONYX ORIGINAL</span></div>` : ""}
          <div class="game-card-copy">
            ${includeQuests
              ? `<div><p class="eyebrow">${escapeHtml(game.slug.replaceAll("-", " "))}</p><h2>${escapeHtml(game.name)}</h2></div>`
              : `<h2>${escapeHtml(game.name)}</h2><p class="featured-game-description">${escapeHtml(homeDescription)}</p>`}
            ${!includeQuests && quests ? renderQuestPreview(quests) : ""}
            ${gameDownloadOptions(game, visitorPlatform)}
          </div>
          ${includeQuests && quests ? `<div class="game-quests" data-quest-panel data-game-slug="${escapeHtml(game.slug)}">${renderQuestPanel(quests, Boolean(accessToken))}</div>` : ""}
        </article>`;
      }).join("");
    });
  } catch (error) {
    if (requestSequence !== gamesLoadSequence) return;
    containers.forEach((container) => {
      container.innerHTML = `<p class="empty-state">${escapeHtml(error.message)} Check that Supabase is configured and the schema has been applied.</p>`;
    });
  }
}

function renderQuestPanel(data, isLoggedIn) {
  const completedCount = data.quests.filter((quest) => quest.completed).length;
  const segments = data.quests.map((quest) => `<span class="quest-segment${quest.completed ? " is-complete" : ""}" aria-label="${escapeHtml(quest.title)}${quest.completed ? ": complete" : ": incomplete"}"></span>`).join("");
  const questList = data.quests.map((quest) => `
    <li class="quest-row${quest.completed ? " is-complete" : ""}">
      <span class="quest-check" aria-hidden="true">${quest.completed ? "✓" : ""}</span>
      <span><strong>${escapeHtml(quest.title)}</strong><small>${escapeHtml(quest.description)}</small></span>
    </li>`).join("");
  return `<div class="quest-panel-head"><span class="eyebrow">QUESTS</span><span class="quest-count">${completedCount}/${data.quests.length}</span></div>
    <div class="quest-track" style="--quest-count:${Math.max(1, data.quests.length)}" role="img" aria-label="${completedCount} of ${data.quests.length} quests complete">${segments}</div>
    <ol class="quest-list">${questList}</ol>
    ${isLoggedIn ? "" : '<p class="quest-signin-prompt">Sign in to track progress and earn shards.</p>'}`;
}

function renderQuestPreview(data) {
  return `<ol class="quest-list quest-preview">${data.quests.slice(0, 3).map((quest) => `
    <li class="quest-row quest-row-preview">
      <span class="quest-preview-dot" aria-hidden="true"></span>
      <span><strong>${escapeHtml(quest.title)}</strong><small>${escapeHtml(quest.description)}</small></span>
    </li>`).join("")}</ol>`;
}

function renderPlatformQuestBar(data) {
  const completedCount = data ? Number(data.completed_count || 0) : null;
  const milestoneProgress = Math.min(completedCount, 10);
  const milestones = [2, 4, 6, 8, 10].map((required, index) => {
    const milestone = data?.milestones.find((item) => item.quests_required === required);
    const nodeIndex = milestone?.node_index || index + 1;
    const claimed = Boolean(milestone?.claimed);
    const claimable = Boolean(milestone?.claimable);
    const isMystery = required === 10;
    const status = claimed ? "is-claimed" : claimable ? "is-claimable" : "is-locked";
    const reward = claimed ? `${milestone.shards}` : isMystery ? "???" : "20";
    const indicator = claimed
      ? '<span class="milestone-check" aria-label="Claimed">✓</span>'
      : `<img src="/shard.svg" width="19" height="19" alt="">`;
    const claim = claimable
      ? `<button class="platform-claim" type="button" data-platform-claim data-node-index="${nodeIndex}">Claim</button>`
      : "";
    return `<div class="platform-milestone ${status}" style="--milestone-position:${required * 10}%" data-node-index="${nodeIndex}">
      <div class="milestone-pin">${indicator}</div>
      <span class="milestone-reward">${escapeHtml(reward)}</span>
      <span class="milestone-label">${required}</span>
      ${claim}
    </div>`;
  }).join("");
  const segments = Array.from({ length: 10 }, (_, index) => (
    `<span class="quest-segment${completedCount !== null && index < completedCount ? " is-complete" : ""}"></span>`
  )).join("");

  return `<div class="platform-quest-card">
    <div class="platform-quest-badge" aria-label="${completedCount === null ? "Loading quest total" : `${completedCount} quests completed`}"><span>${completedCount === null ? "..." : completedCount}</span></div>
    <div class="platform-quest-content">
      <div class="platform-quest-heading"><p class="eyebrow">DAILY QUESTS</p><span>PLATFORM MILESTONES</span></div>
      <div class="platform-track" role="img" aria-label="${completedCount === null ? "Loading quests" : `${Math.min(completedCount, 10)} of 10 quests toward milestones`}">
        <div class="platform-segments">${segments}</div>
        ${milestones}
      </div>
      <p class="platform-quest-progress">${completedCount === null ? "Loading..." : `${milestoneProgress} of 10 quests completed`}</p>
    </div>
  </div>`;
}

async function refreshQuestPanels() {
  const panels = [...document.querySelectorAll("[data-quest-panel]")];
  const request = ++questPanelRequest;
  await Promise.all(panels.map(async (panel) => {
    try {
      const response = await fetch(`/api/quests/${encodeURIComponent(panel.dataset.gameSlug)}`, {
        headers: currentAccessToken ? { Authorization: `Bearer ${currentAccessToken}` } : {},
      });
      if (!response.ok) return;
      const data = await response.json();
      if (request !== questPanelRequest) return;
      panel.innerHTML = renderQuestPanel(data, Boolean(currentAccessToken));
    } catch {
      // The last successfully rendered progress remains visible while offline.
    }
  }));
}

async function refreshPlatformQuestBar() {
  if (!platformQuestBar) return;
  if (!currentAccessToken) {
    platformQuestBar.hidden = true;
    return;
  }

  const request = ++platformQuestRequest;
  try {
    const response = await fetch("/api/platform-quests", {
      headers: { Authorization: `Bearer ${currentAccessToken}` },
    });
    if (!response.ok) throw new Error("Could not refresh platform quests.");
    const data = await response.json();
    if (request !== platformQuestRequest) return;
    platformQuestBar.innerHTML = renderPlatformQuestBar(data);
    platformQuestBar.hidden = false;
  } catch {
    // Keep the last successful milestone state visible while offline.
  }
}

async function refreshLiveQuestState() {
  await refreshQuestPanels();
  await refreshPlatformQuestBar();
}

window.addEventListener("onyx:auth-change", (event) => {
  currentAccessToken = event.detail?.accessToken || "";
  void refreshLiveQuestState();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshLiveQuestState();
});
window.addEventListener("focus", () => void refreshLiveQuestState());
window.setInterval(() => {
  if (document.visibilityState === "visible") void refreshLiveQuestState();
}, 10_000);

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-platform-claim]");
  if (!button || button.disabled) return;
  if (!currentAccessToken) {
    toastMessage("Sign in to claim shard rewards.");
    return;
  }

  button.disabled = true;
  try {
    const response = await fetch("/api/platform-quests/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentAccessToken}` },
      body: JSON.stringify({ node_index: Number(button.dataset.nodeIndex) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not claim this reward.");
    window.dispatchEvent(new CustomEvent("onyx:wallet-updated", { detail: { balance: result.balance } }));
    platformQuestBar.classList.add("is-claiming");
    window.setTimeout(() => platformQuestBar?.classList.remove("is-claiming"), 560);
    toastMessage(result.claimed ? `You claimed ${result.shards} shards.` : "This reward was already claimed.");
    await refreshPlatformQuestBar();
  } catch (error) {
    toastMessage(error.message || "Could not claim this reward.");
    button.disabled = false;
  }
});

function gameActionButton(game) {
  const action = game.owned ? "download" : "get";
  const label = game.downloaded ? "Download again" : game.owned ? "Download" : "Get";
  const status = game.installed
    ? '<span class="download-status-chip" title="A device signed in with this account; the site cannot verify the game remains installed.">Installed</span><button class="download-state-link" type="button" data-uninstall-open>How to uninstall</button>'
    : game.downloaded ? '<span class="download-status-chip" title="A download link was requested; the site cannot verify the file finished downloading.">Downloaded</span>' : "";
  return `<div class="game-actions"><button class="download-link" type="button" data-game-action="${action}" data-game-slug="${escapeHtml(game.slug)}" aria-label="${label} ${escapeHtml(game.name)} for Windows / PC">${label} <span aria-hidden="true">↓</span></button>${status}</div>`;
}

function detectVisitorPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.userAgent || "";
  if (/windows/i.test(platform)) return "windows";
  if (/android/i.test(platform)) return "android";
  return "unsupported";
}

function gameDownloadOptions(game, platform) {
  const pcHidden = platform !== "windows";
  const androidHidden = platform !== "android";
  const androidNote = platform === "android" ? "" : " hidden";
  const unsupportedNote = platform === "unsupported" ? "" : " hidden";
  return `<div class="game-download-area" data-download-area data-device-platform="${platform}">
    <div class="download-actions">
      <div data-platform-option="windows"${pcHidden ? " hidden" : ""}>${gameActionButton(game)}</div>
      <div data-platform-option="android"${androidHidden ? " hidden" : ""}>${downloadButton(null, "Android", "Android")}</div>
      <p class="platform-note" data-platform-note="android"${androidNote}>This game's PC version needs a Windows computer. Open Onyx Games on your PC to download it.</p>
      <p class="platform-note" data-platform-note="unsupported"${unsupportedNote}>This device isn't supported yet. <button class="platform-inline-action" type="button" data-show-anyway>Show anyway</button></p>
    </div>
    <button class="platform-toggle" type="button" data-other-platforms aria-expanded="false">Other platforms</button>
  </div>`;
}

document.addEventListener("click", async (event) => {
  const uninstallButton = event.target.closest("[data-uninstall-open]");
  if (uninstallButton) {
    document.querySelector("[data-uninstall-dialog]")?.showModal();
    return;
  }
  if (event.target.closest("[data-uninstall-close]")) {
    document.querySelector("[data-uninstall-dialog]")?.close();
    return;
  }

  const otherPlatformsButton = event.target.closest("[data-other-platforms]");
  if (otherPlatformsButton) {
    const area = otherPlatformsButton.closest("[data-download-area]");
    const platform = area.dataset.devicePlatform;
    const otherPlatform = platform === "android" ? "windows" : "android";
    const option = area.querySelector(`[data-platform-option="${otherPlatform}"]`);
    const expanded = otherPlatformsButton.getAttribute("aria-expanded") === "true";
    option.hidden = expanded;
    otherPlatformsButton.setAttribute("aria-expanded", String(!expanded));
    return;
  }

  const showAnywayButton = event.target.closest("[data-show-anyway]");
  if (showAnywayButton) {
    const area = showAnywayButton.closest("[data-download-area]");
    area.querySelector('[data-platform-option="windows"]').hidden = false;
    showAnywayButton.hidden = true;
    return;
  }

  const button = event.target.closest("[data-game-action]");
  if (!button || button.disabled) return;
  if (!currentAccessToken) {
    toastMessage("Sign in to get or download games.");
    return;
  }

  const isGet = button.dataset.gameAction === "get";
  button.disabled = true;
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(button.dataset.gameSlug)}/${isGet ? "purchase" : "download"}`, {
      method: isGet ? "POST" : "GET",
      headers: { Authorization: `Bearer ${currentAccessToken}` },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not complete the game request.");
    if (isGet) {
      toastMessage("Game added to your library.");
      await loadGames();
      return;
    }
    const actions = button.closest(".game-actions");
    button.innerHTML = 'Download again <span aria-hidden="true">↓</span>';
    button.setAttribute("aria-label", `Download again ${button.dataset.gameSlug}`);
    if (actions && !actions.querySelector(".download-status-chip")) {
      const status = document.createElement("span");
      status.className = "download-status-chip";
      status.textContent = "Downloaded";
      actions.append(status);
    }
    window.location.assign(result.url);
  } catch (error) {
    toastMessage(error.message || "Could not complete the game request.");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function downloadButton(url, label, platform) {
  if (!url) return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Coming soon</span>`;
  let safeUrl;
  try {
    safeUrl = new URL(url);
  } catch {
    return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Coming soon</span>`;
  }
  if (!['https:', 'http:'].includes(safeUrl.protocol)) {
    return `<span class="download-unavailable" aria-label="${platform} download unavailable">${platform} · Coming soon</span>`;
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
    const signupConsent = signupFields.querySelector("[data-signup-consent]");
    if (signupConsent) signupConsent.required = isSignup;
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
  currentAccessToken = cachedSession?.access_token || "";
  resolveInitialAuth(cachedSession ? {
    username: cachedSession.user?.user_metadata?.username
      || cachedSession.user?.email?.split("@")[0]
      || "Player",
    termsAccepted: cachedSession.user?.user_metadata?.terms_accepted === true,
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
    if (!authPanel) await loadGames();
    return;
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  document.querySelectorAll("[data-sign-in]").forEach((button) => {
    button.addEventListener("click", async () => {
      const consent = button.closest(".auth-panel, .signin-action")?.querySelector("[data-legal-consent]");
      if (consent && !consent.closest("[data-google-consent]")?.hidden && !consent.checked) {
        toastMessage("Please agree to the Terms of Service and Privacy Policy before continuing.");
        consent?.focus();
        return;
      }
      if (consent && !consent.closest("[data-google-consent]")?.hidden) {
        try {
          localStorage.setItem(googleConsentPendingKey, "true");
        } catch {
          toastMessage("Consent could not be saved. Please allow local storage and try again.");
          return;
        }
      }
      button.disabled = true;
      button.classList.add("is-loading");
      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
      } catch (error) {
        clearGoogleConsentPending();
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
    if (authMode === "signup" && !emailAuthForm.querySelector("[data-signup-consent]")?.checked) {
      setAuthMessage("Confirm that you are 13 or older and agree to the Terms of Service and Privacy Policy.", true);
      return;
    }
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
            data: { username, display_name: displayName, terms_accepted: true },
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
  else {
    renderAuthState(null, supabase);
    await loadGames("");
  }
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    if (nextSession) window.setTimeout(() => syncSession(nextSession), 0);
    else {
      const hadAccessToken = Boolean(currentAccessToken);
      renderAuthState(null);
      if (hadAccessToken) void loadGames("");
    }
  });

  async function syncSession(session) {
    if (isGoogleConsentPending() && session.user?.user_metadata?.terms_accepted !== true) {
      const { data, error } = await supabase.auth.updateUser({ data: { terms_accepted: true } });
      if (error) {
        toastMessage("You signed in, but your consent could not be saved. Please try signing in again.");
      } else {
        session = { ...session, user: data.user };
        clearGoogleConsentPending();
      }
    } else if (session.user?.user_metadata?.terms_accepted === true) {
      clearGoogleConsentPending();
    }
    currentAccessToken = session.access_token;
    renderAuthState({
      username: session.user?.user_metadata?.username || session.user?.email?.split("@")[0] || "Player",
      termsAccepted: session.user?.user_metadata?.terms_accepted === true,
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
    renderAuthState({
      ...result.user,
      termsAccepted: session.user?.user_metadata?.terms_accepted === true,
    }, supabase);
    await loadGames(session.access_token);
    document.querySelectorAll("[data-auth-note], [data-library-note]").forEach((element) => {
      element.textContent = `Signed in as ${result.user.username}. Your game scores are ready to sync.`;
    });

    if (gameCodePanel) {
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
  if (!user) currentAccessToken = "";
  window.dispatchEvent(new CustomEvent("onyx:auth-change", { detail: { accessToken: currentAccessToken } }));
  if (document.body.classList.contains("home-page")) {
    document.body.classList.toggle("auth-required", !user);
    document.querySelector(".hero")?.setAttribute("aria-labelledby", user ? "hero-title" : "auth-heading");
  }
  if (authPanel) authPanel.hidden = Boolean(user);
  googleConsentRows.forEach((row) => {
    row.hidden = Boolean(user?.termsAccepted);
  });
  document.querySelectorAll("[data-sign-in]").forEach((button) => {
    button.hidden = Boolean(user);
  });
  if (!accountSlot) return;
  const walletWidget = accountSlot.querySelector("[data-wallet-widget]");
  if (!user) {
    accountSlot.innerHTML = '<span class="account-label">PLAYER 01</span>';
    if (walletWidget) accountSlot.prepend(walletWidget);
    renderGameCode(null);
    return;
  }
  accountSlot.innerHTML = `<a class="account-name" href="/account.html">${escapeHtml(user.username)}</a><a class="account-settings-link" href="/account.html">Settings</a><button class="sign-out" type="button">Sign out</button>`;
  if (walletWidget) accountSlot.prepend(walletWidget);
  const signOutButton = accountSlot.querySelector(".sign-out");
  if (!supabase || !signOutButton) return;
  signOutButton.addEventListener("click", async () => {
    await supabase.auth.signOut();
    renderAuthState(null, supabase);
    toastMessage("You have signed out.");
  });
}

initializeHeroIntro();
initializeAuth().catch((error) => toastMessage(error.message));