// home.js — view Home: dashboard cabang (hari ini, bulan ini, grafik 7 hari, stok galon, customer, top kurir/sales)
// Sumber data (semua baca-saja, pola query sama dengan halaman lain):
//   users/{adminUid}/laporanAdmin/{tanggal}  -> closing, omset, bonus, potongan, kasbon, hutangSaldo per uid
//   users/{adminUid}/cost/{tanggal}          -> total pengeluaran
//   users/{adminUid}/stockopname/{tanggal}   -> galon, pengadukan (saldo dihitung beruntun, sama seperti Stockopname)
//   customers (idCabang)                     -> jumlah customer, ada saldo, ada hutang
import {
  collection, query, where, orderBy, getDocs, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";
import { esc, fmt, num } from "./lib.js";

export const css = new URL("./home.css", import.meta.url).href;

/* ---------- Helper ---------- */
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const HARI_PANJANG = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

const p2 = (n) => String(n).padStart(2, "0");
const ds = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split(" ")[0].split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const dt = parse(s); dt.setDate(dt.getDate() + n); return ds(dt); };
const todayStr = () => ds(new Date());
const rp = (n) => `${n < 0 ? "-" : ""}Rp ${fmt(Math.abs(n))}`;
const namaUser = (u) => u.nama || u.name || u.username || u.email || u.id;

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

function sapaan() {
  const h = new Date().getHours();
  return h < 11 ? "Selamat pagi" : h < 15 ? "Selamat siang" : h < 18 ? "Selamat sore" : "Selamat malam";
}

const ARROW_UP = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const ARROW_DOWN = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`;
const REFRESH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>`;

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const KEY = `home:${admin.uid}:v1`;

  let alive = true;
  let token = 0;
  let loading = false;
  let users = [];
  // null = belum dimuat (tampil skeleton)
  const S = { lap: null, cost: null, stok: null, cust: null };

  el.innerHTML = `
    <section class="v-home">
      <div class="hm-head">
        <div class="hm-head-text">
          <span class="hm-hi" id="hmHi"></span>
          <span class="hm-date" id="hmDate"></span>
        </div>
        <button class="hm-refresh" id="hmRefresh" type="button" aria-label="Muat ulang">${REFRESH}</button>
      </div>

      <h3 class="hm-title">Hari Ini</h3>
      <div class="hm-grid" id="hmHari"></div>

      <h3 class="hm-title" id="hmBulanTitle">Bulan Ini</h3>
      <div class="hm-grid" id="hmBulan"></div>

      <h3 class="hm-title">Closing 7 Hari Terakhir</h3>
      <div id="hmChart"></div>

      <h3 class="hm-title">Stok &amp; Customer</h3>
      <div class="hm-grid" id="hmStok"></div>

      <h3 class="hm-title">Top Kurir &amp; Sales Bulan Ini</h3>
      <div id="hmRank"></div>
    </section>`;

  const $ = (s) => el.querySelector(s);
  const hariEl = $("#hmHari"), bulanEl = $("#hmBulan"), chartEl = $("#hmChart");
  const stokEl = $("#hmStok"), rankEl = $("#hmRank"), refreshBtn = $("#hmRefresh");

  /* ===== Kerangka kartu ===== */
  const skelCard = (wide) => `
    <div class="hm-card${wide ? " wide" : ""}">
      <span class="skel hm-skel-l"></span>
      <span class="skel hm-skel-v"></span>
      <span class="skel hm-skel-n"></span>
    </div>`;

  function card({ label, value, note, tone, href, wide }) {
    const inner = `
      <span class="hm-l">${esc(label)}</span>
      <span class="hm-v">${value}</span>
      ${note ? `<span class="hm-n">${note}</span>` : ""}`;
    const cls = `hm-card${tone ? ` ${tone}` : ""}${wide ? " wide" : ""}${href ? " link" : ""}`;
    return href ? `<a class="${cls}" href="${esc(href)}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
  }

  function delta(now, before, unit) {
    const d = now - before;
    if (!d) return `<span class="hm-delta">sama dengan kemarin</span>`;
    return `<span class="hm-delta ${d > 0 ? "up" : "down"}">${d > 0 ? ARROW_UP : ARROW_DOWN} ${fmt(Math.abs(d))}${unit || ""} dari kemarin</span>`;
  }

  /* ===== Paint ===== */
  function paintHead() {
    const nama = profile?.nama || "";
    $("#hmHi").textContent = `${sapaan()}${nama ? `, ${nama}` : ""}`;
    const d = new Date();
    $("#hmDate").textContent = `${HARI_PANJANG[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
    const n = new Date();
    $("#hmBulanTitle").textContent = `Bulan Ini · ${BULAN[n.getMonth()]} ${n.getFullYear()}`;
  }

  function paintHari() {
    const l = S.lap;
    if (!l) { hariEl.innerHTML = skelCard() + skelCard(); return; }
    hariEl.innerHTML =
      card({ label: "Closing", value: fmt(l.hari.closing), note: delta(l.hari.closing, l.kemarin.closing), href: "#/laporan-harian" }) +
      card({ label: "Omset", value: rp(l.hari.omset), note: delta(l.hari.omset, l.kemarin.omset), href: "#/laporan-harian" });
  }

  function paintBulan() {
    const l = S.lap, c = S.cost;
    if (!l) { bulanEl.innerHTML = skelCard() + skelCard() + skelCard() + skelCard() + skelCard(true); return; }
    const rata = l.hariLapor ? Math.round((l.bulan.closing / l.hariLapor) * 10) / 10 : 0;
    const peng = c ? c.bulan : null;
    const selisih = peng === null ? null : l.bulan.omset - peng;
    const hs = l.hs;
    bulanEl.innerHTML =
      card({ label: "Total Closing", value: fmt(l.bulan.closing), note: `rata-rata ${fmt(rata)} / hari · ${l.hariLapor} hari lapor`, href: "#/laporan-harian" }) +
      card({ label: "Total Omset", value: rp(l.bulan.omset), note: `${fmt(l.bulan.repeat)} repeat`, href: "#/laporan-harian" }) +
      (c
        ? card({ label: "Pengeluaran", value: rp(peng), note: `hari ini ${rp(c.hari)}`, tone: "neg", href: "#/pengeluaran" })
        : skelCard()) +
      (c
        ? card({ label: "Omset − Pengeluaran", value: rp(selisih), tone: selisih < 0 ? "neg" : "pos", href: "#/pengeluaran" })
        : skelCard()) +
      card({ label: "Bonus", value: rp(l.bulan.bonus), tone: "pos" }) +
      card({ label: "Potongan", value: rp(l.bulan.potongan), tone: "neg" }) +
      card({ label: "Kasbon", value: rp(l.bulan.kasbon), tone: "neg" }) +
      card({
        label: "Hutang / Saldo Kurir",
        value: `${hs < 0 ? "-" : ""}${fmt(Math.abs(hs))}`,
        note: "posisi terakhir semua kurir & sales, minus = hutang",
        tone: hs < 0 ? "neg" : hs > 0 ? "pos" : "",
        href: "#/laporan-harian"
      });
  }

  function paintChart() {
    const l = S.lap;
    if (!l) { chartEl.innerHTML = `<div class="hm-chart"><span class="skel hm-skel-chart"></span></div>`; return; }
    const max = Math.max(1, ...l.minggu.map((x) => x.closing));
    const today = todayStr();
    chartEl.innerHTML = `
      <div class="hm-chart">
        <div class="hm-bars">
          ${l.minggu.map((x) => `
            <div class="hm-bar-col${x.t === today ? " now" : ""}">
              <span class="hm-bar-val">${x.closing ? fmt(x.closing) : ""}</span>
              <span class="hm-bar-track"><span class="hm-bar" style="height:${x.closing ? Math.max(4, Math.round((x.closing / max) * 100)) : 0}%"></span></span>
              <span class="hm-bar-lbl"><b>${parse(x.t).getDate()}</b>${HARI[parse(x.t).getDay()]}</span>
            </div>`).join("")}
        </div>
      </div>`;
  }

  function paintStok() {
    const st = S.stok, cu = S.cust;
    const stokCard = !S.lap || st === null
      ? skelCard()
      : st.ada
        ? card({
            label: "Stok Galon",
            value: fmt(st.saldo),
            note: `masuk hari ini ${fmt(st.inp)} · pengadukan ${fmt(st.adk)}`,
            tone: st.saldo < 0 ? "neg" : "",
            href: "#/stockopname"
          })
        : card({ label: "Stok Galon", value: "–", note: "belum ada data stockopname", href: "#/stockopname" });

    const cv = (v) => (v === null || v === undefined ? "–" : fmt(v));
    stokEl.innerHTML = stokCard + (cu === null
      ? skelCard()
      : card({ label: "Customer", value: cv(cu.total), note: "total di cabang ini", href: "#/customer" }))
      + (cu === null
        ? skelCard()
        : card({ label: "Ada Saldo", value: cv(cu.saldo), tone: "pos", href: "#/customer" }))
      + (cu === null
        ? skelCard()
        : card({ label: "Ada Hutang", value: cv(cu.hutang), tone: "neg", href: "#/customer" }));
  }

  function paintRank() {
    const l = S.lap;
    if (!l) {
      rankEl.innerHTML = `<div class="hm-rank">${Array.from({ length: 3 }, () => `<div class="hm-rank-row"><span class="skel hm-skel-rank"></span></div>`).join("")}</div>`;
      return;
    }
    if (!l.rank.length) {
      rankEl.innerHTML = `<div class="hm-empty">Belum ada laporan bulan ini.</div>`;
      return;
    }
    const map = new Map(users.map((u) => [u.id, u]));
    const top = l.rank[0].closing || 1;
    rankEl.innerHTML = `
      <div class="hm-rank">
        ${l.rank.map((r, i) => {
          const u = map.get(r.uid);
          const nama = u ? namaUser(u) : `…${String(r.uid).slice(-4)}`;
          return `
            <div class="hm-rank-row">
              <span class="hm-rank-no">${i + 1}</span>
              <span class="hm-rank-main">
                <span class="hm-rank-top"><span class="hm-rank-name">${esc(nama)}</span><span class="hm-rank-val">${fmt(r.closing)}</span></span>
                <span class="hm-rank-track"><span class="hm-rank-bar" style="width:${Math.max(3, Math.round((r.closing / top) * 100))}%"></span></span>
              </span>
            </div>`;
        }).join("")}
      </div>`;
  }

  function paintAll() {
    paintHead(); paintHari(); paintBulan(); paintChart(); paintStok(); paintRank();
  }

  const saveCache = () => cacheSet(KEY, { day: todayStr(), lap: S.lap, cost: S.cost, stok: S.stok, cust: S.cust });

  /* ===== Ambil data ===== */
  function olah(snapDocs, stokDocs, today, monthStart, weekStart) {
    const list = snapDocs
      .map((d) => ({ t: d.data().tanggal || d.id, x: d.data() }))
      .sort((a, b) => a.t.localeCompare(b.t));

    const days = new Map();
    const perUid = new Map();
    const lastHS = new Map();

    list.forEach(({ t, x }) => {
      const r = { closing: 0, repeat: 0, omset: 0, bonus: 0, potongan: 0, kasbon: 0 };
      Object.entries(x).forEach(([uid, v]) => {
        if (!v || typeof v !== "object" || Array.isArray(v) || v.toMillis || !("closing" in v)) return;
        r.closing += num(v.closing);
        r.repeat += num(v.pelangganRepeat);
        r.omset += num(v.omset);
        r.bonus += num(v.bonus);
        r.potongan += num(v.potongan);
        r.kasbon += num(v.kasbon);
        lastHS.set(uid, num(v.hutangSaldo));
        if (t >= monthStart) perUid.set(uid, (perUid.get(uid) || 0) + num(v.closing));
      });
      days.set(t, r);
    });

    const kosong = { closing: 0, repeat: 0, omset: 0, bonus: 0, potongan: 0, kasbon: 0 };
    const bulan = { ...kosong };
    let hariLapor = 0;
    days.forEach((r, t) => {
      if (t < monthStart || t > today) return;
      hariLapor++;
      Object.keys(bulan).forEach((k) => { bulan[k] += r[k]; });
    });

    const minggu = [];
    for (let i = 6; i >= 0; i--) {
      const t = addDays(today, -i);
      minggu.push({ t, closing: days.get(t)?.closing || 0 });
    }

    let hs = 0;
    lastHS.forEach((v) => { hs += v; });

    const rank = [...perUid.entries()]
      .map(([uid, closing]) => ({ uid, closing }))
      .filter((r) => r.closing > 0)
      .sort((a, b) => b.closing - a.closing)
      .slice(0, 5);

    const lap = {
      hari: { ...kosong, ...(days.get(today) || {}) },
      kemarin: { ...kosong, ...(days.get(addDays(today, -1)) || {}) },
      bulan, hariLapor, minggu, hs, rank
    };

    // stok galon: saldo = saldo kemarin + input - pengadukan - closing (beruntun dari tanggal input pertama)
    let stok = { ada: false, saldo: 0, inp: 0, adk: 0 };
    const first = stokDocs.length ? stokDocs[0].t : "";
    if (first && first <= today) {
      const sm = new Map(stokDocs.map((s) => [s.t, s]));
      let saldo = 0, inp = 0, adk = 0;
      for (let d = first, g = 0; d <= today && g < 4000; d = addDays(d, 1), g++) {
        const s = sm.get(d);
        inp = num(s?.galon); adk = num(s?.pengadukan);
        saldo = saldo + inp - adk - num(days.get(d)?.closing);
      }
      stok = { ada: true, saldo, inp, adk };
    }
    return { lap, stok };
  }

  async function fetchStokDocs() {
    const snap = await getDocs(query(collection(db, "users", admin.uid, "stockopname"), orderBy("tanggal", "asc")));
    return snap.docs.map((d) => {
      const x = d.data();
      return { t: x.tanggal || d.id, galon: num(x.galon), pengadukan: num(x.pengadukan) };
    });
  }

  async function loadLaporanDanStok(my, today, monthStart, weekStart, onFail) {
    try {
      let stokDocs = [];
      try { stokDocs = await fetchStokDocs(); } catch (err) { console.error(err); onFail(); }
      let from = monthStart < weekStart ? monthStart : weekStart;
      if (stokDocs.length && stokDocs[0].t < from) from = stokDocs[0].t;

      const snap = await getDocs(query(
        collection(db, "users", admin.uid, "laporanAdmin"),
        where("tanggal", ">=", from),
        where("tanggal", "<=", today)
      ));
      if (!alive || my !== token) return;
      const { lap, stok } = olah(snap.docs, stokDocs, today, monthStart, weekStart);
      S.lap = lap; S.stok = stok;
      paintHari(); paintBulan(); paintChart(); paintStok(); paintRank();
      saveCache();
    } catch (err) {
      console.error(err);
      onFail();
    }
  }

  async function loadCost(my, today, monthStart, onFail) {
    try {
      const snap = await getDocs(query(
        collection(db, "users", admin.uid, "cost"),
        where("tanggal", ">=", monthStart),
        where("tanggal", "<=", today),
        orderBy("tanggal", "asc")
      ));
      if (!alive || my !== token) return;
      let bulan = 0, hari = 0;
      snap.forEach((d) => {
        const x = d.data();
        const t = num(x.total);
        bulan += t;
        if ((x.tanggal || d.id) === today) hari += t;
      });
      S.cost = { bulan, hari };
      paintBulan();
      saveCache();
    } catch (err) {
      console.error(err);
      onFail();
    }
  }

  async function loadCustomer(my, onFail) {
    if (!idCabang) { S.cust = { total: null, saldo: null, hutang: null }; paintStok(); return; }
    const hitung = async (...extra) => {
      try {
        const snap = await getCountFromServer(query(collection(db, "customers"), where("idCabang", "==", idCabang), ...extra));
        return snap.data().count;
      } catch (err) {
        console.error(err);
        onFail();
        return null;
      }
    };
    const [total, saldo, hutang] = await Promise.all([
      hitung(),
      hitung(where("saldo", ">", 0)),
      hitung(where("hutang", ">", 0))
    ]);
    if (!alive || my !== token) return;
    S.cust = { total, saldo, hutang };
    paintStok();
    saveCache();
  }

  async function loadUsers(my) {
    if (!idCabang) return;
    const c = cacheGet(`dh:list:${idCabang}`);
    if (c?.users?.length) { users = c.users; paintRank(); }
    try {
      const snap = await getDocs(query(
        collection(db, "users"),
        where("idCabang", "==", idCabang),
        where("role", "in", ["kurir", "sales"])
      ));
      if (!alive || my !== token) return;
      users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      paintRank();
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAll() {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add("spin");
    const my = ++token;
    const now = new Date();
    const today = todayStr();
    const monthStart = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-01`;
    const weekStart = addDays(today, -6);

    let failed = false;
    const onFail = () => { failed = true; };

    await Promise.all([
      loadLaporanDanStok(my, today, monthStart, weekStart, onFail),
      loadCost(my, today, monthStart, onFail),
      loadCustomer(my, onFail),
      loadUsers(my)
    ]);

    if (!alive) return;
    loading = false;
    refreshBtn.classList.remove("spin");
    if (failed && my === token) toast("Sebagian data dashboard gagal dimuat.", "error");
  }

  refreshBtn.addEventListener("click", loadAll);

  /* ===== Start: tampil instan dari cache, lalu segarkan ===== */
  const cached = cacheGet(KEY);
  if (cached && cached.day === todayStr()) {
    S.lap = cached.lap || null;
    S.cost = cached.cost || null;
    S.stok = cached.stok || null;
    S.cust = cached.cust || null;
  }
  paintAll();
  loadAll();

  return () => { alive = false; };
}
