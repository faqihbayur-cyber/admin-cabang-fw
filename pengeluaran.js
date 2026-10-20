// pengeluaran.js — pengeluaran harian cabang (list per tanggal + input lewat popup)
// Tab input  : dari array `cost` di kantorCabang/{idCabang} (tiap elemen = map { namaTab: { item: hargaSatuan } }) + tab "Marginal" (manual)
// Simpan     : users/{adminUid}/cost/{tanggal}  -> { tanggal, items: [{ tab, nama, qty, harga, total }], total, ... }
// Kunci edit : hanya hari ini & kemarin (sama seperti stockopname, harus sama dengan rules)
import {
  collection, query, where, orderBy, getDocs, getDoc, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, alertBox } from "./ui.js";

export const css = new URL("./pengeluaran.css", import.meta.url).href;

const BATAS_HARI = 1;            // hanya hari ini & kemarin yang bisa diedit (harus sama dengan rules)
const MARGINAL = "Marginal";     // tab tambahan, diisi manual
const MAX_QTY = 1000000;
const MAX_HARGA = 1000000000;

/* ---------- Helper ---------- */
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const digits = (s) => String(s || "").replace(/\D/g, "");
const p2 = (n) => String(n).padStart(2, "0");

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

const ds = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const dt = parse(s); dt.setDate(dt.getDate() + n); return ds(dt); };
const todayStr = () => ds(new Date());
const endOfMonth = (y, m) => ds(new Date(y, m, 0));
const tglIndoShort = (s) => parse(s).toLocaleDateString("id-ID", { day: "numeric", month: "long" });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

// cost: [ { variable: { Gas: 20000, ... } }, { Fixed: { ... } } ]  ->  [ { name, items: [{ nama, harga }] } ]
function parseCost(arr) {
  const tabs = [];
  (Array.isArray(arr) ? arr : []).forEach((el) => {
    if (!el || typeof el !== "object" || Array.isArray(el)) return;
    Object.entries(el).forEach(([name, items]) => {
      if (!items || typeof items !== "object" || Array.isArray(items)) return;
      tabs.push({ name, items: Object.entries(items).map(([nama, h]) => ({ nama, harga: num(h) })) });
    });
  });
  return tabs;
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const now = new Date();
  const nowYM = { y: now.getFullYear(), m: now.getMonth() + 1 };
  const ymKey = (y, m) => `${y}-${p2(m)}`;

  const KEY_CFG = `pg:cfg:${idCabang}`;
  const KEY_MON = (y, m) => `pg:mon:${admin.uid}:${ymKey(y, m)}`;

  let alive = true;
  let cfgTabs = [];                 // dari kantorCabang.cost
  let cfgReady = false;
  const docs = new Map();           // tanggal -> { items, total, savedAtMs }
  const monthsLoaded = new Set();   // "YYYY-MM" yang sudah dimuat penuh dari server
  let ym = { ...nowYM };
  let monReady = false;

  // popup
  let sheetEl = null;
  let draft = null;                 // { tanggal, exists, savedAtMs, rows: { [tab]: [row] } }
  let activeTab = "";
  let rowSeq = 0;
  let pushTimer = 0;                // timer pushState yang ditunda
  let pushed = false;               // entri history untuk popup sudah dipasang?

  el.innerHTML = `
    <section class="v-pg">
      <button class="pg-open" id="pgOpen" type="button">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Input Pengeluaran
      </button>
      <div class="pg-filter">
        <button type="button" id="pgPrev" aria-label="Bulan sebelumnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span id="pgMonth"></span>
        <button type="button" id="pgNext" aria-label="Bulan berikutnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <div id="pgSummary"></div>
      <div id="pgTable"></div>
    </section>`;

  const $ = (s) => el.querySelector(s);
  const monthEl = $("#pgMonth"), prevBtn = $("#pgPrev"), nextBtn = $("#pgNext");
  const summaryEl = $("#pgSummary"), tableEl = $("#pgTable");

  /* ---------- Kunci edit ---------- */
  const minEditable = () => addDays(todayStr(), -BATAS_HARI);
  const isLocked = (d) => d < minEditable() || d > todayStr();

  /* ---------- Daftar tab ---------- */
  // tab konfigurasi + Marginal + tab lain yang ada di data lama (kalau konfigurasi berubah)
  function allTabNames() {
    const names = cfgTabs.map((t) => t.name).filter((n) => n !== MARGINAL);
    docs.forEach((d) => (d.items || []).forEach((i) => {
      if (i.tab !== MARGINAL && !names.includes(i.tab)) names.push(i.tab);
    }));
    names.push(MARGINAL);
    return names;
  }

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
  $("#pgOpen").addEventListener("click", () => openSheet(todayStr()));

  /* ===== List ===== */
  function skelTable() {
    summaryEl.innerHTML = `<div class="pg-cards">${Array.from({ length: 2 }, () => `<div class="pg-card"><span class="skel" style="height:11px;width:55%"></span><span class="skel" style="height:22px;width:70%"></span></div>`).join("")}</div>`;
    tableEl.innerHTML = `<div class="pg-tablewrap"><div class="pg-skel-rows">${Array.from({ length: 8 }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div></div>`;
  }

  const tabTotal = (d, tab) => (d?.items || []).reduce((s, i) => s + (i.tab === tab ? num(i.total) : 0), 0);

  function paintTable() {
    if (!monReady) { skelTable(); return; }

    const isNow = ym.y === nowYM.y && ym.m === nowYM.m;
    const end = isNow ? todayStr() : endOfMonth(ym.y, ym.m);
    const startM = `${ym.y}-${p2(ym.m)}-01`;
    const tabs = allTabNames();

    const colTot = Object.fromEntries(tabs.map((t) => [t, 0]));
    let grand = 0, hariTercatat = 0;
    let body = "";
    for (let d = end; d >= startM; d = addDays(d, -1)) {
      const dt = parse(d);
      const rec = docs.get(d);
      const lock = isLocked(d);
      const tgl = `<td class="pg-date${dt.getDay() === 0 ? " minggu" : ""}"><b>${dt.getDate()}</b><small>${HARI[dt.getDay()]}</small>${lock ? "" : ` <i class="pg-dot" title="Bisa diedit"></i>`}</td>`;
      if (!rec) {
        body += `<tr class="empty" data-d="${d}">${tgl}<td colspan="${tabs.length + 1}">${lock ? "–" : "belum diinput"}</td></tr>`;
        continue;
      }
      hariTercatat++;
      let cells = "";
      tabs.forEach((t) => {
        const v = tabTotal(rec, t);
        colTot[t] += v;
        cells += `<td>${v ? fmt(v) : "–"}</td>`;
      });
      const tot = num(rec.total);
      grand += tot;
      body += `<tr data-d="${d}">${tgl}${cells}<td><b>${fmt(tot)}</b></td></tr>`;
    }

    summaryEl.innerHTML = `
      <div class="pg-cards">
        <div class="pg-card strong"><span class="pg-l">Total bulan ini</span><span class="pg-v">Rp ${fmt(grand)}</span></div>
        <div class="pg-card"><span class="pg-l">Hari tercatat</span><span class="pg-v">${hariTercatat}</span></div>
      </div>`;

    tableEl.innerHTML = `
      <div class="pg-tablewrap">
        <table class="pg-table">
          <thead>
            <tr><th class="pg-date">Tanggal</th>${tabs.map((t) => `<th>${esc(t)}</th>`).join("")}<th>Total</th></tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td class="pg-date">Total</td>
              ${tabs.map((t) => `<td>${fmt(colTot[t])}</td>`).join("")}
              <td>${fmt(grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="pg-hint">Angka dalam Rupiah. Ketuk satu baris untuk melihat rincian atau mengisi. Hanya hari ini dan kemarin yang bisa diedit (ditandai titik biru); tanggal lebih lama terkunci.</p>`;

    tableEl.querySelectorAll("tr[data-d]").forEach((tr) => {
      tr.addEventListener("click", () => openSheet(tr.dataset.d));
    });
  }

  /* ===== Draft (isi popup) ===== */
  function newRow(p = {}) {
    return { id: ++rowSeq, nama: p.nama || "", harga: num(p.harga), qty: p.qty ? String(p.qty) : "", base: !!p.base };
  }

  function buildDraft(tanggal) {
    const rec = docs.get(tanggal);
    const saved = (rec?.items || []).map((i) => ({ ...i }));
    const rows = {};

    allTabNames().forEach((name) => {
      const mine = saved.filter((i) => i.tab === name);
      if (name === MARGINAL) {
        rows[name] = mine.length
          ? mine.map((i) => newRow({ nama: i.nama, harga: i.harga, qty: i.qty }))
          : [newRow()];
        return;
      }
      const cfg = cfgTabs.find((t) => t.name === name);
      const list = [];
      (cfg?.items || []).forEach((ci) => {
        const idx = mine.findIndex((i) => i.nama === ci.nama);
        if (idx >= 0) {
          const s = mine.splice(idx, 1)[0];
          list.push(newRow({ nama: s.nama, harga: s.harga, qty: s.qty, base: true }));
        } else {
          list.push(newRow({ nama: ci.nama, harga: ci.harga, base: true }));
        }
      });
      mine.forEach((s) => list.push(newRow({ nama: s.nama, harga: s.harga, qty: s.qty })));   // baris tambahan
      rows[name] = list;
    });

    draft = { tanggal, exists: !!rec, savedAtMs: rec?.savedAtMs || null, rows };
    if (!draft.rows[activeTab]) activeTab = allTabNames()[0];
  }

  const rowQty = (r) => num(digits(r.qty));
  const rowTotal = (r) => rowQty(r) * num(r.harga);
  const tabSum = (name) => (draft.rows[name] || []).reduce((s, r) => s + rowTotal(r), 0);
  const grandSum = () => Object.keys(draft.rows).reduce((s, n) => s + tabSum(n), 0);

  /* ===== Popup input ===== */
  function openSheet(tanggal) {
    if (sheetEl) return;
    if (!cfgReady || !monReady) { toast("Data masih dimuat, coba lagi sebentar.", "info"); return; }
    activeTab = "";
    buildDraft(tanggal);

    sheetEl = document.createElement("div");
    sheetEl.className = "pg-sheet-wrap";
    sheetEl.innerHTML = `
      <div class="pg-sheet-backdrop"></div>
      <div class="pg-sheet" role="dialog" aria-label="Input pengeluaran">
        <div class="pg-sheet-grip"></div>
        <div class="pg-sheet-head">
          <h3>Input Pengeluaran</h3>
          <button type="button" class="pg-x" id="pgClose" aria-label="Tutup">✕</button>
        </div>
        <div class="pg-sheet-top" id="pgTop"></div>
        <div class="pg-tabs" id="pgTabs"></div>
        <div class="pg-sheet-body" id="pgBody"></div>
        <div class="pg-sheet-foot" id="pgFoot"></div>
      </div>`;

    // isi dibangun saat sheet belum dipasang, jadi frame pertama animasi tidak tersendat
    sheetEl.querySelector(".pg-sheet-backdrop").addEventListener("click", () => closeSheet());
    sheetEl.querySelector("#pgClose").addEventListener("click", () => closeSheet());
    bindBody();
    paintTop(); paintTabs(); paintBody(); paintFoot();
    setupSwipe(sheetEl.querySelector(".pg-sheet"), sheetEl.querySelector(".pg-sheet-backdrop"));

    const node = sheetEl;
    document.body.appendChild(node);
    node.getBoundingClientRect();                         // pastikan posisi awal (di bawah layar) sudah terhitung
    requestAnimationFrame(() => { if (sheetEl === node) node.classList.add("show"); });

    // pekerjaan sampingan ditunda sampai animasi buka selesai (history & class di <html> bisa berat di WebView)
    pushTimer = setTimeout(() => {
      pushTimer = 0;
      if (sheetEl !== node) return;
      document.documentElement.classList.add("pg-sheet-open");
      history.pushState({ pg: 1 }, "");                   // tombol back Android menutup popup
      pushed = true;
    }, 320);
  }

  function closeSheet(fromPop) {
    if (!sheetEl) return;
    const node = sheetEl;
    sheetEl = null;
    draft = null;
    node.classList.remove("show");
    setTimeout(() => node.remove(), 240);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    document.documentElement.classList.remove("pg-sheet-open");
    if (pushed) {
      pushed = false;
      // kembalikan history setelah animasi tutup, supaya tidak mengganggu frame animasi
      if (!fromPop) setTimeout(() => { if (!sheetEl && history.state && history.state.pg) history.back(); }, 280);
    }
  }

  // Geser ke bawah untuk menutup.
  // Ringan: listener touchmove (non-passive) hanya dipasang saat gestur BERPOTENSI jadi geser (mulai dari area atas,
  // atau dari isi yang sedang di paling atas). Scroll biasa di isi daftar tetap jalan di thread compositor.
  // Gerakan ditulis lewat requestAnimationFrame, tinggi sheet dibaca sekali, tanpa baca-layout tiap event.
  function setupSwipe(sheet, backdrop) {
    const body = sheet.querySelector("#pgBody");
    let sy = 0, sx = 0, st = 0, dy = 0, h = 1, mode = 0, raf = 0, bound = false;   // mode: 0 belum ditentukan, 1 menggeser, 2 diabaikan

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
      if (body.contains(e.target) && body.scrollTop > 0) { mode = 2; return; }   // lagi scroll isi -> biarkan browser
      if (!bound) { sheet.addEventListener("touchmove", move, { passive: false }); bound = true; }
    }, { passive: true });
    sheet.addEventListener("touchend", end, { passive: true });
    sheet.addEventListener("touchcancel", end, { passive: true });
  }

  const sq = (s) => sheetEl && sheetEl.querySelector(s);
  const locked = () => !draft || isLocked(draft.tanggal);

  function paintTop() {
    const lock = locked();
    const badge = draft.exists
      ? `<div class="pg-badge saved">✓ Sudah disimpan${draft.savedAtMs ? " · " + new Date(draft.savedAtMs).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</div>`
      : `<div class="pg-badge new">Belum disimpan</div>`;
    sq("#pgTop").innerHTML = `
      <div class="pg-row">
        <label for="pgTanggal">Tanggal</label>
        <input type="date" id="pgTanggal" value="${draft.tanggal}" max="${todayStr()}">
      </div>
      ${badge}
      ${lock ? `<div class="pg-lock">🔒 Terkunci. Data berumur 2 hari atau lebih tidak bisa diinput atau diubah (yang bisa diedit: ${tglIndoShort(minEditable())} sampai hari ini).</div>` : ""}`;

    sq("#pgTanggal").addEventListener("change", async (e) => {
      const v = e.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      await ensureDay(v);
      if (!sheetEl) return;
      buildDraft(v);
      paintTop(); paintTabs(); paintBody(); paintFoot();
    });
  }

  function paintTabs() {
    const names = allTabNames();
    sq("#pgTabs").innerHTML = names.map((n) => {
      const s = tabSum(n);
      return `<button type="button" class="pg-tab${n === activeTab ? " on" : ""}" data-tab="${esc(n)}">${esc(n)}${s ? `<small>${fmt(s)}</small>` : ""}</button>`;
    }).join("");
    sq("#pgTabs").querySelectorAll(".pg-tab").forEach((b) => {
      b.addEventListener("click", () => {
        activeTab = b.dataset.tab;
        paintTabs(); paintBody();
      });
    });
  }

  // patokan harga dari kantorCabang (hanya untuk baris bawaan)
  function patokan(tab, nama) {
    const it = cfgTabs.find((t) => t.name === tab)?.items.find((i) => i.nama === nama);
    return it ? it.harga : 0;
  }

  function rowHtml(r, lock) {
    const dis = lock ? "disabled" : "";
    const rows = draft.rows[activeTab] || [];
    const canDel = !lock && !r.base && (activeTab !== MARGINAL || rows.length > 1);
    const del = canDel ? `<button type="button" class="pg-del" data-del="${r.id}" aria-label="Hapus baris">✕</button>` : "";
    let top;
    if (r.base) {
      const pk = patokan(activeTab, r.nama);
      top = `<div class="pg-item-name"><b>${esc(r.nama)}</b><small>${pk ? `Patokan Rp ${fmt(pk)}` : "Isi harga satuan"}</small></div>`;
    } else {
      top = `<input class="pg-nama" data-f="nama" type="text" maxlength="60" placeholder="Jenis biaya" autocomplete="off" value="${esc(r.nama)}" ${dis}>`;
    }
    return `
      <div class="pg-item" data-id="${r.id}">
        <div class="pg-item-top">${top}${del}</div>
        <div class="pg-item-calc">
          <input class="pg-qty" data-f="qty" type="text" inputmode="numeric" autocomplete="off" placeholder="Qty" value="${r.qty ? fmt(digits(r.qty)) : ""}" ${dis}>
          <span class="pg-times">×</span>
          <input class="pg-harga" data-f="harga" type="text" inputmode="numeric" autocomplete="off" placeholder="Harga satuan" value="${r.harga ? fmt(r.harga) : ""}" ${dis}>
          <span class="pg-eq">=</span>
          <b class="pg-item-total">${fmt(rowTotal(r))}</b>
        </div>
      </div>`;
  }

  function paintBody() {
    const lock = locked();
    const rows = draft.rows[activeTab] || [];
    let html = rows.map((r) => rowHtml(r, lock)).join("");
    if (!rows.length) html = `<div class="pg-empty">Belum ada item di tab ini. Ketuk + Tambah.</div>`;
    if (!lock) html += `<button type="button" class="pg-add" id="pgAdd">+ Tambah</button>`;
    sq("#pgBody").innerHTML = html;
  }

  function paintFoot() {
    const lock = locked();
    sq("#pgFoot").innerHTML = `
      <div class="pg-sum">
        <div><span class="pg-l">${esc(activeTab)}</span><b id="pgSumTab">Rp ${fmt(tabSum(activeTab))}</b></div>
        <div><span class="pg-l">Total</span><b id="pgSumAll" class="big">Rp ${fmt(grandSum())}</b></div>
      </div>
      ${lock ? "" : `<button class="pg-save" id="pgSave" type="button">${draft.exists ? "Perbarui" : "Simpan"}</button>`}`;
    const sv = sq("#pgSave");
    if (sv) sv.addEventListener("click", simpan);
  }

  function updateTotalsOnly() {
    const a = sq("#pgSumTab"), b = sq("#pgSumAll");
    if (a) a.textContent = `Rp ${fmt(tabSum(activeTab))}`;
    if (b) b.textContent = `Rp ${fmt(grandSum())}`;
    // angka kecil di tab
    sheetEl.querySelectorAll(".pg-tab").forEach((t) => {
      const s = tabSum(t.dataset.tab);
      let sm = t.querySelector("small");
      if (s) { if (!sm) { sm = document.createElement("small"); t.appendChild(sm); } sm.textContent = fmt(s); }
      else if (sm) sm.remove();
    });
  }

  function bindBody() {
    const body = sq("#pgBody");

    body.addEventListener("input", (e) => {
      const inp = e.target.closest("input[data-f]");
      if (!inp || locked()) return;
      const rowEl = inp.closest("[data-id]");
      const r = (draft.rows[activeTab] || []).find((x) => String(x.id) === rowEl.dataset.id);
      if (!r) return;
      const f = inp.dataset.f;
      if (f === "nama") {
        r.nama = inp.value;
        return;
      }
      const raw = digits(inp.value);
      if (f === "qty") {
        const v = Math.min(num(raw), MAX_QTY);
        r.qty = v ? String(v) : "";
        inp.value = v ? fmt(v) : "";
      } else if (f === "harga") {
        const v = Math.min(num(raw), MAX_HARGA);
        r.harga = v;
        inp.value = v ? fmt(v) : "";
      }
      rowEl.querySelector(".pg-item-total").textContent = fmt(rowTotal(r));
      updateTotalsOnly();
    });

    body.addEventListener("click", (e) => {
      if (locked()) return;
      const del = e.target.closest("[data-del]");
      if (del) {
        const id = del.dataset.del;
        draft.rows[activeTab] = draft.rows[activeTab].filter((x) => String(x.id) !== id);
        if (activeTab === MARGINAL && !draft.rows[MARGINAL].length) draft.rows[MARGINAL] = [newRow()];
        paintBody(); updateTotalsOnly();
        return;
      }
      if (e.target.closest("#pgAdd")) {
        const r = newRow();
        (draft.rows[activeTab] = draft.rows[activeTab] || []).push(r);
        paintBody();
        const inp = body.querySelector(`[data-id="${r.id}"] .pg-nama`);
        if (inp) { inp.focus(); inp.scrollIntoView({ block: "center", behavior: "smooth" }); }
      }
    });
  }

  /* ===== Simpan ===== */
  async function simpan() {
    if (!draft) return;
    if (isLocked(draft.tanggal)) { toast("Tanggal ini terkunci.", "error"); return; }

    const items = [];
    const errs = new Set();
    Object.entries(draft.rows).forEach(([tab, rows]) => {
      rows.forEach((r) => {
        const qty = rowQty(r);
        const harga = num(r.harga);
        const nama = r.nama.trim();
        if (r.base) {
          if (qty <= 0) return;                                       // item bawaan tanpa qty diabaikan
          if (harga <= 0) { errs.add(`${tab}: harga satuan ${nama} belum diisi.`); return; }
        } else {
          if (!nama && !qty && !harga) return;                        // baris kosong diabaikan
          if (!nama || qty <= 0 || harga <= 0) { errs.add(`${tab}: lengkapi jenis, qty, dan harga satuan, atau hapus barisnya.`); return; }
        }
        items.push({ tab, nama, qty, harga, total: qty * harga });
      });
    });
    if (!items.length && !errs.size) errs.add("Belum ada qty yang diisi.");
    if (items.length > 150) errs.add("Terlalu banyak baris (maksimal 150).");
    if (errs.size) {
      await alertBox({ title: "Data belum valid", text: [...errs].map((e) => "• " + e).join("\n"), type: "error" });
      return;
    }
    if (!idCabang) { toast("Akun belum punya idCabang.", "error"); return; }

    const total = items.reduce((s, i) => s + i.total, 0);
    const tanggal = draft.tanggal;
    const exists = draft.exists;
    const payload = { tanggal, items, total, adminUid: admin.uid, idCabang, updatedAt: serverTimestamp() };
    if (!exists) payload.createdAt = serverTimestamp();

    const btn = sq("#pgSave");
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;

    try {
      await setDoc(doc(db, "users", admin.uid, "cost", tanggal), payload, { merge: true });
      if (!alive) return;
      docs.set(tanggal, { items, total, savedAtMs: Date.now() });
      saveMonthCache(Number(tanggal.slice(0, 4)), Number(tanggal.slice(5, 7)));
      toast(exists ? "Pengeluaran diperbarui." : "Pengeluaran tersimpan.", "success");
      closeSheet();
      paintTable();
    } catch (err) {
      console.error(err);
      if (!alive || !sheetEl) return;
      btn.disabled = false;
      btn.textContent = label;
      toast(err?.code === "permission-denied"
        ? "Ditolak aturan Firestore (atau tanggal sudah terkunci)."
        : "Gagal menyimpan pengeluaran.", "error", 4500);
    }
  }

  /* ===== Ambil data ===== */
  const fromSnap = (x, id) => ({
    tanggal: x.tanggal || id,
    items: (Array.isArray(x.items) ? x.items : []).map((i) => ({
      tab: String(i.tab ?? ""), nama: String(i.nama ?? ""),
      qty: num(i.qty), harga: num(i.harga), total: num(i.total)
    })),
    total: num(x.total),
    savedAtMs: x.updatedAt?.toMillis ? x.updatedAt.toMillis() : null
  });

  function saveMonthCache(y, m) {
    const pre = ymKey(y, m);
    const obj = {};
    docs.forEach((v, k) => { if (k.startsWith(pre)) obj[k] = v; });
    cacheSet(KEY_MON(y, m), obj);
  }

  async function loadConfig() {
    if (!idCabang) return;
    try {
      const snap = await getDoc(doc(db, "kantorCabang", idCabang));
      if (!alive) return;
      const arr = snap.exists() ? snap.data().cost : [];
      cfgTabs = parseCost(arr);
      cfgReady = true;
      cacheSet(KEY_CFG, arr || []);
      paintTable();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      toast("Gagal memuat daftar biaya cabang.", "error");
    }
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
        collection(db, "users", admin.uid, "cost"),
        where("tanggal", ">=", `${key}-01`),
        where("tanggal", "<=", endOfMonth(y, m)),
        orderBy("tanggal", "asc")
      ));
      if (!alive) return;
      for (const k of [...docs.keys()]) if (k.startsWith(key)) docs.delete(k);
      snap.forEach((d) => docs.set(d.data().tanggal || d.id, fromSnap(d.data(), d.id)));
      monthsLoaded.add(key);
      saveMonthCache(y, m);
      if (ym.y === y && ym.m === m) { monReady = true; paintTable(); }
    } catch (err) {
      console.error(err);
      if (!alive) return;
      if (ym.y === y && ym.m === m && !monReady) {
        summaryEl.innerHTML = "";
        tableEl.innerHTML = `<div class="pg-empty">Gagal memuat data pengeluaran. Cek aturan Firestore dan koneksi.</div>`;
      }
      toast("Gagal memuat data pengeluaran.", "error");
    }
  }

  // pastikan data satu tanggal (di luar bulan yang tampil) sudah dibaca dari server
  async function ensureDay(tanggal) {
    const key = tanggal.slice(0, 7);
    if (monthsLoaded.has(key) || docs.has(tanggal)) return;
    try {
      const snap = await getDoc(doc(db, "users", admin.uid, "cost", tanggal));
      if (snap.exists()) docs.set(tanggal, fromSnap(snap.data(), snap.id));
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
  if (history.state && history.state.pg) history.replaceState(null, "");

  /* ===== Start ===== */
  if (!idCabang) {
    summaryEl.innerHTML = "";
    tableEl.innerHTML = `<div class="pg-empty">Akun admin belum punya idCabang, jadi daftar biaya cabang tidak bisa dimuat.</div>`;
    $("#pgOpen").disabled = true;
  } else {
    const cachedCfg = cacheGet(KEY_CFG);
    if (cachedCfg) { cfgTabs = parseCost(cachedCfg); cfgReady = true; }
    paintMonth();
    loadMonth();
    loadConfig();
  }

  return () => {
    alive = false;
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("keydown", onKey);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
    document.documentElement.classList.remove("pg-sheet-open");
  };
}
