// ============================================================
// PESAM 3.0 – Magazynier ZIP (Odbiór i rozpakowanie dokumentacji)
// POST /api/kosztorysant/magazynier-zip
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI } from "@google/genai";
// @ts-ignore - Wyłączenie kontroli typów dla biblioteki bez wbudowanych typów TS
import AdmZip from "adm-zip"; // Standardowa i lekka biblioteka do obsługi ZIP w pamięci

export const dynamic = "force-dynamic";

// Funkcja pomocnicza określająca mimeType na podstawie rozszerzenia
function getMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'pdf': return 'application/pdf';
        case 'zip': return 'application/zip';
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'xls':
        case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        default: return 'application/octet-stream';
    }
}

export async function POST(req: Request) {
    let tenderId: string | undefined;

    try {
        console.log("[PESAM 3.0 📦] Magazynier ZIP: Odebrano żądanie przesłania pliku.");

        const contentType = req.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
            return NextResponse.json({ error: "Żądanie musi być typu multipart/form-data" }, { status: 400 });
        }

        // 1. Parsowanie FormData z żądania wejściowego (Obsługa wielu plików)
        const formData = await req.formData();
        const files = formData.getAll("file") as File[];

        // Obsługa obu wariantów kluczy z narzutami ("trends" i "marketTrends")
        const marketTrendsRaw = (formData.get("trends") || formData.get("marketTrends")) as string | null;

        if (files.length === 0) {
            return NextResponse.json({ error: "Brak plików w żądaniu (pole 'file')" }, { status: 400 });
        }

        // 2. Generowanie unikalnego ID przetargu (wykorzystujemy autogenerowane ID z Firestore)
        tenderId = adminDb.collection("tenders").doc().id;
        console.log(`[PESAM 3.0 📦] Generuję unikalne ID przetargu: ${tenderId}`);

        // Odbiór i parsowanie narzutów kosztorysowych
        const marketTrends = marketTrendsRaw ? JSON.parse(marketTrendsRaw) : {
            laborAdjustment: 0,
            materialAdjustment: 0,
            equipmentAdjustment: 0,
            kp: 65,
            zysk: 12
        };

        // 3. Inicjalizacja dokumentu głównego przetargu w bazie danych (Standard 1)
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        await tenderRef.set({
            status: "CLASSIFYING",
            createdAt: new Date(),
            updatedAt: new Date(),
            marketTrends,
            budgetGuard: {
                maxBudgetUSD: 5.0,
                currentCostUSD: 0,
                limitReached: false,
                iterationCount: 0,
                maxIterations: 50
            }
        });

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const batch = adminDb.batch();

        const extractedFiles: Array<{ name: string; buffer: Buffer; mime: string }> = [];

        // 4. Pętla przetwarzająca każdy z przesłanych plików
        for (const file of files) {
            const fileArrayBuffer = await file.arrayBuffer();
            const fileBuffer = Buffer.from(new Uint8Array(fileArrayBuffer).buffer); // Standard 3: Bezpieczna konwersja

            if (file.name.endsWith(".zip") || file.type === "application/zip") {
                console.log(`[PESAM 3.0 📦] Wykryto ZIP "${file.name}". Rozpakowywanie w pamięci...`);

                const zip = new AdmZip(fileBuffer);
                const zipEntries = zip.getEntries();

                for (const entry of zipEntries) {
                    // Pomijamy foldery i pliki ukryte (np. __MACOSX, .DS_Store)
                    if (entry.isDirectory || entry.entryName.startsWith("__MACOSX") || entry.name.startsWith(".")) {
                        continue;
                    }

                    extractedFiles.push({
                        name: entry.name,
                        buffer: entry.getData(),
                        mime: getMimeType(entry.name)
                    });
                }
            } else {
                console.log(`[PESAM 3.0 📦] Wykryto dokument pojedynczy "${file.name}". Przetwarzam bezpośrednio.`);
                extractedFiles.push({
                    name: file.name,
                    buffer: fileBuffer,
                    mime: file.type || getMimeType(file.name)
                });
            }
        }

        if (extractedFiles.length === 0) {
            throw new Error("Archiwum ZIP nie zawiera żadnych poprawnych plików.");
        }

        // 6. Bezpieczny zapis plików do Google Cloud Storage i Firestore
        for (const extracted of extractedFiles) {
            console.log(`[PESAM 3.0 📦] Zapisuję plik: ${extracted.name}`);

            const storagePath = `tenders/${tenderId}/documents/${extracted.name}`;
            const fileRef = bucket.file(storagePath);

            // Zapis bufora do Storage
            await fileRef.save(extracted.buffer, {
                metadata: { contentType: extracted.mime }
            });

            // Rejestracja dokumentu w Firestore (Standard 1: documents podkolekcja)
            const docRef = adminDb.collection(`tenders/${tenderId}/documents`).doc();
            batch.set(docRef, {
                fileName: extracted.name,
                storagePath,
                mimeType: extracted.mime,
                sizeBytes: extracted.buffer.length,
                status: "UPLOADED",
                createdAt: new Date()
            });
        }

        await batch.commit();
        console.log(`[PESAM 3.0 📦] Pomyślnie przetworzono i zarejestrowano ${extractedFiles.length} plików.`);

        // 7. Dynamiczne i asynchroniczne wybudzenie Fazy 0 (Inicjalizacji/Klasyfikacji)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 📦] Wybudzam Fazę 0 lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant/inicjalizuj`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId })
        }).catch(e => console.error("[PESAM 3.0 📦] Błąd wybudzania Fazy 0 po rozpakowaniu:", e));

        // Zwracamy tenderId do frontendu
        return NextResponse.json({
            success: true,
            tenderId,
            message: `Wgrano pomyślnie ${extractedFiles.length} plików.`
        });

    } catch (error: any) {
        console.error("[PESAM 3.0 📦] ❌ Błąd krytyczny Magazyniera ZIP:", error);

        // Zabezpieczenie: oznaczamy status jako błąd, jeśli przetarg został utworzony
        if (tenderId) {
            try {
                await adminDb.collection("tenders").doc(tenderId).update({ status: "ERROR" });
            } catch (dbErr) { }
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}