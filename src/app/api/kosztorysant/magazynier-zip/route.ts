import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import JSZip from "jszip";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { PDFDocument } from "pdf-lib";

export const dynamic = "force-dynamic";
// Ustawienie czasu wykonania na 5 minut (dla dużych plików)
export const maxDuration = 300;

const MODEL_FLASH = "gemini-3.5-flash";

const SYSTEM_INSTRUCTION = `
  Jesteś Agentem Bibliotekarzem w systemie PESAM. Twoim zadaniem jest sklasyfikowanie pliku.
  Zwróć DOKŁADNIE obiekt JSON:
  {
    "category": "SWZ" | "DRAWING" | "ESTIMATE" | "CONTRACT" | "OTHER",
    "summary": "Jedno krótkie zdanie opisujące dokument."
  }
`;

/**
 * POMOCNIK: Przetwarzanie tablicy w małych paczkach (Batching), 
 * aby nie zapchać pamięci RAM przy Promise.all
 */
async function processInBatches<T>(
    items: T[],
    batchSize: number,
    processor: (item: T) => Promise<void>
) {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`[Magazynier ZIP] Przetwarzam paczkę plików: ${i + 1} do ${Math.min(i + batchSize, items.length)} z ${items.length}`);
        await Promise.all(batch.map(processor));
    }
}

/**
 * POMOCNIK: Wykrywanie MIME typu na podstawie rozszerzenia
 */
function getMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    switch (ext) {
        case 'pdf': return "application/pdf";
        case 'xlsx': return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case 'xls': return "application/vnd.ms-excel";
        case 'docx': return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case 'doc': return "application/msword";
        case 'png': return "image/png";
        case 'jpg':
        case 'jpeg': return "image/jpeg";
        default: return "application/octet-stream";
    }
}

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Magazynier ZIP] === ROZPOCZĘTO IMPORT PLIKÓW PROJEKTU ===");
    console.log("==================================================");

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
            console.error("[Magazynier ZIP] Błąd: Brak pliku.");
            return NextResponse.json({ error: "Brak pliku w żądaniu." }, { status: 400 });
        }

        console.log(`[Magazynier ZIP] Plik: "${file.name}" | Wielkość: ${(file.size / 1024 / 1024).toFixed(2)} MB`);

        const tenderId = `TND-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

        // POPRAWKA: Jawne wskazanie nazwy bucket'u
        const bucket = adminStorage.bucket(process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app");

        const arrayBuffer = await file.arrayBuffer();
        const filesToProcess: { name: string; buffer: Buffer; type: string }[] = [];

        // 1. ROZPOZNAWANIE: CZY TO ARCHIWUM ZIP CZY POJEDYNCZY PLIK
        if (file.name.toLowerCase().endsWith(".zip")) {
            const zip = await JSZip.loadAsync(arrayBuffer);
            for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
                if (zipEntry.dir || relativePath.includes("__MACOSX") || relativePath.includes(".DS_Store")) continue;

                const buffer = await zipEntry.async("nodebuffer");
                const fileName = relativePath.split("/").pop() || relativePath;
                filesToProcess.push({
                    name: fileName,
                    buffer,
                    type: getMimeType(fileName)
                });
            }
            (zip as any) = null; // Czyszczenie
            console.log(`[Magazynier ZIP] Rozpakowano archiwum ZIP. Liczba plików: ${filesToProcess.length}`);
        } else {
            // Traktujemy pojedynczy plik (np. PDF, Excel) jako jednoelementową paczkę
            filesToProcess.push({
                name: file.name,
                buffer: Buffer.from(arrayBuffer),
                type: file.type || getMimeType(file.name)
            });
            console.log(`[Magazynier ZIP] Przyjęto plik bez kompresji (PDF/Excel). Przetwarzam jako projekt.`);
        }

        // 2. TWORZENIE REKORDU W FIRESTORE
        await adminDb.collection("tenders").doc(tenderId).set({
            id: tenderId,
            name: file.name.replace(/\.zip|\.pdf|\.xlsx/gi, ""),
            status: "ANALYZING",
            createdAt: new Date().toISOString(),
        });

        // 3. INICJALIZACJA AI - PŁASKA STRUKTURA (zgodna z Twoimi typami TypeScript)
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        // 4. PRZETWARZANIE PARTIAMI (Batch Size = 2 dla maksymalnego bezpieczeństwa RAM)
        await processInBatches(filesToProcess, 2, async (item) => {
            const storagePath = `kosztorysy/${tenderId}/${item.name}`;
            const storageFile = bucket.file(storagePath);

            console.log(`[Batch] Zapisuję w Storage: ${item.name}`);
            await storageFile.save(item.buffer, {
                metadata: { contentType: item.type },
            });

            let fileCategory = "OTHER";
            let fileSummary = "Dokument pomocniczy.";

            try {
                let classificationParts: any[] = [];

                if (item.type === "application/pdf" && item.buffer.length < 15 * 1024 * 1024) {
                    try {
                        const pdf = await PDFDocument.load(item.buffer);
                        const previewDoc = await PDFDocument.create();
                        const [page] = await previewDoc.copyPages(pdf, [0]);
                        if (page) previewDoc.addPage(page);
                        const previewBuffer = Buffer.from(await previewDoc.save());

                        classificationParts = [
                            { inlineData: { data: previewBuffer.toString("base64"), mimeType: "application/pdf" } },
                            { text: `Sklasyfikuj plik na podstawie obrazu i nazwy: ${item.name}` }
                        ];
                    } catch (pdfErr) {
                        classificationParts = [{ text: `Sklasyfikuj po nazwie (błąd PDF): ${item.name}` }];
                    }
                } else {
                    classificationParts = [{ text: `Sklasyfikuj dokument na podstawie nazwy pliku: ${item.name}` }];
                }

                const result = await ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: [{ role: "user", parts: classificationParts }],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.1,
                        responseMimeType: "application/json",
                    },
                });

                if (result.text) {
                    const parsed = JSON.parse(result.text);
                    fileCategory = parsed.category || "OTHER";
                    fileSummary = parsed.summary || fileSummary;
                }

            } catch (err) {
                console.warn(`[Batch] AI pominęło plik ${item.name} -> fallback do OTHER.`, err);
            }

            const fileId = `file-${Math.random().toString(36).slice(2, 9)}`;

            await adminDb.collection("tenders").doc(tenderId).collection("files").doc(fileId).set({
                id: fileId,
                fileName: item.name,
                storagePath: storagePath,
                category: fileCategory,
                summary: fileSummary,
                type: item.type,
                sizeBytes: item.buffer.length,
            });

            // RĘCZNE CZYSZCZENIE BUFORA (Pomaga Garbage Collectorowi)
            (item as any).buffer = null;
        });

        // 5. FINALIZACJA
        await adminDb.collection("tenders").doc(tenderId).update({ status: "READY" });

        // Wywołanie inicjalizatora w tle
        const initUrl = `${new URL(req.url).origin}/api/kosztorysant/glowny-kosztorysant/inicjalizuj`;
        console.log(`[Magazynier ZIP] Odpalam inicjalizator: ${initUrl}`);

        fetch(initUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId })
        }).catch(e => console.error("[Magazynier ZIP] Błąd zapłonu:", e));

        console.log(`[Magazynier ZIP] ✅ SUKCES. Przetworzono ${filesToProcess.length} plików.`);

        return NextResponse.json({
            tenderId,
            projectName: file.name.replace(/\.zip|\.pdf|\.xlsx/gi, ""),
            filesCount: filesToProcess.length,
        }, { status: 200 });

    } catch (error: any) {
        console.error("[Magazynier ZIP] KRYTYCZNY BŁĄD:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}