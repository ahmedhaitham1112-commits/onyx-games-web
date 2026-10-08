import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const userCode = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || "";
const authView = document.querySelector("[data-link-auth]");
const approvalView = document.querySelector("[data-link-approval]");
const emailForm = document.querySelector("[data-device-email]");
const message = document.querySelector("[data-device-message]");
const resultMessage = document.querySelector("[data-device-result]");
const errorMessage = document.querySelector("[data-link-error]");
const codeLabel = document.querySelector("[data-code-label]");
const signupFields = document.querySelector("[data-device-signup-fields]");
const submitButton = document.querySelector("[data-device-submit]");
const toggleButton = document.querySelector("[data-device-toggle]");
let supabase;
let authMode = "login";
let activeToken = "";
let pending = false;

function setMessage(element, text, isError = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle("is-error", isError);
  element.classList.toggle("is-success", !isError && Boolean(text));
}

function setPending(value) {
  pending = value;
  submitButton.disabled = value;
  document.querySelectorAll("[data-device-google], [data-device-toggle], [data-device-approve], [data-device-deny]")
    .forEach((button) => { button.disabled = value; });
  submitButton.textContent = value ? "Please wait..." : authMode === "signup" ? "Create account" : "Log in";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not complete sign-in.");
  return payload;
}

async function showApproval(session) {
  if (!session?.access_token || activeToken === session.access_token) return;
  activeToken = session.access_token;
  try {
    const result = await requestJson("/api/login", {
      method: "POST",
      body: JSON.stringify({ access_token: session.access_token }),
    });
    document.querySelector("[data-device-username]").textContent = result.user.username;
    authView.hidden = true;
    approvalView.hidden = false;
  } catch (error) {
    activeToken = "";
    authView.hidden = false;
    approvalView.hidden = true;
    setMessage(message, error.message, true);
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === "signup";
  signupFields.hidden = !isSignup;
  signupFields.querySelectorAll("input").forEach((input) => { input.required = isSignup; });
  emailForm.elements.password.autocomplete = isSignup ? "new-password" : "current-password";
  submitButton.textContent = isSignup ? "Create account" : "Log in";
  toggleButton.textContent = isSignup ? "Already have an account? Log in" : "Create an account";
  setMessage(message, "");
}

async function initialize() {
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(userCode)) {
    errorMessage.textContent = "This device link is missing a valid code. Start sign-in again from your game.";
    errorMessage.hidden = false;
    return;
  }
  codeLabel.textContent = `DEVICE LINK · ${userCode}`;
  codeLabel.hidden = false;

  const config = await fetch("/api/config").then((response) => response.json());
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Sign-in is temporarily unavailable.");
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  document.querySelector("[data-device-google]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.href },
      });
      if (error) throw error;
    } catch (error) {
      button.disabled = false;
      setMessage(message, error.message || "Could not start Google sign-in.", true);
    }
  });

  toggleButton.addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending) return;
    setMessage(message, "");
    const formData = new FormData(emailForm);
    const email = String(formData.get("email")).trim();
    const password = String(formData.get("password"));
    setPending(true);
    try {
      if (authMode === "signup") {
        const username = String(formData.get("username")).trim().toLowerCase();
        const displayName = String(formData.get("display_name")).trim();
        if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("Username must be 3-20 characters using letters, numbers, or underscores.");
        const availability = await requestJson(`/api/users/username-available?username=${encodeURIComponent(username)}`);
        if (!availability.available) throw new Error("That username is already taken. Choose another.");
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username, display_name: displayName },
            emailRedirectTo: window.location.href,
          },
        });
        if (error) throw error;
        if (data.session) await showApproval(data.session);
        else setMessage(message, "Account created. Check your email to confirm, then return here to approve the game link.");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) await showApproval(data.session);
      }
    } catch (error) {
      setMessage(message, error.message || "Could not sign in.", true);
    } finally {
      setPending(false);
    }
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    authView.hidden = true;
    await showApproval(session);
  } else {
    authView.hidden = false;
  }
  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      if (session) void showApproval(session);
      else {
        activeToken = "";
        approvalView.hidden = true;
        authView.hidden = false;
      }
    }, 0);
  });

  document.querySelector("[data-device-approve]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    document.querySelector("[data-device-deny]").disabled = true;
    try {
      await requestJson("/api/device/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ user_code: userCode }),
      });
      setMessage(resultMessage, "Approved. You can return to your game now.");
      document.querySelector(".device-link-actions").hidden = true;
    } catch (error) {
      button.disabled = false;
      document.querySelector("[data-device-deny]").disabled = false;
      setMessage(resultMessage, error.message, true);
    }
  });

  document.querySelector("[data-device-deny]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    document.querySelector("[data-device-approve]").disabled = true;
    try {
      await requestJson("/api/device/deny", {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ user_code: userCode }),
      });
      setMessage(resultMessage, "This device sign-in was cancelled.");
      document.querySelector(".device-link-actions").hidden = true;
    } catch (error) {
      button.disabled = false;
      document.querySelector("[data-device-approve]").disabled = false;
      setMessage(resultMessage, error.message, true);
    }
  });
}

initialize().catch((error) => {
  errorMessage.textContent = error.message || "Sign-in is temporarily unavailable.";
  errorMessage.hidden = false;
});
