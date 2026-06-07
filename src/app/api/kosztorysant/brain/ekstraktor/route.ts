// ============================================================
// PESAM Brain – Agent Ekstraktor
// POST /api/kosztorysant/brain/ekstraktor
//
// 1. Odbiera plik (PDF / XLSX / JSON) z frontendu.
// 2. Wysyła go do Gemini 3.5 Flash w celu wydobycia parametrów.
// 3. Ocenia świeżość danych (FRESH / STALE / EXPIRED).
// 4. Zapisuje wynik do bazy jako status PENDING_REVIEW (czeka na zgodę człowieka).
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb } from '@/lib/firebase/admin';
import { v4 as uuidv4 } from 'uuid';
import type {
    BrainUploadRecord,
    UploadSource,
    FreshnessLevel
} from '../../_shared/brainKnowledge.types';

export const dynamic = "force-dynamic";

// Używamy zoptymalizowanego modelu 3.5 Flash zgodnie z Twoim dostepem
const MODEL_FLASH = "gemini-3.5-flash";

// ============================================================
// SCHEMA DLA GEMINI (Zmusza model do zwrócenia idealnego JSONa)
// ============================================================
const EXTRACTION_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        objectType: {
            type: Type.STRING,
            description: "Typ obiektu, np. przedszkole, szkola, hala_produkcyjna, biurowiec, budynek_mieszkalny, inne"
        },
        documentDate: {
            type: Type.STRING,
            description: "Data sporządzenia kosztorysu/projektu w formacie YYYY-MM-DD"
        },
        totalCost_PLN: { type: Type.NUMBER, description: "Łączna wartość kosztorysu netto (PLN)" },
        totalArea_m2: { type: Type.NUMBER, description: "Powierzchnia użytkowa budynku (m2) - jeśli dostępna" },
        confidenceScore: { type: Type.INTEGER, description: "Pewność modelu co do poprawności danych (0-100)" },
        warnings: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Ostrzeżenia, np. brak daty, brak powierzchni" },

        indicators: {
            type: Type.OBJECT,
            description: "Wskaźniki ilościowe. Podaj tylko wartości liczbowe lub null.",
            properties: {
                concretePerM2Floor: { type: Type.NUMBER, description: "m3 betonu na m2 powierzchni" },
                steelPerM3Concrete: { type: Type.NUMBER, description: "kg stali na m3 betonu" },
                wallM2PerM2Floor: { type: Type.NUMBER, description: "m2 ścian na m2 powierzchni" },
                plasterM2PerM2Floor: { type: Type.NUMBER, description: "m2 tynków na m2 powierzchni" },
                roofM2PerM2Floor: { type: Type.NUMBER, description: "m2 dachu na m2 powierzchni" }
            }
        },

        proportions: {
            type: Type.OBJECT,
            description: "Procentowy udział branż w łącznym koszcie budżetu (0-100).",
            properties: {
                D1_zeroPercent: { type: Type.NUMBER },
                D2_roughPercent: { type: Type.NUMBER },
                D3_finishPercent: { type: Type.NUMBER },
                D4_facadePercent: { type: Type.NUMBER },
                D5_sanitaryPercent: { type: Type.NUMBER },
                D6_electricPercent: { type: Type.NUMBER },
                D7_specialPercent: { type: Type.NUMBER }
            }
        },

        priceItems: {
            type: Type.ARRAY,
            description: "Lista kluczowych pozycji kosztorysowych z cenami jednostkowymi.",
            items: {
                type: Type.OBJECT,
                properties: {
                    itemKey: { type: Type.STRING, description: "Unikalny klucz techniczny (np. beton_c25_30_pompa)" },
                    itemName: { type: Type.STRING, description: "Oryginalna nazwa z kosztorysu" },
                    unit: { type: Type.STRING, description: "Jednostka (m2, m3, t, kpl.)" },
                    unitPrice: { type: Type.NUMBER, description: "Cena jednostkowa w PLN netto" }
                },
                required: ["itemKey", "itemName", "unit", "unitPrice"]
            }
        }
    },
    required: ["objectType", "documentDate", "totalCost_PLN", "confidenceScore", "indicators", "proportions", "priceItems"]
};

// ============================================================
// LOGIKA OCENY ŚWIEŻOŚCI
// ============================================================
function evaluateFreshness(docDateStr: string): { level: FreshnessLevel; warning: string | null; usePrices: boolean } {
    console.log(`[Ekstraktor] 🕒 Ocena świeżości dokumentu na podstawie daty: ${docDateStr}`);

    if (!docDateStr || docDateStr === 'null' || docDateStr === '') {
        console.log(`[Ekstraktor] ⚠️ Brak daty. Zakładam EXPIRED dla bezpieczeństwa.`);
        return { level: 'EXPIRED', warning: 'Brak daty w dokumencie. Ceny ignorowane.', usePrices: false };
    }

    const docDate = new Date(docDateStr);
    const now = new Date(); // Zegar systemowy
    const diffMonths = (now.getFullYear() - docDate.getFullYear()) * 12 + (now.getMonth() - docDate.getMonth());

    console.log(`[Ekstraktor] 🕒 Wiek dokumentu: ok. ${diffMonths} miesięcy.`);

    if (diffMonths <= 6) {
        return { level: 'FRESH', warning: null, usePrices: true };
    } else if (diffMonths <= 24) {
        return {
            level: 'STALE',
            warning: 'Kosztorys starszy niż 6 miesięcy. Zapisane ceny posłużą tylko jako historyczny punkt odniesienia.',
            usePrices: true
        };
    } else {
        return {
            level: 'EXPIRED',
            warning: 'Kosztorys starszy niż 2 lata. Ceny zdezaktualizowane (pomijane w uczeniu). Zapisuję wyłącznie normy ilościowe i proporcje.',
            usePrices: false
        };
    }
}

// ============================================================
// GŁÓWNY HANDLER POST
// ============================================================
export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Ekstraktor] === ROZPOCZĘTO EKSTRAKCJĘ KOSZTORYSU DLA MÓZGU ===");
    console.log("==================================================");

    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const source = formData.get('source') as UploadSource;

        if (!file || !source) {
            console.error("[Ekstraktor] ❌ Błąd: Brak pliku lub źródła w żądaniu.");
            return NextResponse.json({ error: 'Brak pliku' }, { status: 400 });
        }

        console.log(`[Ekstraktor] 📂 Otrzymano plik: "${file.name}" | Typ MIME: ${file.type} | Źródło: ${source}`);

        // Konwersja pliku do Base64 dla Gemini
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Data = buffer.toString('base64');

        console.log(`[Ekstraktor] 🤖 Inicjuję GoogleGenAI (${MODEL_FLASH})... Waga pliku: ${(buffer.length / 1024).toFixed(2)} KB`);

        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const prompt = `
Jesteś Ekspertem Inżynierii Kosztów. Analizujesz historyczny kosztorys/projekt i wyciągasz z niego cenną wiedzę do uczenia bazy "PESAM Brain".
Plik znajduje się w załączniku (PDF/XLSX/JSON).

ZADANIE:
1. Określ datę kosztorysu (niezwykle ważne dla waloryzacji!).
2. Typ obiektu.
3. Znajdź wskaźniki ilościowe. Oblicz je, jeśli masz tylko całkowite objętości (np. m3 betonu podzielone przez m2 powierzchni całkowitej).
4. Określ proporcje branż (D1 do D7) w procencie budżetu.
5. Zwróć 10-20 kluczowych pozycji z ich cenami jednostkowymi.

Odpowiadaj wyłącznie czystym, rygorystycznym JSON.
    `.trim();

        // Wysyłamy prompt oraz plik
        const response = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{
                role: "user",
                parts: [
                    { text: prompt },
                    { inlineData: { data: base64Data, mimeType: file.type } }
                ]
            }],
            config: {
                temperature: 0.1, // Niska temperatura, żeby AI nie zmyślało!
                responseMimeType: "application/json",
                responseSchema: EXTRACTION_SCHEMA as any,
            }
        });

        const rawJson = response.text ?? "{}";
        console.log(`[Ekstraktor] 📥 Otrzymano odpowiedź z Gemini. Parsowanie JSONa...`);
        const extractedData = JSON.parse(rawJson);

        // Ocena świeżości
        const freshness = evaluateFreshness(extractedData.documentDate);
        const uploadId = `UPLOAD-${uuidv4().substring(0, 8).toUpperCase()}`;

        // Transformacja obiektów z AI na format RollingStats (z sample = 1 na starcie, dla interfejsu podglądu)
        const indicatorsToSave: any = {};
        for (const [k, v] of Object.entries(extractedData.indicators || {})) {
            if (v !== null && typeof v === 'number') indicatorsToSave[k] = { avg: v, min: v, max: v, samples: 1 };
        }
        if (extractedData.totalArea_m2) {
            indicatorsToSave.totalArea_m2 = { avg: extractedData.totalArea_m2, min: extractedData.totalArea_m2, max: extractedData.totalArea_m2, samples: 1 };
        }

        const proportionsToSave: any = {};
        for (const [k, v] of Object.entries(extractedData.proportions || {})) {
            if (v !== null && typeof v === 'number') proportionsToSave[k] = { avg: v, min: v, max: v, samples: 1 };
        }
        if (extractedData.totalCost_PLN && extractedData.totalArea_m2) {
            const costPerM2 = extractedData.totalCost_PLN / extractedData.totalArea_m2;
            proportionsToSave.costPerM2 = { avg: costPerM2, min: costPerM2, max: costPerM2, samples: 1 };
        }

        // Budujemy główny rekord
        const record: BrainUploadRecord = {
            uploadId,
            fileName: file.name,
            source,
            objectType: extractedData.objectType || 'inne',
            documentDate: extractedData.documentDate,
            uploadedAt: new Date().toISOString(),

            status: 'PENDING_REVIEW', // Oczekuje na akceptację przez UI!

            totalCost_PLN: extractedData.totalCost_PLN || null,
            totalArea_m2: extractedData.totalArea_m2 || null,
            extractedPriceCount: Array.isArray(extractedData.priceItems) ? extractedData.priceItems.length : 0,

            freshnessLevel: freshness.level,
            freshnessWarning: freshness.warning,
            pricesUsedForLearning: freshness.usePrices,
            confidenceScore: extractedData.confidenceScore || 0,
            warnings: extractedData.warnings || [],

            extractedIndicators: indicatorsToSave,
            extractedProportions: proportionsToSave,
        };

        console.log(`[Ekstraktor] 💾 Zapisuję rekord główny pod: settings/brainKnowledge/uploads/${uploadId}`);

        // Zapis do bazy danych (Batch)
        const batch = adminDb.batch();
        const uploadRef = adminDb.doc(`settings/brainKnowledge/uploads/${uploadId}`);
        batch.set(uploadRef, record);

        // Zapisujemy pozycje cenowe do podkolekcji (aby dokument główny nie przekroczył 1MB w Firestore)
        if (Array.isArray(extractedData.priceItems) && freshness.usePrices) {
            console.log(`[Ekstraktor] 💾 Zapisuję ${extractedData.priceItems.length} pozycji cenowych do podkolekcji...`);
            for (const item of extractedData.priceItems) {
                const itemRef = adminDb.doc(`settings/brainKnowledge/uploads/${uploadId}/priceItems/${item.itemKey}`);
                batch.set(itemRef, { ...item, uploadId });
            }
        } else {
            console.log(`[Ekstraktor] ⏭️ Pomijam zapis cen (brak danych lub kosztorys WYGASŁY).`);
        }

        await batch.commit();

        console.log(`[Ekstraktor] ✅ Sukces! Kosztorys przeanalizowany. Oczekuje na zatwierdzenie przez użytkownika.`);
        console.log("==================================================");

        // Zwracamy paczkę podglądu dla Frontendu
        return NextResponse.json({
            success: true,
            uploadId,
            preview: {
                objectType: record.objectType,
                documentDate: record.documentDate,
                totalCost_PLN: record.totalCost_PLN,
                totalArea_m2: record.totalArea_m2,
                freshnessLevel: record.freshnessLevel,
                freshnessWarning: record.freshnessWarning,
                confidence: record.confidenceScore,
                warnings: record.warnings,
                priceItemCount: record.extractedPriceCount,
                indicatorsPreview: {
                    concretePerM2: extractedData.indicators?.concretePerM2Floor?.toFixed(3) || null,
                    steelPerM3: extractedData.indicators?.steelPerM3Concrete?.toFixed(1) || null,
                },
            }
        });

    } catch (error: any) {
        console.error('[Ekstraktor] ❌ BŁĄD KRYTYCZNY:', error);
        return NextResponse.json(
            { error: 'Błąd przetwarzania kosztorysu', details: String(error) },
            { status: 500 }
        );
    }
}