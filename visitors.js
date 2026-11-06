// visitors.js — dashboard pengunjung landing page
// Sumber data (baca saja): visits/{tanggal} -> { tanggal, total, baru }   dan   visitStats/all -> { total, baru }
// total = jumlah pengunjung (1 browser dihitung 1x per hari), baru = pengunjung yang pertama kali datang
// Sumber promosi (endorse): promo_stat/{KODE}_{tanggal} -> { kode, tanggal, dilihat, ambil }  dan nama kreator dari kode_promo/{KODE}
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, setDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";

export const css = new URL("./visitors.css", import.meta.url).href;

const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const p2 = (n) => String(n).padStart(2, "0");
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const ds = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const dt = parse(s); dt.setDate(dt.getDate() + n); return ds(dt); };
const todayStr = () => ds(new Date());
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const endOfMonth = (y, m) => ds(new Date(y, m, 0));
const PROMO_BASE = "https://familiwater.suruhbeli.com/promo.html?ref=";
const linkKode = (k) => PROMO_BASE + encodeURIComponent(k);
async function salinTeks(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* fallback di bawah */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

export function mount(el, ctx) {
  const { db } = ctx;
  const now = new Date();
  const nowYM = { y: now.getFullYear(), m: now.getMonth() + 1 };
  let ym = { ...nowYM };
  let alive = true;
  let token = 0;
  let all = null;            // visitStats/all
  const days = new Map();    // tanggal -> { total, baru } (bulan yang tampil)
  const kreator = new Map(); // kode -> { nama, dilihat, ambil } (bulan yang tampil)
  const kodeDocs = new Map(); // kode -> data kode_promo (untuk kelola kode)
  let kodeOk = true;
  let formKode = null;       // null = form tutup, "" = tambah baru, "KODE" = ubah
  let promoOk = true;        // false kalau promo_stat gagal dibaca (dashboard utama tetap jalan)

  el.innerHTML = `
    <section class="v-vs">
      <div class="vs-cards" id="vsCards"></div>
      <div class="vs-filter">
        <button type="button" id="vsPrev" aria-label="Bulan sebelumnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span id="vsMonth"></span>
        <button type="button" id="vsNext" aria-label="Bulan berikutnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <div id="vsTable"></div>
      <div id="vsPromo"></div>
    </section>`;

  const $ = (s) => el.querySelector(s);
  const cardsEl = $("#vsCards"), tableEl = $("#vsTable"), monthEl = $("#vsMonth"), promoEl = $("#vsPromo");
  const prevBtn = $("#vsPrev"), nextBtn = $("#vsNext");
  let ready = false;

  function paintMonth() {
    monthEl.textContent = `${BULAN[ym.m - 1]} ${ym.y}`;
    nextBtn.disabled = ym.y === nowYM.y && ym.m === nowYM.m;
  }

  function paint() {
    if (!ready) {
      cardsEl.innerHTML = Array.from({ length: 4 }, () => `<div class="vs-card"><span class="skel" style="height:11px;width:55%"></span><span class="skel" style="height:24px;width:60%"></span></div>`).join("");
      tableEl.innerHTML = `<div class="vs-wrap"><div class="vs-skel">${Array.from({ length: 8 }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div></div>`;
      promoEl.innerHTML = "";
      return;
    }
    const today = todayStr();
    const isNow = ym.y === nowYM.y && ym.m === nowYM.m;
    const end = isNow ? today : endOfMonth(ym.y, ym.m);
    const start = `${ym.y}-${p2(ym.m)}-01`;

    let bulanTotal = 0, bulanBaru = 0, hariAktif = 0, max = 1;
    days.forEach((v) => { bulanTotal += v.total; bulanBaru += v.baru; if (v.total) hariAktif++; max = Math.max(max, v.total); });
    const hari = days.get(today) || { total: 0, baru: 0 };

    cardsEl.innerHTML = `
      <div class="vs-card strong"><span class="vs-l">Hari ini</span><span class="vs-v">${fmt(hari.total)}</span><span class="vs-n">${fmt(hari.baru)} pengunjung baru</span></div>
      <div class="vs-card"><span class="vs-l">${BULAN[ym.m - 1]}</span><span class="vs-v">${fmt(bulanTotal)}</span><span class="vs-n">${fmt(bulanBaru)} baru</span></div>
      <div class="vs-card"><span class="vs-l">Rata-rata / hari</span><span class="vs-v">${fmt(hariAktif ? bulanTotal / hariAktif : 0)}</span><span class="vs-n">${hariAktif} hari ada kunjungan</span></div>
      <div class="vs-card"><span class="vs-l">Total sejak dipasang</span><span class="vs-v">${all ? fmt(all.total) : "–"}</span><span class="vs-n">${all ? fmt(all.baru) + " baru" : "belum ada data"}</span></div>`;

    let body = "";
    for (let d = end; d >= start; d = addDays(d, -1)) {
      const dt = parse(d);
      const v = days.get(d);
      const tot = v ? v.total : 0;
      body += `<tr>
        <td class="vs-date${dt.getDay() === 0 ? " minggu" : ""}"><b>${dt.getDate()}</b><small>${HARI[dt.getDay()]}</small></td>
        <td class="vs-bar"><i style="width:${Math.round((tot / max) * 100)}%"></i><b>${fmt(tot)}</b></td>
        <td>${v ? fmt(v.baru) : "0"}</td>
      </tr>`;
    }
    tableEl.innerHTML = `
      <div class="vs-wrap">
        <table class="vs-table">
          <thead><tr><th class="vs-date">Tanggal</th><th>Pengunjung</th><th>Baru</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td class="vs-date">Total</td><td>${fmt(bulanTotal)}</td><td>${fmt(bulanBaru)}</td></tr></tfoot>
        </table>
      </div>
      <p class="vs-hint">Satu browser dihitung satu kali per hari. "Baru" = browser yang pertama kali membuka landing page. Pengunjung yang memblokir script atau memakai mode privat bisa terhitung lebih dari sekali atau tidak terhitung.</p>`;
  }

  function paintPromo() {
    if (!promoOk) {
      promoEl.innerHTML = `<div class="vs-empty">Data sumber promosi belum bisa dibaca. Cek aturan Firestore promo_stat dan kode_promo.</div>`;
      return;
    }
    const rows = [...kreator.entries()].sort((a, b) => b[1].ambil - a[1].ambil || b[1].dilihat - a[1].dilihat || a[0].localeCompare(b[0]));
    if (!rows.length) { promoEl.innerHTML = ""; return; }
    let tl = 0, ta = 0;
    const body = rows.map(([kode, v]) => {
      tl += v.dilihat || 0; ta += v.ambil;
      return `<tr>
        <td class="vs-date"><b>${esc(v.nama || kode)}</b><small>${esc(kode)}</small></td>
        <td>${v.dilihat === null ? "–" : fmt(v.dilihat)}</td>
        <td>${fmt(v.ambil)}</td>
      </tr>`;
    }).join("");
    promoEl.innerHTML = `
      <div class="vs-sec">Sumber promosi (endorse) · ${BULAN[ym.m - 1]} ${ym.y}</div>
      <div class="vs-wrap">
        <table class="vs-table">
          <thead><tr><th class="vs-date">Kreator</th><th>Dilihat</th><th>Klik Lanjut</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td class="vs-date">Total</td><td>${fmt(tl)}</td><td>${fmt(ta)}</td></tr></tfoot>
        </table>
      </div>
      <p class="vs-hint">Klik Lanjut = browser yang mengisi nama lalu menekan Lanjut di halaman promo, dihitung per sumber (1x per hari per browser). Umum = tanpa kode kreator. Dilihat = browser yang membuka link kreator. Pelanggan yang benar-benar jadi tetap dicek dari pesan WhatsApp (baris "Sumber Promosi").</p>
      ${kelolaHtml()}`;
  }

  function kelolaHtml() {
    if (!kodeOk) return `<div class="vs-sec">Kelola kode endorse</div><div class="vs-empty">Daftar kode belum bisa dibaca. Cek aturan Firestore kode_promo.</div>`;
    const list = [...kodeDocs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = list.map(([k, v]) => `
      <div class="kd-row">
        <div class="kd-i"><b>${esc(v.nama || k)}</b><small>${esc(k)} · ${esc(v.tanggalMulai || "?")} s/d ${esc(v.tanggalSelesai || "?")}</small></div>
        <button type="button" class="kd-sw ${v.aktif === true ? "on" : "off"}" data-act="toggle" data-k="${esc(k)}">${v.aktif === true ? "Aktif" : "Nonaktif"}</button>
        <button type="button" class="kd-ed" data-act="copy" data-k="${esc(k)}">Salin link</button>
        <button type="button" class="kd-ed" data-act="edit" data-k="${esc(k)}">Ubah</button>
      </div>`).join("");
    return `
      <div class="vs-sec">Kelola kode endorse</div>
      <div class="vs-wrap">${rows || `<div class="vs-empty">Belum ada kode. Tekan Tambah kode.</div>`}</div>
      ${formKode === null ? `<button type="button" class="kd-add" data-act="add">+ Tambah kode</button>` : formHtml()}
      <p class="vs-hint">Link kreator: promo.html?ref=KODE (tekan Salin link untuk menyalin). Kode hanya untuk melacak sumber, bukan diskon. Kode nonaktif atau lewat tanggal tidak dihitung sebagai endorse.</p>`;
  }

  function formHtml() {
    const ed = formKode ? kodeDocs.get(formKode) : null;
    const today = todayStr();
    return `
      <div class="kd-form">
        <label>Kode<input id="kfKode" maxlength="20" placeholder="CONTOH26" autocapitalize="characters" value="${esc(formKode || "")}" ${formKode ? "readonly" : ""}></label>
        <label>Nama kreator<input id="kfNama" maxlength="100" value="${esc(ed ? ed.nama || "" : "")}"></label>
        <label>Mulai<input id="kfMulai" type="date" value="${esc(ed ? ed.tanggalMulai || today : today)}"></label>
        <label>Selesai<input id="kfSelesai" type="date" value="${esc(ed ? ed.tanggalSelesai || "" : endOfMonth(nowYM.y, nowYM.m))}"></label>
        <div class="kd-btn">
          <button type="button" data-act="cancel">Batal</button>
          <button type="button" class="pri" data-act="save">Simpan</button>
        </div>
      </div>`;
  }

  let busyKode = false;
  async function aksiKode(btn) {
    const act = btn.dataset.act, k = btn.dataset.k;
    if (act === "add") { formKode = ""; paintPromo(); return; }
    if (act === "edit") { formKode = k; paintPromo(); return; }
    if (act === "cancel") { formKode = null; paintPromo(); return; }
    if (act === "copy") {
      const ok = await salinTeks(linkKode(k));
      toast(ok ? "Link " + k + " disalin." : "Gagal menyalin. Link: " + linkKode(k), ok ? undefined : "error");
      return;
    }
    if (busyKode) return;
    if (act === "toggle") {
      const cur = kodeDocs.get(k);
      if (!cur) return;
      busyKode = true; btn.disabled = true;
      try {
        await updateDoc(doc(db, "kode_promo", k), { aktif: cur.aktif !== true });
        cur.aktif = cur.aktif !== true;
        toast(cur.aktif ? "Kode diaktifkan." : "Kode dinonaktifkan.");
      } catch (err) { console.error(err); toast("Gagal mengubah status kode.", "error"); }
      busyKode = false;
      if (alive) paintPromo();
      return;
    }
    if (act === "save") {
      const kode = ($("#kfKode").value || "").trim().toUpperCase();
      const nama = ($("#kfNama").value || "").trim().replace(/\s+/g, " ");
      const mulai = $("#kfMulai").value, selesai = $("#kfSelesai").value;
      if (!/^[A-Z0-9]{3,20}$/.test(kode) || kode === "UMUM") return toast("Kode 3-20 huruf/angka tanpa spasi (bukan UMUM).", "error");
      if (formKode === "" && kodeDocs.has(kode)) return toast("Kode sudah ada. Pakai tombol Ubah.", "error");
      if (nama.length < 2) return toast("Nama kreator wajib diisi.", "error");
      if (!mulai || !selesai || mulai > selesai) return toast("Tanggal mulai dan selesai belum benar.", "error");
      const aktif = formKode ? kodeDocs.get(formKode).aktif === true : true;
      const data = { kode, nama, jenis: "endorse", aktif, tanggalMulai: mulai, tanggalSelesai: selesai };
      busyKode = true; btn.disabled = true;
      try {
        await setDoc(doc(db, "kode_promo", kode), data);
        kodeDocs.set(kode, data);
        const r = kreator.get(kode) || { nama: "", dilihat: 0, ambil: 0 };
        r.nama = nama; kreator.set(kode, r);
        formKode = null;
        const tersalin = await salinTeks(linkKode(kode));
        toast(tersalin ? "Kode disimpan. Link sudah disalin." : "Kode disimpan. Tekan Salin link untuk menyalin.");
      } catch (err) { console.error(err); toast("Gagal menyimpan kode. Cek aturan Firestore.", "error"); }
      busyKode = false;
      if (alive) paintPromo();
    }
  }
  promoEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) aksiKode(b);
  });

  async function loadPromo(y, m, my) {
    try {
      const [snap, kd] = await Promise.all([
        getDocs(query(
          collection(db, "promo_stat"),
          where("tanggal", ">=", `${y}-${p2(m)}-01`),
          where("tanggal", "<=", endOfMonth(y, m)),
          orderBy("tanggal", "asc")
        )),
        getDocs(collection(db, "kode_promo")).catch(() => null)
      ]);
      if (!alive || my !== token) return;
      kreator.clear();
      kodeDocs.clear();
      kodeOk = !!kd;
      kreator.set("UMUM", { nama: "Umum (tanpa kode)", dilihat: null, ambil: 0 });
      if (kd) kd.forEach((d) => { const x = d.data(); kodeDocs.set(d.id, x); kreator.set(d.id, { nama: x.nama || "", dilihat: 0, ambil: 0 }); });
      snap.forEach((d) => {
        const x = d.data(), k = x.kode || d.id.split("_")[0];
        const r = kreator.get(k) || { nama: "", dilihat: 0, ambil: 0 };
        if (r.dilihat !== null) r.dilihat += num(x.dilihat);
        r.ambil += num(x.ambil);
        kreator.set(k, r);
      });
      promoOk = true;
    } catch (err) {
      console.error(err);
      if (!alive || my !== token) return;
      kreator.clear();
      promoOk = false;
    }
    paintPromo();
  }

  async function load() {
    const my = ++token;
    const { y, m } = ym;
    ready = false;
    paint();
    try {
      const [snap, st] = await Promise.all([
        getDocs(query(
          collection(db, "visits"),
          where("tanggal", ">=", `${y}-${p2(m)}-01`),
          where("tanggal", "<=", endOfMonth(y, m)),
          orderBy("tanggal", "asc")
        )),
        getDoc(doc(db, "visitStats", "all"))
      ]);
      if (!alive || my !== token) return;
      days.clear();
      snap.forEach((d) => { const x = d.data(); days.set(x.tanggal || d.id, { total: num(x.total), baru: num(x.baru) }); });
      all = st.exists() ? { total: num(st.data().total), baru: num(st.data().baru) } : null;
      ready = true;
      paint();
      loadPromo(y, m, my);
    } catch (err) {
      console.error(err);
      if (!alive || my !== token) return;
      cardsEl.innerHTML = "";
      tableEl.innerHTML = `<div class="vs-empty">Gagal memuat data pengunjung. Cek aturan Firestore dan koneksi.</div>`;
      toast("Gagal memuat data pengunjung.", "error");
    }
  }

  function gantiBulan(delta) {
    let { y, m } = ym;
    m += delta;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    ym = { y, m };
    paintMonth();
    load();
  }
  prevBtn.addEventListener("click", () => gantiBulan(-1));
  nextBtn.addEventListener("click", () => { if (!nextBtn.disabled) gantiBulan(1); });

  paintMonth();
  load();
  return () => { alive = false; };
}
