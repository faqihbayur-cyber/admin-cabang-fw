// login.js
import { auth, db } from "./firebase.js";
import { toast, alertBox } from "./ui.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const HOME_URL = "index.html";

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const passEl = document.getElementById("password");
const btn = document.getElementById("btnLogin");
const btnText = btn.querySelector(".btn-text");
const boot = document.getElementById("boot");
const togglePass = document.getElementById("togglePass");

let isLoggingIn = false;

/* ---------- Validasi akun: users/{uid} harus status true & role adminCabang ---------- */
async function checkAdminCabang(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return { ok: false, reason: "notfound" };

  const data = snap.data();
  if (data.role !== "adminCabang") return { ok: false, reason: "role" };
  if (data.status !== true) return { ok: false, reason: "inactive" };

  // idCabang wajib ada dan harus ada di collection kantorCabang (doc ID = idCabang)
  if (!data.idCabang) return { ok: false, reason: "cabang" };
  const cabangSnap = await getDoc(doc(db, "kantorCabang", String(data.idCabang)));
  if (!cabangSnap.exists()) return { ok: false, reason: "cabang" };

  return { ok: true, data };
}

async function rejectUser(reason) {
  await signOut(auth);
  if (reason === "inactive") {
    await alertBox({
      title: "Akun Nonaktif",
      text: "Akun kamu sedang nonaktif. Hubungi admin pusat untuk mengaktifkan kembali.",
      type: "warning"
    });
  } else if (reason === "cabang") {
    await alertBox({
      title: "Cabang Tidak Valid",
      text: "ID cabang akun ini belum diatur atau tidak ditemukan di data kantor cabang. Hubungi admin pusat.",
      type: "error"
    });
  } else if (reason === "role") {
    await alertBox({
      title: "Akses Ditolak",
      text: "Akun ini bukan Admin Cabang.",
      type: "error"
    });
  } else {
    await alertBox({
      title: "Akun Tidak Ditemukan",
      text: "Data akun tidak ditemukan. Hubungi admin pusat.",
      type: "error"
    });
  }
}

/* ---------- UI helper ---------- */
function setLoading(on) {
  isLoggingIn = on;
  btn.disabled = on;
  btn.classList.toggle("loading", on);
  btnText.textContent = on ? "Memproses..." : "Masuk";
  emailEl.disabled = on;
  passEl.disabled = on;
}

function authErrorMessage(code) {
  switch (code) {
    case "auth/invalid-email": return "Format email tidak valid.";
    case "auth/user-disabled": return "Akun ini dinonaktifkan.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "Email atau password salah.";
    case "auth/too-many-requests": return "Terlalu banyak percobaan. Coba lagi nanti.";
    case "auth/network-request-failed": return "Koneksi internet bermasalah.";
    default: return "Gagal masuk. Coba lagi.";
  }
}

/* ---------- Submit ---------- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isLoggingIn) return;

  const email = emailEl.value.trim();
  const password = passEl.value;

  if (!email || !password) {
    toast("Email dan password wajib diisi.", "warning");
    return;
  }

  setLoading(true);
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const result = await checkAdminCabang(cred.user.uid);

    if (!result.ok) {
      await rejectUser(result.reason);
      setLoading(false);
      return;
    }

    toast("Login berhasil!", "success", 1200);
    setTimeout(() => location.replace(HOME_URL), 700);
  } catch (err) {
    console.error(err);
    if (err.code === "permission-denied") {
      await signOut(auth).catch(() => {});
      toast("Akses ditolak oleh server.", "error");
    } else {
      toast(authErrorMessage(err.code), "error");
    }
    setLoading(false);
  }
});

/* ---------- Lihat / sembunyi password ---------- */
togglePass.addEventListener("click", () => {
  const show = passEl.type === "password";
  passEl.type = show ? "text" : "password";
  togglePass.setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
  togglePass.classList.toggle("on", show);
});

/* ---------- Kalau sudah login & valid, langsung masuk ---------- */
onAuthStateChanged(auth, async (user) => {
  if (isLoggingIn) return; // biar proses submit yang menangani

  if (!user) {
    boot.classList.add("hide");
    return;
  }

  try {
    const result = await checkAdminCabang(user.uid);
    if (result.ok) {
      location.replace(HOME_URL);
      return;
    }
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await signOut(auth).catch(() => {});
  }
  boot.classList.add("hide");
});
