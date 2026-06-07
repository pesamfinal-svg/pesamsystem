// ============================================================
// PESAM – Endpoint: Answer Question (ASK_USER)
// POST /api/kosztorysant/scope-manifest/answer-question
//
// Odbiera od użytkownika wartość, przelicza koszt i tworzy sekcję kosztorysu
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import type { ScopeManifest, CoverageEntry } from '../../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    console.log("[API Answer Question] Otrzymano odpowiedź na pytanie z czatu...");

    try {
        const { tenderId, elementId, value, unit } = await req.json() as {
            tenderId: string;
            elementId: string;
            value: number;
            unit: string;
        };

        if (!tenderId || !elementId || value === undefined) {
            console.error("[API Answer Question] ❌ Błąd: Brak parametrów.");
            return NextResponse.json({ error: 'Brak wymaganych parametrów wejściowych' }, { status: 400 });
        }

        console.log(`[API Answer Question] ID: ${tenderId} | Element: ${elementId} | Wartość: ${value} ${unit}`);

        const manifestRef = adminDb.doc(`tenders/${tenderId}/scopeManifest/main`);
        const manifestDoc = await manifestRef.get();

        if (!manifestDoc.exists) {
            console.error("[API Answer Question] ❌ Błąd: ScopeManifest nie istnieje.");
            return NextResponse.json({ error: 'ScopeManifest nie istnieje' }, { status: 404 });
        }

        const manifest = manifestDoc.data() as ScopeManifest;

        // Szukamy elementu, który użytkownik uzupełnił
        let targetElement = null;
        let targetDivisionId = '';
        for (const div of manifest.requiredDivisions) {
            const el = div.elements.find((e) => e.elementId === elementId);
            if (el) { targetElement = el; targetDivisionId = div.divisionId; break; }
        }

        if (!targetElement) {
            console.error(`[API Answer Question] ❌ Błąd: Nie znaleziono elementu ${elementId} w strukturze.`);
            return NextResponse.json({ error: 'Element nie znaleziony w strukturze manifestu' }, { status: 404 });
        }

        const now = new Date().toISOString();

        // Przeliczanie: Jeśli użytkownik podał czystą kwotę PLN lub ilość fizyczną (np. m3)
        let estimatedValue_PLN = value;
        let note = `Wycena podana bezpośrednio przez kosztorysanta: ${value} ${unit}`;

        if (unit !== 'PLN') {
            const defaultRates: Record<string, number> = {
                'm²': 250,
                'm³': 800,
                't': 5500,
                'kpl.': 50000,
                'szt.': 5000,
                'mb': 120,
            };
            const rate = defaultRates[unit] ?? 1000;
            estimatedValue_PLN = Math.round(value * rate);
            note = `Koszt doliczony: ${value} ${unit} × ${rate} PLN/${unit} = ${estimatedValue_PLN.toLocaleString('pl-PL')} PLN (użyto polskiej stawki referencyjnej)`;
        }

        // Aktualizacja bazy danych (ScopeManifest)
        console.log(`[API Answer Question] Aktualizuję ScopeManifest dla ${elementId}...`);
        const updatedCoverage: CoverageEntry[] = manifest.coverageStatus.map((entry) =>
            entry.elementId === elementId
                ? {
                    ...entry,
                    status: 'GAP_FILLED' as const,
                    dataQuality: 'ESTIMATED' as const,
                    gapFillerNote: note,
                    gapFillerValue: estimatedValue_PLN,
                    coveredBySectionId: `USER-${elementId}`,
                    pendingQuestion: undefined, // Zdejmujemy pytanie z kolejki
                    lastUpdatedBy: 'user',
                    lastUpdatedAt: now,
                }
                : entry
        );

        await manifestRef.update({
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
        });

        // Zapisywanie wyliczonego działu do kosztorysu głównego tenders/{id}
        console.log(`[API Answer Question] Zapisuję nową sekcję wyceny ręcznej do kosztorysu głównego...`);
        const tenderRef = adminDb.doc(`tenders/${tenderId}`);
        const tenderDoc = await tenderRef.get();
        const existingSections = tenderDoc.data()?.sections ?? [];

        const newSection = {
            sectionId: `USER-${elementId}`,
            divisionId: targetDivisionId,
            items: [{
                itemId: `USER-ITEM-${elementId}`,
                name: targetElement.name,
                unit,
                quantity: unit !== 'PLN' ? value : null,
                unitPrice: unit !== 'PLN' ? estimatedValue_PLN / value : null,
                totalPrice: estimatedValue_PLN,
                dataQuality: 'ESTIMATED',
                source: 'USER_INPUT',
                note,
            }],
            totalPrice: estimatedValue_PLN,
            dataQuality: 'ESTIMATED',
            isUserProvided: true,
        };

        // Podmieniamy starą wersję tej ręcznej sekcji (jeśli istniała)
        const cleanSections = existingSections.filter(
            (s: any) => s.sectionId !== `USER-${elementId}`
        );
        await tenderRef.update({ sections: [...cleanSections, newSection] });

        console.log(`[API Answer Question] ✅ Pomyślnie przetworzono odpowiedź. Wyceniono pozycję: ${targetElement.name}`);
        return NextResponse.json({
            success: true,
            estimatedValue_PLN,
            note,
            chatMessage: `✅ Zapisałem pozycję **"${targetElement.name}"**: ~${estimatedValue_PLN.toLocaleString('pl-PL')} PLN. ${note}`,
        });

    } catch (error: any) {
        console.error("[API Answer Question] ❌ Krytyczny błąd serwera:", error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}