import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import JSZip from "jszip";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { PDFDocument } from "pdf-lib"; // Wymagane do Fix #7

// Budowanie bezpiecznego URL dla wywołań wewnętrznych
function internalUrl(req: NextRequest, path: string): string {
    const url = new URL(req.url);
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

        const tenderId = `TND-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const bucket = adminStorage.bucket(process.env.FIREBASE_STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app");

        console.log("[Magazynier ZIP] Wczytuję archiwum do bufora pamięci RAM...");
        const arrayBuffer = await file.arrayBuffer();

        console.log("[Magazynier ZIP] JSZip rozpakowuje archiwum w locie...");
        const zip = await JSZip.loadAsync(arrayBuffer);

        const filesToProcess: { name: string; buffer: Buffer; type: string }[] = [];

        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) continue;

            if (relativePath.startsWith("__MACOSX") || relativePath.includes(".DS_Store")) {
                console.log(`[Magazynier ZIP] Pominięto plik systemowy: ${relativePath}`);
                continue;
            }

            const fileBuffer = await zipEntry.async("nodebuffer");

            let type = "application/octet-stream";
            if (relativePath.endsWith(".pdf")) type = "application/pdf";
            else if (relativePath.endsWith(".xlsx")) type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            else if (relativePath.endsWith(".xls")) type = "application/vnd.ms-excel";
            else if (relativePath.endsWith(".docx")) type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            else if (relativePath.endsWith(".doc")) type = "application/msword";
            else if (relativePath.endsWith(".jpg") || relativePath.endsWith(".jpeg")) type = "image/jpeg";
            else if (relativePath.endsWith(".png")) type = "image/png";

            const fileName = relativePath.split("/").pop() || relativePath;

            console.log(`[Magazynier ZIP] Wyekstrahowano plik: "${fileName}" (Typ: ${type}, rozmiar: ${fileBuffer.length} bajtów)`);
            filesToProcess.push({ name: fileName, buffer: fileBuffer, type });
        }

        console.log(`[Magazynier ZIP] Zakończono rozpakowywanie. Wykryto łącznie ${filesToProcess.length} poprawnych plików do przetworzenia.`);

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

        for (const item of filesToProcess) {
            const storagePath = `kosztorysy/${tenderId}/${item.name}`;
            const storageFile = bucket.file(storagePath);

            console.log(`[Magazynier ZIP] Przesyłam plik do Cloud Storage: "${storagePath}"...`);
            await storageFile.save(item.buffer, {
                metadata: { contentType: item.type },
            });

            let fileCategory = "OTHER";
            let fileSummary = "Dokument pomocniczy przetargu.";

            try {
                let classificationParts = [];

                // ── FIX #7: WIZUALNA KLASYFIKACJA PDF ──
                if (item.type === "application/pdf") {
                    console.log(`[Magazynier ZIP] Konwersja pierwszej strony PDF "${item.name}" na obraz dla AI...`);
                    const miniDoc = await PDFDocument.load(item.buffer);
                    const previewDoc = await PDFDocument.create();
                    const pagesToPreview = await previewDoc.copyPages(miniDoc, [0].filter(i => i < miniDoc.getPageCount()));
                    pagesToPreview.forEach(p => previewDoc.addPage(p));
                    const previewBuffer = Buffer.from(await previewDoc.save());

                    classificationParts = [
                        { inlineData: { data: previewBuffer.toString("base64"), mimeType: "application/pdf" } },
                        { text: `Sklasyfikuj ten dokument. Nazwa pliku: ${item.name}` }
                    ];
                } else {
                    classificationParts = [
                        { text: `Sklasyfikuj dokument na podstawie nazwy pliku: ${item.name}` }
                    ];
                }

                console.log(`[Magazynier ZIP] Wysyłam zapytanie klasyfikacyjne do Gemini Flash...`);
                const response = await ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: [{ role: "user", parts: classificationParts }],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.1,
                        responseMimeType: "application/json",
                    },
                });

                if (response.text) {
                    const parsed = JSON.parse(response.text);
                    fileCategory = parsed.category || "OTHER";
                    fileSummary = parsed.summary || fileSummary;
                }
            } catch (err) {
                console.warn(`[Magazynier ZIP] Ostrzeżenie: Nie udało się sklasyfikować pliku ${item.name} przez AI. Używam domyślnych kategorii.`, err);
            }

            const fileId = `file-${Math.random().toString(36).slice(2, 9)}`;
            console.log(`[Magazynier ZIP] Zapisuję metadane pliku do podkolekcji "files" pod ID: "${fileId}"...`);

            // ── FIX #2: ZAPISUJEMY storagePath ZAMIAST URL ──
            await adminDb.collection("tenders").doc(tenderId).collection("files").doc(fileId).set({
                id: fileId,
                fileName: item.name,
                storagePath: storagePath, // Zmiana tutaj!
                category: fileCategory,
                summary: fileSummary,
                type: item.type,
                sizeBytes: item.buffer.length,
            });

            console.log(`[Magazynier ZIP] Pomyślnie zmapowano i zapisano plik: ${item.name} jako [${fileCategory}]`);
        }

        console.log(`[Magazynier ZIP] Aktualizuję status główny przetargu "${tenderId}" na "READY"...`);
        await adminDb.collection("tenders").doc(tenderId).update({
            status: "READY",
        });

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