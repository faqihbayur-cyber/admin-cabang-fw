// index.js — SPA global: router (hash), sidebar, guard login
import { auth, db } from "./firebase.js";
import { toast, confirmBox } from "./ui.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const LOGIN_URL = "login.html";

/* ---------- Daftar view ----------
   Tiap view = <nama>.js + <nama>.css
   Module view mengekspor: css (URL file css) dan mount(el, ctx) -> (opsional) fungsi unmount */
const ROUTES = {
  "home": {
    label: "Home",
    load: () => import("./home.js"),
    icon: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'
  },
  "data-harian": {
    label: "Data Harian",
    load: () => import("./data-harian.js"),
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'
  },
  "laporan-harian": {
    label: "Laporan Harian",
    load: () => import("./laporan-harian.js"),
    icon: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>'
  },
  "stockopname": {
    label: "Stockopname",
    load: () => import("./stockopname.js"),
    icon: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'
  },
  "pengeluaran": {
    label: "Pengeluaran",
    load: () => import("./pengeluaran.js"),
    icon: '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/><path d="M6 10v5M18 10v5"/>'
  },
  "cash-flow": {
    label: "Cash Flow",
    load: () => import("./cashflow.js"),
    icon: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'
  },
  "rekapitulasi": {
    label: "Rekapitulasi",
    load: () => import("./rekapitulasi.js"),
    icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'
  },
  "pengunjung": {
    label: "Pengunjung",
    load: () => import("./visitors.js"),
    icon: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
  },
  "customer": {
    label: "Customer",
    load: () => import("./customer.js"),
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'
  },
  "akun": {
    label: "Akun",
    load: () => import("./akun.js"),
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2 .8 3.5 2.7 3.5 5.7"/>'
  }
};
const DEFAULT_ROUTE = "home";

const $ = (id) => document.getElementById(id);
const boot = $("boot"); // (opsional) overlay awal — sudah tidak dipakai, shell langsung tampil
const viewEl = $("view");
const titleEl = $("viewTitle");
const navEl = $("nav");
const sidebar = $("sidebar");
const backdrop = $("backdrop");
const fab = $("fab");

/* ---------- Sidebar ---------- */
function setMenu(open) {
  sidebar.classList.toggle("open", open);
  backdrop.classList.toggle("show", open);
  fab.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
  sidebar.setAttribute("aria-hidden", String(!open));
  fab.setAttribute("aria-expanded", String(open));
  fab.setAttribute("aria-label", open ? "Tutup menu" : "Buka menu");
}
fab.addEventListener("click", () => setMenu(!sidebar.classList.contains("open")));
backdrop.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

/* ---------- Build nav ---------- */
function buildNav() {
  navEl.innerHTML = Object.entries(ROUTES).map(([key, r]) => `
    <a class="nav-item" href="#/${key}" data-route="${key}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${r.icon}</svg>
      <span>${r.label}</span>
    </a>`).join("");
}

function setActive(key) {
  navEl.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === key);
  });
}

/* ---------- Router ---------- */
let currentCss = null;
let currentUnmount = null;
let navToken = 0;

function getRouteKey() {
  const key = location.hash.replace(/^#\/?/, "");
  return ROUTES[key] ? key : DEFAULT_ROUTE;
}

async function navigate() {
  const key = getRouteKey();
  const route = ROUTES[key];
  const token = ++navToken;

  setActive(key);
  setMenu(false);
  titleEl.textContent = route.label;
  document.title = `${route.label} — FW Admin`;

  try {
    const mod = await route.load();
    if (token !== navToken) return; // sudah pindah halaman lagi

    // bersihkan view lama
    if (typeof currentUnmount === "function") currentUnmount();
    currentUnmount = null;
    if (currentCss) { currentCss.remove(); currentCss = null; }

    // pasang CSS view
    if (mod.css) {
      currentCss = document.createElement("link");
      currentCss.rel = "stylesheet";
      currentCss.href = mod.css;
      document.head.appendChild(currentCss);
    }

    // render ulang animasi
    viewEl.style.animation = "none";
    void viewEl.offsetWidth;
    viewEl.style.animation = "";
    viewEl.innerHTML = "";

    currentUnmount = (await mod.mount(viewEl, { user: currentUser, profile: currentProfile, db, auth })) || null;
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    toast("Gagal memuat halaman.", "error");
  }
}

window.addEventListener("hashchange", navigate);

/* ---------- Logout ---------- */
$("btnLogout").addEventListener("click", async () => {
  const ok = await confirmBox({
    title: "Keluar?",
    text: "Kamu akan keluar dari akun ini.",
    yes: "Keluar",
    no: "Batal",
    danger: true
  });
  if (!ok) return;
  try {
    if (currentUser) localStorage.removeItem(PROFILE_KEY(currentUser.uid));
    await signOut(auth);
    location.replace(LOGIN_URL);
  } catch (err) {
    console.error(err);
    toast("Gagal keluar. Coba lagi.", "error");
  }
});

/* ---------- Tampilan awal instan (tanpa spinner) ---------- */
buildNav();
{
  const k = getRouteKey();
  setActive(k);
  titleEl.textContent = ROUTES[k].label;
}

/* ---------- Guard: wajib login, role adminCabang, status true ---------- */
let currentUser = null;
let currentProfile = null;
let started = false;

const PROFILE_KEY = (uid) => `fw:profile:${uid}`;
const readProfile = (uid) => {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY(uid)) || "null"); } catch { return null; }
};
const writeProfile = (uid, data) => {
  try { localStorage.setItem(PROFILE_KEY(uid), JSON.stringify(data)); } catch { /* abaikan */ }
};
const isValidProfile = (d) => !!d && d.role === "adminCabang" && d.status === true;

async function kickOut() {
  await signOut(auth).catch(() => {});
  location.replace(LOGIN_URL);
}

async function startApp(user, profile) {
  currentUser = user;
  currentProfile = profile;
  $("userEmail").textContent = user.email || "-";
  started = true;
  if (!location.hash) location.replace(`#/${DEFAULT_ROUTE}`);
  boot?.classList.add("hide");
  navigate();
  // muat modul halaman lain di latar belakang, supaya pindah menu langsung muncul
  setTimeout(() => Object.values(ROUTES).forEach((r) => r.load().catch(() => {})), 300);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace(LOGIN_URL);
    return;
  }

  try {
    // 1) Pakai profil tersimpan -> halaman langsung tampil, tanpa menunggu jaringan
    const cached = readProfile(user.uid);
    if (!started && isValidProfile(cached)) startApp(user, cached);

    // 2) Verifikasi ke server di latar belakang (tetap wajib)
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : null;

    if (!isValidProfile(data)) {
      localStorage.removeItem(PROFILE_KEY(user.uid));
      await kickOut();
      return;
    }

    writeProfile(user.uid, data);
    currentUser = user;
    currentProfile = data;
    $("userEmail").textContent = user.email || "-";

    if (!started) await startApp(user, data);
  } catch (err) {
    console.error(err);
    if (!started) await kickOut();   // sudah tampil dari cache? biarkan, jangan usir karena jaringan putus
  }
});
