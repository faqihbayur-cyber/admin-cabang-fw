// visitors.js — dashboard pengunjung landing page
// Sumber data (baca saja): visits/{tanggal} -> { tanggal, total, baru }   dan   visitStats/all -> { total, baru }
// total = jumlah pengunjung (1 browser dihitung 1x per hari), baru = pengunjung yang pertama kali datang
import {
  collection, query, where, orderBy, getDocs, getDoc, doc
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
const endOfMonth = (y, m) => ds(new Date(y, m, 0));

export function mount(el, ctx) {
  const { db } = ctx;
  const now = new Date();
  const nowYM = { y: now.getFullYear(), m: now.getMonth() + 1 };
  let ym = { ...nowYM };
  let alive = true;
  let token = 0;
  let all = null;            // visitStats/all
  const days = new Map();    // tanggal -> { total, baru } (bulan yang tampil)

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
    </section>`;

  const $ = (s) => el.querySelector(s);
  const cardsEl = $("#vsCards"), tableEl = $("#vsTable"), monthEl = $("#vsMonth");
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
