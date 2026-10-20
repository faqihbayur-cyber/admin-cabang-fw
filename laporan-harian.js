// laporan-harian.js — laporan individu per kurir/sales (tabel per tanggal, per bulan)
// Sumber data: users/{uidKurir}/laporan/{tanggal} (mirror dari laporanAdmin)
import {
  collection, query, where, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";

export const css = new URL("./laporan-harian.css", import.meta.url).href;

/* ---------- Helper ---------- */
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const rp = (n) => `${n < 0 ? "-" : ""}Rp ${fmt(Math.abs(n))}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const p2 = (n) => String(n).padStart(2, "0");

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

const namaUser = (u) => u.nama || u.name || u.username || u.email || u.id;

function todayParts() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function tglPendek(tanggal) {
  const [y, m, d] = tanggal.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return { hari: HARI[dt.getDay()], d, minggu: dt.getDay() === 0 };
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const now = todayParts();

  let alive = true;
  let users = [];
  const ALL = "ALL";            // pilihan "Semua" (gabungan semua uid)
  let selUid = ALL;             // default: Semua
  let sheetEl = null;           // popup pilih kurir/sales
  let ym = { y: now.y, m: now.m };
  let token = 0;

  el.innerHTML = `
    <section class="v-lh">
      <div class="lh-filter">
        <div id="lhUserBox"></div>
        <div class="lh-month">
          <button type="button" id="lhPrev" aria-label="Bulan sebelumnya">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <span id="lhMonth"></span>
          <button type="button" id="lhNext" aria-label="Bulan berikutnya">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
      <div id="lhSummary"></div>
      <div id="lhTable"></div>
    </section>`;

  const $ = (id) => el.querySelector(id);
  const userBox = $("#lhUserBox"), monthEl = $("#lhMonth");
  const prevBtn = $("#lhPrev"), nextBtn = $("#lhNext");
  const summaryEl = $("#lhSummary"), tableEl = $("#lhTable");

  /* ===== Filter ===== */
  function paintMonth() {
    monthEl.textContent = `${BULAN[ym.m - 1]} ${ym.y}`;
    nextBtn.disabled = ym.y === now.y && ym.m === now.m;
  }

  const CHECK = `<svg class="lh-check" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`;
  const GROUP = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.6 0 4.5 1.7 4.5 4"/></svg>`;

  const selInfo = () => {
    if (selUid === ALL) return { name: "Semua", sub: "Gabungan semua kurir & sales" };
    const u = users.find((x) => x.id === selUid);
    return u ? { name: namaUser(u), sub: u.role } : { name: "Semua", sub: "Gabungan semua kurir & sales" };
  };

  function paintUsers() {
    const info = selInfo();
    userBox.innerHTML = `
      <button type="button" class="lh-pick" id="lhPick" aria-haspopup="listbox">
        <span class="lh-pick-ico">${selUid === ALL ? GROUP : esc(info.name.charAt(0).toUpperCase())}</span>
        <span class="lh-pick-main">
          <span class="lh-pick-name">${esc(info.name)}</span>
          <span class="lh-pick-sub">${esc(info.sub)}</span>
        </span>
        <svg class="lh-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>`;
    $("#lhPick").addEventListener("click", openSheet);
  }

  /* ----- Popup pilih kurir/sales (bottom sheet) ----- */
  function optionsHtml() {
    const opt = (uid, ico, name, sub, role) => `
      <button type="button" class="lh-opt${uid === selUid ? " active" : ""}" role="option" aria-selected="${uid === selUid}" data-uid="${esc(uid)}">
        <span class="lh-opt-ico${role ? "" : " all"}">${ico}</span>
        <span class="lh-opt-main">
          <span class="lh-opt-name">${esc(name)}</span>
          <span class="lh-opt-sub">${role ? `<span class="lh-role ${esc(role)}">${esc(role)}</span>` : esc(sub)}</span>
        </span>
        ${uid === selUid ? CHECK : ""}
      </button>`;

    let html = opt(ALL, GROUP, "Semua", "Gabungan semua kurir & sales", "");
    if (!users.length) {
      html += Array.from({ length: 3 }, () => `<div class="lh-opt skel-row"><span class="lh-opt-ico skel"></span><span class="lh-opt-main"><span class="skel" style="height:15px;width:50%"></span></span></div>`).join("");
    } else {
      html += users.map((u) => opt(u.id, esc(namaUser(u).charAt(0).toUpperCase()), namaUser(u), "", u.role)).join("");
    }
    return html;
  }

  function bindOptions() {
    sheetEl.querySelectorAll(".lh-opt[data-uid]").forEach((b) => {
      b.addEventListener("click", () => {
        const uid = b.dataset.uid;
        closeSheet();
        if (uid === selUid) return;
        selUid = uid;
        paintUsers();
        loadReport();
      });
    });
  }

  function openSheet() {
    if (sheetEl) return;
    sheetEl = document.createElement("div");
    sheetEl.className = "lh-sheet-wrap";
    sheetEl.innerHTML = `
      <div class="lh-sheet-backdrop"></div>
      <div class="lh-sheet" role="listbox" aria-label="Pilih kurir atau sales">
        <div class="lh-sheet-grip"></div>
        <div class="lh-sheet-title">Pilih Kurir / Sales</div>
        <div class="lh-sheet-list">${optionsHtml()}</div>
      </div>`;
    document.body.appendChild(sheetEl);
    sheetEl.querySelector(".lh-sheet-backdrop").addEventListener("click", () => closeSheet());
    bindOptions();
    history.pushState({ lh: 1 }, "");            // tombol back Android menutup popup
    requestAnimationFrame(() => sheetEl && sheetEl.classList.add("show"));
  }

  function closeSheet(fromPop) {
    if (!sheetEl) return;
    const node = sheetEl;
    sheetEl = null;
    node.classList.remove("show");
    setTimeout(() => node.remove(), 220);
    if (!fromPop && history.state && history.state.lh) history.back();
  }

  function refreshSheet() {
    if (!sheetEl) return;
    sheetEl.querySelector(".lh-sheet-list").innerHTML = optionsHtml();
    bindOptions();
  }

  const onPop = () => { if (sheetEl) closeSheet(true); };
  const onKey = (e) => { if (e.key === "Escape") closeSheet(); };
  window.addEventListener("popstate", onPop);
  document.addEventListener("keydown", onKey);
  if (history.state && history.state.lh) history.replaceState(null, "");

  prevBtn.addEventListener("click", () => {
    ym = ym.m === 1 ? { y: ym.y - 1, m: 12 } : { y: ym.y, m: ym.m - 1 };
    paintMonth(); loadReport();
  });
  nextBtn.addEventListener("click", () => {
    if (nextBtn.disabled) return;
    ym = ym.m === 12 ? { y: ym.y + 1, m: 1 } : { y: ym.y, m: ym.m + 1 };
    paintMonth(); loadReport();
  });

  /* ===== Skeleton ===== */
  function paintSkeleton() {
    summaryEl.innerHTML = `
      <div class="lh-cards">
        ${Array.from({ length: 5 }, () => `<div class="lh-card"><span class="skel" style="height:11px;width:55%"></span><span class="skel" style="height:22px;width:75%"></span></div>`).join("")}
      </div>`;
    tableEl.innerHTML = `
      <div class="lh-tablewrap">
        <div class="lh-skel-rows">
          ${Array.from({ length: 8 }, () => `<div class="skel" style="height:34px"></div>`).join("")}
        </div>
      </div>`;
  }

  /* ===== Render laporan ===== */
  function paintReport(rows) {
    const byDate = new Map(rows.map((r) => [r.tanggal, r]));
    const lastDay = new Date(ym.y, ym.m, 0).getDate();
    const isNow = ym.y === now.y && ym.m === now.m;
    const endDay = isNow ? now.d : lastDay;

    let t = { closing: 0, repeat: 0, omset: 0, bonus: 0, potongan: 0, kasbon: 0 };
    rows.forEach((r) => {
      t.closing += num(r.closing); t.repeat += num(r.repeat); t.omset += num(r.omset);
      t.bonus += num(r.bonus); t.potongan += num(r.potongan); t.kasbon += num(r.kasbon);
    });
    const hari = rows.length;
    const rata = hari ? t.closing / hari : 0;
    const terbaru = rows.length ? rows.reduce((a, b) => (a.tanggal > b.tanggal ? a : b)) : null;
    const hs = terbaru ? num(terbaru.hutangSaldo) : 0;

    summaryEl.innerHTML = `
      <div class="lh-cards">
        <div class="lh-card"><span class="lh-l">Total Closing</span><span class="lh-v">${fmt(t.closing)}</span><span class="lh-n">rata-rata ${fmt(Math.round(rata * 10) / 10)} / hari · ${hari} hari lapor</span></div>
        <div class="lh-card"><span class="lh-l">Total Omset</span><span class="lh-v">${rp(t.omset)}</span><span class="lh-n">${fmt(t.repeat)} repeat</span></div>
        <div class="lh-card pos"><span class="lh-l">Total Bonus</span><span class="lh-v">${rp(t.bonus)}</span></div>
        <div class="lh-card neg"><span class="lh-l">Total Potongan</span><span class="lh-v">${rp(t.potongan)}</span></div>
        <div class="lh-card neg wide"><span class="lh-l">Total Kasbon</span><span class="lh-v">${rp(t.kasbon)}</span></div>
      </div>`;

    // baris tabel: semua tanggal sampai hari ini (kosong ditandai), terbaru di atas
    let body = "";
    for (let d = endDay; d >= 1; d--) {
      const tanggal = `${ym.y}-${p2(ym.m)}-${p2(d)}`;
      const info = tglPendek(tanggal);
      const r = byDate.get(tanggal);
      const tgl = `<td class="lh-date${info.minggu ? " minggu" : ""}"><b>${info.d}</b><small>${info.hari}</small></td>`;
      if (!r) {
        body += `<tr class="empty">${tgl}<td colspan="7">Belum ada laporan</td></tr>`;
        continue;
      }
      const h = num(r.hutangSaldo);
      body += `<tr>${tgl}
        <td>${fmt(r.closing)}</td>
        <td>${fmt(r.repeat)}</td>
        <td>${fmt(r.omset)}</td>
        <td class="pos">${num(r.bonus) ? fmt(r.bonus) : "–"}</td>
        <td class="neg">${num(r.potongan) ? fmt(r.potongan) : "–"}</td>
        <td class="neg">${num(r.kasbon) ? fmt(r.kasbon) : "–"}</td>
        <td class="${h < 0 ? "neg" : h > 0 ? "pos" : ""}">${h < 0 ? "-" : ""}${fmt(Math.abs(h))}</td>
      </tr>`;
    }

    tableEl.innerHTML = `
      <div class="lh-tablewrap">
        <table class="lh-table">
          <thead>
            <tr>
              <th class="lh-date">Tanggal</th>
              <th>Closing</th><th>Repeat</th><th>Omset</th>
              <th>Bonus</th><th>Potongan</th><th>Kasbon</th><th>Hutang / Saldo</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td class="lh-date">Total</td>
              <td>${fmt(t.closing)}</td><td>${fmt(t.repeat)}</td><td>${fmt(t.omset)}</td>
              <td class="pos">${fmt(t.bonus)}</td><td class="neg">${fmt(t.potongan)}</td><td class="neg">${fmt(t.kasbon)}</td>
              <td class="${hs < 0 ? "neg" : hs > 0 ? "pos" : ""}" title="Nilai terakhir, bukan jumlah">${hs < 0 ? "-" : ""}${fmt(Math.abs(hs))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="lh-hint">Angka dalam Rupiah (kecuali Closing &amp; Repeat). Hutang / Saldo di baris Total = nilai terakhir, minus berarti hutang.${selUid === ALL ? " Mode Semua: Hutang / Saldo = jumlah posisi terakhir tiap kurir &amp; sales." : ""}</p>`;
  }

  function paintMessage(text) {
    summaryEl.innerHTML = "";
    tableEl.innerHTML = `<div class="lh-empty">${esc(text)}</div>`;
  }

  /* ===== Ambil data ===== */
  // "Semua": baca users/{admin}/laporanAdmin (1 dokumen per hari, isinya map per uid), jumlahkan per tanggal.
  // Hutang/Saldo per tanggal = jumlah posisi terakhir tiap orang (carry-forward dalam bulan itu).
  async function fetchAll(start, end) {
    const snap = await getDocs(query(
      collection(db, "users", admin.uid, "laporanAdmin"),
      where("tanggal", ">=", start),
      where("tanggal", "<=", end)
    ));
    const days = snap.docs
      .map((d) => ({ tanggal: d.data().tanggal || d.id, data: d.data() }))
      .sort((a, b) => a.tanggal.localeCompare(b.tanggal));

    const lastHS = new Map();   // uid -> hutangSaldo terakhir
    const rows = days.map(({ tanggal, data }) => {
      const r = { tanggal, closing: 0, repeat: 0, omset: 0, bonus: 0, potongan: 0, kasbon: 0, hutangSaldo: 0 };
      Object.entries(data).forEach(([uid, v]) => {
        if (!v || typeof v !== "object" || Array.isArray(v) || v.toMillis || !("closing" in v)) return;
        r.closing += num(v.closing);
        r.repeat += num(v.pelangganRepeat);
        r.omset += num(v.omset);
        r.bonus += num(v.bonus);
        r.potongan += num(v.potongan);
        r.kasbon += num(v.kasbon);
        lastHS.set(uid, num(v.hutangSaldo));
      });
      lastHS.forEach((h) => { r.hutangSaldo += h; });
      return r;
    });
    return rows.reverse();   // terbaru di atas
  }

  async function fetchOne(uid, start, end) {
    const snap = await getDocs(query(
      collection(db, "users", uid, "laporan"),
      where("tanggal", ">=", start),
      where("tanggal", "<=", end),
      orderBy("tanggal", "desc")
    ));
    return snap.docs.map((d) => {
      const x = d.data();
      return {
        tanggal: x.tanggal || d.id,
        closing: num(x.closing), repeat: num(x.pelangganRepeat), omset: num(x.omset),
        bonus: num(x.bonus), potongan: num(x.potongan), kasbon: num(x.kasbon),
        hutangSaldo: num(x.hutangSaldo)
      };
    });
  }

  async function loadReport() {
    const my = ++token;
    const uid = selUid;
    const start = `${ym.y}-${p2(ym.m)}-01`;
    const end = `${ym.y}-${p2(ym.m)}-${p2(new Date(ym.y, ym.m, 0).getDate())}`;
    const key = `lh:rep:${uid}:${ym.y}-${p2(ym.m)}`;

    const cached = cacheGet(key);
    if (cached) paintReport(cached); else paintSkeleton();

    try {
      const rows = uid === ALL ? await fetchAll(start, end) : await fetchOne(uid, start, end);
      if (!alive || my !== token) return;
      cacheSet(key, rows);
      if (JSON.stringify(rows) !== JSON.stringify(cached)) paintReport(rows);
    } catch (err) {
      console.error(err);
      if (!alive || my !== token) return;
      if (!cached) paintMessage("Gagal memuat laporan. Cek aturan Firestore dan koneksi.");
      toast("Gagal memuat laporan.", "error");
    }
  }

  /* ===== Daftar kurir/sales (untuk popup) ===== */
  async function loadUsers() {
    if (!idCabang) return;

    // pakai cache daftar dari halaman Data Harian (tampil instan)
    const c = cacheGet(`dh:list:${idCabang}`);
    if (c?.users?.length) { users = c.users; paintUsers(); refreshSheet(); }

    try {
      const snap = await getDocs(query(
        collection(db, "users"),
        where("idCabang", "==", idCabang),
        where("role", "in", ["kurir", "sales"])
      ));
      if (!alive) return;
      users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
      paintUsers(); refreshSheet();
    } catch (err) {
      console.error(err);
      if (!alive || users.length) return;
      toast("Gagal memuat daftar kurir/sales.", "error");
    }
  }

  paintMonth();
  paintUsers();
  paintSkeleton();
  loadReport();      // default "Semua": tidak perlu menunggu daftar kurir
  loadUsers();

  return () => {
    alive = false;
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("keydown", onKey);
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
  };
}
