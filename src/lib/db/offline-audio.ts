// src/lib/db/offline-audio.ts

export interface OfflineRecording {
    id: string;
    siteId: string;
    siteName: string;
    audioBlob: Blob;
    createdAt: string;
    durationSec?: number; 
    status?: "PENDING" | "SENDING" | "DONE" | "ERROR"; 
}

const DB_NAME = "PesamVoiceDB";
const STORE_NAME = "recordings";

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2); 
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveRecordingOffline(recording: OfflineRecording): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(recording);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function getOfflineRecordings(): Promise<OfflineRecording[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

export async function deleteOfflineRecording(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function updateRecordingStatus(id: string, status: "PENDING" | "SENDING" | "DONE" | "ERROR"): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);
        request.onsuccess = () => {
            const rec = request.result;
            if (rec) {
                rec.status = status;
                store.put(rec);
            }
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}