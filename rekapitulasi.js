// rekapitulasi.js — Rekapitulasi (tahap 1: gerbang password)
// Password dibaca dari kantorCabang/{idCabang}.pagePass (string). Setiap view dibuka, password diminta lagi.
// Catatan: pengecekan dilakukan di sisi klien, jadi ini pembatas tampilan, bukan keamanan data.
import {
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";

export const css = new URL("./rekapitulasi.css", import.meta.url).href;

const MAX_SALAH = 5;          // salah berturut-turut sebelum dijeda
const JEDA_DETIK = 30;

export function mount(el, ctx) {
  const { db, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  let alive = true;
  let pagePass = null;        // string dari kantorCabang.pagePass (null = belum dimuat)
  let salah = 0;
  let jedaSampai = 0;
  let jedaTimer = 0;

  el.innerHTML = `<section class="v-rk"></section>`;
  const root = el.firstElementChild;

  /* ===== Tampilan ===== */
  function paintLoading() {
    root.innerHTML = `
      <div class="rk-box">
        <span class="skel" style="height:22px;width:50%"></span>
        <span class="skel" style="height:46px"></span>
        <span class="skel" style="height:48px"></span>
      </div>`;
  }

  function paintMessage(text) {
    root.innerHTML = `<div class="rk-box"><div class="rk-empty">${text}</div></div>`;
  }

  function paintGate() {
    root.innerHTML = `
      <div class="rk-box">
        <div class="rk-lock">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        </div>
        <h2>Rekapitulasi</h2>
        <p class="rk-sub">Masukkan password untuk membuka halaman ini.</p>
        <div class="rk-field">
          <input type="password" id="rkPass" placeholder="Password" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
          <button type="button" class="rk-eye" id="rkEye" aria-label="Tampilkan password">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <div class="rk-err" id="rkErr" role="alert"></div>
        <button type="button" class="rk-btn" id="rkOk">Buka</button>
      </div>`;

    const inp = root.querySelector("#rkPass");
    const err = root.querySelector("#rkErr");
    const ok = root.querySelector("#rkOk");

    root.querySelector("#rkEye").addEventListener("click", () => {
      inp.type = inp.type === "password" ? "text" : "password";
      inp.focus();
    });

    const cekJeda = () => {
      const sisa = Math.ceil((jedaSampai - Date.now()) / 1000);
      if (sisa > 0) {
        err.textContent = `Terlalu banyak percobaan. Coba lagi ${sisa} detik.`;
        ok.disabled = true; inp.disabled = true;
        clearTimeout(jedaTimer);
        jedaTimer = setTimeout(() => { if (alive) cekJeda(); }, 1000);
        return true;
      }
      if (inp.disabled) { inp.disabled = false; ok.disabled = false; err.textContent = ""; }
      return false;
    };

    const coba = () => {
      if (cekJeda()) return;
      if (!inp.value) { err.textContent = "Password belum diisi."; inp.focus(); return; }
      if (inp.value === pagePass) {
        salah = 0;
        paintOpen();
        return;
      }
      salah++;
      inp.value = "";
      if (salah >= MAX_SALAH) {
        salah = 0;
        jedaSampai = Date.now() + JEDA_DETIK * 1000;
        cekJeda();
        return;
      }
      err.textContent = "Password salah.";
      root.querySelector(".rk-box").classList.remove("shake");
      void root.offsetWidth;
      root.querySelector(".rk-box").classList.add("shake");
      inp.focus();
    };

    ok.addEventListener("click", coba);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") coba(); });
    inp.addEventListener("input", () => { if (err.textContent && !inp.disabled) err.textContent = ""; });
    if (!cekJeda()) setTimeout(() => { if (alive) inp.focus(); }, 50);
  }

  // Isi rekapitulasi menyusul di tahap berikutnya
  function paintOpen() {
    root.innerHTML = `
      <div class="rk-box wide">
        <div class="rk-head">
          <h2>Rekapitulasi</h2>
          <button type="button" class="rk-lockbtn" id="rkLock">Kunci</button>
        </div>
        <div class="rk-empty">Halaman terbuka. Isi rekapitulasi menyusul.</div>
      </div>`;
    root.querySelector("#rkLock").addEventListener("click", paintGate);
  }

  /* ===== Muat password ===== */
  async function load() {
    if (!idCabang) { paintMessage("Akun admin belum punya idCabang."); return; }
    paintLoading();
    try {
      const snap = await getDoc(doc(db, "kantorCabang", idCabang));
      if (!alive) return;
      const v = snap.exists() ? snap.data().pagePass : null;
      if (typeof v !== "string" || v === "") {
        paintMessage("Password halaman belum diatur. Isi field <b>pagePass</b> (string) di kantorCabang.");
        return;
      }
      pagePass = v;
      paintGate();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      paintMessage("Gagal memuat data cabang. Cek aturan Firestore dan koneksi.");
      toast("Gagal memuat data cabang.", "error");
    }
  }

  load();

  return () => {
    alive = false;
    clearTimeout(jedaTimer);
    pagePass = null;
  };
}
