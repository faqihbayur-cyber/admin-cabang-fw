// akun.js — view Akun: kelola akun sales/kurir cabang (tambah, edit, nonaktifkan/aktifkan)
import {
  collection, query, where, getDocs, doc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { toast, alertBox } from "./ui.js";

export const css = new URL("./akun.css", import.meta.url).href;

/* ---------- Konstanta ---------- */
const ROLES = ["sales", "kurir", "konsumen"];
// konsumen = satu akun bersama untuk pembeli yang datang langsung ke tempat produksi (tanpa login, hanya nama)
const MAX_FOTO = 200 * 1024;      // batas panjang string base64 (≈150 KB file asli)

/* ---------- Helper ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
const pad = (n) => String(n).padStart(2, "0");
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function tglIndo(s) {
  const [y, m, d] = String(s || "").split("-").map(Number);
  if (!y || !m || !d) return s || "-";
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}
function waktuIndo(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
const namaUser = (u) => u.nama || u.email || u.id;
const inisial = (u) => String(namaUser(u)).trim().charAt(0).toUpperCase() || "?";
const kb = (len) => `${Math.round(len / 1024)} KB`;

/* ---------- Cache IndexedDB (tampil instan, lalu disegarkan dari server) ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("fw-akun", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const d = await idbOpen();
    return await new Promise((res) => {
      const q = d.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function idbSet(key, val) {
  try {
    const d = await idbOpen();
    await new Promise((res) => {
      const t = d.transaction("kv", "readwrite");
      t.objectStore("kv").put(val, key);
      t.oncomplete = res; t.onerror = res; t.onabort = res;
    });
  } catch { /* abaikan */ }
}

/* ---------- Kompres foto (canvas -> JPEG base64 <= 200 KB) ---------- */
async function kompresFoto(file) {
  if (!file || !String(file.type).startsWith("image/")) throw new Error("bukan-gambar");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("gagal-baca"));
      i.src = url;
    });
    let side = 720;
    for (let round = 0; round < 6; round++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      for (let q = 0.82; q >= 0.38; q -= 0.1) {
        const out = c.toDataURL("image/jpeg", q);
        if (out.length <= MAX_FOTO) return out;
      }
      side = Math.round(side * 0.8);
    }
    throw new Error("terlalu-besar");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- Auth: bikin akun lewat secondary app (admin tidak ke-logout) ---------- */
async function buatAkunAuth(mainAuth, email, password) {
  const app2 = initializeApp(mainAuth.app.options, `akun-${Date.now()}`);
  try {
    const a2 = getAuth(app2);
    const cred = await createUserWithEmailAndPassword(a2, email, password);
    const uid = cred.user.uid;
    await signOut(a2).catch(() => {});
    return uid;
  } finally {
    deleteApp(app2).catch(() => {});
  }
}

function authError(code) {
  switch (code) {
    case "auth/email-already-in-use": return "Email sudah terdaftar.";
    case "auth/invalid-email": return "Format email tidak valid.";
    case "auth/weak-password": return "Password terlalu lemah (minimal 6 karakter).";
    case "auth/network-request-failed": return "Koneksi internet bermasalah.";
    case "auth/too-many-requests": return "Terlalu banyak percobaan. Coba lagi nanti.";
    default: return "Gagal membuat akun login.";
  }
}

/* ---------- Normalisasi dokumen (buang Timestamp supaya aman masuk cache) ---------- */
function norm(d) {
  const x = d.data();
  return {
    id: d.id,
    nama: x.nama || "",
    alamat: x.alamat || "",
    tglLahir: x.tglLahir || "",
    nik: x.nik || "",
    email: x.email || "",
    foto: x.foto || "",
    role: x.role,
    idCabang: x.idCabang,
    status: x.status !== false,
    createdAtMs: x.createdAt?.toMillis ? x.createdAt.toMillis() : 0
  };
}

/* ---------- Mount ---------- */
export function mount(el, ctx) {
  const { db, auth, profile } = ctx;
  const idCabang = profile?.idCabang ? String(profile.idCabang) : "";
  const cacheKey = `list:${idCabang}`;

  let alive = true;
  let users = [];
  let keyword = "";
  let filter = "all";            // all | sales | kurir
  let showOff = false;           // section nonaktif terbuka?
  let sheetEl = null;
  let sheetPushed = false;
  let busy = false;

  el.innerHTML = `
    <section class="v-ak">
      <button class="ak-add" type="button" id="akAdd">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <span>Tambah Akun</span>
      </button>
      <div class="ak-tools">
        <input class="ak-search" id="akSearch" type="search" placeholder="Cari nama atau email" autocomplete="off">
        <div class="ak-chips" id="akChips">
          <button type="button" class="ak-chip on" data-f="all">Semua</button>
          <button type="button" class="ak-chip" data-f="sales">Sales</button>
          <button type="button" class="ak-chip" data-f="kurir">Kurir</button>
          <button type="button" class="ak-chip" data-f="konsumen">Konsumen</button>
        </div>
      </div>
      <div id="akList"></div>
    </section>`;
  const listEl = el.querySelector("#akList");

  /* ===== LIST ===== */
  const avatar = (u, big) => u.foto
    ? `<img class="ak-avatar${big ? " big" : ""}" src="${esc(u.foto)}" alt="">`
    : `<span class="ak-avatar${big ? " big" : ""}">${esc(inisial(u))}</span>`;

  const cardHtml = (u) => `
    <button class="ak-item${u.status ? "" : " off"}" type="button" data-id="${esc(u.id)}">
      ${avatar(u)}
      <span class="ak-item-main">
        <span class="ak-item-name">${esc(namaUser(u))}</span>
        <span class="ak-item-sub">
          <span class="ak-role ${esc(u.role)}">${esc(u.role)}</span>
          <span class="ak-item-mail">${esc(u.role === "konsumen" ? "tanpa login" : u.email)}</span>
        </span>
      </span>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;

  function skeleton() {
    listEl.innerHTML = `<div class="ak-list">${Array.from({ length: 5 }, () => `
      <div class="ak-item skel-row">
        <span class="ak-avatar skel"></span>
        <span class="ak-item-main">
          <span class="skel ak-skel-name"></span>
          <span class="skel ak-skel-sub"></span>
        </span>
      </div>`).join("")}</div>`;
  }

  function paintList() {
    if (!alive) return;
    const k = keyword.trim().toLowerCase();
    const cocok = users.filter((u) =>
      (filter === "all" || u.role === filter) &&
      (!k || String(u.nama).toLowerCase().includes(k) || String(u.email).toLowerCase().includes(k)));
    const aktif = cocok.filter((u) => u.status);
    const nonaktif = cocok.filter((u) => !u.status);

    if (!users.length) {
      listEl.innerHTML = `<div class="ak-empty">Belum ada akun sales atau kurir di cabang ini.<br>Ketuk "Tambah Akun" untuk membuat.</div>`;
      return;
    }

    listEl.innerHTML = `
      <div class="ak-count">${aktif.length} akun aktif</div>
      ${aktif.length
        ? `<div class="ak-list">${aktif.map(cardHtml).join("")}</div>`
        : `<div class="ak-empty">Tidak ada akun aktif yang cocok.</div>`}
      ${nonaktif.length ? `
        <button class="ak-off-head${showOff ? " open" : ""}" type="button" id="akOffToggle">
          <span>Nonaktif (${nonaktif.length})</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        ${showOff ? `<div class="ak-list">${nonaktif.map(cardHtml).join("")}</div>` : ""}` : ""}`;
  }

  async function load() {
    if (!idCabang) {
      listEl.innerHTML = `<div class="ak-empty">Akun ini belum punya idCabang.</div>`;
      return;
    }

    const cached = await idbGet(cacheKey);
    if (!alive) return;
    if (cached?.users) { users = cached.users; paintList(); } else { skeleton(); }

    try {
      const snap = await getDocs(query(
        collection(db, "users"),
        where("idCabang", "==", idCabang),
        where("role", "in", ROLES)
      ));
      if (!alive) return;
      users = snap.docs.map(norm).sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
      idbSet(cacheKey, { users });
      paintList();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      if (!cached) listEl.innerHTML = `<div class="ak-empty">Gagal memuat daftar akun. Cek aturan Firestore & koneksi.</div>`;
      toast("Gagal memuat daftar akun.", "error");
    }
  }

  function simpanLokal(u) {
    const i = users.findIndex((x) => x.id === u.id);
    if (i >= 0) users[i] = u; else users.push(u);
    users.sort((a, b) => namaUser(a).localeCompare(namaUser(b), "id"));
    idbSet(cacheKey, { users });
    paintList();
  }

  /* ===== KONFIRMASI (popup custom, pengganti confirm()) ===== */
  function konfirmasi({ title, text, ok = "Ya", danger = false }) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "alert-overlay";
      ov.innerHTML = `
        <div class="alert-box warning" role="alertdialog" aria-modal="true">
          <div class="alert-icon">!</div>
          <div class="alert-title"></div>
          <div class="alert-text"></div>
          <div class="ak-btn-row">
            <button class="ak-btn-ghost" type="button" data-v="0">Batal</button>
            <button class="alert-btn${danger ? " ak-danger" : ""}" type="button" data-v="1"></button>
          </div>
        </div>`;
      ov.querySelector(".alert-title").textContent = title;
      ov.querySelector(".alert-text").textContent = text;
      ov.querySelector('[data-v="1"]').textContent = ok;
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => done(b.dataset.v === "1")));
      document.body.appendChild(ov);
    });
  }

  /* ===== SHEET ===== */
  function openSheet() {
    if (sheetEl) return;
    sheetEl = document.createElement("div");
    sheetEl.className = "ak-sheet-wrap";
    sheetEl.innerHTML = `
      <div class="ak-sheet-backdrop"></div>
      <div class="ak-sheet" role="dialog" aria-label="Akun">
        <div class="ak-sheet-grip"></div>
        <div class="ak-sheet-body" id="akSheetBody"></div>
      </div>`;
    sheetEl.querySelector(".ak-sheet-backdrop").addEventListener("click", () => closeSheet());
    document.body.appendChild(sheetEl);
    sheetEl.getBoundingClientRect();
    const node = sheetEl;
    requestAnimationFrame(() => { if (sheetEl === node) node.classList.add("show"); });
    history.pushState({ ak: 1 }, "");
    sheetPushed = true;
  }

  function closeSheet(fromPop) {
    if (!sheetEl) return;
    const node = sheetEl;
    sheetEl = null;
    node.classList.remove("show");
    setTimeout(() => node.remove(), 240);
    if (sheetPushed) {
      sheetPushed = false;
      if (!fromPop && history.state && history.state.ak) history.back();
    }
  }

  const sheetBody = () => sheetEl?.querySelector("#akSheetBody");

  /* ===== DETAIL ===== */
  function showDetail(u) {
    openSheet();
    const b = sheetBody();
    b.scrollTop = 0;
    b.innerHTML = `
      <div class="ak-d-head">
        ${avatar(u, true)}
        <div class="ak-d-name">${esc(namaUser(u))}</div>
        <div class="ak-d-badges">
          <span class="ak-role ${esc(u.role)}">${esc(u.role)}</span>
          <span class="ak-state ${u.status ? "on" : "off"}">${u.status ? "Aktif" : "Nonaktif"}</span>
        </div>
      </div>
      <div class="ak-rows">
        ${u.role === "konsumen" ? `
        <div class="ak-row"><span>Login</span><b>Tanpa login</b></div>
        <div class="ak-row"><span>Dipakai untuk</span><b>Pembeli langsung di tempat produksi</b></div>` : `
        <div class="ak-row"><span>Email</span><b>${esc(u.email || "-")}</b></div>
        <div class="ak-row"><span>Alamat</span><b>${esc(u.alamat || "-")}</b></div>
        <div class="ak-row"><span>Tanggal lahir</span><b>${esc(tglIndo(u.tglLahir))}</b></div>
        <div class="ak-row"><span>NIK</span><b>${esc(u.nik || "-")}</b></div>`}
        <div class="ak-row"><span>Dibuat</span><b>${esc(waktuIndo(u.createdAtMs))}</b></div>
      </div>
      <div class="ak-actions">
        <button class="ak-btn" type="button" id="akEdit">Edit data</button>
        <button class="ak-btn ${u.status ? "danger" : "success"}" type="button" id="akToggle">${u.status ? "Nonaktifkan akun" : "Aktifkan akun"}</button>
        <button class="ak-btn-ghost" type="button" id="akClose">Tutup</button>
      </div>`;
    b.querySelector("#akEdit").addEventListener("click", () => showForm(u));
    b.querySelector("#akClose").addEventListener("click", () => closeSheet());
    b.querySelector("#akToggle").addEventListener("click", () => toggleStatus(u));
  }

  async function toggleStatus(u) {
    if (busy) return;
    const target = !u.status;
    const ok = await konfirmasi(target
      ? { title: "Aktifkan akun?", text: u.role === "konsumen" ? `${namaUser(u)} bisa dipilih lagi di Data Harian.` : `${namaUser(u)} bisa login dan bekerja lagi.`, ok: "Aktifkan" }
      : { title: "Nonaktifkan akun?", text: u.role === "konsumen" ? `${namaUser(u)} tidak akan muncul untuk input Data Harian sampai diaktifkan lagi.` : `${namaUser(u)} tidak akan bisa mengakses data sampai diaktifkan lagi.`, ok: "Nonaktifkan", danger: true });
    if (!ok || !alive) return;

    busy = true;
    const btn = sheetBody()?.querySelector("#akToggle");
    if (btn) btn.disabled = true;
    try {
      await updateDoc(doc(db, "users", u.id), { status: target, updatedAt: serverTimestamp() });
      const baru = { ...u, status: target };
      simpanLokal(baru);
      toast(target ? "Akun diaktifkan." : "Akun dinonaktifkan.", "success");
      if (sheetEl) showDetail(baru);
    } catch (err) {
      console.error(err);
      if (btn) btn.disabled = false;
      toast(err?.code === "permission-denied"
        ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui."
        : "Gagal mengubah status akun.", "error", 4500);
    } finally {
      busy = false;
    }
  }

  /* ===== FORM (tambah / edit) ===== */
  function showForm(u) {
    const edit = !!u;
    openSheet();
    const b = sheetBody();
    b.scrollTop = 0;

    let foto = edit ? (u.foto || "") : "";
    let role = edit ? u.role : "sales";

    b.innerHTML = `
      <div class="ak-f-title">${edit ? "Edit Akun" : "Tambah Akun"}</div>

      <div class="ak-photo" data-full>
        <div id="akPhotoPrev"></div>
        <div class="ak-photo-side">
          <button class="ak-btn small" type="button" id="akPick">Pilih dari galeri</button>
          <button class="ak-link" type="button" id="akPhotoDel">Hapus foto</button>
          <small id="akPhotoInfo"></small>
        </div>
        <input type="file" id="akFile" accept="image/*" class="ak-hidden">
      </div>

      <div class="ak-field">
        <label>Role</label>
        <div class="ak-seg${edit ? " locked" : ""}" id="akRole">
          ${ROLES.map((r) => `<button type="button" class="ak-seg-btn${r === role ? " on" : ""}" data-r="${r}">${r}</button>`).join("")}
        </div>
      </div>

      <div class="ak-field">
        <label for="akNama">Nama</label>
        <input id="akNama" type="text" maxlength="100" autocomplete="off" value="${edit ? esc(u.nama) : ""}">
        <small class="ak-hint ak-hidden" id="akKonsHint">Akun konsumen tanpa login, dipakai untuk mencatat pembelian langsung di tempat produksi. Hanya satu per cabang.</small>
      </div>
      <div class="ak-field" data-full>
        <label for="akAlamat">Alamat</label>
        <textarea id="akAlamat" rows="3" maxlength="300">${edit ? esc(u.alamat) : ""}</textarea>
      </div>
      <div class="ak-field" data-full>
        <label for="akTgl">Tanggal lahir</label>
        <input id="akTgl" type="date" max="${todayStr()}" value="${edit ? esc(u.tglLahir) : ""}">
      </div>
      <div class="ak-field" data-full>
        <label for="akNik">NIK (16 digit)</label>
        <input id="akNik" type="text" inputmode="numeric" maxlength="16" autocomplete="off" value="${edit ? esc(u.nik) : ""}">
      </div>
      <div class="ak-field" data-full>
        <label for="akEmail">Email</label>
        <input id="akEmail" type="email" autocomplete="off"${edit ? " readonly" : ""} value="${edit ? esc(u.email) : ""}">
        ${edit ? `<small class="ak-hint">Email tidak bisa diubah.</small>` : ""}
      </div>
      ${edit ? "" : `
      <div class="ak-field" data-full>
        <label for="akPass">Password</label>
        <div class="ak-pass">
          <input id="akPass" type="password" autocomplete="new-password" placeholder="Minimal 6 karakter">
          <button class="ak-eye" type="button" id="akEye">Lihat</button>
        </div>
        <small class="ak-hint">Password hanya dipakai untuk membuat login, tidak disimpan di data.</small>
      </div>`}

      <div class="ak-actions">
        <button class="ak-btn primary" type="button" id="akSave">${edit ? "Simpan perubahan" : "Buat akun"}</button>
        <button class="ak-btn-ghost" type="button" id="akCancel">${edit ? "Batal" : "Tutup"}</button>
      </div>`;

    const $ = (id) => b.querySelector(id);
    const prev = $("#akPhotoPrev");
    const info = $("#akPhotoInfo");
    const del = $("#akPhotoDel");

    function paintFoto() {
      prev.innerHTML = foto
        ? `<img class="ak-avatar big" src="${esc(foto)}" alt="">`
        : `<span class="ak-avatar big">${esc((($("#akNama").value || "?").trim().charAt(0) || "?").toUpperCase())}</span>`;
      info.textContent = foto ? `Ukuran ${kb(foto.length)} (maks 200 KB)` : "Foto opsional, maks 200 KB";
      del.classList.toggle("ak-hidden", !foto);
    }
    paintFoto();

    $("#akPick").addEventListener("click", () => $("#akFile").click());
    del.addEventListener("click", () => { foto = ""; paintFoto(); });
    $("#akFile").addEventListener("change", async (e) => {
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

    // konsumen: hanya nama (tanpa foto, alamat, tanggal lahir, NIK, email, password)
    function sesuaikanRole() {
      const k = role === "konsumen";
      b.querySelectorAll("[data-full]").forEach((n) => n.classList.toggle("ak-hidden", k));
      $("#akKonsHint").classList.toggle("ak-hidden", !k);
    }
    sesuaikanRole();

    $("#akRole").addEventListener("click", (e) => {
      const btn = e.target.closest(".ak-seg-btn");
      if (!btn || edit) return;
      if (btn.dataset.r === "konsumen" && users.some((x) => x.role === "konsumen")) {
        toast("Akun konsumen sudah ada di cabang ini.", "warning", 3500);
        return;
      }
      role = btn.dataset.r;
      b.querySelectorAll(".ak-seg-btn").forEach((x) => x.classList.toggle("on", x === btn));
      sesuaikanRole();
    });

    const eye = $("#akEye");
    if (eye) eye.addEventListener("click", () => {
      const p = $("#akPass");
      const show = p.type === "password";
      p.type = show ? "text" : "password";
      eye.textContent = show ? "Sembunyikan" : "Lihat";
    });

    $("#akNik").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 16); });
    $("#akCancel").addEventListener("click", () => { if (edit) showDetail(u); else closeSheet(); });

    b.querySelectorAll("input, textarea").forEach((i) => i.addEventListener("input", () => i.classList.remove("invalid")));

    $("#akSave").addEventListener("click", () => simpan());

    function gagal(idInput, msg) {
      toast(msg, "warning", 3500);
      const i = idInput ? $(idInput) : null;
      if (i) { i.classList.add("invalid"); i.focus(); }
    }

    // Akun konsumen: tanpa Firebase Auth, id dokumen tetap `konsumen_{idCabang}` (jadi hanya satu per cabang)
    async function simpanKonsumen(nama) {
      busy = true;
      const btn = $("#akSave");
      const label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      const reset = () => { busy = false; btn.disabled = false; btn.textContent = label; };
      try {
        if (edit) {
          await updateDoc(doc(db, "users", u.id), { nama, updatedAt: serverTimestamp() });
          const baru = { ...u, nama };
          simpanLokal(baru);
          toast("Perubahan tersimpan.", "success");
          busy = false;
          if (sheetEl) showDetail(baru);
          return;
        }

        const id = `konsumen_${idCabang}`;
        if (users.some((x) => x.role === "konsumen")) { reset(); return gagal(null, "Akun konsumen sudah ada di cabang ini."); }

        await setDoc(doc(db, "users", id), {
          id, role: "konsumen", nama, idCabang, status: true, createdAt: serverTimestamp()
        });
        const baru = {
          id, role: "konsumen", nama, alamat: "", tglLahir: "", nik: "", email: "", foto: "",
          idCabang, status: true, createdAtMs: Date.now()
        };
        simpanLokal(baru);
        toast("Akun konsumen dibuat.", "success");
        busy = false;
        if (sheetEl) showDetail(baru);
      } catch (err) {
        console.error(err);
        reset();
        toast(err?.code === "permission-denied"
          ? "Ditolak aturan Firestore (rules belum diperbarui, atau akun konsumen sudah ada)."
          : "Gagal menyimpan. Coba lagi.", "error", 4500);
      }
    }

    async function simpan() {
      if (busy) return;

      const nama = $("#akNama").value.trim();
      const alamat = $("#akAlamat").value.trim();
      const tglLahir = $("#akTgl").value;
      const nik = $("#akNik").value.trim();
      const email = $("#akEmail").value.trim().toLowerCase();
      const password = edit ? "" : $("#akPass").value;

      if (!idCabang) return gagal(null, "Akun admin belum punya idCabang.");
      if (!ROLES.includes(role)) return gagal(null, "Role tidak valid.");
      if (nama.length < 2) return gagal("#akNama", "Nama minimal 2 karakter.");
      if (role === "konsumen") return simpanKonsumen(nama);
      if (alamat.length < 3) return gagal("#akAlamat", "Alamat wajib diisi.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tglLahir) || tglLahir > todayStr()) return gagal("#akTgl", "Tanggal lahir tidak valid.");
      if (!/^\d{16}$/.test(nik)) return gagal("#akNik", "NIK harus 16 digit angka.");
      if (!edit) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return gagal("#akEmail", "Format email tidak valid.");
        if (password.length < 6) return gagal("#akPass", "Password minimal 6 karakter.");
      }
      if (foto && foto.length > MAX_FOTO) return gagal(null, "Foto lebih dari 200 KB, pilih ulang.");

      busy = true;
      const btn = $("#akSave");
      const label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      const reset = () => { busy = false; btn.disabled = false; btn.textContent = label; };

      try {
        // NIK harus unik di cabang (cek langsung ke server, bukan dari cache)
        const dup = await getDocs(query(
          collection(db, "users"),
          where("idCabang", "==", idCabang),
          where("role", "in", ROLES),
          where("nik", "==", nik)
        ));
        if (dup.docs.some((d) => !edit || d.id !== u.id)) {
          reset();
          return gagal("#akNik", "NIK ini sudah dipakai akun lain di cabang.");
        }

        if (edit) {
          await updateDoc(doc(db, "users", u.id), {
            nama, alamat, tglLahir, nik, foto, updatedAt: serverTimestamp()
          });
          const baru = { ...u, nama, alamat, tglLahir, nik, foto };
          simpanLokal(baru);
          toast("Perubahan tersimpan.", "success");
          busy = false;
          if (sheetEl) showDetail(baru);
          return;
        }

        // 1) login dibuat lewat secondary app
        let uid;
        try {
          uid = await buatAkunAuth(auth, email, password);
        } catch (err) {
          console.error(err);
          reset();
          return gagal("#akEmail", authError(err.code));
        }

        // 2) dokumen users/{uid}
        const data = {
          id: uid, role, nama, alamat, tglLahir, nik, email, foto,
          idCabang, status: true, createdAt: serverTimestamp()
        };
        try {
          await setDoc(doc(db, "users", uid), data);
        } catch (err) {
          console.error(err);
          reset();
          await alertBox({
            title: "Data Belum Tersimpan",
            text: "Login untuk email ini sudah terbuat, tapi data akun gagal disimpan (cek aturan Firestore). Hubungi admin pusat sebelum mencoba email yang sama.",
            type: "error"
          });
          return;
        }

        const baru = {
          id: uid, role, nama, alamat, tglLahir, nik, email, foto,
          idCabang, status: true, createdAtMs: Date.now()
        };
        simpanLokal(baru);
        toast("Akun berhasil dibuat.", "success");
        busy = false;
        if (sheetEl) showDetail(baru);
      } catch (err) {
        console.error(err);
        reset();
        toast(err?.code === "permission-denied"
          ? "Ditolak aturan Firestore. Pastikan rules sudah diperbarui."
          : "Gagal menyimpan. Coba lagi.", "error", 4500);
      }
    }
  }

  /* ===== Event ===== */
  el.querySelector("#akAdd").addEventListener("click", () => showForm(null));

  el.querySelector("#akSearch").addEventListener("input", (e) => {
    keyword = e.target.value;
    paintList();
  });

  el.querySelector("#akChips").addEventListener("click", (e) => {
    const c = e.target.closest(".ak-chip");
    if (!c) return;
    filter = c.dataset.f;
    el.querySelectorAll(".ak-chip").forEach((x) => x.classList.toggle("on", x === c));
    paintList();
  });

  listEl.addEventListener("click", (e) => {
    if (e.target.closest("#akOffToggle")) { showOff = !showOff; paintList(); return; }
    const item = e.target.closest(".ak-item[data-id]");
    if (!item) return;
    const u = users.find((x) => x.id === item.dataset.id);
    if (u) showDetail(u);
  });

  // Tombol back (Android / browser) menutup sheet
  const onPop = () => { if (alive && sheetEl) closeSheet(true); };
  window.addEventListener("popstate", onPop);
  if (history.state && history.state.ak) history.replaceState(null, "");

  load();

  return () => {
    alive = false;
    window.removeEventListener("popstate", onPop);
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
  };
}
