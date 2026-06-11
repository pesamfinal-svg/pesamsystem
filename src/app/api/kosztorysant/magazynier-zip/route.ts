import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
// @ts-ignore - AdmZip może nie mieć wbudowanych typów w niektórych konfiguracjach TS, ignorujemy to ostrzeżenie
import AdmZip from "adm-zip";

export const dynamic = "force-dynamic";

// Słownik pomocniczy do określania typu MIME na podstawie rozszerzenia pliku
function determineMimeType(fileName: string): string {
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
        console.log("[MAGAZYNIER ZIP 📦] Rozpoczynam obsługę żądania uploadu pliku...");

        const contentType = req.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
            console.error("[MAGAZYNIER ZIP 📦] Błąd: Żądanie nie jest typu multipart/form-data.");
            return NextResponse.json({ error: "Żądanie musi być typu multipart/form-data" }, { status: 400 });
        }

        // 1. Parsowanie FormData z żądania
        const formData = await req.formData();
        const files = formData.getAll("file") as File[];
        const marketTrendsRaw = (formData.get("trends") || formData.get("marketTrends")) as string | null;

        console.log(`[MAGAZYNIER ZIP 📦] Odebrano pliki: ${files.length} szt. Narzuty kosztorysowe (raw): ${marketTrendsRaw}`);

        if (files.length === 0) {
            console.error("[MAGAZYNIER ZIP 📦] Błąd: Brak plików w polu 'file'.");
            return NextResponse.json({ error: "Brak plików w żądaniu (pole 'file')" }, { status: 400 });
        }

        // 2. Generowanie unikalnego ID przetargu w bazie danych
        tenderId = adminDb.collection("tenders").doc().id;
        console.log(`[MAGAZYNIER ZIP 📦] Wygenerowano nowe tenderId dla projektu: ${tenderId}`);

        // Parsowanie narzutów rynkowych przesyłanych z suwaków na frontendzie
        const marketTrends = marketTrendsRaw ? JSON.parse(marketTrendsRaw) : {
            laborAdjustment: 0,
            materialAdjustment: 0,
            equipmentAdjustment: 0,
            kp: 65,
            zysk: 12
        };

        // 3. Rejestracja dokumentu głównego przetargu (Standard 1)
        console.log(`[MAGAZYNIER ZIP 📦] Tworzę dokument główny tenders/${tenderId} w bazie Firestore...`);
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

        // 4. Przetwarzanie przesłanych plików (obsługa ZIP lub pojedynczych)
        for (const file of files) {
            console.log(`[MAGAZYNIER ZIP 📦] Przetwarzam plik: ${file.name} (Rozmiar: ${file.size} bajtów, Typ: ${file.type})`);

            const fileArrayBuffer = await file.arrayBuffer();
            const fileBuffer = Buffer.from(new Uint8Array(fileArrayBuffer).buffer);

            if (file.name.endsWith(".zip") || file.type === "application/zip") {
                console.log(`[MAGAZYNIER ZIP 📦] Wykryto plik ZIP: ${file.name}. Rozpakowuję w pamięci RAM...`);

                const zip = new AdmZip(fileBuffer);
                const zipEntries = zip.getEntries();
                console.log(`[MAGAZYNIER ZIP 📦] ZIP zawiera ${zipEntries.length} wpisów.`);

                for (const entry of zipEntries) {
                    // Pomijamy foldery i pliki ukryte systemowo (np. z systemów macOS)
                    if (entry.isDirectory || entry.entryName.startsWith("__MACOSX") || entry.name.startsWith(".")) {
                        console.log(`[MAGAZYNIER ZIP 📦] Pomijam wpis katalogowy lub systemowy: ${entry.entryName}`);
                        continue;
                    }

                    const extractedBuffer = entry.getData();
                    const determinedMime = determineMimeType(entry.name);

                    console.log(`[MAGAZYNIER ZIP 📦] Rozpakowano plik: ${entry.name} (${extractedBuffer.length} bajtów). Typ MIME: ${determinedMime}`);
                    extractedFiles.push({
                        name: entry.name,
                        buffer: extractedBuffer,
                        mime: determinedMime
                    });
                }
            } else {
                console.log(`[MAGAZYNIER ZIP 📦] Wykryto plik pojedynczy: ${file.name}.`);
                extractedFiles.push({
                    name: file.name,
                    buffer: fileBuffer,
                    mime: file.type || determineMimeType(file.name)
                });
            }
        }

        if (extractedFiles.length === 0) {
            console.error("[MAGAZYNIER ZIP 📦] Archiwum ZIP nie zawierało żadnych poprawnych plików.");
            throw new Error("Archiwum ZIP nie zawiera żadnych poprawnych plików.");
        }

        // 5. Zapis plików do Google Cloud Storage i rejestracja metadanych w Firestore
        console.log(`[MAGAZYNIER ZIP 📦] Łącznie do zapisu w Storage przygotowano ${extractedFiles.length} plików.`);

        for (const extracted of extractedFiles) {
            const storagePath = `tenders/${tenderId}/documents/${extracted.name}`;
            const fileRef = bucket.file(storagePath);

            console.log(`[MAGAZYNIER ZIP 📦] Zapisuję fizycznie plik w chmurze GCS: ${storagePath}`);
            await fileRef.save(extracted.buffer, {
                metadata: { contentType: extracted.mime }
            });

            const docRef = adminDb.collection(`tenders/${tenderId}/documents`).doc();
            console.log(`[MAGAZYNIER ZIP 📦] Rejestruję metadane dokumentu w Firestore: ${docRef.id} (${extracted.name})`);

            batch.set(docRef, {
                fileName: extracted.name,
                storagePath,
                mimeType: extracted.mime,
                sizeBytes: extracted.buffer.length,
                status: "UPLOADED",
                createdAt: new Date()
            });
        }

        // Zatwierdzamy transakcję zapisu Firestore w paczce (batch)
        console.log("[MAGAZYNIER ZIP 📦] Zapisuję metadane do Firestore w paczce batch...");
        await batch.commit();
        console.log("[MAGAZYNIER ZIP 📦] Batch zapisany pomyślnie.");

        // 6. Asynchroniczne wybudzenie Fazy 0 (Inicjalizatora i Klasyfikatora dokumentów)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[MAGAZYNIER ZIP 📦] Wybudzam asynchronicznie Klasyfikator (Fazę 0) przez loopback: ${localOrigin}/api/kosztorysant/glowny-kosztorysant/inicjalizuj`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant/inicjalizuj`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId })
        }).catch((err) => {
            console.error("[MAGAZYNIER ZIP 📦] Nie udało się automatycznie wywołać loopbacka Fazy 0:", err);
        });

        console.log("[MAGAZYNIER ZIP 📦] Upload zakończony sukcesem. Zwracam tenderId do klienta.");
        return NextResponse.json({
            success: true,
            tenderId,
            message: `Wgrano pomyślnie ${extractedFiles.length} plików.`
        });

    } catch (error: any) {
        console.error("[MAGAZYNIER ZIP 📦] ❌ Błąd krytyczny Magazyniera ZIP:", error);

        if (tenderId) {
            console.log(`[MAGAZYNIER ZIP 📦] Ze względu na błąd, oznaczam projekt ${tenderId} statusem ERROR.`);
            await adminDb.collection("tenders").doc(tenderId).update({ status: "ERROR" }).catch(() => { });
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}