import { CONTACT_EMAIL } from "./site-config.js?v=20261024";

let walletAccessToken = readCachedAccessToken();
let walletRequest = 0;
let lastWalletRefreshAt = 0;
let walletHasLoaded = false;

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
  widget.hidden = !walletAccessToken;
  widget.innerHTML = '<svg width="19" height="19" viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M18 2.8 29.4 8l4.1 12.2L21 33.1l-8.8-.8L2.5 20.1 6.1 8.5 18 2.8Z" fill="url(#wallet-shard)" stroke="#E8D6FF" stroke-width="1.2"/><path d="m18 2.8 1.1 12.8L6.1 8.5 18 2.8Z" fill="#F2E8FF"/><path d="m19.1 15.6 14.4 4.6L21 33.1 19.1 15.6Z" fill="#A36AFF"/><path d="m19.1 15.6 13.9 4.1L29.4 8l-10.3 7.6Z" fill="#D7B9FF"/><path d="m6.1 8.5 13 7.1-7 16.7-9.6-12.2L6.1 8.5Z" fill="#7542BD"/><path d="m19.1 15.6 1.9 17.5-8.9-.8 7-16.7Z" fill="#C18CFF"/><path d="m6.1 8.5 11.9-5.7 1.1 12.8-13-7.1Z" fill="#D9C0FF"/><defs><linearGradient id="wallet-shard" x1="5" x2="31" y1="5" y2="31" gradientUnits="userSpaceOnUse"><stop stop-color="#F3E9FF"/><stop offset=".42" stop-color="#A66AFF"/><stop offset="1" stop-color="#57268F"/></linearGradient></defs></svg><span data-wallet-amount><span class="wallet-loading-spinner" role="status" aria-label="Loading shard balance"></span></span>';
  if (accountArea) slot.prepend(widget);
  else slot.replaceChildren(widget);
  return widget;
}

function setWalletAmount(value) {
  const amount = ensureWalletWidget()?.querySelector("[data-wallet-amount]");
  if (amount) amount.textContent = value;
}

async function refreshWallet() {
  const widget = ensureWalletWidget();
  if (!widget) return;
  if (!walletAccessToken) {
    widget.hidden = true;
    walletHasLoaded = true;
    return;
  }
  widget.hidden = false;
  const request = ++walletRequest;
  try {
    const response = await fetch("/api/wallet", { headers: { Authorization: `Bearer ${walletAccessToken}` } });
    if (request !== walletRequest) return;
    if (response.status === 401) {
      setWalletAmount("-");
      walletHasLoaded = true;
      return;
    }
    if (!response.ok) {
      setWalletAmount("-");
      walletHasLoaded = true;
      return;
    }
    const result = await response.json();
    if (request !== walletRequest) return;
    setWalletAmount(Number(result.balance || 0).toLocaleString());
    walletHasLoaded = true;
    widget.hidden = false;
  } catch {
    if (request === walletRequest) {
      setWalletAmount("-");
      walletHasLoaded = true;
    }
  }
}

window.addEventListener("onyx:auth-change", (event) => {
  const hadWalletAccessToken = Boolean(walletAccessToken);
  walletAccessToken = event.detail?.accessToken || "";
  const widget = ensureWalletWidget();
  if (widget) widget.hidden = !walletAccessToken;
  if (walletHasLoaded && walletAccessToken && !hadWalletAccessToken) setWalletAmount("-");
  void refreshWallet();
});
window.addEventListener("onyx:wallet-updated", (event) => {
  walletRequest += 1;
  const widget = ensureWalletWidget();
  if (!widget) return;
  setWalletAmount(Number(event.detail?.balance || 0).toLocaleString());
  walletHasLoaded = true;
  widget.hidden = !walletAccessToken;
});
function refreshWalletOnFocus() {
  const now = Date.now();
  if (now - lastWalletRefreshAt < 1000) return;
  lastWalletRefreshAt = now;
  void refreshWallet();
}
window.addEventListener("focus", refreshWalletOnFocus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshWalletOnFocus();
});
window.setInterval(() => {
  if (document.visibilityState === "visible") void refreshWallet();
}, 30_000);
void refreshWallet();

const noticeDismissalKey = "onyx-cookie-notice-dismissed";
let noticeDismissed = false;
try {
  const storedDismissal = localStorage.getItem(noticeDismissalKey);
  if (storedDismissal === "true") {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 12);
    localStorage.setItem(noticeDismissalKey, String(expiresAt.getTime()));
    noticeDismissed = true;
  } else if (storedDismissal) {
    const expiresAt = Number(storedDismissal);
    noticeDismissed = Number.isFinite(expiresAt) && expiresAt > 0;
  }
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
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 12);
      localStorage.setItem(noticeDismissalKey, String(expiresAt.getTime()));
    } catch {
      // The notice still dismisses for this page when storage is unavailable.
    }
    notice.remove();
  });
  document.body.append(notice);
}