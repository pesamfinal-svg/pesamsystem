import { NextResponse } from "next/server";
import { adminStorage } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        let { storagePath } = await req.json();
        if (!storagePath) return NextResponse.json({ error: "Brak ścieżki" }, { status: 400 });

        // --- PRZEZROCZYSTA PODMIANA PODGLĄDU ---
        // Jeśli system pod spodem zoptymalizował plik i wskazał w bazie na .md,
        // my na potrzeby wyświetlenia podglądu PDF na frontendzie zmieniamy ścieżkę na oryginalny .pdf
        if (storagePath.endsWith(".pdf.md")) {
            storagePath = storagePath.replace(".pdf.md", ".pdf");
            console.log(`[PODGLĄD API 👁️] Po cichu przełączono ścieżkę podglądu z Markdown na oryginalny PDF: ${storagePath}`);
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const file = adminStorage.bucket(bucketName).file(storagePath);

        // Generujemy bezpieczny link ważny przez 1 godzinę
        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000,
        });

        return NextResponse.json({ url });
    } catch (e: any) {
        console.error("[PODGLĄD API 👁️] Błąd generowania url:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}