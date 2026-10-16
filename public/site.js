import { CONTACT_EMAIL } from "./site-config.js?v=20261013";

let walletAccessToken = readCachedAccessToken();
let walletRequest = 0;

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

document.querySelectorAll("[data-contact-email]").forEach((element) => {
  element.textContent = CONTACT_EMAIL;
  if (element instanceof HTMLAnchorElement) element.href = `mailto:${CONTACT_EMAIL}`;
});

function readCachedAccessToken() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue;
      const stored = JSON.parse(localStorage.getItem(key) || "null");
      const session = stored?.currentSession || stored;
      if (session?.access_token && session?.user) return session.access_token;
    }
  } catch {
    return "";
  }
  return "";
}

function ensureWalletWidget() {
  const header = document.querySelector(".site-header");
  if (!header) return null;
  let widget = header.querySelector("[data-wallet-widget]");
  if (widget) return widget;
  const accountArea = header.querySelector("[data-account]");
  let slot = accountArea;
  if (!slot) {
    slot = [...header.children].reverse().find((child) => child.tagName === "SPAN");
    if (!slot) return null;
  }
  widget = document.createElement("span");
  widget.className = "wallet-balance";
  widget.dataset.walletWidget = "";
  widget.hidden = true;
  widget.innerHTML = '<img src="/shard.svg" alt=""><span data-wallet-amount>0</span>';
  if (accountArea) slot.prepend(widget);
  else slot.replaceChildren(widget);
  return widget;
}

async function refreshWallet() {
  const widget = ensureWalletWidget();
  if (!widget) return;
  if (!walletAccessToken) {
    widget.hidden = true;
    return;
  }
  const request = ++walletRequest;
  try {
    const response = await fetch("/api/wallet", { headers: { Authorization: `Bearer ${walletAccessToken}` } });
    if (request !== walletRequest) return;
    if (response.status === 401) {
      widget.hidden = true;
      return;
    }
    if (!response.ok) return;
    const result = await response.json();
    widget.querySelector("[data-wallet-amount]").textContent = Number(result.balance || 0).toLocaleString();
    widget.hidden = false;
  } catch {
    // Keep the last balance visible if a refresh fails.
  }
}

window.addEventListener("onyx:auth-change", (event) => {
  walletAccessToken = event.detail?.accessToken || "";
  void refreshWallet();
});
window.addEventListener("onyx:wallet-updated", (event) => {
  const widget = ensureWalletWidget();
  if (!widget) return;
  widget.querySelector("[data-wallet-amount]").textContent = Number(event.detail?.balance || 0).toLocaleString();
  widget.hidden = !walletAccessToken;
});
window.addEventListener("focus", () => void refreshWallet());
window.setInterval(() => {
  if (document.visibilityState === "visible") void refreshWallet();
}, 20_000);
void refreshWallet();

let noticeDismissed = false;
try {
  noticeDismissed = localStorage.getItem("onyx-cookie-notice-dismissed") === "true";
} catch {
  noticeDismissed = false;
}

if (!noticeDismissed) {
  const notice = document.createElement("aside");
  notice.className = "cookie-notice";
  notice.setAttribute("aria-label", "Cookie notice");
  notice.innerHTML = '<p>We use essential storage for sign-in and settings only. No ads or tracking. <a href="/cookies.html">Cookie details</a></p><button type="button" aria-label="Dismiss cookie notice">Got it</button>';
  notice.querySelector("button").addEventListener("click", () => {
    try {
      localStorage.setItem("onyx-cookie-notice-dismissed", "true");
    } catch {
      // The notice still dismisses for this page when storage is unavailable.
    }
    notice.remove();
  });
  document.body.append(notice);
}