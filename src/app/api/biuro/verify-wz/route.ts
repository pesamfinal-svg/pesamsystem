// src/app/api/biuro/verify-wz/route.ts
// Moduł weryfikacji WZ przez porównanie z notatką kierowcy.
//
// Logika (wg biuro-ai.md §Moduł 2 + §3.5):
//   1. Szukaj w Firestore driver_wz_notes gdzie wz_ref == document_number z WZ
//   2. Brak notatki → HITL_NO_NOTE
//   3. Jest notatka → Gemini semantycznie porównuje pozycje
//   4. ≥1 pozycja: name semantycznie OK + quantity ±5% → AUTO_VERIFIED
//   5. Wszystkie rozbieżne → HITL_MISMATCH

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { db } from '@/lib/firebase/config';
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const runtime = 'nodejs';

// ─── Typy ────────────────────────────────────────────────────────────────────

interface WzItem {
    lp: number;
    name: string;
    quantity: number;
    unit: string;
    value_net?: number;
}

interface DriverItem {
    name: string;
    quantity: number;
    unit: string;
}

interface MatchedPair {
    driver_item: DriverItem;
    wz_item: WzItem;
    name_match_score: number;    // 0.0 – 1.0
    quantity_match: boolean;     // true jeśli ilość ±5%
    verdict: 'MATCH' | 'NAME_OK_QTY_DIFF' | 'NO_MATCH';
    explanation: string;
}

export type VerificationVerdict =
    | 'AUTO_VERIFIED'       // ≥1 pozycja w pełni pasuje → można przyjąć bez HITL
    | 'PARTIAL_MATCH'       // ≥1 pozycja pasuje semantycznie, ale ilości się różnią → HITL zalecany
    | 'HITL_MISMATCH'       // żadna pozycja nie pasuje → wymagana ludzka weryfikacja
    | 'HITL_NO_NOTE';       // brak notatki kierowcy w bazie → HITL

export interface VerifyWzResponse {
    verdict: VerificationVerdict;
    confidence: number;              // 0.0 – 1.0
    document_number: string;
    note_found: boolean;
    note_id?: string;
    driver_name?: string;
    driver_raw_text?: string;
    matched_pairs: MatchedPair[];
    summary: string;                 // zdanie dla UI
    execution_time_ms: number;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    const start = performance.now();

    try {
        const body = await req.json();
        const { document_number, items: wzItems } = body as {
            document_number: string;
            items: WzItem[];
        };

        if (!document_number) {
            return NextResponse.json({ error: 'Wymagane pole: document_number' }, { status: 400 });
        }

        // ── Krok 1: Szukaj notatki kierowcy ──────────────────────────────────
        // Szukaj po dokładnym dopasowaniu ORAZ po numerze bazowym (bez sufiksów /DE, /CMB itp.)
        const baseNumber = document_number.replace(/\/[A-Z]{2,4}$/i, '').trim().toUpperCase();
        const normalizedDocNumber = document_number.trim().toUpperCase();

        const notesRef = collection(db, 'driver_wz_notes');
        const q = query(
            notesRef,
            where('wz_ref', '>=', baseNumber),
            where('wz_ref', '<=', baseNumber + '\uf8ff'),
            orderBy('wz_ref'),
            orderBy('createdAt', 'desc'),
            limit(5)
        );

        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            const ms = Math.round(performance.now() - start);
            const response: VerifyWzResponse = {
                verdict: 'HITL_NO_NOTE',
                confidence: 0,
                document_number: normalizedDocNumber,
                note_found: false,
                matched_pairs: [],
                summary: `Brak notatki kierowcy dla WZ "${document_number}". Wymagana ręczna weryfikacja.`,
                execution_time_ms: ms
            };
            return NextResponse.json({ success: true, data: response });
        }

        // Bierzemy najnowszą notatkę
        const noteDoc = snapshot.docs[0];
        const noteData = noteDoc.data() as {
            wz_ref: string;
            raw_text: string;
            items: DriverItem[];
            driver_name?: string;
        };

        const driverItems: DriverItem[] = noteData.items || [];

        // ── Krok 2: Semantic matching przez Gemini ────────────────────────────
        const matchedPairs = await semanticMatch(driverItems, wzItems || []);

        // ── Krok 3: Wyznacz werdykt ────────────────────────────────────────
        const fullMatches = matchedPairs.filter(p => p.verdict === 'MATCH');
        const nameMatches = matchedPairs.filter(p => p.verdict === 'NAME_OK_QTY_DIFF');

        let verdict: VerificationVerdict;
        let confidence: number;
        let summary: string;

        if (fullMatches.length >= 1) {
            verdict = 'AUTO_VERIFIED';
            confidence = Math.min(0.99, 0.75 + fullMatches.length * 0.08);
            summary = `✅ AUTO_VERIFIED — ${fullMatches.length} pozycja/-e w pełni zgodna/-e z notatką kierowcy ${noteData.driver_name || ''}. Dokument przyjęty bez HITL.`;
        } else if (nameMatches.length >= 1) {
            verdict = 'PARTIAL_MATCH';
            confidence = 0.5 + nameMatches.length * 0.1;
            summary = `⚠️ PARTIAL_MATCH — ${nameMatches.length} pozycja/-e rozpoznana/-e semantycznie, ale ilości się różnią. Zalecana weryfikacja człowieka.`;
        } else {
            verdict = 'HITL_MISMATCH';
            confidence = 0.1;
            summary = `🚨 HITL_MISMATCH — żadna pozycja z notatki kierowcy nie pasuje do WZ. Wymagana ręczna weryfikacja.`;
        }

        const ms = Math.round(performance.now() - start);
        const response: VerifyWzResponse = {
            verdict,
            confidence: Math.round(confidence * 100) / 100,
            document_number: normalizedDocNumber,
            note_found: true,
            note_id: noteDoc.id,
            driver_name: noteData.driver_name,
            driver_raw_text: noteData.raw_text,
            matched_pairs: matchedPairs,
            summary,
            execution_time_ms: ms
        };

        return NextResponse.json({ success: true, data: response });

    } catch (error: any) {
        console.error('[verify-wz] Błąd:', error);
        return NextResponse.json({ error: error.message || 'Błąd serwera' }, { status: 500 });
    }
}

// ─── Semantic Matcher (Gemini Flash-Lite) ─────────────────────────────────────

async function semanticMatch(
    driverItems: DriverItem[],
    wzItems: WzItem[]
): Promise<MatchedPair[]> {

    if (driverItems.length === 0 || wzItems.length === 0) {
        return [];
    }

    // Buduj prompt z listami po obu stronach
    const driverList = driverItems.map((it, i) =>
        `  D${i + 1}. "${it.name}" — ilość: ${it.quantity} ${it.unit}`
    ).join('\n');

    const wzList = wzItems.map((it) =>
        `  W${it.lp}. "${it.name}" — ilość: ${it.quantity} ${it.unit}`
    ).join('\n');

    const prompt = `Jesteś ekspertem materiałów budowlanych w polskiej firmie. Porównaj semantycznie pozycje podane przez kierowcę z pozycjami z dokumentu WZ.

POZYCJE KIEROWCY (potoczne nazwy z budowy):
${driverList}

POZYCJE Z DOKUMENTU WZ (oficjalne nazwy handlowe):
${wzList}

ZASADY OCENY:
- "regipsy" = "Płyta G-K" = "PŁYTA GKBI" = "KNAUF GKB" → semantycznie to samo
- "profile" = "PROFIL C" = "PROFIL UA" = "PROFIL CD" → ta sama rodzina, ale typ może się różnić
- "taśma" = "TAŚMA DYLATACYJNA" = "taśma uszczelniająca" → semantycznie to samo
- "wiertło" samotnie = "WIERTŁO DO METALU", "WIERTŁO DO BETONU" itp. → semantycznie to samo
- Ilość uznaj za zgodną jeśli różnica ≤ 5% (tolerancja zaokrągleń)
- Jeśli kierowca nie podał ilości (0) → quantity_match = true (nie oceniamy)

Dla każdej pozycji kierowcy wskaż najlepiej pasującą pozycję z WZ (lub null jeśli brak).`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    matches: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                driver_index: { type: Type.INTEGER, description: 'Indeks pozycji kierowcy (0-based).' },
                                wz_lp: { type: Type.INTEGER, description: 'Numer lp pozycji WZ. -1 jeśli brak dopasowania.' },
                                name_match_score: { type: Type.NUMBER, description: 'Ocena semantycznego podobieństwa nazw: 0.0–1.0.' },
                                quantity_match: { type: Type.BOOLEAN, description: 'Czy ilość jest zgodna (±5%).' },
                                explanation: { type: Type.STRING, description: 'Krótkie uzasadnienie (max 1 zdanie).' }
                            },
                            required: ['driver_index', 'wz_lp', 'name_match_score', 'quantity_match', 'explanation']
                        }
                    }
                },
                required: ['matches']
            }
        }
    });

    let aiMatches: {
        driver_index: number;
        wz_lp: number;
        name_match_score: number;
        quantity_match: boolean;
        explanation: string;
    }[] = [];

    try {
        const parsed = JSON.parse(response.text || '{}');
        aiMatches = parsed.matches || [];
    } catch {
        aiMatches = [];
    }

    // Buduj strukturę MatchedPair
    const result: MatchedPair[] = [];

    for (const m of aiMatches) {
        const driverItem = driverItems[m.driver_index];
        if (!driverItem) continue;

        const wzItem = wzItems.find(w => w.lp === m.wz_lp) || null;

        if (!wzItem) {
            result.push({
                driver_item: driverItem,
                wz_item: { lp: -1, name: '(brak dopasowania)', quantity: 0, unit: '' },
                name_match_score: 0,
                quantity_match: false,
                verdict: 'NO_MATCH',
                explanation: m.explanation || 'Brak pasującej pozycji w WZ.'
            });
            continue;
        }

        let verdict: MatchedPair['verdict'];
        if (m.name_match_score >= 0.75 && m.quantity_match) {
            verdict = 'MATCH';
        } else if (m.name_match_score >= 0.75) {
            verdict = 'NAME_OK_QTY_DIFF';
        } else {
            verdict = 'NO_MATCH';
        }

        result.push({
            driver_item: driverItem,
            wz_item: wzItem,
            name_match_score: m.name_match_score,
            quantity_match: m.quantity_match,
            verdict,
            explanation: m.explanation
        });
    }

    return result;
}
