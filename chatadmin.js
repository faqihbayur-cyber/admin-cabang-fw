// chatadmin.js — inbox chat pelanggan anonim (web adminCabang)
// Sumber data (baca saja): chats/{uid} dan chats/{uid}/messages/{id}
// Semua tulisan lewat Cloud Functions: balasPesan, tutupChat, tandaiDibaca (App Check wajib).
// Tab WhatsApp (baca saja): wa_customers/{nomor} dan wa_messages (phone, role, text, createdAt).
// Pasang: taruh di folder yang sama dengan visitors.js dan ui.js, lalu daftarkan seperti visitors.js (export mount + css).
import { getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  collection, query, where, orderBy, limit, limitToLast, onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { toast, confirmBox } from "./ui.js";

export const css = new URL("./chatadmin.css", import.meta.url).href;

const SITE_KEY = "6LfU2xQuAAAAANTKwl3Nh38L2P4qHkP3VAjET6p-"; // reCAPTCHA Enterprise (App Check)
const VAPID = "BIM_grMV1aJktQboW2T216jLrMvQPddngtAZCeTE4vO_l56iB5Mis_d2IJr1UeqLIJ5AMHr72tqHqqvd7SSEiiI"; // kunci publik Web Push (FCM)
const REGION = "asia-southeast2";
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const p2 = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function waktu(ts, panjang) {
  try {
    const d = ts && ts.toDate ? ts.toDate() : null;
    if (!d) return "";
    const n = new Date();
    const jam = `${p2(d.getHours())}.${p2(d.getMinutes())}`;
    if (d.toDateString() === n.toDateString()) return jam;
    return `${d.getDate()} ${BULAN[d.getMonth()]}${panjang ? " " + jam : ""}`;
  } catch (e) { return ""; }
}

function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = new AC(), o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.frequency.value = 880; g.gain.value = 0.05;
    o.start();
    setTimeout(() => { o.stop(); c.close(); }, 180);
  } catch (e) { /* browser memblokir suara sebelum ada interaksi */ }
}

function pesanError(e) {
  const c = ((e && e.code) || "").replace("functions/", "");
  if (["invalid-argument", "resource-exhausted", "not-found", "permission-denied"].includes(c) && e.message) return e.message;
  console.error(e);
  return "Gagal terhubung. Coba lagi sebentar.";
}

export function mount(el, ctx) {
  const { db } = ctx;
  const app = getApps()[0];
  let alive = true;
  let unsubList = null, unsubMsgs = null;
  const chats = new Map();      // uid -> data chat
  let filter = "aktif";         // aktif | tutup
  let sel = null;               // uid chat yang dibuka
  let msgs = [];
  let first = true;             // snapshot pertama tidak memicu notifikasi
  let sending = false;
  const marking = new Set();
  const waChats = new Map();    // nomor -> data wa_customers
  let selWa = null;             // nomor WA yang dibuka
  let waMsgs = [];
  let unsubWa = null, unsubWaMsgs = null;
  let waErr = false;

  try {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(SITE_KEY), isTokenAutoRefreshEnabled: true });
  } catch (e) { /* App Check sudah aktif di app ini */ }
  const fns = getFunctions(app, REGION);
  const call = (n, d) => httpsCallable(fns, n)(d || {});

  /* ---------- notifikasi push perangkat admin ---------- */
  const pushOk = () => ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  const iosTanpa = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !("Notification" in window);
  async function daftarToken() {
    const reg = await navigator.serviceWorker.ready;
    const M = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js");
    if (!(await M.isSupported())) return false;
    const token = await M.getToken(M.getMessaging(app), { vapidKey: VAPID, serviceWorkerRegistration: reg });
    if (!token) return false;
    await call("daftarPush", { token });
    return true;
  }
  function pushHtml() {
    if (pushOk()) {
      if (Notification.permission === "default") return `<div class="ch-push"><p>Aktifkan notifikasi supaya chat baru tetap masuk walau aplikasi ditutup.</p><button type="button" data-a="push">Aktifkan notifikasi</button></div>`;
      if (Notification.permission === "denied") return `<div class="ch-push"><p>Notifikasi diblokir di browser ini. Buka pengaturan situs, lalu izinkan notifikasi.</p></div>`;
      return "";
    }
    if (iosTanpa()) return `<div class="ch-push"><p>Untuk notifikasi di iPhone, pasang web ini ke Layar Utama lewat tombol Bagikan, lalu buka dari ikonnya.</p></div>`;
    return "";
  }
  async function aktifkanPush() {
    try {
      const izin = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (izin !== "granted") toast("Izin notifikasi tidak diberikan.", "warning");
      else if (await daftarToken()) toast("Notifikasi aktif di perangkat ini.", "success");
      else toast("Perangkat ini belum mendukung notifikasi.", "warning");
    } catch (e) { console.error(e); toast("Gagal mengaktifkan notifikasi.", "error"); }
    paintList();
  }
  if (pushOk() && Notification.permission === "granted") daftarToken().catch(() => {});

  el.innerHTML = `
    <section class="ch" id="chRoot">
      <div class="ch-list" id="chList"></div>
      <div class="ch-thread" id="chThread"></div>
    </section>`;
  const $ = (s) => el.querySelector(s);
  const root = $("#chRoot"), listEl = $("#chList"), thrEl = $("#chThread");

  const nama = (c, uid) => (c.order && c.order.nama) || `Pengunjung ${String(uid).slice(-4)}`;
  const unreadTotal = () => { let n = 0; chats.forEach((c) => { n += c.unreadAdmin || 0; }); return n; };

  /* ---------- daftar WhatsApp ---------- */
  const msOf = (t) => (t && t.toMillis && t.toMillis()) || 0;
  function waRows() {
    const arr = [...waChats.entries()].sort((a, b) => msOf(b[1].updatedAt) - msOf(a[1].updatedAt));
    if (!arr.length) return `<div class="ch-empty">${waErr ? "Gagal memuat chat WhatsApp. Cek aturan Firestore (wa_customers)." : "Belum ada chat WhatsApp."}</div>`;
    return arr.map(([ph, c]) => {
      const bot = c.aiMode === "on";
      return `
      <button type="button" class="ch-item${ph === selWa ? " on" : ""}" data-wa="${esc(ph)}">
        <div class="ch-i1"><b>${esc(c.name || ph)}</b><span>${esc(waktu(c.updatedAt))}</span></div>
        <div class="ch-i2"><span class="ch-prev">${c.lastRole === "ai" ? "AI: " : ""}${esc(c.lastMessage || "")}</span></div>
        <span class="ch-tag${bot ? "" : " adm"}">${bot ? "Bot AI" : "Dipegang admin"}</span>
      </button>`;
    }).join("");
  }

  /* ---------- daftar ---------- */
  function paintList() {
    const arr = [...chats.entries()]
      .filter(([, c]) => (filter === "tutup") === (c.status === "closed"))
      .sort((a, b) => ((b[1].updatedAt && b[1].updatedAt.toMillis && b[1].updatedAt.toMillis()) || 0) - ((a[1].updatedAt && a[1].updatedAt.toMillis && a[1].updatedAt.toMillis()) || 0));
    const un = unreadTotal();
    try {
      if ("setAppBadge" in navigator) { const r = un > 0 ? navigator.setAppBadge(un) : navigator.clearAppBadge(); if (r && r.catch) r.catch(() => {}); }
    } catch (e) { /* badge tidak didukung */ }
    const rows = arr.map(([uid, c]) => `
      <button type="button" class="ch-item${uid === sel ? " on" : ""}" data-uid="${esc(uid)}">
        <div class="ch-i1"><b>${esc(nama(c, uid))}</b><span>${esc(waktu(c.updatedAt))}</span></div>
        <div class="ch-i2"><span class="ch-prev">${c.lastFrom === "admin" ? "Anda: " : ""}${esc(c.lastMessage || "")}</span>
          ${c.unreadAdmin > 0 ? `<i class="ch-bd">${c.unreadAdmin > 9 ? "9+" : c.unreadAdmin}</i>` : ""}</div>
        ${c.order ? `<span class="ch-tag">Pesanan${c.order.kodePromo ? " · " + esc(c.order.kodePromo) : ""}</span>` : ""}
      </button>`).join("");
    listEl.innerHTML = `
      <div class="ch-top"><b>Chat pelanggan</b><span>${un > 0 ? un + " belum dibaca" : "semua terbaca"}</span></div>
      ${pushHtml()}
      <div class="ch-tabs">
        <button type="button" data-f="aktif" class="${filter === "aktif" ? "on" : ""}">Aktif</button>
        <button type="button" data-f="tutup" class="${filter === "tutup" ? "on" : ""}">Ditutup</button>
        <button type="button" data-f="wa" class="${filter === "wa" ? "on" : ""}">WhatsApp</button>
      </div>
      <div class="ch-rows">${filter === "wa" ? waRows() : rows || `<div class="ch-empty">${filter === "aktif" ? "Belum ada chat aktif." : "Belum ada chat yang ditutup."}</div>`}</div>`;
  }

  /* ---------- percakapan ---------- */
  function buildThread() {
    if (!sel && !selWa) {
      root.classList.remove("thr");
      thrEl.innerHTML = `<div class="ch-empty big">Pilih chat di sebelah kiri.</div>`;
      return;
    }
    root.classList.add("thr");
    if (selWa) {
      thrEl.innerHTML = `
      <div class="ch-th">
        <button type="button" class="ch-back" data-a="back" aria-label="Kembali">‹</button>
        <div class="ch-tt" id="chTitle"></div>
      </div>
      <div class="ch-msgs" id="chMsgs"></div>
      <div class="ch-note" id="chNote"></div>`;
      paintThread();
      return;
    }
    thrEl.innerHTML = `
      <div class="ch-th">
        <button type="button" class="ch-back" data-a="back" aria-label="Kembali">‹</button>
        <div class="ch-tt" id="chTitle"></div>
        <button type="button" class="ch-close" data-a="close" id="chCloseBtn">Tutup chat</button>
      </div>
      <div id="chOrder"></div>
      <div class="ch-msgs" id="chMsgs"></div>
      <div class="ch-note" id="chNote"></div>
      <div class="ch-comp" id="chComp">
        <input id="chInp" maxlength="1000" placeholder="Tulis balasan…" autocomplete="off" enterkeyhint="send">
        <button type="button" data-a="send" id="chSend">Kirim</button>
      </div>`;
    paintThread();
  }

  function paintWaThread() {
    const c = waChats.get(selWa) || {};
    const t = $("#chTitle");
    if (!t) return;
    const bot = c.aiMode === "on";
    t.innerHTML = `<b>${esc(c.name || selWa)}</b><small>${esc(selWa)} · ${bot ? "Bot AI aktif" : "Dipegang admin"}</small>`;
    $("#chNote").textContent = "Chat WhatsApp, hanya lihat. Balas lewat WA Business. Untuk ambil alih dari AI, kirim #ADMIN " + selWa + " dari WA admin pusat.";
    const box = $("#chMsgs");
    const dekat = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = waMsgs.map((m) => `
      <div class="ch-m ${m.role === "user" ? "pg" : "ad"}">${esc(m.text)}<small>${m.role === "user" ? "" : "AI · "}${esc(waktu(m.createdAt, true))}</small></div>`).join("")
      || `<div class="ch-empty">Belum ada pesan.</div>`;
    if (dekat || waMsgs.length < 2) box.scrollTop = box.scrollHeight;
  }

  function paintThread() {
    if (selWa) return paintWaThread();
    if (!sel) return;
    const c = chats.get(sel);
    if (!c) return;
    const t = $("#chTitle");
    if (!t) return;
    t.innerHTML = `<b>${esc(nama(c, sel))}</b><small>${c.status === "closed" ? "Ditutup" : "Aktif"} · mulai ${esc(waktu(c.createdAt, true))}</small>`;
    $("#chCloseBtn").style.display = c.status === "closed" ? "none" : "";

    const o = c.order;
    let lok = "";
    if (o && o.lokasi && typeof o.lokasi.latitude === "number") {
      lok = `<a class="ch-map" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${o.lokasi.latitude},${o.lokasi.longitude}">Buka lokasi di Maps</a>`;
    }
    $("#chOrder").innerHTML = o ? `
      <div class="ch-order">
        <b>Pesanan masuk</b>
        <div>Nama: ${esc(o.nama)}</div>
        ${o.catatan ? `<div>Catatan: ${esc(o.catatan)}</div>` : ""}
        ${o.kodePromo ? `<div>Sumber promosi: ${esc(o.kodePromo)}</div>` : (o.promo ? `<div>Promo: tanpa kode kreator</div>` : "")}
        ${lok}
      </div>` : "";

    const closed = c.status === "closed";
    $("#chNote").textContent = closed ? "Chat ditutup. Kalau pengunjung mengirim pesan lagi, chat terbuka kembali." : "";
    $("#chComp").style.display = closed ? "none" : "";

    const box = $("#chMsgs");
    const dekat = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = msgs.map((m) => `
      <div class="ch-m ${m.from === "admin" ? "ad" : "pg"}">${m.tipe === "order" ? "Pesanan: " : ""}${esc(m.text)}<small>${esc(waktu(m.createdAt, true))}</small></div>`).join("")
      || `<div class="ch-empty">Belum ada pesan.</div>`;
    if (dekat || msgs.length < 2) box.scrollTop = box.scrollHeight;
  }

  function tandaiBaca(uid) {
    const c = chats.get(uid);
    if (!c || !(c.unreadAdmin > 0) || marking.has(uid)) return;
    marking.add(uid);
    call("tandaiDibaca", { uid }).catch(() => {}).then(() => marking.delete(uid));
  }

  function bukaChat(uid) {
    sel = uid; msgs = []; selWa = null; waMsgs = [];
    if (unsubWaMsgs) { unsubWaMsgs(); unsubWaMsgs = null; }
    if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
    buildThread();
    paintList();
    unsubMsgs = onSnapshot(
      query(collection(db, "chats", uid, "messages"), orderBy("createdAt", "asc"), limitToLast(300)),
      (s) => {
        if (!alive || sel !== uid) return;
        msgs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        paintThread();
      },
      (err) => { console.error(err); toast("Gagal memuat percakapan.", "error"); }
    );
    tandaiBaca(uid);
    const i = $("#chInp"); if (i && window.innerWidth >= 900) i.focus();
  }

  function bukaWa(ph) {
    selWa = ph; sel = null; msgs = []; waMsgs = [];
    if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
    if (unsubWaMsgs) { unsubWaMsgs(); unsubWaMsgs = null; }
    buildThread();
    paintList();
    unsubWaMsgs = onSnapshot(
      query(collection(db, "wa_messages"), where("phone", "==", ph), orderBy("createdAt", "desc"), limit(200)),
      (s) => {
        if (!alive || selWa !== ph) return;
        waMsgs = s.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
        paintThread();
      },
      (err) => { console.error(err); toast("Gagal memuat percakapan WhatsApp.", "error"); }
    );
  }

  function tutupView() {
    sel = null; msgs = []; selWa = null; waMsgs = [];
    if (unsubWaMsgs) { unsubWaMsgs(); unsubWaMsgs = null; }
    if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
    buildThread();
    paintList();
  }

  async function kirim() {
    const i = $("#chInp");
    if (!i || sending || !sel) return;
    const text = i.value.trim().replace(/\s+/g, " ");
    if (!text) return;
    sending = true; const b = $("#chSend"); if (b) b.disabled = true;
    try {
      await call("balasPesan", { uid: sel, text });
      i.value = "";
    } catch (e) { toast(pesanError(e), "error"); }
    sending = false;
    const b2 = $("#chSend"); if (b2) b2.disabled = false;
    const i2 = $("#chInp"); if (i2) i2.focus();
  }

  async function tutupChat() {
    if (!sel) return;
    const ok = await confirmBox({ title: "Tutup chat ini?", text: "Pengunjung masih bisa mengirim pesan lagi untuk membukanya kembali.", yes: "Tutup chat", no: "Batal" });
    if (!ok) return;
    try { await call("tutupChat", { uid: sel }); toast("Chat ditutup.", "success"); }
    catch (e) { toast(pesanError(e), "error"); }
  }

  /* ---------- event ---------- */
  el.addEventListener("click", (e) => {
    const w = e.target.closest("[data-wa]");
    if (w) return bukaWa(w.dataset.wa);
    const item = e.target.closest(".ch-item");
    if (item) return bukaChat(item.dataset.uid);
    const f = e.target.closest("[data-f]");
    if (f) {
      const nf = f.dataset.f;
      if ((nf === "wa" && sel) || (nf !== "wa" && selWa)) tutupView();
      filter = nf;
      return paintList();
    }
    const a = e.target.closest("[data-a]");
    if (!a) return;
    if (a.dataset.a === "send") kirim();
    else if (a.dataset.a === "back") tutupView();
    else if (a.dataset.a === "close") tutupChat();
    else if (a.dataset.a === "push") aktifkanPush();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target && e.target.id === "chInp") { e.preventDefault(); kirim(); }
  });

  /* ---------- muat daftar chat ---------- */
  async function mulai() {
    paintList(); buildThread();
    try {
      let prof = ctx.profile || null;
      if (!prof || !prof.role) {
        const auth = getAuth(app);
        const user = auth.currentUser || await new Promise((res) => { const off = onAuthStateChanged(auth, (u) => { off(); res(u); }); });
        if (!user) throw new Error("belum login");
        const ps = await getDoc(doc(db, "users", user.uid));
        prof = ps.exists() ? ps.data() : {};
      }
      if (prof.role !== "admin" && !prof.idCabang) throw new Error("akun tanpa idCabang");
      const base = collection(db, "chats");
      const q = prof.role === "admin"
        ? query(base, orderBy("updatedAt", "desc"), limit(100))
        : query(base, where("idCabang", "==", prof.idCabang), orderBy("updatedAt", "desc"), limit(100));
      unsubList = onSnapshot(q, (s) => {
        if (!alive) return;
        s.docChanges().forEach((ch) => {
          const uid = ch.doc.id, d = ch.doc.data(), prev = chats.get(uid);
          if (ch.type === "removed") { chats.delete(uid); return; }
          if (!first && d.lastFrom === "pengunjung" && (d.unreadAdmin || 0) > ((prev && prev.unreadAdmin) || 0) && uid !== sel) {
            toast(`Chat baru dari ${nama(d, uid)}`, "info", 4000);
            beep();
          }
          chats.set(uid, d);
        });
        first = false;
        paintList();
        if (sel) { paintThread(); tandaiBaca(sel); }
      }, (err) => {
        console.error(err);
        listEl.innerHTML = `<div class="ch-empty">Gagal memuat chat. Cek aturan Firestore (chats) dan index.</div>`;
        toast("Gagal memuat daftar chat.", "error");
      });
      unsubWa = onSnapshot(
        query(collection(db, "wa_customers"), orderBy("updatedAt", "desc"), limit(100)),
        (s) => {
          if (!alive) return;
          waErr = false;
          waChats.clear();
          s.docs.forEach((d) => waChats.set(d.id, d.data()));
          if (filter === "wa") paintList();
          if (selWa) paintThread();
        },
        (err) => { console.error(err); waErr = true; if (filter === "wa") paintList(); }
      );
    } catch (err) {
      console.error(err);
      listEl.innerHTML = `<div class="ch-empty">Gagal memuat chat. Coba muat ulang halaman.</div>`;
    }
  }
  mulai();

  return () => { alive = false; if (unsubList) unsubList(); if (unsubMsgs) unsubMsgs(); if (unsubWa) unsubWa(); if (unsubWaMsgs) unsubWaMsgs(); };
}
