// cashflow.js — Cash Flow harian cabang (list per tanggal + popup hitung & simpan)
// Sumber hitung (baca saja):
//   users/{adminUid}/laporanAdmin/{tanggal}  -> per uid: pembayaranProduksi, kasDistribusi, hutangSaldo (dijumlahkan semua uid)
//   users/{adminUid}/cost/{tanggal}          -> total pengeluaran
// Simpan      : users/{adminUid}/cashFlow/{tanggal} -> { tanggal, produksi: { omset, cost, cashFlow }, distribusi: { omset, hutang, cashFlow }, ... }
// Kunci edit  : hanya hari ini & kemarin (tanggal terlewat 2 hari atau lebih terkunci, harus sama dengan rules)
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast } from "./ui.js";

export const css = new URL("./cashflow.css", import.meta.url).href;

const BATAS_HARI = 1;            // hanya hari ini & kemarin yang bisa diedit (harus sama dengan rules)

/* ---------- Helper ---------- */
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const rp = (n) => `${n < 0 ? "-" : ""}Rp ${fmt(Math.abs(n))}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const p2 = (n) => String(n).padStart(2, "0");

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

const ds = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const dt = parse(s); dt.setDate(dt.getDate() + n); return ds(dt); };
const todayStr = () => ds(new Date());
const endOfMonth = (y, m) => ds(new Date(y, m, 0));
const tglIndoShort = (s) => parse(s).toLocaleDateString("id-ID", { day: "numeric", month: "long" });
const tglIndo = (s) => parse(s).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

const tone = (n) => (n < 0 ? "neg" : n > 0 ? "pos" : "");

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const now = new Date();
  const nowYM = { y: now.getFullYear(), m: now.getMonth() + 1 };
  const ymKey = (y, m) => `${y}-${p2(m)}`;
  const KEY_MON = (y, m) => `cf:mon:${admin.uid}:${ymKey(y, m)}`;

  let alive = true;
  const docs = new Map();           // tanggal -> { produksi, distribusi, savedAtMs }
  const monthsLoaded = new Set();   // "YYYY-MM" yang sudah dimuat penuh dari server
  let ym = { ...nowYM };
  let monReady = false;

  // popup
  let sheetEl = null;
  let draft = null;                 // { tanggal, exists, savedAtMs, calc: null | {...} }
  let calcToken = 0;
  let pushTimer = 0;
  let pushed = false;

  el.innerHTML = `
    <section class="v-cf">
      <button class="cf-open" id="cfOpen" type="button">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Input Cash Flow
      </button>
      <div class="cf-filter">
        <button type="button" id="cfPrev" aria-label="Bulan sebelumnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span id="cfMonth"></span>
        <button type="button" id="cfNext" aria-label="Bulan berikutnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <div id="cfSummary"></div>
      <div id="cfTable"></div>
    </section>`;

  const $ = (s) => el.querySelector(s);
  const monthEl = $("#cfMonth"), prevBtn = $("#cfPrev"), nextBtn = $("#cfNext");
  const summaryEl = $("#cfSummary"), tableEl = $("#cfTable");

  /* ---------- Kunci edit ---------- */
  const minEditable = () => addDays(todayStr(), -BATAS_HARI);
  const isLocked = (d) => d < minEditable() || d > todayStr();

  /* ===== Filter bulan ===== */
  function paintMonth() {
    monthEl.textContent = `${BULAN[ym.m - 1]} ${ym.y}`;
    nextBtn.disabled = ym.y === nowYM.y && ym.m === nowYM.m;
  }
  function gantiBulan(delta) {
    let { y, m } = ym;
    m += delta;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    ym = { y, m };
    paintMonth();
    loadMonth();
  }
  prevBtn.addEventListener("click", () => gantiBulan(-1));
  nextBtn.addEventListener("click", () => { if (!nextBtn.disabled) gantiBulan(1); });
  $("#cfOpen").addEventListener("click", () => openSheet(todayStr()));

  /* ===== List ===== */
  function skelTable() {
    summaryEl.innerHTML = `<div class="cf-cards">${Array.from({ length: 3 }, () => `<div class="cf-card"><span class="skel" style="height:11px;width:55%"></span><span class="skel" style="height:22px;width:70%"></span></div>`).join("")}</div>`;
    tableEl.innerHTML = `<div class="cf-tablewrap"><div class="cf-skel-rows">${Array.from({ length: 8 }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div></div>`;
  }

  const cell = (n) => `<td class="${tone(n)}">${n ? fmt(n) : "0"}</td>`;

  function paintTable() {
    if (!monReady) { skelTable(); return; }

    const isNow = ym.y === nowYM.y && ym.m === nowYM.m;
    const end = isNow ? todayStr() : endOfMonth(ym.y, ym.m);
    const startM = `${ym.y}-${p2(ym.m)}-01`;

    let totProd = 0, totDist = 0, hariTersimpan = 0;
    let body = "";
    for (let d = end; d >= startM; d = addDays(d, -1)) {
      const dt = parse(d);
      const rec = docs.get(d);
      const lock = isLocked(d);
      const tgl = `<td class="cf-date${dt.getDay() === 0 ? " minggu" : ""}"><b>${dt.getDate()}</b><small>${HARI[dt.getDay()]}</small>${lock ? "" : ` <i class="cf-dot" title="Bisa diedit"></i>`}</td>`;
      if (!rec) {
        body += `<tr class="empty" data-d="${d}">${tgl}<td colspan="4">${lock ? "–" : "belum disimpan"}</td></tr>`;
        continue;
      }
      hariTersimpan++;
      const p = num(rec.produksi?.cashFlow), s = num(rec.distribusi?.cashFlow);
      totProd += p; totDist += s;
      body += `<tr data-d="${d}">${tgl}${cell(p)}${cell(s)}<td class="${tone(p + s)}"><b>${fmt(p + s)}</b></td><td class="cf-ck">✓</td></tr>`;
    }

    const grand = totProd + totDist;
    summaryEl.innerHTML = `
      <div class="cf-cards">
        <div class="cf-card strong"><span class="cf-l">Total Cash Flow</span><span class="cf-v ${tone(grand)}">${rp(grand)}</span></div>
        <div class="cf-card"><span class="cf-l">Produksi</span><span class="cf-v sm ${tone(totProd)}">${rp(totProd)}</span></div>
        <div class="cf-card"><span class="cf-l">Distribusi</span><span class="cf-v sm ${tone(totDist)}">${rp(totDist)}</span></div>
      </div>`;

    tableEl.innerHTML = `
      <div class="cf-tablewrap">
        <table class="cf-table">
          <thead>
            <tr><th class="cf-date">Tanggal</th><th>Produksi</th><th>Distribusi</th><th>Total</th><th></th></tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td class="cf-date">Total</td>
              <td>${fmt(totProd)}</td>
              <td>${fmt(totDist)}</td>
              <td>${fmt(grand)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="cf-hint">Angka dalam Rupiah. Tanda ✓ = tanggal sudah disimpan (${hariTersimpan} hari). Ketuk satu baris untuk melihat atau menyimpan. Hanya hari ini dan kemarin yang bisa disimpan atau diperbarui (ditandai titik biru); tanggal lebih lama terkunci.</p>`;

    tableEl.querySelectorAll("tr[data-d]").forEach((tr) => {
      tr.addEventListener("click", () => openSheet(tr.dataset.d));
    });
  }

  /* ===== Hitung dari laporanAdmin & cost ===== */
  async function hitungTanggal(tanggal) {
    const [lap, cost] = await Promise.all([
      getDoc(doc(db, "users", admin.uid, "laporanAdmin", tanggal)),
      getDoc(doc(db, "users", admin.uid, "cost", tanggal))
    ]);

    let prodOmset = 0, distOmset = 0, hutang = 0, jumlahUid = 0;
    if (lap.exists()) {
      Object.values(lap.data()).forEach((v) => {
        // entri per uid = map yang punya kurirUid (updatedAt dkk bukan map laporan)
        if (!v || typeof v !== "object" || Array.isArray(v) || !("kurirUid" in v)) return;
        jumlahUid++;
        prodOmset += num(v.pembayaranProduksi);
        distOmset += num(v.kasDistribusi);
        hutang += num(v.hutangSaldo);
      });
    }
    const costTotal = cost.exists() ? num(cost.data().total) : 0;

    return {
      adaLaporan: lap.exists() && jumlahUid > 0,
      adaCost: cost.exists(),
      jumlahUid,
      produksi: { omset: prodOmset, cost: costTotal, cashFlow: prodOmset - costTotal },
      distribusi: { omset: distOmset, hutang, cashFlow: distOmset + hutang }   // hutang bernilai minus
    };
  }

  /* ===== Popup ===== */
  function openSheet(tanggal) {
    if (sheetEl) return;
    if (!monReady) { toast("Data masih dimuat, coba lagi sebentar.", "info"); return; }

    sheetEl = document.createElement("div");
    sheetEl.className = "cf-sheet-wrap";
    sheetEl.innerHTML = `
      <div class="cf-sheet-backdrop"></div>
      <div class="cf-sheet" role="dialog" aria-label="Input cash flow">
        <div class="cf-sheet-grip"></div>
        <div class="cf-sheet-head">
          <h3>Input Cash Flow</h3>
          <button type="button" class="cf-x" id="cfClose" aria-label="Tutup">✕</button>
        </div>
        <div class="cf-sheet-top" id="cfTop"></div>
        <div class="cf-sheet-body" id="cfBody"></div>
        <div class="cf-sheet-foot" id="cfFoot"></div>
      </div>`;

    sheetEl.querySelector(".cf-sheet-backdrop").addEventListener("click", () => closeSheet());
    sheetEl.querySelector("#cfClose").addEventListener("click", () => closeSheet());
    setupSwipe(sheetEl.querySelector(".cf-sheet"), sheetEl.querySelector(".cf-sheet-backdrop"));
    loadDraft(tanggal);

    const node = sheetEl;
    document.body.appendChild(node);
    node.getBoundingClientRect();
    requestAnimationFrame(() => { if (sheetEl === node) node.classList.add("show"); });

    pushTimer = setTimeout(() => {
      pushTimer = 0;
      if (sheetEl !== node) return;
      document.documentElement.classList.add("cf-sheet-open");
      history.pushState({ cf: 1 }, "");                   // tombol back Android menutup popup
      pushed = true;
    }, 320);
  }

  function closeSheet(fromPop) {
    if (!sheetEl) return;
    const node = sheetEl;
    sheetEl = null;
    draft = null;
    calcToken++;
    node.classList.remove("show");
    setTimeout(() => node.remove(), 240);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    document.documentElement.classList.remove("cf-sheet-open");
    if (pushed) {
      pushed = false;
      if (!fromPop) setTimeout(() => { if (!sheetEl && history.state && history.state.cf) history.back(); }, 280);
    }
  }

  function setupSwipe(sheet, backdrop) {
    const body = sheet.querySelector("#cfBody");
    let sy = 0, sx = 0, st = 0, dy = 0, h = 1, mode = 0, raf = 0, bound = false;

    const apply = () => {
      raf = 0;
      sheet.style.transform = `translate3d(0, ${dy}px, 0)`;
      backdrop.style.opacity = String(Math.max(0, 1 - dy / h));
    };

    const move = (e) => {
      if (mode === 2) return;
      const t = e.touches[0];
      const ddy = t.clientY - sy, ddx = t.clientX - sx;
      if (mode === 0) {
        if (Math.abs(ddy) < 6 && Math.abs(ddx) < 6) return;
        if (!(ddy > 0 && Math.abs(ddy) > Math.abs(ddx))) { mode = 2; return; }
        mode = 1;
        h = sheet.offsetHeight || 1;
        sheet.style.transition = "none";
        backdrop.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, ddy);
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const end = () => {
      if (bound) { sheet.removeEventListener("touchmove", move); bound = false; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (mode !== 1) { mode = 0; return; }
      mode = 0;
      const v = dy / Math.max(1, Date.now() - st);
      sheet.style.transition = "";
      backdrop.style.transition = "";
      sheet.style.transform = "";
      backdrop.style.opacity = "";
      if (dy > 110 || v > 0.6) closeSheet();
    };

    sheet.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { mode = 2; return; }
      sy = e.touches[0].clientY; sx = e.touches[0].clientX; st = Date.now(); dy = 0; mode = 0;
      if (body.contains(e.target) && body.scrollTop > 0) { mode = 2; return; }
      if (!bound) { sheet.addEventListener("touchmove", move, { passive: false }); bound = true; }
    }, { passive: true });
    sheet.addEventListener("touchend", end, { passive: true });
    sheet.addEventListener("touchcancel", end, { passive: true });
  }

  const sq = (s) => sheetEl && sheetEl.querySelector(s);
  const locked = () => !draft || isLocked(draft.tanggal);

  // siapkan draft untuk satu tanggal, lalu hitung dari laporanAdmin & cost
  async function loadDraft(tanggal) {
    const token = ++calcToken;
    await ensureDay(tanggal);
    if (!sheetEl || token !== calcToken) return;
    const rec = docs.get(tanggal);
    draft = { tanggal, exists: !!rec, savedAtMs: rec?.savedAtMs || null, rec: rec || null, calc: null, failed: false };
    paintTop(); paintBody(); paintFoot();

    try {
      const calc = await hitungTanggal(tanggal);
      if (!sheetEl || token !== calcToken) return;
      draft.calc = calc;
    } catch (err) {
      console.error(err);
      if (!sheetEl || token !== calcToken) return;
      draft.failed = true;
      toast("Gagal memuat laporan atau pengeluaran. Cek aturan Firestore dan koneksi.", "error", 4500);
    }
    paintBody(); paintFoot();
  }

  // angka yang ditampilkan: tanggal terkunci & sudah tersimpan -> pakai data tersimpan, selain itu hasil hitung terbaru
  function shown() {
    if (!draft) return null;
    if (locked() && draft.rec) return { produksi: draft.rec.produksi, distribusi: draft.rec.distribusi, saved: true };
    if (draft.calc) return { produksi: draft.calc.produksi, distribusi: draft.calc.distribusi, saved: false };
    return null;
  }

  function paintTop() {
    const lock = locked();
    const badge = draft.exists
      ? `<div class="cf-badge saved">✓ Sudah disimpan${draft.savedAtMs ? " · " + new Date(draft.savedAtMs).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</div>`
      : `<div class="cf-badge new">Belum disimpan</div>`;
    sq("#cfTop").innerHTML = `
      <div class="cf-row">
        <label for="cfTanggal">Tanggal</label>
        <input type="date" id="cfTanggal" value="${draft.tanggal}" max="${todayStr()}">
      </div>
      ${badge}
      ${lock ? `<div class="cf-lock">🔒 Terkunci. Data berumur 2 hari atau lebih tidak bisa disimpan atau diubah (yang bisa diedit: ${tglIndoShort(minEditable())} sampai hari ini).</div>` : ""}`;

    sq("#cfTanggal").addEventListener("change", (e) => {
      const v = e.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      loadDraft(v);
    });
  }

  const line = (label, value, cls = "") =>
    `<div class="cf-line ${cls}"><span>${esc(label)}</span><b class="${tone(value)}">${rp(value)}</b></div>`;

  function paintBody() {
    const body = sq("#cfBody");
    if (!body) return;
    const s = shown();

    if (!s) {
      body.innerHTML = draft?.failed
        ? `<div class="cf-empty">Gagal memuat data tanggal ini.</div>`
        : `<div class="cf-skel-rows">${Array.from({ length: 7 }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div>`;
      return;
    }

    const p = s.produksi, d = s.distribusi;
    const c = draft.calc;
    const notes = [];
    if (!s.saved && c) {
      if (!c.adaLaporan) notes.push("Belum ada laporan admin (Data Harian) pada tanggal ini, omset dihitung Rp 0.");
      else notes.push(`Dijumlahkan dari ${c.jumlahUid} kurir/sales.`);
      if (!c.adaCost) notes.push("Pengeluaran belum diinput pada tanggal ini, cost dihitung Rp 0.");
    }
    if (s.saved) notes.push("Menampilkan data yang sudah tersimpan (tanggal terkunci).");

    body.innerHTML = `
      <div class="cf-date-title">${esc(tglIndo(draft.tanggal))}</div>

      <div class="cf-group">
        <h4>Produksi</h4>
        ${line("Omset (pembayaran produksi)", num(p?.omset))}
        ${line("Cost (pengeluaran)", num(p?.cost))}
        ${line("Cash Flow", num(p?.cashFlow), "total")}
      </div>

      <div class="cf-group">
        <h4>Distribusi</h4>
        ${line("Omset (kas distribusi)", num(d?.omset))}
        ${line("Hutang", num(d?.hutang))}
        ${line("Cash Flow", num(d?.cashFlow), "total")}
      </div>

      ${notes.map((n) => `<p class="cf-note">${esc(n)}</p>`).join("")}`;
  }

  function paintFoot() {
    const foot = sq("#cfFoot");
    if (!foot) return;
    const lock = locked();
    const s = shown();
    const total = s ? num(s.produksi?.cashFlow) + num(s.distribusi?.cashFlow) : null;
    foot.innerHTML = `
      <div class="cf-sum">
        <span class="cf-l">Total Cash Flow</span>
        <b class="big ${total === null ? "" : tone(total)}">${total === null ? "…" : rp(total)}</b>
      </div>
      ${lock ? "" : `<button class="cf-save" id="cfSave" type="button" ${draft?.calc ? "" : "disabled"}>${draft?.exists ? "Perbarui" : "Simpan"}</button>`}`;
    const sv = sq("#cfSave");
    if (sv) sv.addEventListener("click", simpan);
  }

  /* ===== Simpan ===== */
  async function simpan() {
    if (!draft?.calc) return;
    if (isLocked(draft.tanggal)) { toast("Tanggal ini terkunci.", "error"); return; }
    if (!idCabang) { toast("Akun belum punya idCabang.", "error"); return; }

    const { tanggal, exists } = draft;
    const produksi = { ...draft.calc.produksi };
    const distribusi = { ...draft.calc.distribusi };
    const payload = { tanggal, produksi, distribusi, adminUid: admin.uid, idCabang, updatedAt: serverTimestamp() };
    if (!exists) payload.createdAt = serverTimestamp();

    const btn = sq("#cfSave");
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;

    try {
      await setDoc(doc(db, "users", admin.uid, "cashFlow", tanggal), payload, { merge: true });
      if (!alive) return;
      docs.set(tanggal, { produksi, distribusi, savedAtMs: Date.now() });
      saveMonthCache(Number(tanggal.slice(0, 4)), Number(tanggal.slice(5, 7)));
      toast(exists ? "Cash flow diperbarui." : "Cash flow tersimpan.", "success");
      closeSheet();
      paintTable();
    } catch (err) {
      console.error(err);
      if (!alive || !sheetEl) return;
      btn.disabled = false;
      btn.textContent = label;
      toast(err?.code === "permission-denied"
        ? "Ditolak aturan Firestore (atau tanggal sudah terkunci)."
        : "Gagal menyimpan cash flow.", "error", 4500);
    }
  }

  /* ===== Ambil data tersimpan ===== */
  const fromSnap = (x) => ({
    produksi: {
      omset: num(x.produksi?.omset), cost: num(x.produksi?.cost), cashFlow: num(x.produksi?.cashFlow)
    },
    distribusi: {
      omset: num(x.distribusi?.omset), hutang: num(x.distribusi?.hutang), cashFlow: num(x.distribusi?.cashFlow)
    },
    savedAtMs: x.updatedAt?.toMillis ? x.updatedAt.toMillis() : null
  });

  function saveMonthCache(y, m) {
    const pre = ymKey(y, m);
    const obj = {};
    docs.forEach((v, k) => { if (k.startsWith(pre)) obj[k] = v; });
    cacheSet(KEY_MON(y, m), obj);
  }

  // muat 1 bulan penuh (cache dulu, lalu server)
  async function loadMonth() {
    const { y, m } = ym;
    const key = ymKey(y, m);
    const c = cacheGet(KEY_MON(y, m));
    if (c) { Object.entries(c).forEach(([k, v]) => docs.set(k, v)); }
    monReady = !!c || monthsLoaded.has(key);
    paintTable();

    try {
      const snap = await getDocs(query(
        collection(db, "users", admin.uid, "cashFlow"),
        where("tanggal", ">=", `${key}-01`),
        where("tanggal", "<=", endOfMonth(y, m)),
        orderBy("tanggal", "asc")
      ));
      if (!alive) return;
      for (const k of [...docs.keys()]) if (k.startsWith(key)) docs.delete(k);
      snap.forEach((d) => docs.set(d.data().tanggal || d.id, fromSnap(d.data())));
      monthsLoaded.add(key);
      saveMonthCache(y, m);
      if (ym.y === y && ym.m === m) { monReady = true; paintTable(); }
    } catch (err) {
      console.error(err);
      if (!alive) return;
      if (ym.y === y && ym.m === m && !monReady) {
        summaryEl.innerHTML = "";
        tableEl.innerHTML = `<div class="cf-empty">Gagal memuat data cash flow. Cek aturan Firestore dan koneksi.</div>`;
      }
      toast("Gagal memuat data cash flow.", "error");
    }
  }

  // pastikan data satu tanggal (di luar bulan yang tampil) sudah dibaca dari server
  async function ensureDay(tanggal) {
    const key = tanggal.slice(0, 7);
    if (monthsLoaded.has(key) || docs.has(tanggal)) return;
    try {
      const snap = await getDoc(doc(db, "users", admin.uid, "cashFlow", tanggal));
      if (snap.exists()) docs.set(tanggal, fromSnap(snap.data()));
    } catch (err) {
      console.error(err);
      toast("Gagal memeriksa data tanggal itu.", "error");
    }
  }

  /* ===== Event global ===== */
  const onPop = () => { if (sheetEl) closeSheet(true); };
  const onKey = (e) => { if (e.key === "Escape") closeSheet(); };
  window.addEventListener("popstate", onPop);
  document.addEventListener("keydown", onKey);
  if (history.state && history.state.cf) history.replaceState(null, "");

  /* ===== Start ===== */
  if (!idCabang) {
    summaryEl.innerHTML = "";
    tableEl.innerHTML = `<div class="cf-empty">Akun admin belum punya idCabang.</div>`;
    $("#cfOpen").disabled = true;
  } else {
    paintMonth();
    loadMonth();
  }

  return () => {
    alive = false;
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("keydown", onKey);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
    document.documentElement.classList.remove("cf-sheet-open");
  };
}
