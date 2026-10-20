// ui.js — toast & alert custom (dipakai semua halaman)
const ICONS = { success: "✓", error: "✕", warning: "!", info: "i" };

function getContainer() {
  let c = document.querySelector(".toast-container");
  if (!c) {
    c = document.createElement("div");
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

export function toast(message, type = "info", duration = 3000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-icon">${ICONS[type] || "i"}</span><span class="t-msg"></span>`;
  el.querySelector(".t-msg").textContent = message;
  getContainer().appendChild(el);

  setTimeout(() => {
    el.classList.add("hide");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, duration);
}

export function alertBox({ title = "Info", text = "", type = "info", button = "OK" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "alert-overlay";
    overlay.innerHTML = `
      <div class="alert-box ${type}" role="alertdialog" aria-modal="true">
        <div class="alert-icon">${ICONS[type] || "i"}</div>
        <div class="alert-title"></div>
        <div class="alert-text"></div>
        <button class="alert-btn" type="button"></button>
      </div>`;
    overlay.querySelector(".alert-title").textContent = title;
    overlay.querySelector(".alert-text").textContent = text;
    const btn = overlay.querySelector(".alert-btn");
    btn.textContent = button;

    const close = () => { overlay.remove(); resolve(); };
    btn.addEventListener("click", close);
    document.body.appendChild(overlay);
    btn.focus();
  });
}

export function confirmBox({ title = "Konfirmasi", text = "", type = "warning", yes = "Ya", no = "Batal", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "alert-overlay";
    overlay.innerHTML = `
      <div class="alert-box ${type}" role="alertdialog" aria-modal="true">
        <div class="alert-icon">${ICONS[type] || "i"}</div>
        <div class="alert-title"></div>
        <div class="alert-text"></div>
        <div class="alert-actions">
          <button class="alert-btn secondary" type="button"></button>
          <button class="alert-btn${danger ? " danger" : ""}" type="button"></button>
        </div>
      </div>`;
    overlay.querySelector(".alert-title").textContent = title;
    overlay.querySelector(".alert-text").textContent = text;
    const [btnNo, btnYes] = overlay.querySelectorAll(".alert-btn");
    btnNo.textContent = no;
    btnYes.textContent = yes;

    const onKey = (e) => { if (e.key === "Escape") close(false); };
    const close = (v) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(v);
    };
    btnNo.addEventListener("click", () => close(false));
    btnYes.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    btnNo.focus();
  });
}
