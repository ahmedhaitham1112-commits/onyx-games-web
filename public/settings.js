import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const status = document.querySelector("[data-settings-status]");
const settingsSections = document.querySelectorAll("[data-settings-content]");
const displayNameForm = document.querySelector("[data-display-name-form]");
const deleteForm = document.querySelector("[data-delete-account-form]");
let supabase;
let accessToken = "";
let username = "";

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not update your account.");
  return payload;
}

async function initialize() {
  const config = await fetch("/api/config").then((response) => response.json());
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Account settings are temporarily unavailable.");
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace("/");
    return;
  }
  accessToken = session.access_token;
  const account = await requestJson("/api/session/me");
  username = account.username;
  document.querySelector("[data-account-email]").textContent = account.email;
  document.querySelector("[data-account-username]").textContent = account.username;
  document.querySelector("[data-confirm-username]").textContent = account.username;
  displayNameForm.elements.display_name.value = account.display_name;
  settingsSections.forEach((section) => { section.hidden = false; });
  showStatus("Your account settings are up to date.");

  displayNameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = displayNameForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await requestJson("/api/account", {
        method: "PUT",
        body: JSON.stringify({ display_name: displayNameForm.elements.display_name.value }),
      });
      displayNameForm.elements.display_name.value = result.display_name;
      showStatus("Display name saved.");
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("[data-settings-sign-out]").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await supabase.auth.signOut();
    window.location.replace("/");
  });

  deleteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (deleteForm.elements.confirm_username.value.trim().toLowerCase() !== username.toLowerCase()) {
      showStatus("The username confirmation does not match.", true);
      deleteForm.elements.confirm_username.focus();
      return;
    }
    if (!window.confirm("Delete your Onyx Games account and all associated data? This cannot be undone.")) return;
    const button = deleteForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await requestJson("/api/account", {
        method: "DELETE",
        body: JSON.stringify({ confirm_username: deleteForm.elements.confirm_username.value }),
      });
      await supabase.auth.signOut();
      window.location.replace("/");
    } catch (error) {
      showStatus(error.message, true);
      button.disabled = false;
    }
  });
}

initialize().catch((error) => showStatus(error.message || "Could not load your account.", true));