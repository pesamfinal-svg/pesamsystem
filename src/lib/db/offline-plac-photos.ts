// src/lib/db/offline-plac-photos.ts
// Kolejka offline dla zdjęć i resztek z placu (IndexedDB)

export interface PendingPhotoUpload {
    id: string; // np. "PHOTO-1729512345"
    itemId: string; // ID w kolekcji inventory lub "NEW_ITEM"
    itemName: string;
    photoBlob: Blob;
    previewDataUrl?: string; // Data URL do natychmiastowego podglądu na telefonie
    isNewItem?: boolean;
    newItemData?: {
        name: string;
        qty: number;
        unit: string;
        location: string;
        category?: string;
        subcategory?: string;
        notes: string;
    };
    createdAt: string;
    status: "PENDING" | "UPLOADING" | "FAILED";
    errorMessage?: string;
}

const DB_NAME = "PesamPlacDB";
const STORE_NAME = "pending_photos";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof window === "undefined" || !window.indexedDB) {
            return reject(new Error("IndexedDB is not supported"));
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

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

/**
 * Zapisuje oczekujące zdjęcie do IndexedDB w telefonie
 */
export async function savePendingPhoto(item: PendingPhotoUpload): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(item);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Pobiera wszystkie oczekujące zdjęcia z kolejki offline
 */
export async function getPendingPhotos(): Promise<PendingPhotoUpload[]> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return [];
    }
}

/**
 * Usuwa zsynchronizowane zdjęcie z kolejki offline
 */
export async function deletePendingPhoto(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Zwraca liczbę oczekujących na wysłanie zdjęć
 */
export async function getPendingPhotosCount(): Promise<number> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return 0;
    }
}

/**
 * Konwertuje Blob na base64 DataURL (do trwałego podglądu w pamięci podręcznej)
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
