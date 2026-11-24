// src/lib/biuro/ingestion/workers/vision.agent.ts
//
// Agent Wizyjny (Slow Path Vision)
// Odpowiada za odczyt skanów, pogniecionych kartek z kabiny busa, zdjęć JPG/PNG
// oraz PDF-ów bez cyfrowej warstwy tekstu. Wykorzystuje model Gemini Vision.

import { GoogleGenAI, Type } from '@google/genai';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
  location: 'global'
});

export interface VisionOptions {
  fallbackFrom?: string;
  fallbackReason?: string;
}

export class VisionWorkerAgent {
  static async process(
    buffer: Buffer,
    fileName: string,
    mimeType?: string,
    options?: VisionOptions
  ): Promise<CanonicalIngestPayload> {
    const startTime = performance.now();
    const base64Data = buffer.toString('base64');

    const effectiveMime = (
      mimeType === 'application/pdf' ||
      mimeType?.startsWith('image/')
    ) ? mimeType : (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

    const prompt = `Jesteś wyspecjalizowanym Agentem Wizyjnym OCR w systemie budowlanym PESAM.
Odczytaj dokument (skan, zdjęcie WZ lub faktury, pogniecioną kartkę z kabiny auta) o nazwie "${fileName}".
Zwróć precyzyjny JSON zgodny ze schematem.

ZASADY:
- Odczytaj wszystkie pozycje tabeli materiałowej.
- Liczby: separator dziesiętny to kropka.
- NIP: same cyfry bez kresek.
- target_site_hint: szukaj nazwy budowy/miejsca dostawy (np. "Kielce Przychodnia").`;

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
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            document_type: { type: Type.STRING, description: 'WZ, FAKTURA, NOTATKA_KIEROWCY lub NIEZNANY' },
            document_number: { type: Type.STRING },
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
    const costUsd = Math.max(0.001, (buffer.length / 1024) * 0.00001);

    return {
      meta: {
        ingest_id: `ING-VISION-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        source_type: 'SCAN_VISION',
        processed_by_agent: 'Agent-Vision',
        fallback_occurred: Boolean(options?.fallbackFrom),
        fallback_reason: options?.fallbackReason,
        cost_usd: Math.round(costUsd * 100000) / 100000,
        confidence_score: 0.88,
        execution_time_ms: executionTimeMs
      },
      document: {
        type: (rawJson.document_type || 'WZ') as any,
        number: rawJson.document_number || null,
        issue_date: rawJson.issue_date || null,
        seller: {
          name: rawJson.seller?.name || null,
          nip: rawJson.seller?.nip?.replace(/\D/g, '') || null
        },
        buyer: {
          name: rawJson.buyer?.name || null,
          nip: rawJson.buyer?.nip?.replace(/\D/g, '') || null
        },
        target_site_hint: rawJson.target_site_hint || null
      },
      items: (rawJson.items || []).map((it: any, idx: number) => ({
        lp: it.lp || idx + 1,
        raw_name: it.raw_name || `Pozycja ${idx + 1}`,
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
