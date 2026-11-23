// src/app/api/biuro/process-document/route.ts
//
// Główny endpoint przetwarzania dokumentów biurowych (WZ, Faktury, Skany).
// Implementuje architekturę PESAM 3.0 z biuro-ai.md:
//
//   FAST PATH  → PDF z warstwą tekstową → ekstrakcja deterministyczna + Gemini Flash-Lite (tekst)
//   SLOW PATH  → Skan / zdjęcie / PDF-obraz → Gemini Flash Vision (OCR wizyjny)
//   AUDIO PATH → Nagranie audio → Gemini Audio STT
//
// Endpoint zwraca jednolity JSON (Standard Modułu 1 wg biuro-ai.md §3.4).

import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { detectDocumentTextLayer } from '@/lib/pdf/text-layer-detector';
import { extractFullTextFromPdf } from '@/lib/pdf/pdf-fast-extractor';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

// ─── Schemat wyjściowy JSON (Standard Modułu 1) ──────────────────────────────

const WZ_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        document_type: {
            type: 'STRING',
            description: 'Typ dokumentu: WZ, WZT, FA, FV, FAKTURA, PARAGON, SKAN lub NIEZNANY.'
        },
        document_number: {
            type: 'STRING',
            description: 'Numer dokumentu np. WZT/963/11/2026/DE. Jeśli brak — pusty string.'
        },
        issue_date: {
            type: 'STRING',
            description: 'Data wystawienia w formacie YYYY-MM-DD. Jeśli brak — pusty string.'
        },
        seller: {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING', description: 'Pełna nazwa sprzedawcy/wystawcy.' },
                nip: { type: 'STRING', description: 'NIP sprzedawcy (tylko cyfry, bez kresek). Jeśli brak — pusty string.' }
            },
            required: ['name', 'nip']
        },
        buyer: {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING', description: 'Pełna nazwa nabywcy.' },
                nip: { type: 'STRING', description: 'NIP nabywcy (tylko cyfry, bez kresek). Jeśli brak — pusty string.' }
            },
            required: ['name', 'nip']
        },
        target_site_hint: {
            type: 'STRING',
            description: 'Wskazówka do której budowy/obiektu ma trafić materiał. Szukaj w opisach, nagłówkach, polach "Opis", "Budowa", "Miejsce dostawy". Jeśli brak — pusty string.'
        },
        items: {
            type: 'ARRAY',
            description: 'Lista pozycji dokumentu.',
            items: {
                type: 'OBJECT',
                properties: {
                    lp: { type: 'INTEGER', description: 'Numer porządkowy pozycji.' },
                    name: { type: 'STRING', description: 'Nazwa towaru/usługi.' },
                    quantity: { type: 'NUMBER', description: 'Ilość.' },
                    unit: { type: 'STRING', description: 'Jednostka miary (szt, m2, mb, kg, t, kpl, op).' },
                    unit_price_net: { type: 'NUMBER', description: 'Cena jednostkowa netto. 0 jeśli brak.' },
                    value_net: { type: 'NUMBER', description: 'Wartość netto pozycji. 0 jeśli brak.' },
                    vat_rate: { type: 'INTEGER', description: 'Stawka VAT w procentach (np. 23, 8, 0). -1 jeśli nie dotyczy.' }
                },
                required: ['lp', 'name', 'quantity', 'unit', 'unit_price_net', 'value_net', 'vat_rate']
            }
        },
        totals: {
            type: 'OBJECT',
            properties: {
                net: { type: 'NUMBER', description: 'Suma netto.' },
                vat: { type: 'NUMBER', description: 'Kwota VAT.' },
                gross: { type: 'NUMBER', description: 'Suma brutto.' }
            },
            required: ['net', 'vat', 'gross']
        }
    },
    required: ['document_type', 'document_number', 'issue_date', 'seller', 'buyer', 'target_site_hint', 'items', 'totals']
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    const globalStart = performance.now();

    try {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'Nie przesłano pliku (pole "file" jest wymagane).' }, { status: 400 });
        }

        const fileName = file.name || 'dokument.bin';
        const mimeType = file.type || '';
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // ── Krok 1: Detekcja warstwy tekstowej ───────────────────────────────
        const detection = detectDocumentTextLayer(buffer, fileName, mimeType);

        // ── Krok 2: Routing ───────────────────────────────────────────────────
        let structuredData: Record<string, unknown>;
        let pathUsed: 'fast_path_text' | 'slow_path_vision' | 'slow_path_audio';
        let modelCostPln = 0;

        if (detection.recommendedPath === 'SPEECH_TO_TEXT') {
            // ── AUDIO PATH ────────────────────────────────────────────────────
            pathUsed = 'slow_path_audio';
            structuredData = await processAudio(buffer, mimeType, fileName);
            modelCostPln = 0.02; // szacunek
        } else if (detection.recommendedPath === 'FAST_PATH') {
            // ── FAST PATH: ekstrakcja tekstu + Gemini Flash-Lite (tekst) ─────
            pathUsed = 'fast_path_text';
            const extracted = extractFullTextFromPdf(buffer);
            structuredData = await processFastPath(extracted.fullText, fileName);
            // Flash-Lite text-only jest ~10x tańszy niż Vision
            const inputTokens = Math.ceil(extracted.fullText.length / 4);
            modelCostPln = (inputTokens / 1_000_000) * 0.075; // ~0.075 zł/1M tokenów
        } else {
            // ── SLOW PATH: Gemini Flash Vision (OCR) ─────────────────────────
            pathUsed = 'slow_path_vision';
            structuredData = await processSlowPath(buffer, mimeType, fileName);
            const fileSizeKb = buffer.length / 1024;
            modelCostPln = Math.max(0.01, fileSizeKb * 0.000012); // szacunek wg rozmiaru
        }

        const executionTimeSec = Math.round((performance.now() - globalStart)) / 1000;

        // Walidacja matematyczna sum (edge case z biuro-ai.md §3.5)
        const validationOk = validateTotals(structuredData);

        // Jeśli Fast Path nie przeszedł walidacji → Slow Path ratunkowy
        if (pathUsed === 'fast_path_text' && !validationOk) {
            const slowData = await processSlowPath(buffer, mimeType, fileName);
            const slowValidation = validateTotals(slowData);
            const totalTime = Math.round((performance.now() - globalStart)) / 1000;

            return NextResponse.json({
                success: true,
                data: {
                    ...slowData,
                    processing_meta: {
                        path_used: 'slow_path_vision_fallback',
                        fast_path_failed_validation: true,
                        execution_time_sec: totalTime,
                        model_cost_pln: modelCostPln + 0.01,
                        validation_ok: slowValidation,
                        detection: {
                            has_text_layer: detection.hasTextLayer,
                            extracted_chars: detection.extractedCharactersCount,
                            detection_time_ms: detection.executionTimeMs
                        }
                    }
                }
            });
        }

        return NextResponse.json({
            success: true,
            data: {
                ...structuredData,
                processing_meta: {
                    path_used: pathUsed,
                    execution_time_sec: executionTimeSec,
                    model_cost_pln: Math.round(modelCostPln * 10000) / 10000,
                    validation_ok: validationOk,
                    detection: {
                        has_text_layer: detection.hasTextLayer,
                        extracted_chars: detection.extractedCharactersCount,
                        detection_time_ms: detection.executionTimeMs,
                        is_comarch_erp: detection.detectedMetadata?.isComarchOptima ?? false
                    }
                }
            }
        });

    } catch (error: any) {
        console.error('[process-document] Błąd krytyczny:', error);
        return NextResponse.json(
            { error: 'Błąd podczas przetwarzania dokumentu.', details: error?.message || String(error) },
            { status: 500 }
        );
    }
}

// ─── FAST PATH: tekst → Gemini Flash-Lite ────────────────────────────────────

async function processFastPath(fullText: string, fileName: string): Promise<Record<string, unknown>> {
    const prompt = `Poniżej znajduje się tekst wyekstrahowany deterministycznie z pliku PDF o nazwie "${fileName}".
Przeanalizuj go i wyciągnij wszystkie dane zgodnie ze schematem JSON.

UWAGI:
- Liczby mogą być z przecinkiem (1 234,56) lub kropką (1234.56) — zawsze zwróć z kropką jako separator dziesiętny.
- NIP zwróć jako same cyfry bez kresek ani spacji (np. "8722410651").
- Daty zwróć jako YYYY-MM-DD (np. "2026-11-18").
- Jeśli pozycja nie ma ceny jednostkowej (np. WZ bez cen), wstaw 0.
- target_site_hint szukaj w polach: "Opis", "Budowa", "Miejsce dostawy", "Plac budowy", nagłówku dokumentu.

TEKST DOKUMENTU:
---
${fullText.slice(0, 12000)}
---`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: WZ_RESPONSE_SCHEMA as any
        }
    });

    return parseAiResponse(response.text || '{}');
}

// ─── SLOW PATH: plik (obraz/skan PDF) → Gemini Flash Vision ──────────────────

async function processSlowPath(buffer: Buffer, mimeType: string, fileName: string): Promise<Record<string, unknown>> {
    const base64Data = buffer.toString('base64');
    // Gemini Vision przyjmuje PDF jako application/pdf lub obraz jako image/*
    const effectiveMime = (mimeType === 'application/pdf' || mimeType.startsWith('image/'))
        ? mimeType
        : 'application/pdf';

    const prompt = `Jesteś precyzyjnym systemem OCR dla firmy budowlanej PESAM. Przeanalizuj załączony dokument (plik: "${fileName}") i wyciągnij z niego wszystkie dane.

UWAGI:
- Liczby zawsze z kropką jako separator dziesiętny.
- NIP jako same cyfry bez kresek (np. "8722410651").  
- Daty jako YYYY-MM-DD.
- Jeśli pozycja nie ma ceny, wstaw 0.
- target_site_hint szukaj w opisach, miejscu dostawy, polach budowy.
- Jeśli to zdjęcie lub skan niskiej jakości — rób wszystko co możliwe, aby odczytać dane.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
            role: 'user',
            parts: [
                { text: prompt },
                { inlineData: { mimeType: effectiveMime, data: base64Data } }
            ]
        }],
        config: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: WZ_RESPONSE_SCHEMA as any
        }
    });

    return parseAiResponse(response.text || '{}');
}

// ─── AUDIO PATH: Gemini Audio STT ────────────────────────────────────────────

async function processAudio(buffer: Buffer, mimeType: string, fileName: string): Promise<Record<string, unknown>> {
    const base64Data = buffer.toString('base64');
    const audioMime = mimeType.startsWith('audio/') ? mimeType : 'audio/mp4';

    const prompt = `Jesteś asystentem kierowcy na budowie. Transkrybuj poniższe nagranie audio i wyciągnij z niego informacje o dostawie/dokumencie.
Plik: "${fileName}". Wypełnij wszystkie pola schematu na podstawie tego co kierowca mówi.
Jeśli czegoś nie ma w nagraniu — wstaw pusty string lub 0.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
            role: 'user',
            parts: [
                { text: prompt },
                { inlineData: { mimeType: audioMime, data: base64Data } }
            ]
        }],
        config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: WZ_RESPONSE_SCHEMA as any
        }
    });

    return parseAiResponse(response.text || '{}');
}

// ─── Walidacja matematyczna sum ───────────────────────────────────────────────

function validateTotals(data: Record<string, unknown>): boolean {
    try {
        const totals = data.totals as { net: number; vat: number; gross: number } | undefined;
        const items = data.items as Array<{ value_net: number }> | undefined;

        if (!totals || !items || items.length === 0) return true; // brak danych = nie blokujemy

        const sumNet = items.reduce((acc, item) => acc + (item.value_net || 0), 0);
        const declaredNet = totals.net || 0;
        const declaredGross = totals.gross || 0;
        const declaredVat = totals.vat || 0;

        // Tolerancja ±1% (różnice zaokrągleń)
        const netOk = declaredNet === 0 || Math.abs(sumNet - declaredNet) / declaredNet < 0.01;
        const grossOk = declaredGross === 0 || Math.abs((declaredNet + declaredVat) - declaredGross) / declaredGross < 0.01;

        return netOk && grossOk;
    } catch {
        return true; // nie blokujemy przy błędzie walidacji
    }
}

// ─── Parser odpowiedzi AI ─────────────────────────────────────────────────────

function parseAiResponse(text: string): Record<string, unknown> {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        // Wyciągnij pierwszy obiekt JSON metodą brace-matching
        let depth = 0;
        let start = -1;
        for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
            else if (cleaned[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
                }
            }
        }
        return { document_type: 'NIEZNANY', document_number: '', issue_date: '', seller: { name: '', nip: '' }, buyer: { name: '', nip: '' }, target_site_hint: '', items: [], totals: { net: 0, vat: 0, gross: 0 } };
    }
}
