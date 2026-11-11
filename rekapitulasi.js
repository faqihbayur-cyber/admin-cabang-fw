// rekapitulasi.js — Rekapitulasi (tahap 1: gerbang password)
// Password dibaca dari kantorCabang/{idCabang}.pagePass (string). Setelah benar, halaman tetap terbuka selama BUKA_MENIT menit atau sampai tombol Kunci ditekan.
// Catatan: pengecekan dilakukan di sisi klien, jadi ini pembatas tampilan, bukan keamanan data.
import {
  collection, collectionGroup, query, where, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";

export const css = new URL("./rekapitulasi.css", import.meta.url).href;

const MAX_SALAH = 5;          // salah berturut-turut sebelum dijeda
const JEDA_DETIK = 30;
const BUKA_MENIT = 15;

let bukaSampai = 0;

const HARGA_JUAL = 5500;
const GAS_PER_GALON = 18000 / 30;
const TUTUP_PER_GALON = 150;
const KAS_PER_GALON = 500;
const LISTRIK_BULANAN = 100000;
const KOKI_ADMIN_BULANAN = 2000000;
const ANGSURAN_BULANAN = 1400000;
const ORTU_HARIAN = 50000;

const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const rp = (n) => `${n < 0 ? "-" : ""}Rp ${fmt(Math.abs(n))}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function mount(el, ctx) {
  const { db, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  let alive = true;
  let pagePass = null;        // string dari kantorCabang.pagePass (null = belum dimuat)
  let salah = 0;
  let jedaSampai = 0;
  let jedaTimer = 0;
  let hargaJual = HARGA_JUAL;
  let kurirUids = null;
  let bulan = todayStr().slice(0, 7);
  let token = 0;

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
        bukaSampai = Date.now() + BUKA_MENIT * 60000;
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

  function paintOpen() {
    root.innerHTML = `
      <div class="rk-box wide">
        <div class="rk-head">
          <h2>Rekapitulasi</h2>
          <button type="button" class="rk-lockbtn" id="rkLock">Kunci</button>
        </div>
        <div class="rk-month">
          <label for="rkBulan">Bulan</label>
          <input type="month" id="rkBulan" value="${bulan}" max="${todayStr().slice(0, 7)}">
        </div>
        <div class="rk-body" id="rkBody"></div>
      </div>`;
    root.querySelector("#rkLock").addEventListener("click", () => { bukaSampai = 0; token++; paintGate(); });
    const inp = root.querySelector("#rkBulan");
    inp.addEventListener("change", () => {
      if (!/^\d{4}-\d{2}$/.test(inp.value)) return;
      bulan = inp.value;
      muat();
    });
    muat();
  }

  async function muat() {
    const my = ++token;
    const body = root.querySelector("#rkBody");
    if (!body) return;
    body.innerHTML = `<span class="skel" style="height:84px"></span><span class="skel" style="height:220px"></span>`;
    try {
      const [y, m] = bulan.split("-").map(Number);
      const hariBulan = new Date(y, m, 0).getDate();
      const awal = `${bulan}-01`;
      const akhir = `${bulan}-${String(hariBulan).padStart(2, "0")}`;

      if (!kurirUids) {
        const us = await getDocs(query(
          collection(db, "users"), where("idCabang", "==", idCabang), where("role", "==", "kurir")
        ));
        kurirUids = new Set(us.docs.map((d) => d.id));
      }
      const snap = await getDocs(query(
        collectionGroup(db, "dataHarian"),
        where("idCabang", "==", idCabang), where("tanggal", ">=", awal), where("tanggal", "<=", akhir)
      ));
      if (!alive || my !== token) return;

      const perTanggal = {};
      snap.forEach((d) => {
        const x = d.data();
        if (!kurirUids.has(x.createdBy)) return;
        perTanggal[x.tanggal] = (perTanggal[x.tanggal] || 0) + num(x.pengisianGalon);
      });
      paintHasil(perTanggal, y, m, hariBulan);
    } catch (err) {
      console.error(err);
      if (!alive || my !== token) return;
      body.innerHTML = `<div class="rk-empty">Gagal memuat data harian. Cek index Firestore dan koneksi.</div>`;
      toast("Gagal memuat rekapitulasi.", "error", 4500);
    }
  }

  function paintHasil(perTanggal, y, m, hariBulan) {
    const body = root.querySelector("#rkBody");
    if (!body) return;
    const hariIni = todayStr();
    const tetap = (LISTRIK_BULANAN + KOKI_ADMIN_BULANAN + ANGSURAN_BULANAN) / hariBulan + ORTU_HARIAN;
    const perGalon = GAS_PER_GALON + TUTUP_PER_GALON + KAS_PER_GALON;

    const rows = [];
    let saldo = 0, galon = 0, masuk = 0, biaya = 0;
    const rinci = { gas: 0, tutup: 0, kas: 0, listrik: 0, koki: 0, ortu: 0, angsuran: 0 };
    for (let d = 1; d <= hariBulan; d++) {
      const tgl = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (tgl > hariIni) break;
      const closing = perTanggal[tgl] || 0;
      const pemasukan = closing * hargaJual;
      const pengeluaran = closing * perGalon + tetap;
      const sisa = pemasukan - pengeluaran;
      saldo += sisa; galon += closing; masuk += pemasukan; biaya += pengeluaran;
      rinci.gas += closing * GAS_PER_GALON;
      rinci.tutup += closing * TUTUP_PER_GALON;
      rinci.kas += closing * KAS_PER_GALON;
      rinci.listrik += LISTRIK_BULANAN / hariBulan;
      rinci.koki += KOKI_ADMIN_BULANAN / hariBulan;
      rinci.angsuran += ANGSURAN_BULANAN / hariBulan;
      rinci.ortu += ORTU_HARIAN;
      const label = new Date(y, m - 1, d).toLocaleDateString("id-ID", { weekday: "short", day: "numeric" });
      rows.push({ label, closing, sisa, saldo });
    }

    if (!rows.length) {
      body.innerHTML = `<div class="rk-empty">Belum ada hari yang dihitung pada bulan ini.</div>`;
      return;
    }

    body.innerHTML = `
      <div class="rk-hero ${saldo < 0 ? "neg" : "pos"}">
        <span class="rk-hero-label">Sisa berjalan, boleh dipakai</span>
        <span class="rk-hero-val">${rp(saldo)}</span>
      </div>
      <div class="rk-stats">
        <div class="rk-stat"><span>Closing</span><b>${fmt(galon)} galon</b></div>
        <div class="rk-stat"><span>Pemasukan</span><b>${rp(masuk)}</b></div>
        <div class="rk-stat"><span>Pengeluaran</span><b>${rp(biaya)}</b></div>
      </div>
      <div class="rk-rinci">
        <div class="rk-rinci-title">Rincian pengeluaran</div>
        ${[
          ["Gas", `${rp(GAS_PER_GALON)}/galon`, rinci.gas],
          ["Tutup", `${rp(TUTUP_PER_GALON)}/galon`, rinci.tutup],
          ["Kas", `${rp(KAS_PER_GALON)}/galon`, rinci.kas],
          ["Listrik", `${rp(LISTRIK_BULANAN)}/bulan`, rinci.listrik],
          ["Koki & admin", `${rp(KOKI_ADMIN_BULANAN)}/bulan`, rinci.koki],
          ["Ortu", `${rp(ORTU_HARIAN)}/hari`, rinci.ortu],
          ["Angsuran", `${rp(ANGSURAN_BULANAN)}/bulan`, rinci.angsuran]
        ].map(([nama, ket, v]) => `
          <div class="rk-rinci-row">
            <span>${nama}<small>${ket}</small></span>
            <b>${rp(v)}</b>
          </div>`).join("")}
      </div>
      <div class="rk-list">
        <div class="rk-row rk-row-head">
          <span>Tanggal</span><span>Closing</span><span>Sisa hari</span><span>Sisa berjalan</span>
        </div>
        ${rows.slice().reverse().map((r) => `
          <div class="rk-row${r.closing === 0 ? " libur" : ""}">
            <span class="rk-day">${r.label}${r.closing === 0 ? " · libur" : ""}</span>
            <span>${fmt(r.closing)}</span>
            <span class="${r.sisa < 0 ? "neg" : "pos"}">${rp(r.sisa)}</span>
            <span class="${r.saldo < 0 ? "neg" : "pos"}">${rp(r.saldo)}</span>
          </div>`).join("")}
      </div>`;
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
      hargaJual = num(snap.data().hpp?.hargaJual) || HARGA_JUAL;
      if (Date.now() < bukaSampai) paintOpen(); else paintGate();
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
    token++;
  };
}
