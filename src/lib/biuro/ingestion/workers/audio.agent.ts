// src/lib/biuro/ingestion/workers/audio.agent.ts
//
// Agent Słuchu (Audio Ingest Agent)
// Przetwarza notatki głosowe nagrane przez kierowców na placu budowy lub w hurtowni.
// Wykorzystuje Gemini Audio STT do wyciągnięcia intencji, materiałów i numeru WZ.

import { GoogleGenAI, Type } from '@google/genai';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
  location: 'global'
});

export class AudioWorkerAgent {
  static async process(buffer: Buffer, fileName: string, mimeType?: string): Promise<CanonicalIngestPayload> {
    const startTime = performance.now();
    const base64Audio = buffer.toString('base64');
    const effectiveMime = mimeType?.startsWith('audio/') ? mimeType : 'audio/mp3';

    const prompt = `Jesteś Agentem Słuchu (Audio Ingest) w systemie PESAM.
Kierowca nagrał krótką wiadomość głosową ze smartfona o odebranych materiałach, zakupach lub WZ.
Twoim zadaniem jest zamienić mowę na ustrukturyzowany kontrakt dostawy.

ZASADY:
- Nazwy towarów: zachowaj potoczne sformułowania kierowcy (np. "regipsy", "profile", "wkręty").
- Jeśli kierowca podał numer WZ (np. "wuzetka 963 na 11") -> zapisz jako document_number.
- Jeśli wspomniał o budowie (np. "to na Kielce", "dla Tuchowa") -> target_site_hint.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: effectiveMime, data: base64Audio } }
        ]
      }],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            document_number: { type: Type.STRING },
            target_site_hint: { type: Type.STRING },
            seller_name: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lp: { type: Type.INTEGER },
                  raw_name: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  raw_unit: { type: Type.STRING }
                },
                required: ['lp', 'raw_name', 'quantity', 'raw_unit']
              }
            }
          },
          required: ['items']
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

    return {
      meta: {
        ingest_id: `ING-AUDIO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        source_type: 'DRIVER_AUDIO',
        processed_by_agent: 'Agent-Audio',
        fallback_occurred: false,
        cost_usd: 0.002,
        confidence_score: 0.85,
        execution_time_ms: executionTimeMs
      },
      document: {
        type: 'NOTATKA_KIEROWCY',
        number: rawJson.document_number || null,
        issue_date: new Date().toISOString().slice(0, 10),
        seller: {
          name: rawJson.seller_name || null,
          nip: null
        },
        buyer: {
          name: 'PESAM Sp. z o.o.',
          nip: null
        },
        target_site_hint: rawJson.target_site_hint || null
      },
      items: (rawJson.items || []).map((it: any, idx: number) => ({
        lp: it.lp || idx + 1,
        raw_name: it.raw_name || `Pozycja ${idx + 1}`,
        quantity: it.quantity || 1,
        raw_unit: it.raw_unit || 'szt',
        unit_price_net: null,
        total_net: null,
        vat_rate: null
      })),
      totals: {
        total_net: null,
        total_vat: null,
        total_gross: null,
        currency: 'PLN'
      }
    };
  }
}
