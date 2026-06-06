// src/lib/firebase/admin.ts
import { initializeApp, getApps, cert, ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage"; // <--- 1. NOWY IMPORT DLA STORAGE

// Dodano .trim() do zmiennych, aby uciąć ukryte spacje i entery z Windowsa!
const serviceAccount: ServiceAccount = {
    projectId: process.env.FIREBASE_ADMIN_PROJECT_ID?.trim(),
    clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim(),
    privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim(),
};

const adminApp = getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0];

export const adminDb = getFirestore(adminApp);
export const adminAuth = getAuth(adminApp);
export const adminStorage = getStorage(adminApp); // <--- 2. NOWY EKSPORT DLA STORAGE