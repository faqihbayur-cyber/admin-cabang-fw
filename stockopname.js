// stockopname.js — stok galon per tanggal (input galon & pengadukan, closing dari laporan, saldo beruntun)
// Simpan : users/{adminUid}/stockopname/{tanggal}
// Closing: dijumlah dari users/{adminUid}/laporanAdmin/{tanggal} (semua field uid -> closing)
// Saldo  : TIDAK disimpan, dihitung beruntun tiap halaman dibuka:
//          saldo = saldo kemarin + input - pengadukan - closing   (mulai dari 0 di tanggal input pertama)
import {
  collection, query, where, orderBy, getDocs, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, alertBox } from "./ui.js";

export const css = new URL("./stockopname.css", import.meta.url).href;

const BATAS_HARI = 1;   // hanya hari ini & kemarin yang bisa diedit; umur 2 hari ke atas terkunci (harus sama dengan rules)

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

function tglIndo(s) {
  return parse(s).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const now = new Date();
  const nowYM = { y: now.getFullYear(), m: now.getMonth() + 1 };

  const KEY_DOCS = `so:docs:${admin.uid}`;
  const KEY_CLOS = `so:clos:${admin.uid}`;

  let alive = true;
  let docs = new Map();          // tanggal -> { galon, pengadukan, savedAtMs }
  let closings = new Map();      // tanggal -> total closing semua kurir/sales
  let closUpto = "";             // closing sudah dimuat sampai tanggal ini
  let ym = { ...nowYM };
  let formDate = todayStr();
  let dirty = false;
  let docsReady = false;

  el.innerHTML = `
    <section class="v-so">
      <div class="so-form" id="soForm"></div>
      <div class="so-filter">
        <button type="button" id="soPrev" aria-label="Bulan sebelumnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span id="soMonth"></span>
        <button type="button" id="soNext" aria-label="Bulan berikutnya">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <div id="soSummary"></div>
      <div id="soTable"></div>
    </section>`;

  const $ = (s) => el.querySelector(s);
  const formEl = $("#soForm"), monthEl = $("#soMonth");
  const prevBtn = $("#soPrev"), nextBtn = $("#soNext");
  const summaryEl = $("#soSummary"), tableEl = $("#soTable");

  /* ---------- Cache ---------- */
  function loadCache() {
    const d = cacheGet(KEY_DOCS);
    if (d) { docs = new Map(Object.entries(d)); docsReady = true; }
    const c = cacheGet(KEY_CLOS);
    if (c) { closings = new Map(Object.entries(c.map || {})); closUpto = c.upto || ""; }
  }
  const saveDocsCache = () => cacheSet(KEY_DOCS, Object.fromEntries(docs));
  const saveClosCache = () => cacheSet(KEY_CLOS, { map: Object.fromEntries(closings), upto: closUpto });

  /* ---------- Hitungan beruntun ---------- */
  const firstDate = () => {
    let f = "";
    for (const k of docs.keys()) if (!f || k < f) f = k;
    return f;
  };

  // saldo tiap tanggal dari tanggal pertama sampai `end`
  function chain(end) {
    const first = firstDate();
    const out = new Map();
    if (!first || end < first) return out;
    let saldo = 0;
    for (let d = first, guard = 0; d <= end && guard < 4000; d = addDays(d, 1), guard++) {
      const s = docs.get(d);
      const inp = num(s?.galon), adk = num(s?.pengadukan);
      const clos = num(closings.get(d));
      saldo = saldo + inp - adk - clos;
      out.set(d, { inp, adk, clos, saldo, hasDoc: !!s });
    }
    return out;
  }

  /* ---------- Kunci edit ---------- */
  const minEditable = () => addDays(todayStr(), -BATAS_HARI);
  const isLocked = (d) => d < minEditable() || d > todayStr();

  /* ===== Form ===== */
  function paintForm() {
    const s = docs.get(formDate);
    const locked = isLocked(formDate);

    const val = (v) => (v ? fmt(v) : "");
    formEl.innerHTML = `
      <h3>Input Stok</h3>
      <div class="so-row">
        <label for="soTanggal">Tanggal</label>
        <input type="date" id="soTanggal" value="${formDate}" max="${todayStr()}">
      </div>

      <div id="soBadge" class="so-badge ${!docsReady ? "skel" : s ? "saved" : "new"}">${
        !docsReady ? "" : s ? "✓ Sudah pernah disimpan" + (s.savedAtMs ? " · " + new Date(s.savedAtMs).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "") : "Belum disimpan"
      }</div>

      ${locked ? `<div class="so-lock">🔒 Terkunci. Data berumur 2 hari atau lebih tidak bisa diinput atau diubah (yang bisa diedit: ${tglIndoShort(minEditable())} sampai hari ini).</div>` : ""}

      <div class="so-fields">
        <div>
          <label for="soGalon">Galon</label>
          <input id="soGalon" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${val(num(s?.galon))}" ${locked ? "disabled" : ""}>
        </div>
        <div>
          <label for="soAdk">Pengadukan</label>
          <input id="soAdk" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${val(num(s?.pengadukan))}" ${locked ? "disabled" : ""}>
        </div>
      </div>

      <button class="so-save" id="soSave" type="button" ${locked || !docsReady ? "disabled" : ""}>${s ? "Perbarui" : "Simpan"}</button>
    `;

    $("#soTanggal").addEventListener("change", (e) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) return;
      formDate = e.target.value;
      dirty = false;
      paintForm();
    });

    ["#soGalon", "#soAdk"].forEach((id) => {
      const inp = $(id);
      if (!inp) return;
      inp.addEventListener("input", () => {
        dirty = true;
        const raw = digits(inp.value);
        inp.value = raw ? fmt(raw) : "";
      });
    });
    $("#soSave").addEventListener("click", simpan);
  }

  const tglIndoShort = (s) => parse(s).toLocaleDateString("id-ID", { day: "numeric", month: "long" });

  /* ===== Simpan ===== */
  async function simpan() {
    if (isLocked(formDate)) { toast("Tanggal ini terkunci.", "error"); return; }
    const galon = num(digits($("#soGalon").value));
    const adk = num(digits($("#soAdk").value));

    const errs = [];
    if (galon > 1000000 || adk > 1000000) errs.push("Angka terlalu besar, periksa kembali.");
    if (errs.length) {
      await alertBox({ title: "Data belum valid", text: errs.map((e) => "• " + e).join("\n"), type: "error" });
      return;
    }

    const exists = docs.has(formDate);
    const payload = {
      tanggal: formDate, galon, pengadukan: adk,
      adminUid: admin.uid, idCabang,
      updatedAt: serverTimestamp()
    };
    if (!exists) payload.createdAt = serverTimestamp();

    const btn = $("#soSave");
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;

    try {
      await setDoc(doc(db, "users", admin.uid, "stockopname", formDate), payload, { merge: true });
      if (!alive) return;

      docs.set(formDate, { galon, pengadukan: adk, savedAtMs: Date.now() });
      saveDocsCache();
      dirty = false;
      toast(exists ? "Stok diperbarui." : "Stok tersimpan.", "success");
      paintForm();
      paintTable();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      btn.disabled = false;
      btn.textContent = label;
      toast(err?.code === "permission-denied"
        ? "Ditolak aturan Firestore (atau tanggal sudah terkunci)."
        : "Gagal menyimpan stok.", "error", 4500);
    }
  }

  /* ===== Filter bulan ===== */
  function paintMonth() {
    monthEl.textContent = `${BULAN[ym.m - 1]} ${ym.y}`;
    nextBtn.disabled = ym.y === nowYM.y && ym.m === nowYM.m;
  }
  prevBtn.addEventListener("click", () => {
    ym = ym.m === 1 ? { y: ym.y - 1, m: 12 } : { y: ym.y, m: ym.m - 1 };
    paintMonth(); paintTable(); loadClosings();
  });
  nextBtn.addEventListener("click", () => {
    if (nextBtn.disabled) return;
    ym = ym.m === 12 ? { y: ym.y + 1, m: 1 } : { y: ym.y, m: ym.m + 1 };
    paintMonth(); paintTable(); loadClosings();
  });

  /* ===== Tabel ===== */
  function skelTable() {
    summaryEl.innerHTML = `<div class="so-cards">${Array.from({ length: 2 }, () => `<div class="so-card"><span class="skel" style="height:11px;width:55%"></span><span class="skel" style="height:22px;width:70%"></span></div>`).join("")}</div>`;
    tableEl.innerHTML = `<div class="so-tablewrap"><div class="so-skel-rows">${Array.from({ length: 8 }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div></div>`;
  }

  function paintTable() {
    if (!docsReady) { skelTable(); return; }

    const first = firstDate();
    if (!first) {
      summaryEl.innerHTML = "";
      tableEl.innerHTML = `<div class="so-empty">Belum ada data stok. Isi form di atas untuk mulai mencatat.</div>`;
      return;
    }

    const lastDay = endOfMonth(ym.y, ym.m);
    const isNow = ym.y === nowYM.y && ym.m === nowYM.m;
    const end = isNow ? todayStr() : lastDay;
    const startM = `${ym.y}-${p2(ym.m)}-01`;
    const closReady = closUpto >= end;           // closing sudah lengkap sampai akhir bulan ini?
    const map = chain(end);

    let tI = 0, tA = 0, tC = 0, lastSaldo = null;
    let body = "";
    for (let d = end; d >= startM; d = addDays(d, -1)) {
      const dt = parse(d);
      const tgl = `<td class="so-date${dt.getDay() === 0 ? " minggu" : ""}"><b>${dt.getDate()}</b><small>${HARI[dt.getDay()]}</small></td>`;
      const r = map.get(d);
      if (!r) {                                     // sebelum tanggal pertama pencatatan
        body += `<tr class="empty">${tgl}<td colspan="4">Belum ada pencatatan</td></tr>`;
        continue;
      }
      tI += r.inp; tA += r.adk; tC += r.clos;
      if (lastSaldo === null) lastSaldo = r.saldo;  // iterasi dari terbaru -> yang pertama = terakhir
      const inpCell = r.hasDoc ? fmt(r.inp) : `<span class="so-miss">belum diinput</span>`;
      const adkCell = r.hasDoc ? (r.adk ? fmt(r.adk) : "–") : "–";
      const closCell = closReady ? (r.clos ? fmt(r.clos) : "–") : `<span class="skel so-cellskel"></span>`;
      const saldoCell = closReady ? `<b class="${r.saldo < 0 ? "neg" : ""}">${r.saldo < 0 ? "-" : ""}${fmt(Math.abs(r.saldo))}</b>` : `<span class="skel so-cellskel"></span>`;
      body += `<tr class="${r.hasDoc ? "" : "nodoc"}">${tgl}<td>${inpCell}</td><td>${adkCell}</td><td>${closCell}</td><td>${saldoCell}</td></tr>`;
    }

    // saldo awal bulan = saldo hari terakhir bulan sebelumnya
    const prevEnd = addDays(startM, -1);
    const saldoAwalBulan = first <= prevEnd ? chain(prevEnd).get(prevEnd)?.saldo ?? 0 : 0;
    const sv = (v) => `${v < 0 ? "-" : ""}${fmt(Math.abs(v))}`;

    summaryEl.innerHTML = `
      <div class="so-cards">
        <div class="so-card"><span class="so-l">Saldo awal bulan</span>${closReady ? `<span class="so-v ${saldoAwalBulan < 0 ? "neg" : ""}">${sv(saldoAwalBulan)}</span>` : `<span class="skel" style="height:22px;width:60%"></span>`}</div>
        <div class="so-card strong"><span class="so-l">Saldo akhir</span>${closReady ? `<span class="so-v ${(lastSaldo ?? 0) < 0 ? "neg" : ""}">${sv(lastSaldo ?? saldoAwalBulan)}</span>` : `<span class="skel" style="height:22px;width:60%"></span>`}</div>
      </div>`;

    tableEl.innerHTML = `
      <div class="so-tablewrap">
        <table class="so-table">
          <thead>
            <tr><th class="so-date">Tanggal</th><th>Input</th><th>Pengadukan</th><th>Closing</th><th>Saldo</th></tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td class="so-date">Total</td>
              <td>${fmt(tI)}</td><td>${fmt(tA)}</td>
              <td>${closReady ? fmt(tC) : `<span class="skel so-cellskel"></span>`}</td>
              <td title="Saldo terakhir, bukan jumlah">${closReady ? sv(lastSaldo ?? saldoAwalBulan) : `<span class="skel so-cellskel"></span>`}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="so-hint">Saldo = saldo kemarin + input − pengadukan − closing, berantai lintas bulan. Closing = jumlah closing semua kurir &amp; sales dari laporan yang sudah disimpan. Saldo di baris Total adalah saldo terakhir, bukan jumlah.</p>`;
  }

  /* ===== Ambil data ===== */
  async function loadDocs() {
    try {
      const snap = await getDocs(query(collection(db, "users", admin.uid, "stockopname"), orderBy("tanggal", "asc")));
      if (!alive) return;
      const fresh = new Map();
      snap.forEach((d) => {
        const x = d.data();
        fresh.set(x.tanggal || d.id, {
          galon: num(x.galon), pengadukan: num(x.pengadukan),
          savedAtMs: x.updatedAt?.toMillis ? x.updatedAt.toMillis() : null
        });
      });
      const changed = JSON.stringify([...fresh]) !== JSON.stringify([...docs]);
      const wasReady = docsReady;
      docs = fresh; docsReady = true;
      saveDocsCache();
      if (changed || !wasReady) { if (!dirty) paintForm(); paintTable(); }
      loadClosings();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      if (!docsReady) {
        summaryEl.innerHTML = "";
        tableEl.innerHTML = `<div class="so-empty">Gagal memuat data stok. Cek aturan Firestore dan koneksi.</div>`;
      }
      toast("Gagal memuat data stok.", "error");
    }
  }

  async function loadClosings() {
    const first = firstDate();
    if (!first) return;
    const end = ym.y === nowYM.y && ym.m === nowYM.m ? todayStr() : endOfMonth(ym.y, ym.m);
    try {
      const snap = await getDocs(query(
        collection(db, "users", admin.uid, "laporanAdmin"),
        where("tanggal", ">=", first),
        where("tanggal", "<=", end)
      ));
      if (!alive) return;
      const fresh = new Map();
      snap.forEach((d) => {
        const x = d.data();
        let total = 0;
        Object.values(x).forEach((v) => {
          if (v && typeof v === "object" && !Array.isArray(v) && "closing" in v && !v.toMillis) total += num(v.closing);
        });
        fresh.set(x.tanggal || d.id, total);
      });
      // ganti seluruh rentang first..end, pertahankan tanggal setelah `end` dari cache
      for (const k of [...closings.keys()]) if (k >= first && k <= end) closings.delete(k);
      fresh.forEach((v, k) => closings.set(k, v));
      if (end > closUpto) closUpto = end;
      saveClosCache();
      paintTable();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      toast("Gagal memuat closing dari laporan.", "error");
    }
  }

  /* ===== Start ===== */
  loadCache();
  paintMonth();
  paintForm();
  paintTable();
  loadDocs();

  return () => { alive = false; };
}
