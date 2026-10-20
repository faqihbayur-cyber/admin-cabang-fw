// customer.js — view Customer: list (10 per halaman, scroll otomatis), filter, KPI, edit, peta Leaflet
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getCountFromServer, doc, updateDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, confirmBox } from "./ui.js";
import { esc, fmt, rp, num, kb, createIdb, kompresFoto, MAX_FOTO } from "./lib.js";

export const css = new URL("./customer.css", import.meta.url).href;

/* ---------- Konstanta ---------- */
const PAGE = 10;
const ROLES = ["kurir", "sales"];
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const idb = createIdb("fw-customer");

const digits = (s) => String(s || "").replace(/\D/g, "");
const hasLoc = (c) => Number.isFinite(c.lat) && Number.isFinite(c.lng);
const namaUser = (u) => u.nama || u.email || u.id;

function tglIndo(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

/* ---------- Normalisasi dokumen customers ---------- */
function norm(d) {
  const x = d.data();
  const lp = x.lokasiPelanggan;
  return {
    id: d.id,
    nama: x.namaPelanggan || "",
    telp: x.noTelepon || "",
    alamat: x.alamat || "",
    foto: x.fotoPelanggan || "",
    harga: num(x.harga),
    hutang: num(x.hutang),
    saldo: num(x.saldo),
    galon: num(x.jumlahGalon),
    status: x.status !== false,
    pemilik: x.pemilik || "",
    lat: lp && typeof lp.lat === "number" ? lp.lat : null,
    lng: lp && typeof lp.lng === "number" ? lp.lng : null,
    createdAtMs: x.createdAt?.toMillis ? x.createdAt.toMillis() : 0
  };
}

/* ---------- Leaflet (dimuat hanya saat peta dibuka) ---------- */
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((res, rej) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = LEAFLET_CSS;
    document.head.appendChild(l);
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.onload = () => res(window.L);
    s.onerror = () => { leafletPromise = null; rej(new Error("leaflet")); };
    document.head.appendChild(s);
  });
  return leafletPromise;
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";

  let alive = true;
  let users = [];                 // dropdown kurir/sales (langsung dari Firestore)
  const userMap = new Map();
  let owner = "all";              // uid pemilik | all
  let saldoF = "all";             // all | saldo | hutang
  let hargaVal = 0;               // 0 = tidak difilter
  let items = [];
  let lastDoc = null;
  let hasMore = false;
  let loading = false;
  let total = null;
  let token = 0;
  let hargaTimer = 0;
  let io = null;

  const layers = [];              // sheet / peta yang sedang terbuka (back Android menutup yang paling atas)
  let sheetBusy = false;
  let map = null;
  let mini = null;
  let selectMode = false;
  const selected = new Set();     // id customer yang dicentang
  let actionBusy = false;
  let modalCancel = null;         // penutup modal konfirmasi yang sedang terbuka (untuk tombol back)                // ringkasan customer di atas peta

  el.innerHTML = `
    <section class="v-cu">
      <div class="cu-bar">
        <button class="cu-select" type="button" id="cuOwner" aria-label="Pilih kurir atau sales">
          <span class="cu-select-label" id="cuOwnerLabel">Semua kurir &amp; sales</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="cu-mapall" type="button" id="cuMapAll">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
          <span>Peta</span>
        </button>
      </div>
      <div class="cu-chips" id="cuSaldo">
        <button type="button" class="cu-chip on" data-f="all">Semua</button>
        <button type="button" class="cu-chip" data-f="saldo">Ada saldo</button>
        <button type="button" class="cu-chip" data-f="hutang">Ada hutang</button>
      </div>
      <div class="cu-harga">
        <input id="cuHarga" type="text" inputmode="numeric" autocomplete="off" placeholder="Cari harga (mis. 6500)">
        <button class="cu-x cu-hidden" type="button" id="cuHargaX" aria-label="Hapus filter harga">✕</button>
      </div>
      <div class="cu-kpi" id="cuKpi"></div>
      <div id="cuList"></div>
    </section>`;

  const $ = (id) => el.querySelector(id);
  const listEl = $("#cuList");
  const kpiEl = $("#cuKpi");

  /* ===== Query ===== */
  const conds = () => {
    const c = [where("idCabang", "==", idCabang)];
    if (owner !== "all") c.push(where("pemilik", "==", owner));
    if (hargaVal > 0) c.push(where("harga", "==", hargaVal));
    if (saldoF === "saldo") c.push(where("saldo", ">", 0));
    if (saldoF === "hutang") c.push(where("hutang", ">", 0));
    return c;
  };
  // filter range wajib jadi orderBy pertama
  const urut = () => saldoF === "saldo" ? ["saldo", "desc"] : saldoF === "hutang" ? ["hutang", "desc"] : ["namaPelanggan", "asc"];
  const cacheKey = () => `cu:${idCabang}:${owner}|${saldoF}|${hargaVal}`;

  async function fetchPage(after) {
    const [f, dir] = urut();
    const q = query(
      collection(db, "customers"), ...conds(), orderBy(f, dir),
      ...(after ? [startAfter(after)] : []), limit(PAGE)
    );
    const snap = await getDocs(q);
    return {
      rows: snap.docs.map(norm),
      last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      full: snap.docs.length === PAGE
    };
  }

  async function fetchCount() {
    const snap = await getCountFromServer(query(collection(db, "customers"), ...conds()));
    return snap.data().count;
  }

  const saveCache = () => idb.set(cacheKey(), {
    items: items.slice(0, PAGE).map((c) => ({ ...c, foto: "" })),   // foto tidak ikut cache (berat)
    total
  });

  /* ===== KPI ===== */
  function paintKpi() {
    kpiEl.innerHTML = `
      <div class="cu-kpi-card">
        <span class="cu-kpi-num${total === null ? " skel" : ""}">${total === null ? "" : fmt(total)}</span>
        <span class="cu-kpi-lbl">customer</span>
      </div>
      <div class="cu-kpi-note">${items.length ? `${fmt(items.length)} dimuat` : ""}</div>`;
  }

  /* ===== List ===== */
  const avatar = (c, big) => c.foto
    ? `<img class="cu-avatar${big ? " big" : ""}" src="${esc(c.foto)}" alt="">`
    : `<span class="cu-avatar${big ? " big" : ""}">${esc((c.nama.trim().charAt(0) || "?").toUpperCase())}</span>`;

  function cardHtml(c) {
    const pm = userMap.get(c.pemilik);
    return `
      <div class="cu-item${c.status ? "" : " off"}${selected.has(c.id) ? " sel" : ""}" data-id="${esc(c.id)}">
        <span class="cu-check" aria-hidden="true">✓</span>
        <button class="cu-item-main" type="button" data-act="open">
          ${avatar(c)}
          <span class="cu-item-text">
            <span class="cu-item-name">${esc(c.nama || "(tanpa nama)")}</span>
            <span class="cu-item-sub">${esc(c.telp || "-")} · ${rp(c.harga)}</span>
            <span class="cu-tags">
              ${c.hutang > 0 ? `<span class="cu-tag hutang">Hutang ${rp(c.hutang)}</span>` : ""}
              ${c.saldo > 0 ? `<span class="cu-tag saldo">Saldo ${rp(c.saldo)}</span>` : ""}
              ${c.status ? "" : `<span class="cu-tag off">Nonaktif</span>`}
              <span class="cu-tag owner">${esc(pm ? namaUser(pm) : "-")}</span>
            </span>
          </span>
        </button>
        <button class="cu-wabtn" type="button" data-act="wa" aria-label="Chat WhatsApp">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.7-5.5A8.4 8.4 0 1 1 21 11.5z"/><path d="M9 8.5c0 3.3 2.7 6 6 6l1.2-1.4-2-1-.9.8a4 4 0 0 1-1.7-1.7l.8-.9-1-2z"/></svg>
        </button>
        <button class="cu-pinbtn" type="button" data-act="map" aria-label="Lihat di peta">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
        </button>
      </div>`;
  }

  const footHtml = () => loading
    ? `<div class="cu-foot"><span class="spinner dark"></span></div>`
    : hasMore
      ? `<div class="cu-foot" id="cuSentinel"><span class="spinner dark"></span></div>`
      : items.length ? `<div class="cu-foot end">Semua customer sudah dimuat</div>` : "";

  function skeleton() {
    listEl.innerHTML = `<div class="cu-list">${Array.from({ length: 5 }, () => `
      <div class="cu-item skel-row">
        <span class="cu-avatar skel"></span>
        <span class="cu-item-text">
          <span class="skel cu-skel-name"></span>
          <span class="skel cu-skel-sub"></span>
        </span>
      </div>`).join("")}</div>`;
  }

  function observe() {
    if (io) io.disconnect();
    const s = listEl.querySelector("#cuSentinel");
    if (s && io) io.observe(s);    // observe ulang -> callback jalan lagi kalau sentinel masih kelihatan
  }

  function paintList() {
    if (!alive) return;
    if (!items.length) {
      listEl.innerHTML = `<div class="cu-empty">Tidak ada customer yang cocok dengan filter ini.</div>`;
      return;
    }
    listEl.innerHTML = `<div class="cu-list" id="cuRows">${items.map(cardHtml).join("")}</div><div id="cuFootWrap">${footHtml()}</div>`;
    observe();
  }

  function appendRows(rows) {
    const rowsEl = listEl.querySelector("#cuRows");
    if (!rowsEl) { paintList(); return; }
    rowsEl.insertAdjacentHTML("beforeend", rows.map(cardHtml).join(""));
    paintFoot();
  }

  function paintFoot() {
    const w = listEl.querySelector("#cuFootWrap");
    if (w) w.innerHTML = footHtml();
    observe();
  }

  function errorState(err) {
    console.error(err);
    if (!alive) return;
    const idx = err?.code === "failed-precondition";
    listEl.innerHTML = `<div class="cu-empty">${idx
      ? "Index Firestore untuk filter ini belum dibuat. Deploy firestore.indexes.json atau buka link di console browser."
      : "Gagal memuat customer. Cek aturan Firestore & koneksi."}</div>`;
    toast(idx ? "Index Firestore belum dibuat." : "Gagal memuat customer.", "error", 4500);
  }

  async function reload() {
    const my = ++token;
    loading = false; hasMore = false; lastDoc = null; items = []; total = null;
    paintKpi();

    if (!idCabang) {
      listEl.innerHTML = `<div class="cu-empty">Akun ini belum punya idCabang.</div>`;
      return;
    }

    const cached = await idb.get(cacheKey());
    if (!alive || my !== token) return;
    if (cached?.items?.length) {
      items = cached.items; total = cached.total ?? null;
      paintKpi(); paintList();
    } else {
      skeleton();
    }

    try {
      const [page, cnt] = await Promise.all([fetchPage(null), fetchCount()]);
      if (!alive || my !== token) return;
      items = page.rows; lastDoc = page.last; hasMore = page.full; total = cnt;
      saveCache();
      paintKpi(); paintList();
    } catch (err) {
      if (!alive || my !== token) return;
      if (cached?.items?.length) { toast("Gagal menyegarkan data.", "error"); return; }
      errorState(err);
    }
  }

  async function loadMore() {
    if (loading || !hasMore || !alive) return;
    const my = token;
    loading = true;
    paintFoot();
    try {
      const page = await fetchPage(lastDoc);
      if (!alive || my !== token) return;
      loading = false;
      items = items.concat(page.rows);
      lastDoc = page.last || lastDoc;
      hasMore = page.full;
      appendRows(page.rows);
      paintKpi();
    } catch (err) {
      console.error(err);
      if (!alive || my !== token) return;
      loading = false; hasMore = false;
      paintFoot();
      toast("Gagal memuat lanjutan.", "error");
    }
  }

  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: "300px" });

  /* ===== Layer (sheet & peta) — back Android menutup yang paling atas ===== */
  function pushLayer(layer) {
    layers.push(layer);
    document.documentElement.classList.add("cu-lock");   // cegah pull-to-refresh selama sheet/peta terbuka
    history.pushState({ cu: layers.length }, "");
  }
  function popLayer() {
    const l = layers.pop();
    if (!l) return;
    if (l.destroy) l.destroy();
    l.el.classList.remove("show");
    if (l.type === "map") { l.el.remove(); } else { setTimeout(() => l.el.remove(), 240); }
    if (!layers.length) document.documentElement.classList.remove("cu-lock");
  }

  // Geser ke bawah untuk menutup (sheet & ringkasan). touchmove non-passive di-preventDefault
  // saat menggeser, jadi pull-to-refresh browser tidak ikut jalan.
  function enableSwipe(panel, wrap, scroller) {
    let sy = 0, sx = 0, dy = 0, h = 1, t0 = 0, mode = 0, raf = 0;   // mode: 0 belum ditentukan, 1 menggeser, 2 diabaikan
    const paint = () => {
      raf = 0;
      panel.style.setProperty("--dy", `${dy}px`);
      wrap.style.setProperty("--bo", String(Math.max(0, 1 - dy / h)));
    };
    const move = (e) => {
      if (mode === 2) return;
      const t = e.touches[0];
      const ddy = t.clientY - sy, ddx = t.clientX - sx;
      if (mode === 0) {
        if (Math.abs(ddy) < 6 && Math.abs(ddx) < 6) return;
        if (ddy > 0 && Math.abs(ddy) > Math.abs(ddx) && (!scroller || scroller.scrollTop <= 0)) {
          mode = 1;
          panel.classList.add("drag");
        } else { mode = 2; return; }
      }
      e.preventDefault();
      dy = Math.max(0, ddy);
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const end = () => {
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", end);
      if (mode !== 1) return;
      panel.classList.remove("drag");
      const speed = dy / Math.max(1, Date.now() - t0);
      if (dy > h * 0.25 || speed > 0.6) closeTop();
      else { dy = 0; paint(); }
    };
    panel.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || e.target.closest("input, textarea, select")) return;
      sy = e.touches[0].clientY; sx = e.touches[0].clientX;
      dy = 0; mode = 0; t0 = Date.now(); h = panel.offsetHeight || 1;
      panel.addEventListener("touchmove", move, { passive: false });
      panel.addEventListener("touchend", end);
      panel.addEventListener("touchcancel", end);
    }, { passive: true });
  }

  function makeSheet(label) {
    const wrap = document.createElement("div");
    wrap.className = "cu-sheet-wrap";
    wrap.innerHTML = `
      <div class="cu-sheet-backdrop"></div>
      <div class="cu-sheet" role="dialog" aria-label="${esc(label)}">
        <div class="cu-sheet-grip"></div>
        <div class="cu-sheet-body"></div>
      </div>`;
    wrap.querySelector(".cu-sheet-backdrop").addEventListener("click", closeTop);
    document.body.appendChild(wrap);
    wrap.getBoundingClientRect();
    requestAnimationFrame(() => wrap.classList.add("show"));
    pushLayer({ type: "sheet", el: wrap });
    const sheet = wrap.querySelector(".cu-sheet");
    const body = wrap.querySelector(".cu-sheet-body");
    enableSwipe(sheet, wrap, body);
    return { wrap, sheet, body };
  }
  const closeTop = () => { if (layers.length) history.back(); };
  const onPop = () => {
    if (!alive) return;
    if (modalCancel) {                       // back saat modal konfirmasi terbuka: tutup modal saja
      modalCancel();
      history.pushState({ cu: layers.length }, "");
      return;
    }
    popLayer();
  };
  window.addEventListener("popstate", onPop);
  if (history.state && history.state.cu) history.replaceState(null, "");

  /* ===== Sheet edit ===== */
  function openSheet(c) {
    const { body } = makeSheet("Edit customer");
    buildForm(body, c);
  }

  function buildForm(b, c) {
    let foto = c.foto || "";
    const pm = userMap.get(c.pemilik);

    b.innerHTML = `
      <div class="cu-f-title">Edit Customer</div>

      <div class="cu-photo">
        <div id="cuPhotoPrev"></div>
        <div class="cu-photo-side">
          <button class="cu-btn small" type="button" id="cuPick">Pilih dari galeri</button>
          <button class="cu-link" type="button" id="cuPhotoDel">Hapus foto</button>
          <small id="cuPhotoInfo"></small>
        </div>
        <input type="file" id="cuFile" accept="image/*" class="cu-hidden">
      </div>

      <div class="cu-field"><label for="cuNama">Nama pelanggan</label>
        <input id="cuNama" type="text" maxlength="100" autocomplete="off" value="${esc(c.nama)}"></div>
      <div class="cu-field"><label for="cuTelp">No. telepon</label>
        <input id="cuTelp" type="text" inputmode="tel" maxlength="20" autocomplete="off" value="${esc(c.telp)}"></div>
      <div class="cu-field"><label for="cuAlamat">Alamat</label>
        <textarea id="cuAlamat" rows="3" maxlength="300">${esc(c.alamat)}</textarea></div>

      <div class="cu-grid">
        <div class="cu-field"><label for="cuHargaF">Harga (Rp)</label>
          <input id="cuHargaF" type="text" inputmode="numeric" value="${c.harga}"></div>
        <div class="cu-field"><label for="cuGalon">Jumlah galon</label>
          <input id="cuGalon" type="text" inputmode="numeric" value="${c.galon}"></div>
        <div class="cu-field"><label for="cuSaldo">Saldo (Rp)</label>
          <input id="cuSaldo" type="text" inputmode="numeric" value="${c.saldo}"></div>
        <div class="cu-field"><label for="cuHutang">Hutang (Rp)</label>
          <input id="cuHutang" type="text" inputmode="numeric" value="${c.hutang}"></div>
      </div>

      <label class="cu-switch"><input type="checkbox" id="cuStatus"${c.status ? " checked" : ""}><span>Customer aktif</span></label>

      <div class="cu-rows">
        <div class="cu-row"><span>Lokasi (tidak bisa diubah)</span>
          <b>${hasLoc(c) ? `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}` : "Belum ada lokasi"}</b>
          ${hasLoc(c) ? `<a class="cu-ext" href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener">Buka di Google Maps</a>` : ""}
        </div>
        <div class="cu-row"><span>Pemilik</span><b>${esc(pm ? `${namaUser(pm)} (${pm.role})` : "-")}</b></div>
        <div class="cu-row"><span>Dibuat</span><b>${esc(tglIndo(c.createdAtMs))}</b></div>
      </div>

      <div class="cu-actions">
        <button class="cu-btn primary" type="button" id="cuSave">Simpan perubahan</button>
        <button class="cu-btn-ghost" type="button" id="cuCancel">Tutup</button>
      </div>`;

    const q = (id) => b.querySelector(id);
    const prev = q("#cuPhotoPrev");
    const info = q("#cuPhotoInfo");
    const del = q("#cuPhotoDel");

    function paintFoto() {
      prev.innerHTML = avatar({ ...c, foto, nama: q("#cuNama").value || c.nama }, true);
      info.textContent = foto ? `Ukuran ${kb(foto.length)} (maks 200 KB)` : "Foto opsional, maks 200 KB";
      del.classList.toggle("cu-hidden", !foto);
    }
    paintFoto();

    q("#cuPick").addEventListener("click", () => q("#cuFile").click());
    del.addEventListener("click", () => { foto = ""; paintFoto(); });
    q("#cuFile").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      info.textContent = "Memproses foto...";
      try {
        foto = await kompresFoto(f);
        toast("Foto siap dipakai.", "success", 1500);
      } catch (err) {
        console.error(err);
        toast(err.message === "bukan-gambar" ? "File harus berupa gambar." : "Foto gagal diproses, coba foto lain.", "error");
      }
      paintFoto();
    });

    ["#cuHargaF", "#cuGalon", "#cuSaldo", "#cuHutang"].forEach((id) => {
      q(id).addEventListener("input", (e) => { e.target.value = digits(e.target.value).slice(0, 10); });
    });
    b.querySelectorAll("input, textarea").forEach((i) => i.addEventListener("input", () => i.classList.remove("invalid")));
    q("#cuCancel").addEventListener("click", closeTop);
    q("#cuSave").addEventListener("click", () => simpan());

    function gagal(id, msg) {
      toast(msg, "warning", 3500);
      const i = q(id);
      if (i) { i.classList.add("invalid"); i.focus(); }
    }

    async function simpan() {
      if (sheetBusy) return;
      const nama = q("#cuNama").value.trim();
      const telp = q("#cuTelp").value.trim();
      const alamat = q("#cuAlamat").value.trim();
      const harga = Number(digits(q("#cuHargaF").value) || 0);
      const galon = Number(digits(q("#cuGalon").value) || 0);
      const saldo = Number(digits(q("#cuSaldo").value) || 0);
      const hutang = Number(digits(q("#cuHutang").value) || 0);
      const status = q("#cuStatus").checked;

      if (nama.length < 1) return gagal("#cuNama", "Nama pelanggan wajib diisi.");
      if (telp && !/^[0-9+\-\s]{3,20}$/.test(telp)) return gagal("#cuTelp", "Nomor telepon tidak valid.");
      if (foto && foto.length > MAX_FOTO) return toast("Foto lebih dari 200 KB, pilih ulang.", "warning");

      const baru = { namaPelanggan: nama, noTelepon: telp, alamat, harga, jumlahGalon: galon, saldo, hutang, status, fotoPelanggan: foto || null };
      const lama = {
        namaPelanggan: c.nama, noTelepon: c.telp, alamat: c.alamat, harga: c.harga, jumlahGalon: c.galon,
        saldo: c.saldo, hutang: c.hutang, status: c.status, fotoPelanggan: c.foto || null
      };
      const patch = {};
      Object.keys(baru).forEach((k) => { if (baru[k] !== lama[k]) patch[k] = baru[k]; });
      if (!Object.keys(patch).length) { toast("Tidak ada perubahan.", "info"); return; }

      sheetBusy = true;
      const btn = q("#cuSave");
      const label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      try {
        await updateDoc(doc(db, "customers", c.id), { ...patch, updatedAt: serverTimestamp() });
        const upd = { ...c, nama, telp, alamat, harga, galon, saldo, hutang, status, foto };
        const i = items.findIndex((x) => x.id === c.id);
        if (i >= 0) {
          items[i] = upd;
          const node = listEl.querySelector(`.cu-item[data-id="${CSS.escape(c.id)}"]`);
          if (node) node.outerHTML = cardHtml(upd);
        }
        saveCache();
        toast("Perubahan tersimpan.", "success");
        sheetBusy = false;
        closeTop();
        fetchCount().then((n) => { if (alive) { total = n; paintKpi(); } }).catch(() => {});
      } catch (err) {
        console.error(err);
        sheetBusy = false;
        btn.disabled = false;
        btn.textContent = label;
        toast(err?.code === "permission-denied"
          ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui."
          : "Gagal menyimpan. Coba lagi.", "error", 4500);
      }
    }
  }

  /* ===== Ringkasan customer di atas peta (foto, nama, alamat, telepon) ===== */
  function showMini(c) {
    const row = `
      ${avatar(c, true)}
      <div class="cu-mini-text">
        <div class="cu-mini-name">${esc(c.nama || "(tanpa nama)")}</div>
        <div class="cu-mini-addr">${esc(c.alamat || "Alamat belum ada")}</div>
        <div class="cu-mini-tel">${esc(c.telp || "Telepon belum ada")}</div>
      </div>`;
    if (mini) {                                   // pin lain diketuk: cukup ganti isinya
      mini.querySelector(".cu-mini-row").innerHTML = row;
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "cu-mini-wrap";
    wrap.innerHTML = `
      <div class="cu-mini" role="dialog" aria-label="Ringkasan customer">
        <div class="cu-sheet-grip"></div>
        <div class="cu-mini-row">${row}</div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.getBoundingClientRect();
    requestAnimationFrame(() => wrap.classList.add("show"));
    mini = wrap;
    pushLayer({ type: "mini", el: wrap, destroy: () => { mini = null; } });
    enableSwipe(wrap.querySelector(".cu-mini"), wrap, null);
  }

  /* ===== Peta ===== */
  async function openMap(focus) {
    if (map) return;
    if (focus && !hasLoc(focus)) { toast("Lokasi customer ini belum ada.", "warning"); return; }
    const pins = items.filter(hasLoc);
    if (!pins.length) { toast("Belum ada customer berlokasi yang dimuat.", "warning"); return; }

    let L;
    try { L = await loadLeaflet(); } catch { toast("Peta gagal dimuat. Cek koneksi internet.", "error"); return; }
    if (!alive || map) return;

    const wrap = document.createElement("div");
    wrap.className = "cu-map-wrap";
    wrap.innerHTML = `
      <div class="cu-map-bar">
        <button class="cu-map-back" type="button" id="cuMapBack" aria-label="Tutup peta">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <div class="cu-map-title">Peta Customer</div>
        <div class="cu-map-count">${pins.length} pin</div>
      </div>
      <div class="cu-map" id="cuMapEl"></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#cuMapBack").addEventListener("click", closeTop);

    map = L.map(wrap.querySelector("#cuMapEl"), { zoomControl: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);

    pins.forEach((c) => {
      const kls = c.hutang > 0 ? "hutang" : c.saldo > 0 ? "saldo" : "";
      const icon = L.divIcon({
        className: `cu-pin ${kls}${focus && focus.id === c.id ? " sel" : ""}`,
        html: "<span></span>", iconSize: [26, 26], iconAnchor: [13, 26]
      });
      L.marker([c.lat, c.lng], { icon, title: c.nama }).addTo(map).on("click", () => {
        map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 17), { duration: .4 });
        showMini(c);
      });
    });

    pushLayer({
      type: "map", el: wrap,
      destroy: () => { try { map.remove(); } catch { /* abaikan */ } map = null; }
    });

    if (focus) map.setView([focus.lat, focus.lng], 17);
    else map.fitBounds(L.latLngBounds(pins.map((c) => [c.lat, c.lng])), { padding: [40, 40], maxZoom: 17 });
    setTimeout(() => { if (map) map.invalidateSize(); }, 60);

    if (focus) showMini(focus);
  }

  /* ===== Event ===== */
  function paintOwnerLabel() {
    const u = userMap.get(owner);
    $("#cuOwnerLabel").textContent = owner === "all" || !u ? "Semua kurir & sales" : `${namaUser(u)} (${u.role})`;
  }

  // Pilih kurir/sales: sheet custom (pengganti dropdown bawaan browser)
  function openOwnerPicker() {
    const { body } = makeSheet("Pilih kurir atau sales");
    const opt = (id, nama, sub, off) => `
      <button class="cu-opt${id === owner ? " on" : ""}" type="button" data-v="${esc(id)}">
        <span class="cu-opt-text">
          <span class="cu-opt-name">${esc(nama)}</span>
          ${sub ? `<span class="cu-opt-sub">${esc(sub)}${off ? " · nonaktif" : ""}</span>` : ""}
        </span>
        <span class="cu-opt-check">✓</span>
      </button>`;
    body.innerHTML = `
      <div class="cu-f-title">Pilih kurir / sales</div>
      <div class="cu-opts">
        ${opt("all", "Semua kurir & sales", "", false)}
        ${users.map((u) => opt(u.id, namaUser(u), u.role, u.status === false)).join("")}
      </div>`;
    body.addEventListener("click", (e) => {
      const b = e.target.closest(".cu-opt");
      if (!b) return;
      const v = b.dataset.v;
      closeTop();
      if (v !== owner) { owner = v; paintOwnerLabel(); reload(); }
    });
  }

  // Chat WhatsApp ke noTelepon (0812... / +62812... / 812... -> 62812...)
  function bukaWa(c) {
    let n = digits(c.telp);
    if (n.startsWith("0")) n = "62" + n.slice(1);
    else if (n.startsWith("8")) n = "62" + n;
    if (n.length < 9) { toast("Nomor telepon belum ada atau tidak valid.", "warning"); return; }
    window.open(`https://wa.me/${n}`, "_blank", "noopener");
  }

  /* ===== Mode centang (tekan lama) ===== */
  const rootEl = el.querySelector(".v-cu");
  let selBar = null;
  let lpTimer = 0, lpX = 0, lpY = 0, lpFired = false;

  const rowNode = (id) => listEl.querySelector(`.cu-item[data-id="${CSS.escape(id)}"]`);
  const waitLayers = (n) => new Promise((res) => {
    const t = () => (!alive || layers.length <= n ? res() : setTimeout(t, 16));
    t();
  });

  // modal konfirmasi custom; tombol back menutupnya (bukan keluar dari mode centang)
  async function konfirmasi(opts) {
    const p = confirmBox(opts);
    const ov = document.body.lastElementChild;
    const no = ov && ov.querySelector(".alert-btn.secondary");
    modalCancel = no ? () => no.click() : null;
    try { return await p; } finally { modalCancel = null; }
  }

  const paintSelCount = () => {
    if (selBar) selBar.querySelector("#cuSelCount").textContent = `${selected.size} dipilih`;
  };
  const setBusy = (v) => { actionBusy = v; if (selBar) selBar.classList.toggle("busy", v); };
  const selesaiSelect = () => {
    const top = layers[layers.length - 1];
    if (selectMode && top && top.type === "select") closeTop();
  };

  function enterSelect(id) {
    if (selectMode) { if (!selected.has(id)) toggleSel(id); return; }
    selectMode = true;
    selected.add(id);
    rootEl.classList.add("selecting");

    const bar = document.createElement("div");
    bar.className = "cu-selbar";
    bar.innerHTML = `
      <button class="cu-sel-x" type="button" id="cuSelX" aria-label="Batalkan pilihan">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <span class="cu-sel-count" id="cuSelCount"></span>
      <button class="cu-sel-btn" type="button" id="cuSelAll" aria-label="Pilih semua">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l4.5 4.5L15 8.5"/><path d="M10 15l1.5 1.5L21 7"/></svg>
        <span>Semua</span>
      </button>
      <button class="cu-sel-btn" type="button" id="cuSelOwner" aria-label="Pindah pemilik">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>Pemilik</span>
      </button>
      <button class="cu-sel-btn danger" type="button" id="cuSelDel" aria-label="Hapus customer">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>
        <span>Hapus</span>
      </button>`;
    document.body.appendChild(bar);
    selBar = bar;
    bar.getBoundingClientRect();
    requestAnimationFrame(() => bar.classList.add("show"));
    bar.querySelector("#cuSelX").addEventListener("click", closeTop);
    bar.querySelector("#cuSelAll").addEventListener("click", pilihSemua);
    bar.querySelector("#cuSelOwner").addEventListener("click", openMovePicker);
    bar.querySelector("#cuSelDel").addEventListener("click", hapusTerpilih);

    pushLayer({
      type: "select", el: bar,
      destroy: () => {
        selectMode = false;
        selected.clear();
        selBar = null;
        rootEl.classList.remove("selecting");
        listEl.querySelectorAll(".cu-item.sel").forEach((n) => n.classList.remove("sel"));
      }
    });

    const n = rowNode(id);
    if (n) n.classList.add("sel");
    paintSelCount();
  }

  // pilih semua customer yang sudah dimuat; kalau semuanya sudah tercentang, tekan lagi = batal semua
  function pilihSemua() {
    if (actionBusy || !items.length) return;
    if (items.every((c) => selected.has(c.id))) { closeTop(); return; }
    items.forEach((c) => {
      selected.add(c.id);
      const n = rowNode(c.id);
      if (n) n.classList.add("sel");
    });
    paintSelCount();
  }

  function toggleSel(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const n = rowNode(id);
    if (n) n.classList.toggle("sel", selected.has(id));
    if (!selected.size) { closeTop(); return; }     // centang terakhir dibatalkan -> keluar mode centang
    paintSelCount();
  }

  // tekan lama ~0,45 detik pada kartu -> mode centang
  listEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    lpFired = false;
    clearTimeout(lpTimer);
    const row = e.target.closest(".cu-item[data-id]");
    if (!row || e.target.closest('[data-act="wa"], [data-act="map"]')) return;
    lpX = e.clientX; lpY = e.clientY;
    lpTimer = setTimeout(() => {
      lpTimer = 0;
      if (actionBusy) return;
      lpFired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      enterSelect(row.dataset.id);
    }, 450);
  });
  listEl.addEventListener("pointermove", (e) => {
    if (lpTimer && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) { clearTimeout(lpTimer); lpTimer = 0; }
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => {
    listEl.addEventListener(ev, () => { clearTimeout(lpTimer); lpTimer = 0; });
  });
  listEl.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ----- Aksi massal ----- */
  async function commitChunks(ids, fn) {
    for (let i = 0; i < ids.length; i += 400) {
      const b = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => fn(b, id));
      await b.commit();
    }
  }

  function gagalAksi(err, ids) {
    console.error(err);
    toast(err?.code === "permission-denied"
      ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui."
      : "Gagal memproses. Coba lagi.", "error", 4500);
    if (ids.length > 400) { selesaiSelect(); reload(); }   // bisa sebagian sudah terproses -> sinkron ulang
  }

  function dropItems(ids) {
    const s = new Set(ids);
    items = items.filter((c) => !s.has(c.id));
    ids.forEach((id) => { const n = rowNode(id); if (n) n.remove(); });
    saveCache();
    paintKpi();
    fetchCount().then((n) => { if (alive) { total = n; paintKpi(); } }).catch(() => {});
    if (!items.length) { if (hasMore) loadMore(); else paintList(); } else paintFoot();
  }

  async function hapusTerpilih() {
    if (actionBusy || !selected.size) return;
    const ids = [...selected];
    const ok = await konfirmasi({
      title: "Hapus customer?",
      text: `${ids.length} customer akan dihapus permanen dan tidak bisa dikembalikan.`,
      yes: "Hapus", no: "Batal", danger: true
    });
    if (!ok || !alive) return;
    setBusy(true);
    try {
      await commitChunks(ids, (b, id) => b.delete(doc(db, "customers", id)));
      if (!alive) return;
      dropItems(ids);
      toast(`${ids.length} customer dihapus.`, "success");
      selesaiSelect();
    } catch (err) {
      gagalAksi(err, ids);
    } finally {
      setBusy(false);
    }
  }

  // Pilih pemilik baru: sheet daftar kurir & sales -> modal konfirmasi -> ubah field pemilik
  function openMovePicker() {
    if (actionBusy || !selected.size) return;
    if (!users.length) { toast("Daftar kurir/sales belum dimuat.", "warning"); return; }
    const { body } = makeSheet("Pindah pemilik");
    body.innerHTML = `
      <div class="cu-f-title">Pindahkan ke kurir / sales</div>
      <div class="cu-opts">
        ${users.map((u) => `
          <button class="cu-opt" type="button" data-v="${esc(u.id)}">
            <span class="cu-opt-text">
              <span class="cu-opt-name">${esc(namaUser(u))}</span>
              <span class="cu-opt-sub">${esc(u.role)}${u.status === false ? " · nonaktif" : ""}</span>
            </span>
          </button>`).join("")}
      </div>`;
    let picked = false;
    body.addEventListener("click", async (e) => {
      const b = e.target.closest(".cu-opt");
      if (!b || picked) return;
      const u = userMap.get(b.dataset.v);
      if (!u) return;
      picked = true;
      const depth = layers.length - 1;
      closeTop();
      await waitLayers(depth);
      if (alive) pindahPemilik(u);
    });
  }

  async function pindahPemilik(u) {
    if (actionBusy || !selected.size) return;
    const ids = [...selected];
    const ok = await konfirmasi({
      title: "Pindah pemilik?",
      text: `${ids.length} customer akan dipindahkan ke ${namaUser(u)} (${u.role}).`,
      yes: "Pindahkan", no: "Batal", type: "info"
    });
    if (!ok || !alive) return;
    setBusy(true);
    try {
      await commitChunks(ids, (b, id) => b.update(doc(db, "customers", id), { pemilik: u.id, updatedAt: serverTimestamp() }));
      if (!alive) return;
      const s = new Set(ids);
      items.forEach((c) => { if (s.has(c.id)) c.pemilik = u.id; });
      if (owner !== "all" && owner !== u.id) {
        dropItems(ids);                                   // tidak lagi cocok dengan filter pemilik
      } else {
        items.forEach((c) => { if (s.has(c.id)) { const n = rowNode(c.id); if (n) n.outerHTML = cardHtml(c); } });
        saveCache();
      }
      toast(`${ids.length} customer dipindahkan ke ${namaUser(u)}.`, "success");
      selesaiSelect();
    } catch (err) {
      gagalAksi(err, ids);
    } finally {
      setBusy(false);
    }
  }

  $("#cuOwner").addEventListener("click", openOwnerPicker);

  $("#cuSaldo").addEventListener("click", (e) => {
    const b = e.target.closest(".cu-chip");
    if (!b || b.dataset.f === saldoF) return;
    saldoF = b.dataset.f;
    el.querySelectorAll(".cu-chip").forEach((x) => x.classList.toggle("on", x === b));
    reload();
  });

  const hargaEl = $("#cuHarga");
  const hargaX = $("#cuHargaX");
  hargaEl.addEventListener("input", () => {
    hargaEl.value = digits(hargaEl.value).slice(0, 10);
    hargaX.classList.toggle("cu-hidden", !hargaEl.value);
    clearTimeout(hargaTimer);
    hargaTimer = setTimeout(() => {
      const v = Number(hargaEl.value || 0);
      if (v === hargaVal) return;
      hargaVal = v;
      reload();
    }, 450);
  });
  hargaX.addEventListener("click", () => {
    hargaEl.value = "";
    hargaX.classList.add("cu-hidden");
    clearTimeout(hargaTimer);
    if (hargaVal !== 0) { hargaVal = 0; reload(); }
  });

  $("#cuMapAll").addEventListener("click", () => openMap(null));

  listEl.addEventListener("click", (e) => {
    if (lpFired) { lpFired = false; return; }
    const row = e.target.closest(".cu-item[data-id]");
    if (!row) return;
    if (selectMode) { toggleSel(row.dataset.id); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const c = items.find((x) => x.id === row.dataset.id);
    if (!c) return;
    if (btn.dataset.act === "open") openSheet(c);
    else if (btn.dataset.act === "map") openMap(c);
    else if (btn.dataset.act === "wa") bukaWa(c);
  });

  /* ===== Awal: dropdown langsung dari Firestore, lalu list ===== */
  async function loadUsers() {
    if (!idCabang) return;
    try {
      const snap = await getDocs(query(
        collection(db, "users"), where("idCabang", "==", idCabang), where("role", "in", ROLES)
      ));
      if (!alive) return;
      users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
      users.forEach((u) => userMap.set(u.id, u));
      paintOwnerLabel();
      // nama pemilik di kartu ikut diperbarui
      if (items.length) paintList();
    } catch (err) {
      console.error(err);
      toast("Gagal memuat daftar kurir/sales.", "error");
    }
  }

  paintKpi();
  loadUsers();
  reload();

  return () => {
    alive = false;
    clearTimeout(hargaTimer);
    if (io) io.disconnect();
    window.removeEventListener("popstate", onPop);
    while (layers.length) popLayer();
    document.querySelectorAll(".cu-sheet-wrap, .cu-map-wrap, .cu-mini-wrap, .cu-selbar").forEach((n) => n.remove());
    document.documentElement.classList.remove("cu-lock");
  };
}
