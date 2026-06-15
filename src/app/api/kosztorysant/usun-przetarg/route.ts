import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { tenderId } = await req.json();

        console.log(`[USUWANIE 🗑️] Otrzymano żądanie pełnego usunięcia przetargu: ${tenderId}`);

        if (!tenderId) {
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        // 1. Usunięcie wszystkich fizycznych plików PDF/ZIP z Google Cloud Storage!
        // To kluczowe, żeby nie nabijać rachunków za "osierocone" pliki po usunięciu z DB.
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const folderPrefix = `tenders/${tenderId}/`;

        console.log(`[USUWANIE 🗑️] Kasowanie plików fizycznych ze Storage (ścieżka: ${folderPrefix})...`);
        try {
            await bucket.deleteFiles({ prefix: folderPrefix });
            console.log(`[USUWANIE 🗑️] Pomyślnie wyczyszczono pliki z chmury GCS.`);
        } catch (storageError) {
            console.warn(`[USUWANIE 🗑️] UWAGA: Błąd usuwania plików GCS (może już ich nie było):`, storageError);
        }

        // 2. Usunięcie bazy danych
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // Korzystamy z natywnej, atomowej metody Admin SDK do rekurencyjnego czyszczenia dokumentów wraz z subkolekcjami
        // Ta metoda automatycznie i głęboko usuwa subkolekcje: 'tasks', 'technolog_tasks', 'estimate', 'chat', 'documents', 'technolog' itp.
        console.log(`[USUWANIE 🗑️] Kasowanie rekurencyjne bazy danych Firestore...`);
        await adminDb.recursiveDelete(tenderRef);

        console.log(`[USUWANIE 🗑️] Pomyślnie i bezpowrotnie usunięto projekt ${tenderId} ze wszystkich struktur PESAM.`);

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("[USUWANIE 🗑️] ❌ Błąd krytyczny podczas rekurencyjnego usuwania:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}