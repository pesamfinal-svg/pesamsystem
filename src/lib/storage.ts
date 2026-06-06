import { adminStorage } from "@/lib/firebase/admin";

export async function getFileUrl(storagePath: string): Promise<string> {
    console.log(`[Storage Helper] Generowanie podpisanego URL dla ścieżki: ${storagePath}`);
    try {
        const bucket = adminStorage.bucket(process.env.FIREBASE_STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app");
        const [url] = await bucket.file(storagePath).getSignedUrl({
            action: "read",
            expires: Date.now() + 60 * 60 * 1000, // 1 godzina
        });
        console.log(`[Storage Helper] Sukces. Wygenerowano URL ważny 1h.`);
        return url;
    } catch (error) {
        console.error(`[Storage Helper] Błąd generowania URL dla ${storagePath}:`, error);
        throw error;
    }
}