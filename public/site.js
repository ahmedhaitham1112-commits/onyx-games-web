import { CONTACT_EMAIL } from "./site-config.js";

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

document.querySelectorAll("[data-contact-email]").forEach((element) => {
  element.textContent = CONTACT_EMAIL;
  if (element instanceof HTMLAnchorElement) element.href = `mailto:${CONTACT_EMAIL}`;
});

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