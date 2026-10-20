// data-harian.js — view Data Harian: laporan kurir/sales per hari
import {
  collection, collectionGroup, query, where, getDocs, getDoc, doc,
  writeBatch, serverTimestamp, getAggregateFromServer, sum
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, alertBox } from "./ui.js";

export const css = new URL("./data-harian.css", import.meta.url).href;

/* ---------- Helper ---------- */
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const rp = (n) => `${n < 0 ? "-" : ""}Rp ${fmt(Math.abs(n))}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const digits = (s) => String(s || "").replace(/\D/g, "");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tglIndo(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

/* ---------- Cache lokal (tampil instan, lalu disegarkan di latar belakang) ---------- */
const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem("dh:" + k) || "null"); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem("dh:" + k, JSON.stringify(v)); } catch { /* penuh/diblokir */ } };

function namaUser(u) {
  return u.nama || u.name || u.username || u.email || u.id;
}

/* ---------- Rumus bonus & potongan ----------
   Bonus   : closing >= ketentuan -> klaim, tambah klaim lagi tiap kelipatan di atas ketentuan
             (60 -> 5.000 | 65 -> 10.000 | 70 -> 15.000)
   Potongan: closing <  ketentuan -> potonganUpah, tambah lagi tiap kelipatan kekurangan
             (54..50 -> 5.000 | 49..45 -> 10.000)  */
export function hitungBonus(closing, b) {
  const ket = num(b?.ketentuan), klaim = num(b?.klaim), kel = num(b?.kelipatan);
  if (!ket || !klaim || closing < ket) return 0;
  const step = kel > 0 ? Math.floor((closing - ket) / kel) : 0;
  return klaim * (1 + step);
}

export function hitungPotongan(closing, p) {
  const ket = num(p?.ketentuan), pot = num(p?.potonganUpah), kel = num(p?.kelipatan);
  if (!ket || !pot || closing >= ket) return 0;
  const step = kel > 0 ? Math.ceil((ket - closing) / kel) : 1;
  return pot * step;
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, user: admin, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  let alive = true;
  let cabang = null;          // data kantorCabang (bonus & potongan)
  let users = [];             // daftar kurir/sales
  let sel = null;             // user terpilih
  let state = null;           // data laporan (null = belum ada, ready=false = dari cache)
  let loadToken = 0;
  let dirty = false;          // kasbon sudah diketik user

  el.innerHTML = `<section class="v-dh"></section>`;
  const root = el.firstElementChild;

  /* ===== LIST ===== */
  const skelRows = (n = 5) => Array.from({ length: n }, () => `
    <div class="dh-item skel-row">
      <span class="dh-avatar skel"></span>
      <span class="dh-item-main">
        <span class="skel" style="height:16px;width:55%"></span>
        <span class="skel" style="height:12px;width:30%"></span>
      </span>
    </div>`).join("");

  function listHtml() {
    return `
      <div class="dh-head">
        <h2>Pilih Kurir / Sales</h2>
        <p>${users.length} orang · ketuk nama untuk membuka laporan harian.</p>
      </div>
      <div class="dh-list">
        ${users.map((u) => `
          <button class="dh-item" type="button" data-id="${esc(u.id)}">
            <span class="dh-avatar">${esc(namaUser(u).charAt(0).toUpperCase())}</span>
            <span class="dh-item-main">
              <span class="dh-item-name">${esc(namaUser(u))}</span>
              <span class="dh-item-sub">
                <span class="dh-role ${esc(u.role)}">${esc(u.role)}</span>
                ${u.status === false ? `<span class="dh-role off">nonaktif</span>` : ""}
              </span>
            </span>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>`).join("")}
      </div>`;
  }

  function paintList() {
    if (!users.length) {
      root.innerHTML = `
        <div class="dh-head"><h2>Pilih Kurir / Sales</h2></div>
        <div class="dh-empty">Belum ada kurir atau sales di cabang ini.</div>`;
      return;
    }
    root.innerHTML = listHtml();
    root.querySelectorAll(".dh-item").forEach((b) => {
      b.addEventListener("click", () => {
        sel = users.find((u) => u.id === b.dataset.id);
        history.pushState({ dh: sel.id }, "");   // tombol back Android -> kembali ke daftar
        showDetail(todayStr());
      });
    });
  }

  async function showList() {
    sel = null; state = null; loadToken++;
    const token = loadToken;

    if (!idCabang) {
      root.innerHTML = `<div class="dh-empty">Akun ini belum punya idCabang.</div>`;
      return;
    }

    // Tampil instan: dari cache, kalau belum ada pakai kerangka (skeleton)
    const cached = cacheGet(`list:${idCabang}`);
    if (cached) {
      users = cached.users || [];
      cabang = cached.cabang || null;
      paintList();
    } else {
      root.innerHTML = `
        <div class="dh-head">
          <h2>Pilih Kurir / Sales</h2>
          <p>Ketuk nama untuk membuka laporan harian.</p>
        </div>
        <div class="dh-list">${skelRows()}</div>`;
    }

    // Segarkan dari server
    try {
      const [snap, cab] = await Promise.all([
        getDocs(query(
          collection(db, "users"),
          where("idCabang", "==", idCabang),
          where("role", "in", ["kurir", "sales"])
        )),
        getDoc(doc(db, "kantorCabang", idCabang))
      ]);
      if (!alive) return;
      const fresh = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
      const freshCab = cab.exists() ? cab.data() : null;

      const changed = JSON.stringify(fresh) !== JSON.stringify(users);
      users = fresh;
      cabang = freshCab;
      cacheSet(`list:${idCabang}`, { users: fresh, cabang: freshCab });

      // jangan timpa layar kalau user sudah pindah ke detail
      if (token === loadToken && sel === null && (changed || !cached)) paintList();
      else if (sel) paintDetail();   // aturan bonus/potongan mungkin ikut berubah
    } catch (err) {
      console.error(err);
      if (!alive || cached) return;
      root.innerHTML = `<div class="dh-empty">Gagal memuat daftar. Cek aturan Firestore & koneksi.</div>`;
      toast("Gagal memuat daftar kurir/sales.", "error");
    }
  }

  /* ===== DATA LAPORAN ===== */
  async function ambilData(uid, tanggal) {
    const base = [
      where("createdBy", "==", uid),
      where("idCabang", "==", idCabang)
    ];

    const hariIni = await getDocs(query(
      collectionGroup(db, "dataHarian"), ...base, where("tanggal", "==", tanggal)
    ));

    let closing = 0, omset = 0;
    hariIni.forEach((d) => {
      const x = d.data();
      closing += num(x.pengisianGalon);
      omset += num(x.pembayaran);
    });
    const repeat = hariIni.size;

    // Hutang / saldo: jumlah seluruh keterangan (semua tanggal)
    const qAll = query(collectionGroup(db, "dataHarian"), ...base);
    let hutangSaldo = 0;
    try {
      const agg = await getAggregateFromServer(qAll, { total: sum("keterangan") });
      hutangSaldo = num(agg.data().total);
    } catch (e) {
      console.warn("Aggregate gagal, pakai getDocs:", e);
      const all = await getDocs(qAll);
      all.forEach((d) => { hutangSaldo += num(d.data().keterangan); });
    }

    return { closing, repeat, omset, hutangSaldo };
  }

  // Satu dokumen per tanggal: users/{admin}/laporanAdmin/{tanggal}
  // Isinya map per uid kurir/sales: { "<uid>": { ...laporan } }
  const adminRef = (tanggal) =>
    doc(db, "users", admin.uid, "laporanAdmin", tanggal);
  const mirrorRef = (uid, tanggal) =>
    doc(db, "users", uid, "laporan", tanggal);

  /* ===== DETAIL ===== */
  function showDetail(tanggal) {
    const token = ++loadToken;
    const u = sel;
    dirty = false;

    // Tampil instan: angka dari cache (kalau ada), selain itu kerangka
    const c = cacheGet(`det:${u.id}:${tanggal}`);
    state = c
      ? { tanggal, ready: false, ...c }
      : { tanggal, ready: false, closing: null, repeat: null, omset: null, hutangSaldo: null, exists: null, saved: null, kasbon: 0 };
    renderDetail();

    (async () => {
      try {
        const [data, saved] = await Promise.all([
          ambilData(u.id, tanggal),
          getDoc(adminRef(tanggal))
        ]);
        if (!alive || token !== loadToken) return;

        const entry = saved.exists() ? (saved.data()[u.id] || null) : null;
        state = {
          tanggal,
          ready: true,
          ...data,
          exists: !!entry,
          saved: entry,
          kasbon: entry ? num(entry.kasbon) : 0,
          savedAtMs: entry?.updatedAt?.toMillis ? entry.updatedAt.toMillis() : null
        };
        cacheSet(`det:${u.id}:${tanggal}`, {
          closing: data.closing, repeat: data.repeat, omset: data.omset, hutangSaldo: data.hutangSaldo,
          exists: state.exists, kasbon: state.kasbon, savedAtMs: state.savedAtMs
        });

        // isi kasbon dari data tersimpan, kecuali user sudah mengetik sendiri
        const inp = root.querySelector("#dhKasbon");
        if (inp && !dirty) inp.value = state.kasbon ? fmt(state.kasbon) : "";
        paintDetail();
      } catch (err) {
        console.error(err);
        if (!alive || token !== loadToken) return;
        toast("Gagal memuat laporan. Cek aturan Firestore / index.", "error", 4500);
        const v = root.querySelector("#dhValid");
        if (v) v.innerHTML = `<div class="dh-valid-title">Validasi data sebelum disimpan</div>
          <div class="dh-v err"><span class="dh-v-ico">✕</span><span>Gagal memuat data. Simpan dinonaktifkan sampai data berhasil dimuat.</span></div>`;
      }
    })();
  }

  function detailHeader(u, tanggal) {
    return `
      <div class="dh-top">
        <button class="dh-back" type="button" id="dhBack" aria-label="Kembali">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <div class="dh-top-main">
          <div class="dh-top-name">${esc(namaUser(u))}</div>
          <span class="dh-role ${esc(u.role)}">${esc(u.role)}</span>
        </div>
      </div>
      <div class="dh-datebar">
        <label for="dhTanggal">Tanggal laporan</label>
        <input type="date" id="dhTanggal" value="${esc(tanggal)}" max="${todayStr()}">
      </div>`;
  }

  function hitung(kasbon) {
    const closing = state.closing || 0;
    const omset = state.omset || 0;
    const hppDistribusi = num(cabang?.hpp?.distribusi);
    const pembayaranProduksi = closing * hppDistribusi;
    const bonus = hitungBonus(closing, cabang?.bonus);
    const potongan = hitungPotongan(closing, cabang?.potongan);
    const kasDistribusi = omset - pembayaranProduksi - kasbon;   // boleh minus

    // hari kerja = jumlah hari pada bulan tanggal laporan dikurangi hari Minggu
    const [y, m] = String(state.tanggal).split("-").map(Number);
    const hariBulan = y && m ? new Date(y, m, 0).getDate() : 30;
    let hariMinggu = 0;
    if (y && m) {
      for (let d = 1; d <= hariBulan; d++) if (new Date(y, m - 1, d).getDay() === 0) hariMinggu++;
    }
    const hariKerja = Math.max(hariBulan - hariMinggu, 1);
    const upahKurir = num(cabang?.upahKurir);
    const upahHarian = upahKurir / hariKerja;
    const hargaJual = num(cabang?.hpp?.hargaJual);
    const pendapatan = closing * hargaJual;
    const marginDistribusi = pendapatan - pembayaranProduksi - upahHarian + potongan - bonus;

    return {
      bonus, potongan, kasbon,
      hppDistribusi, pembayaranProduksi, kasDistribusi,
      hariBulan, hariMinggu, hariKerja, upahKurir, upahHarian, hargaJual, pendapatan, marginDistribusi
    };
  }

  function validasi(kasbon) {
    const out = [];
    const add = (level, text) => out.push({ level, text });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.tanggal)) add("err", "Tanggal tidak valid.");
    else add("ok", `Tanggal laporan ${tglIndo(state.tanggal)}.`);

    if (!idCabang) add("err", "Akun admin belum punya idCabang.");

    if (kasbon > 100000000) add("err", "Kasbon terlalu besar, periksa kembali.");
    else add("ok", kasbon === 0 ? "Kasbon kosong, disimpan sebagai Rp 0." : `Kasbon ${rp(kasbon)}.`);

    if (!cabang?.bonus?.ketentuan) add("warn", "Ketentuan bonus belum diatur di kantor cabang, bonus dihitung Rp 0.");
    if (!cabang?.potongan?.ketentuan) add("warn", "Ketentuan potongan belum diatur di kantor cabang, potongan dihitung Rp 0.");
    if (!num(cabang?.hpp?.hargaJual)) add("warn", "Harga jual belum diatur di kantor cabang (hpp.hargaJual), pendapatan margin dihitung Rp 0.");
    if (!num(cabang?.upahKurir)) add("warn", "Upah kurir belum diatur di kantor cabang, margin distribusi dihitung tanpa upah kurir.");
    if (!num(cabang?.hpp?.distribusi)) add("warn", "HPP distribusi belum diatur di kantor cabang, pembayaran produksi dihitung Rp 0.");

    if (state.repeat === 0) {
      add("warn", "Belum ada entri data harian pada tanggal ini. Closing, repeat & omset bernilai 0" +
        (cabang?.potongan?.ketentuan ? " dan potongan tetap terhitung." : "."));
    } else {
      add("ok", `${state.repeat} entri data harian ditemukan.`);
    }

    if (state.exists) add("info", "Laporan ini sudah pernah disimpan. Menyimpan akan memperbarui dokumen yang ada.");
    return out;
  }

  // Kerangka detail: dirender sekali & langsung, angkanya diisi lewat paintDetail()
  function renderDetail() {
    root.innerHTML = `
      ${detailHeader(sel, state.tanggal)}

      <div class="dh-badge" id="dhBadge"></div>

      <div class="dh-grid">
        <div class="dh-stat">
          <span class="dh-stat-label">Closing</span>
          <span class="dh-stat-val" id="dhClosing"></span>
          <span class="dh-stat-note">galon diisi</span>
        </div>
        <div class="dh-stat">
          <span class="dh-stat-label">Pelanggan Repeat</span>
          <span class="dh-stat-val" id="dhRepeat"></span>
          <span class="dh-stat-note">pelanggan</span>
        </div>
        <div class="dh-stat wide">
          <span class="dh-stat-label">Omset</span>
          <span class="dh-stat-val" id="dhOmset"></span>
        </div>
        <div class="dh-stat wide">
          <span class="dh-stat-label">Pembayaran Produksi</span>
          <span class="dh-stat-val" id="dhPayProd"></span>
          <span class="dh-stat-note" id="dhPayProdInfo"></span>
        </div>
        <div class="dh-stat wide" id="dhKasDistCard">
          <span class="dh-stat-label">Kas Distribusi</span>
          <span class="dh-stat-val" id="dhKasDist"></span>
          <span class="dh-stat-note">omset − pembayaran produksi − kasbon</span>
        </div>
        <div class="dh-stat wide" id="dhHSCard">
          <span class="dh-stat-label" id="dhHSLabel">Hutang / Saldo</span>
          <span class="dh-stat-val" id="dhHS"></span>
          <span class="dh-stat-note">akumulasi seluruh data</span>
        </div>
        <div class="dh-stat pos">
          <span class="dh-stat-label">Bonus</span>
          <span class="dh-stat-val" id="dhBonus"></span>
          <span class="dh-stat-note" id="dhBonusInfo"></span>
        </div>
        <div class="dh-stat neg">
          <span class="dh-stat-label">Potongan</span>
          <span class="dh-stat-val" id="dhPot"></span>
          <span class="dh-stat-note" id="dhPotInfo"></span>
        </div>
      </div>

      <div class="dh-form">
        <h3>Input</h3>
        <label for="dhKasbon">Kasbon (Rp)</label>
        <input id="dhKasbon" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${state.kasbon ? fmt(state.kasbon) : ""}">
      </div>

      <div class="dh-valid" id="dhValid"></div>

      <button class="dh-save" id="dhSave" type="button" disabled>Simpan Laporan</button>
    `;

    root.querySelector("#dhBack").addEventListener("click", () => {
      if (history.state && history.state.dh) history.back();
      else showList();
    });
    const t = root.querySelector("#dhTanggal");
    t.addEventListener("change", () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value)) return;
      showDetail(t.value);
    });

    const inp = root.querySelector("#dhKasbon");
    inp.addEventListener("input", () => {
      dirty = true;
      const raw = digits(inp.value);
      inp.value = raw ? fmt(raw) : "";
      paintDetail();
    });
    root.querySelector("#dhSave").addEventListener("click", simpan);

    paintDetail();
  }

  const setVal = (id, v, text) => {
    const n = root.querySelector(id);
    if (!n) return;
    const empty = v === null || v === undefined;
    n.classList.toggle("skel", empty);
    n.textContent = empty ? "" : text;
  };

  // Isi angka ke kerangka. Nilai null = tampil skeleton.
  function paintDetail() {
    if (!state || !root.querySelector("#dhKasbon")) return;
    const s = state;
    const kasbon = num(digits(root.querySelector("#dhKasbon").value));
    const known = s.closing !== null && s.closing !== undefined;

    setVal("#dhClosing", s.closing, fmt(s.closing));
    setVal("#dhRepeat", s.repeat, fmt(s.repeat));
    setVal("#dhOmset", s.omset, rp(s.omset || 0));

    const hs = s.hutangSaldo;
    setVal("#dhHS", hs, rp(Math.abs(hs || 0)));
    root.querySelector("#dhHSLabel").textContent = hs === null || hs === undefined ? "Hutang / Saldo" : (hs < 0 ? "Hutang" : "Saldo");
    root.querySelector("#dhHSCard").className = "dh-stat wide " + (hs < 0 ? "neg" : hs > 0 ? "pos" : "");

    const h = hitung(kasbon);
    setVal("#dhPayProd", known ? 1 : null, rp(h.pembayaranProduksi));
    setVal("#dhKasDist", known ? 1 : null, rp(h.kasDistribusi));
    root.querySelector("#dhPayProdInfo").textContent = h.hppDistribusi
      ? `${fmt(s.closing || 0)} closing × ${rp(h.hppDistribusi)} (HPP distribusi)`
      : "HPP distribusi belum diatur";
    root.querySelector("#dhKasDistCard").className =
      "dh-stat wide " + (!known ? "" : h.kasDistribusi < 0 ? "neg" : h.kasDistribusi > 0 ? "pos" : "");
    setVal("#dhBonus", known ? 1 : null, rp(h.bonus));
    setVal("#dhPot", known ? 1 : null, rp(h.potongan));

    const b = cabang?.bonus, p = cabang?.potongan;
    root.querySelector("#dhBonusInfo").textContent = b?.ketentuan
      ? `Target ${fmt(b.ketentuan)} galon · ${rp(num(b.klaim))} tiap kelipatan ${fmt(b.kelipatan)}`
      : "Ketentuan belum diatur";
    root.querySelector("#dhPotInfo").textContent = p?.ketentuan
      ? `Di bawah ${fmt(p.ketentuan)} galon · ${rp(num(p.potonganUpah))} tiap kelipatan ${fmt(p.kelipatan)}`
      : "Ketentuan belum diatur";

    // badge status simpan
    const badge = root.querySelector("#dhBadge");
    if (s.exists === null || s.exists === undefined) {
      badge.className = "dh-badge skel"; badge.textContent = "";
    } else if (s.exists) {
      const ms = s.savedAtMs;
      const waktu = ms ? " · " + new Date(ms).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      badge.className = "dh-badge saved";
      badge.textContent = "✓ Sudah pernah disimpan" + waktu;
    } else {
      badge.className = "dh-badge new";
      badge.textContent = "Belum disimpan";
    }

    // validasi (hanya setelah data segar dari server)
    const valid = root.querySelector("#dhValid");
    const btn = root.querySelector("#dhSave");
    if (s.ready) {
      const v = validasi(kasbon);
      valid.innerHTML = `
        <div class="dh-valid-title">Validasi data sebelum disimpan</div>
        ${v.map((x) => `<div class="dh-v ${x.level}"><span class="dh-v-ico">${{ ok: "✓", warn: "!", err: "✕", info: "i" }[x.level]}</span><span>${esc(x.text)}</span></div>`).join("")}`;
      btn.disabled = false;
      btn.textContent = s.exists ? "Perbarui Laporan" : "Simpan Laporan";
    } else {
      valid.innerHTML = `
        <div class="dh-valid-title">Validasi data sebelum disimpan</div>
        <div class="skel" style="height:14px;width:80%"></div>
        <div class="skel" style="height:14px;width:65%"></div>
        <div class="skel" style="height:14px;width:72%"></div>`;
      btn.disabled = true;
      btn.textContent = s.exists ? "Perbarui Laporan" : "Simpan Laporan";
    }
  }

  /* ===== SIMPAN ===== */
  async function simpan() {
    if (!state?.ready) return;
    const btn = root.querySelector("#dhSave");
    const inp = root.querySelector("#dhKasbon");
    const kasbonVal = num(digits(inp.value));
    const v = validasi(kasbonVal);
    const errs = v.filter((x) => x.level === "err");
    if (errs.length) {
      await alertBox({
        title: "Data belum valid",
        text: errs.map((e) => "• " + e.text).join("\n"),
        type: "error"
      });
      return;
    }

    const u = sel, s = state;
    const h = hitung(kasbonVal);

    const payload = {
      kurirUid: u.id,
      kurirNama: namaUser(u),
      kurirRole: u.role,
      adminUid: admin.uid,
      idCabang,
      tanggal: s.tanggal,
      closing: s.closing,
      pelangganRepeat: s.repeat,
      omset: s.omset,
      pembayaranProduksi: h.pembayaranProduksi,
      kasDistribusi: h.kasDistribusi,
      marginDistribusi: h.marginDistribusi,
      hutangSaldo: s.hutangSaldo,
      bonus: h.bonus,
      potongan: h.potongan,
      kasbon: h.kasbon,
      updatedAt: serverTimestamp()
    };
    if (!s.exists) payload.createdAt = serverTimestamp();

    btn.disabled = true;
    const label = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span>`;   // spinner kecil hanya saat menyimpan

    try {
      const batch = writeBatch(db);
      // users/{admin}/laporanAdmin/{tanggal} -> field per uid (merge, uid lain tidak tertimpa)
      batch.set(adminRef(s.tanggal), {
        tanggal: s.tanggal,
        adminUid: admin.uid,
        idCabang,
        updatedAt: serverTimestamp(),
        [u.id]: payload
      }, { merge: true });
      batch.set(mirrorRef(u.id, s.tanggal), payload, { merge: true });  // users/{kurir}/laporan
      await batch.commit();
      if (!alive) return;

      state = { ...s, exists: true, kasbon: kasbonVal, savedAtMs: Date.now() };
      cacheSet(`det:${u.id}:${s.tanggal}`, {
        closing: s.closing, repeat: s.repeat, omset: s.omset, hutangSaldo: s.hutangSaldo,
        exists: true, kasbon: kasbonVal, savedAtMs: state.savedAtMs
      });
      toast(s.exists ? "Laporan diperbarui." : "Laporan tersimpan.", "success");
      paintDetail();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      btn.disabled = false;
      btn.textContent = label;
      toast(err?.code === "permission-denied"
        ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui."
        : "Gagal menyimpan laporan.", "error", 4500);
    }
  }

  // Tombol back (Android / browser): detail -> daftar, tanpa keluar halaman
  const onPop = (e) => {
    if (!alive) return;
    const id = e.state && e.state.dh;
    if (id) {
      const u = users.find((x) => x.id === id);
      if (u) { sel = u; showDetail(state?.tanggal || todayStr()); return; }
    }
    if (sel) showList();
  };
  window.addEventListener("popstate", onPop);

  // Bersihkan sisa state history dari kunjungan sebelumnya
  if (history.state && history.state.dh) history.replaceState(null, "");

  showList();

  return () => {
    alive = false;
    window.removeEventListener("popstate", onPop);
  };
}
