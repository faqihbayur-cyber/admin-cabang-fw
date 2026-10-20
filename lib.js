// lib.js — helper bersama (dipakai view Customer; view Akun masih punya salinan sendiri)

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const nf = new Intl.NumberFormat("id-ID");
export const fmt = (n) => nf.format(Math.round(Number(n) || 0));
export const rp = (n) => `Rp ${fmt(n)}`;
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const kb = (len) => `${Math.round(len / 1024)} KB`;

/* ---------- Cache IndexedDB ---------- */
function idbOpen(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function createIdb(name) {
  return {
    async get(key) {
      try {
        const d = await idbOpen(name);
        return await new Promise((res) => {
          const q = d.transaction("kv").objectStore("kv").get(key);
          q.onsuccess = () => res(q.result ?? null);
          q.onerror = () => res(null);
        });
      } catch { return null; }
    },
    async set(key, val) {
      try {
        const d = await idbOpen(name);
        await new Promise((res) => {
          const t = d.transaction("kv", "readwrite");
          t.objectStore("kv").put(val, key);
          t.oncomplete = res; t.onerror = res; t.onabort = res;
        });
      } catch { /* abaikan */ }
    }
  };
}

/* ---------- Kompres foto (canvas -> JPEG base64 <= 200 KB) ---------- */
export const MAX_FOTO = 200 * 1024;   // batas panjang string base64 (≈150 KB file asli)

export async function kompresFoto(file) {
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
