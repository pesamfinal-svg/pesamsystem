// src/lib/firebase/config.ts
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyCE470BBsa3CF-ik4XOjHs939kuLqNJpcc",
    authDomain: "pesam-system-81165.firebaseapp.com",
    projectId: "pesam-system-81165",
    storageBucket: "pesam-system-81165.firebasestorage.app",
    messagingSenderId: "311399925834",
    appId: "1:311399925834:web:08c1252a9089287533beb3",
    measurementId: "G-EK3TYCXR92"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);