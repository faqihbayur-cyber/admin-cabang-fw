// analisa.js — view Analisa: seberapa sering tiap customer repeat (dari input Data Harian)
import {
  collection, collectionGroup, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";
import { esc, fmt, createIdb } from "./lib.js";

export const css = new URL("./analisa.css", import.meta.url).href;

/* ---------- Konstanta ---------- */
const PERIODE = [7, 14, 30];   // pilihan periode (hari)
const AMBIL_HARI = 30;         // data ditarik sekali sebanyak ini, periode lebih pendek difilter lokal
const BATAS_AKTIF = 7;         // rata-rata repeat <= 7 hari sekali = aktif, di atas itu = jarang
const PAGE = 40;
const ROLES = ["kurir", "sales"];
const idb = createIdb("fw-analisa");

/* ---------- Helper ---------- */
const p2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const angka = (v) => (Math.round(v * 10) / 10).toLocaleString("id-ID");
const namaUser = (u) => u.nama || u.email || u.id;

// rentang `hari` hari terakhir, termasuk hari ini
function rentang(hari) {
  const s = new Date();
  s.setDate(s.getDate() - (hari - 1));
  return { dari: ymd(s), sampai: ymd(new Date()) };
}

function tglPendek(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const cacheKey = `an2:${idCabang}`;

  let alive = true;
  let data = null;               // { custs, tgl, dari, sampai }
  let hari = 30;
  let kat = "all";               // all | aktif | jarang | nol
  let users = [];
  let owner = "all";
  let cari = "";
  let shown = PAGE;
  let rows = [];
  let hitung = { aktif: 0, jarang: 0, nol: 0 };
  let token = 0;
  let loading = false;
  let searchTimer = 0;

  el.innerHTML = `
    <section class="v-an">
      <div class="an-chips" id="anPeriode">
        ${PERIODE.map((h) => `<button type="button" class="an-chip${h === hari ? " on" : ""}" data-h="${h}">${h} hari</button>`).join("")}
      </div>
      <div class="an-chips an-owner" id="anOwner"></div>
      <div class="an-meta">
        <span class="an-range" id="anRange"></span>
        <button type="button" class="an-refresh" id="anRefresh">Muat ulang</button>
      </div>
      <div class="an-kpi" id="anKpi"></div>
      <div class="an-note" id="anAvg"></div>
      <div class="an-search">
        <input id="anCari" type="text" autocomplete="off" placeholder="Cari nama customer">
      </div>
      <div class="an-list" id="anList"></div>
    </section>`;

  const $ = (id) => el.querySelector(id);
  const listEl = $("#anList");
  const kpiEl = $("#anKpi");
  const rangeEl = $("#anRange");
  const avgEl = $("#anAvg");
  const refreshEl = $("#anRefresh");
  const ownerEl = $("#anOwner");

  /* ===== Data ===== */
  async function ambil() {
    const { dari, sampai } = rentang(AMBIL_HARI);
    const [cs, hs] = await Promise.all([
      getDocs(query(collection(db, "customers"), where("idCabang", "==", idCabang))),
      getDocs(query(
        collectionGroup(db, "dataHarian"),
        where("idCabang", "==", idCabang),
        where("tanggal", ">=", dari),
        where("tanggal", "<=", sampai)
      ))
    ]);

    // foto & field berat lain sengaja dibuang, cukup yang dipakai analisa
    const custs = cs.docs.map((d) => {
      const x = d.data();
      return { id: d.id, nama: x.namaPelanggan || "", status: x.status !== false, pemilik: x.pemilik || "" };
    });

    // induk dokumen dataHarian = dokumen customer; tanggal dihitung unik per customer
    const tgl = {};
    hs.forEach((d) => {
      const id = d.ref.parent.parent?.id;
      const t = String(d.data().tanggal || "");
      if (!id || !t) return;
      (tgl[id] ||= new Set()).add(t);
    });
    Object.keys(tgl).forEach((id) => { tgl[id] = [...tgl[id]].sort(); });

    return { custs, tgl, dari, sampai };
  }

  function hitungRows() {
    if (!data) { rows = []; return; }
    const { dari } = rentang(hari);
    rows = data.custs.filter((c) => c.status && (owner === "all" || c.pemilik === owner)).map((c) => {
      const ds = (data.tgl[c.id] || []).filter((t) => t >= dari);
      const n = ds.length;
      const interval = n ? hari / n : 0;
      const k = !n ? "nol" : interval <= BATAS_AKTIF ? "aktif" : "jarang";
      return { id: c.id, nama: c.nama, ds, n, interval, k };
    });
    rows.sort((a, b) => b.n - a.n || a.nama.localeCompare(b.nama, "id"));
    hitung = { aktif: 0, jarang: 0, nol: 0 };
    rows.forEach((r) => { hitung[r.k]++; });
  }

  /* ===== Tampilan ===== */
  function paintMeta() {
    const { dari, sampai } = rentang(hari);
    rangeEl.textContent = `${tglPendek(dari)} – ${tglPendek(sampai)}`;
    refreshEl.disabled = loading;
    refreshEl.textContent = loading ? "Memuat…" : "Muat ulang";
  }

  function paintKpi() {
    const card = (k, num, lbl, sub) => `
      <button type="button" class="an-kpi-card ${k}${kat === k ? " on" : ""}" data-k="${k}">
        <span class="an-kpi-num${data ? "" : " skel"}">${data ? fmt(num) : ""}</span>
        <span class="an-kpi-lbl">${lbl}</span>
        <span class="an-kpi-sub">${sub}</span>
      </button>`;
    kpiEl.innerHTML =
      card("all", rows.length, "Semua", "customer berstatus aktif") +
      card("aktif", hitung.aktif, "Aktif", `tiap ≤ ${BATAS_AKTIF} hari sekali`) +
      card("jarang", hitung.jarang, "Jarang", `tiap > ${BATAS_AKTIF} hari sekali`) +
      card("nol", hitung.nol, "Tidak pernah", `0× dalam ${hari} hari`);

    const repeaters = rows.filter((r) => r.n > 0);
    if (!data || !repeaters.length) { avgEl.textContent = ""; return; }
    const totalN = repeaters.reduce((s, r) => s + r.n, 0);
    const rata = totalN / repeaters.length;
    avgEl.textContent = `Customer yang repeat: rata-rata ${angka(rata)}× dalam ${hari} hari (sekitar tiap ${angka(hari / rata)} hari sekali).`;
  }

  function subText(r) {
    if (!r.n) return `Tidak ada repeat dalam ${hari} hari`;
    const perMinggu = `${angka(r.n / (hari / 7))}× / minggu`;
    if (r.n === 1) return `1× dalam ${hari} hari · ${perMinggu}`;
    return `Tiap ${angka(r.interval)} hari sekali · ${perMinggu}`;
  }

  function itemHtml(r) {
    const detail = r.n
      ? `<div class="an-dates">${r.ds.map((t) => `<span class="an-date">${esc(tglPendek(t))}</span>`).join("")}</div>`
      : `<div class="an-dates-empty">Belum ada input Data Harian untuk customer ini selama ${hari} hari terakhir.</div>`;
    return `
      <div class="an-item" data-id="${esc(r.id)}">
        <button class="an-item-main" type="button" data-act="toggle">
          <span class="an-avatar ${r.k}">${esc((r.nama.trim().charAt(0) || "?").toUpperCase())}</span>
          <span class="an-item-text">
            <span class="an-item-name">${esc(r.nama || "(tanpa nama)")}</span>
            <span class="an-item-sub">${esc(subText(r))}</span>
          </span>
          <span class="an-badge ${r.k}">${fmt(r.n)}×</span>
        </button>
        <div class="an-detail">${detail}</div>
      </div>`;
  }

  function paintList() {
    if (!data) {
      listEl.innerHTML = Array.from({ length: 6 }, () => `
        <div class="an-item skel-row">
          <span class="an-avatar skel"></span>
          <span class="an-item-text">
            <span class="skel an-skel-name"></span>
            <span class="skel an-skel-sub"></span>
          </span>
        </div>`).join("");
      return;
    }
    const q = cari.trim().toLowerCase();
    const list = rows.filter((r) =>
      (kat === "all" || r.k === kat) && (!q || r.nama.toLowerCase().includes(q))
    );
    if (!list.length) {
      listEl.innerHTML = `<div class="an-empty">${q ? "Tidak ada customer yang cocok." : "Tidak ada customer di kategori ini."}</div>`;
      return;
    }
    listEl.innerHTML =
      list.slice(0, shown).map(itemHtml).join("") +
      (list.length > shown
        ? `<button class="an-more" type="button" data-act="more">Tampilkan lagi (${fmt(list.length - shown)})</button>`
        : "");
  }

  function render() {
    hitungRows();
    paintMeta();
    paintKpi();
    paintList();
  }

  function paintOwner() {
    ownerEl.innerHTML =
      `<button type="button" class="an-chip${owner === "all" ? " on" : ""}" data-o="all">Semua</button>` +
      users.map((u) => `<button type="button" class="an-chip${owner === u.id ? " on" : ""}" data-o="${esc(u.id)}">${esc(namaUser(u))}</button>`).join("");
  }

  async function loadUsers() {
    if (!idCabang) return;
    try {
      const snap = await getDocs(query(
        collection(db, "users"), where("idCabang", "==", idCabang), where("role", "in", ROLES)
      ));
      if (!alive) return;
      users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
      paintOwner();
    } catch (err) {
      console.error(err);
      toast("Gagal memuat daftar kurir/sales.", "error");
    }
  }

  /* ===== Muat data ===== */
  async function muat() {
    if (!idCabang) {
      listEl.innerHTML = `<div class="an-empty">Akun ini belum punya idCabang.</div>`;
      return;
    }
    const t = ++token;
    loading = true;
    paintMeta();

    // tampil instan dari cache (kalau ada), lalu disegarkan dari server
    if (!data) {
      try {
        const c = await idb.get(cacheKey);
        if (c && alive && t === token && !data) { data = c; render(); }
      } catch { /* abaikan */ }
    }

    try {
      const fresh = await ambil();
      if (!alive || t !== token) return;
      data = fresh;
      idb.set(cacheKey, fresh);
    } catch (err) {
      console.error(err);
      if (!alive || t !== token) return;
      toast(
        err?.code === "failed-precondition" ? "Index Firestore belum dibuat. Cek link index di console." :
        err?.code === "permission-denied" ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui." :
        "Gagal memuat data analisa.",
        "error", 4500
      );
      if (!data) listEl.innerHTML = `<div class="an-empty">Gagal memuat data. Coba muat ulang.</div>`;
    } finally {
      if (alive && t === token) { loading = false; if (data) render(); else paintMeta(); }
    }
  }

  /* ===== Event ===== */
  $("#anPeriode").addEventListener("click", (e) => {
    const b = e.target.closest(".an-chip");
    if (!b || Number(b.dataset.h) === hari) return;
    hari = Number(b.dataset.h);
    shown = PAGE;
    el.querySelectorAll(".an-chip").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });

  ownerEl.addEventListener("click", (e) => {
    const b = e.target.closest(".an-chip");
    if (!b || b.dataset.o === owner) return;
    owner = b.dataset.o;
    shown = PAGE;
    paintOwner();
    render();
  });

  kpiEl.addEventListener("click", (e) => {
    const b = e.target.closest(".an-kpi-card");
    if (!b || !data) return;
    kat = b.dataset.k;
    shown = PAGE;
    paintKpi();
    paintList();
  });

  $("#anCari").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      cari = e.target.value;
      shown = PAGE;
      paintList();
    }, 200);
  });

  refreshEl.addEventListener("click", () => { if (!loading) muat(); });

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "more") { shown += PAGE; paintList(); return; }
    if (btn.dataset.act === "toggle") btn.closest(".an-item").classList.toggle("open");
  });

  paintMeta();
  paintKpi();
  paintList();
  paintOwner();
  loadUsers();
  muat();

  return () => {
    alive = false;
    clearTimeout(searchTimer);
  };
}
