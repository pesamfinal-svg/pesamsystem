// src/app/api/kosztorysant/magazynier-zip/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import JSZip from "jszip";
import { adminDb, adminStorage } from "@/lib/firebase/admin"; // Używamy Admin SDK do zapisu

// Budowanie bezpiecznego URL dla wywołań wewnętrznych
function internalUrl(req: NextRequest, path: string): string {
    const url = new URL(req.url);
    // Wewnątrz kontenera Google Cloud komunikacja idzie po HTTP
    if (url.hostname === "0.0.0.0" || url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        url.protocol = "http:";
    }
    return `${url.origin}${path}`;
}

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-3.5-flash";

const SYSTEM_INSTRUCTION = `
  Jesteś Agentem Bibliotekarzem w systemie PESAM. Twoim jedynym zadaniem jest sklasyfikowanie wgranego pliku i wygenerowanie dla niego krótkiego, 1-zdaniowego technicznego podsumowania.
  Zwróć DOKŁADNIE JEDEN obiekt JSON (bez markdown, bez komentarzy):
  {
    "category": "SWZ" | "DRAWING" | "ESTIMATE" | "CONTRACT" | "OTHER",
    "summary": "Jedno krótkie zdanie opisujące techniczny charakter dokumentu."
  }
`;

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Magazynier ZIP] === ROZPOCZĘTO NOWE IMPORTOWANIE ===");
    console.log("==================================================");

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
            console.error("[Magazynier ZIP] Błąd: Brak pliku ZIP w żądaniu.");
            return NextResponse.json({ error: "Brak pliku ZIP w żądaniu." }, { status: 400 });
        }

        console.log(`[Magazynier ZIP] Odczytano metadane pliku: "${file.name}" (${file.size} bajtów).`);

        // Tworzymy unikalne ID dla nowej inwestycji (Tender ID)
        const tenderId = `TND-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const bucket = adminStorage.bucket(process.env.FIREBASE_STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app");

        // Wczytujemy plik ZIP do pamięci RAM
        console.log("[Magazynier ZIP] Wczytuję archiwum do bufora pamięci RAM...");
        const arrayBuffer = await file.arrayBuffer();

        console.log("[Magazynier ZIP] JSZip rozpakowuje archiwum w locie...");
        const zip = await JSZip.loadAsync(arrayBuffer);

        const filesToProcess: { name: string; buffer: Buffer; type: string }[] = [];

        // Przeglądamy pliki wewnątrz ZIP
        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) continue; // Pomijamy foldery

            // Ignorujemy pliki systemowe macOS/Windows (np. __MACOSX, DS_Store)
            if (relativePath.startsWith("__MACOSX") || relativePath.includes(".DS_Store")) {
                console.log(`[Magazynier ZIP] Pominięto plik systemowy: ${relativePath}`);
                continue;
            }

            const fileBuffer = await zipEntry.async("nodebuffer");

            // Proste dopasowanie typu MIME na podstawie rozszerzenia
            let type = "application/octet-stream";
            if (relativePath.endsWith(".pdf")) type = "application/pdf";
            else if (relativePath.endsWith(".xlsx")) type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            else if (relativePath.endsWith(".xls")) type = "application/vnd.ms-excel";
            else if (relativePath.endsWith(".docx")) type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            else if (relativePath.endsWith(".doc")) type = "application/msword";
            else if (relativePath.endsWith(".jpg") || relativePath.endsWith(".jpeg")) type = "image/jpeg";
            else if (relativePath.endsWith(".png")) type = "image/png";

            // Pobieramy samą nazwę pliku (bez ścieżki folderu)
            const fileName = relativePath.split("/").pop() || relativePath;

            console.log(`[Magazynier ZIP] Wyekstrahowano plik: "${fileName}" (Typ: ${type}, rozmiar: ${fileBuffer.length} bajtów)`);
            filesToProcess.push({ name: fileName, buffer: fileBuffer, type });
        }

        console.log(`[Magazynier ZIP] Zakończono rozpakowywanie. Wykryto łącznie ${filesToProcess.length} poprawnych plików do przetworzenia.`);

        // Zakładamy główny dokument przetargu w Firestore
        console.log(`[Magazynier ZIP] Zakładam nowy rekord przetargu w kolekcji "tenders" pod ID: "${tenderId}"...`);
        await adminDb.collection("tenders").doc(tenderId).set({
            id: tenderId,
            name: file.name.replace(".zip", ""),
            status: "ANALYZING",
            createdAt: new Date().toISOString(),
        });

        console.log("[Magazynier ZIP] Inicjalizuję klienta GoogleGenAI...");
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        // Przesyłamy każdy plik na Storage i rejestrujemy w bazie
        for (const item of filesToProcess) {
            const storagePath = `kosztorysy/${tenderId}/${item.name}`;
            const storageFile = bucket.file(storagePath);

            // 1. Zapis na Firebase Cloud Storage
            console.log(`[Magazynier ZIP] Przesyłam plik do Cloud Storage: "${storagePath}"...`);
            await storageFile.save(item.buffer, {
                metadata: { contentType: item.type },
            });

            // Tworzymy podpisany link (URL) ważny przez rok
            const [url] = await storageFile.getSignedUrl({
                action: "read",
                expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
            });
            console.log(`[Magazynier ZIP] Wygenerowano bezpieczny podpisany URL dla: "${item.name}"`);

            // 2. Wywołanie szybkiego Agenta Bibliotekarza (Gemini Flash), aby sklasyfikował plik
            let fileCategory = "OTHER";
            let fileSummary = "Dokument pomocniczy przetargu.";

            try {
                // Przekazujemy modelowi pierwsze 500 bajtów jako tekst do szybkiej analizy
                const previewText = item.buffer.slice(0, 500).toString("utf-8");
                console.log(`[Magazynier ZIP] Wysyłam nagłówek pliku "${item.name}" do klasyfikacji AI...`);

                const response = await ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: [{ role: "user", parts: [{ text: `Plik: ${item.name}. Podgląd nagłówka:\n${previewText}` }] }],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.1,
                        responseMimeType: "application/json",
                    },
                });

                if (response.text) {
                    const [parsed] = extractAllJSONObjects(response.text) as any[];
                    if (parsed) {
                        fileCategory = parsed.category || "OTHER";
                        fileSummary = parsed.summary || fileSummary;
                    }
                }
            } catch (err) {
                console.warn(`[Magazynier ZIP] Ostrzeżenie: Nie udało się sklasyfikować pliku ${item.name} przez AI. Używam domyślnych kategorii.`, err);
            }

            // 3. Zapisujemy plik do podkolekcji w Firestore
            const fileId = `file-${Math.random().toString(36).slice(2, 9)}`;
            console.log(`[Magazynier ZIP] Zapisuję metadane pliku do podkolekcji "files" pod ID: "${fileId}"...`);
            await adminDb.collection("tenders").doc(tenderId).collection("files").doc(fileId).set({
                id: fileId,
                fileName: item.name,
                storageUrl: url,
                category: fileCategory,
                summary: fileSummary,
                type: item.type,
                sizeBytes: item.buffer.length,
            });

            console.log(`[Magazynier ZIP] Pomyślnie zmapowano i zapisano plik: ${item.name} jako [${fileCategory}]`);
        }

        // Aktualizujemy status przetargu na gotowy dla reszty roju
        console.log(`[Magazynier ZIP] Aktualizuję status główny przetargu "${tenderId}" na "READY"...`);
        await adminDb.collection("tenders").doc(tenderId).update({
            status: "READY",
        });

        // =========================================================================
        // AUTOMATYCZNY ZAPŁON: Wywołujemy wewnętrznie nasz inicjalizator zadań w tle
        // =========================================================================
        try {
            const initUrl = internalUrl(req, "/api/kosztorysant/glowny-kosztorysant/inicjalizuj");
            console.log(`[Magazynier ZIP] [ZAPŁON] Automatycznie odpalam proces inicjalizacji zadań pod adresem: ${initUrl}...`);

            const initRes = await fetch(initUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId })
            });

            if (initRes.ok) {
                console.log(`[Magazynier ZIP] [ZAPŁON] SUKCES: Pomyślnie wygenerowano listę zadań w Firestore dla projektu: ${tenderId}`);
            } else {
                console.warn(`[Magazynier ZIP] [ZAPŁON] Ostrzeżenie: Inicjalizator zadań zwrócił status błędu: ${initRes.status}`);
            }
        } catch (initErr) {
            console.error("[Magazynier ZIP] [ZAPŁON] Krytyczny błąd automatycznego wywołania inicjalizatora zadań:", initErr);
        }
        // =========================================================================

        console.log(`[Magazynier ZIP] Zakończono import przetargu ${tenderId}. Zwracam dane do przeglądarki.`);
        console.log("==================================================");

        return NextResponse.json({
            tenderId,
            projectName: file.name.replace(".zip", ""),
            filesCount: filesToProcess.length,
        }, { status: 200 });

    } catch (error: any) {
        console.error("[Magazynier ZIP] Krytyczny błąd podczas importu:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Funkcja pomocnicza do parsowania (taka sama jak w shared types)
function extractAllJSONObjects(text: string) {
    const objects = [];
    let depth = 0; let startIndex = -1; let inString = false; let escape = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') escape = !escape;
            else if (char === '"' && !escape) inString = false;
            else escape = false;
        } else {
            if (char === '"') inString = true;
            else if (char === '{') { if (depth === 0) startIndex = i; depth++; }
            else if (char === '}') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && startIndex !== -1) {
                        try { objects.push(JSON.parse(text.substring(startIndex, i + 1))); } catch (e) { }
                        startIndex = -1;
                    }
                }
            }
        }
    }
    return objects;
}