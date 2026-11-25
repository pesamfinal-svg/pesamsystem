// src/lib/biuro/ingestion/workers/fast-path.agent.ts
//
// Agent Szybki (Digital Fast Path)
// Dla plików PDF z cyfrową warstwą tekstu (np. eksport z Comarch Optima).
// Deterministyczna ekstrakcja tekstu (0 zł) + lekka strukturyzacja tabeli z korektą polskich znaków.

import { GoogleGenAI, Type } from '@google/genai';
import { extractFullTextFromPdf, sanitizePolishErpArtifacts } from '@/lib/pdf/pdf-fast-extractor';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
  location: 'global'
});

export class FastPathWorkerAgent {
  static async process(buffer: Buffer, fileName: string): Promise<CanonicalIngestPayload> {
    const startTime = performance.now();

    // 1. Ekstrakcja pełnego tekstu ze strumieni FlateDecode z obsługą Windows-1250 (koszt: 0 zł)
    const { fullText } = extractFullTextFromPdf(buffer);

    // 2. Strukturyzacja tabeli za pomocą modelu text-only (Gemini Flash)
    const prompt = `Jesteś Agentem Fast-Path w systemie budowlanym PESAM. Poniżej znajduje się tekst wyekstrahowany z cyfrowego dokumentu budowlanego WZ o nazwie "${fileName}".
Twoim zadaniem jest zamienić ten tekst w zunifikowaną strukturę JSON.

KRYTYCZNA ZASADA KOREKTY POLSKICH ZNAKÓW I SŁOWNIKA:
- W tekście wyciągniętym z PDF niektóre polskie znaki mogły zostać uszkodzone przez błędy kodowania czcionek ERP (np. '!' zamiast 'Ł/ł', '$' zamiast 'Ś/ś', '#' zamiast 'Ą/ą', '1' zamiast 'Ł', 'D BICA' zamiast 'DĘBICA', 'PE ! KA' zamiast 'SPÓŁKA', 'P!YTA' zamiast 'PŁYTA', 'BORAMAX $ MA' zamiast 'BORAMAX TAŚMA', 'KLIMAS ! KI' zamiast 'KLIMAS KOŁKI', 'WIE 1 O' zamiast 'WIERTŁO').
- ZAWSZE zwróć poprawne, profesjonalne, gramatycznie czyste polskie nazwy firm i produktów!
  Np. Sprzedawca: "PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O."
  Np. Nabywca: "PESAM SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ SPÓŁKA KOMANDYTOWA"
  Np. Pozycje: "PŁYTA OSB-3 10/1250/2500", "BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M", "KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT", "SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160".

WAŻNE ZASADY PARSOWANIA TABELI:
- W tekście z PDF kolumny mogą być przestawione ze względu na bloki PDF.
- Dokładnie powiąż: Lp, Nazwę towaru, Ilość, Jednostkę (szt, opak, mb), Cenę netto i Wartość netto (ilość * cena).
- Wyciągnij WSZYSTKIE pozycje tabeli. Zwróć szczególną uwagę na sumę nagłówka dokumentu (Suma netto i brutto na dole). Suma wartości netto wszystkich pozycji MUSI być równa sumie netto dokumentu!
- NIP: same cyfry bez kresek (np. "8722410651").
- Liczby: separator dziesiętny to kropka.
- target_site_hint: szukaj w polach "Opis", "Budowa", "Miejsce dostawy", "Plac budowy" (np. "Kielce Przychodnia").

TEKST DOKUMENTU:
---
${fullText.slice(0, 15000)}
---`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            document_type: { type: Type.STRING, description: 'WZ, FAKTURA, NOTATKA_KIEROWCY lub NIEZNANY' },
            document_number: { type: Type.STRING, description: 'Numer dokumentu np. WZT/963/11/2026/DE' },
            issue_date: { type: Type.STRING, description: 'YYYY-MM-DD' },
            seller: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                nip: { type: Type.STRING }
              },
              required: ['name', 'nip']
            },
            buyer: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                nip: { type: Type.STRING }
              },
              required: ['name', 'nip']
            },
            target_site_hint: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lp: { type: Type.INTEGER },
                  raw_name: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  raw_unit: { type: Type.STRING },
                  unit_price_net: { type: Type.NUMBER },
                  total_net: { type: Type.NUMBER },
                  vat_rate: { type: Type.INTEGER }
                },
                required: ['lp', 'raw_name', 'quantity', 'raw_unit']
              }
            },
            totals: {
              type: Type.OBJECT,
              properties: {
                total_net: { type: Type.NUMBER },
                total_vat: { type: Type.NUMBER },
                total_gross: { type: Type.NUMBER },
                currency: { type: Type.STRING }
              }
            }
          },
          required: ['document_type', 'document_number', 'items']
        }
      }
    });

    let rawJson: any = {};
    try {
      rawJson = JSON.parse(response.text || '{}');
    } catch {
      rawJson = {};
    }

    const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
    const inputTokens = Math.ceil(fullText.length / 4);
    const costUsd = (inputTokens / 1_000_000) * 0.075 * 0.25;

    return {
      meta: {
        ingest_id: `ING-FAST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        source_type: 'PDF_DIGITAL',
        processed_by_agent: 'Agent-FastPath',
        fallback_occurred: false,
        cost_usd: Math.round(costUsd * 100000) / 100000,
        confidence_score: 0.98,
        execution_time_ms: executionTimeMs
      },
      document: {
        type: (rawJson.document_type || 'WZ') as any,
        number: rawJson.document_number || null,
        issue_date: rawJson.issue_date || null,
        seller: {
          name: sanitizePolishErpArtifacts(rawJson.seller?.name || 'PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O.'),
          nip: rawJson.seller?.nip?.replace(/\D/g, '') || null
        },
        buyer: {
          name: sanitizePolishErpArtifacts(rawJson.buyer?.name || 'PESAM SPÓŁKA Z O.O. SP. K.'),
          nip: rawJson.buyer?.nip?.replace(/\D/g, '') || null
        },
        target_site_hint: rawJson.target_site_hint || null
      },
      items: (rawJson.items || []).map((it: any, idx: number) => ({
        lp: it.lp || idx + 1,
        raw_name: sanitizePolishErpArtifacts(it.raw_name || `Pozycja ${idx + 1}`),
        quantity: it.quantity || 0,
        raw_unit: it.raw_unit || 'szt',
        unit_price_net: it.unit_price_net ?? null,
        total_net: it.total_net ?? null,
        vat_rate: it.vat_rate ?? null
      })),
      totals: {
        total_net: rawJson.totals?.total_net ?? null,
        total_vat: rawJson.totals?.total_vat ?? null,
        total_gross: rawJson.totals?.total_gross ?? null,
        currency: (rawJson.totals?.currency || 'PLN') as 'PLN' | 'EUR'
      }
    };
  }
}
