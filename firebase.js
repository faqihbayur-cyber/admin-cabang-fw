// firebase.js — init Firebase (dipakai semua halaman)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB3UfH10F8SwiEXSZvjTakSxhKoaVo6VCs",
  authDomain: "klien2.firebaseapp.com",
  projectId: "klien2",
  storageBucket: "klien2.firebasestorage.app",
  messagingSenderId: "935807025251",
  appId: "1:935807025251:web:1dc2dbd4765e20f97df856"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
