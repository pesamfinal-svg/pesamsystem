// ============================================================
// PESAM – Endpoint: Update Coverage Entry
// PATCH /api/kosztorysant/scope-manifest/update-coverage
//
// Służy do zmiany statusu elementu (np. na NEEDS_REVIEW) przez kosztorysanta
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import type { ScopeManifest } from '../../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
    console.log("[API Update Coverage] Rozpoczynam aktualizację statusu pokrycia...");

    try {
        const { tenderId, elementId, status, dataQuality, coveredBySectionId } = await req.json() as {
            tenderId: string;
            elementId: string;
            status: string;
            dataQuality?: string;
            coveredBySectionId?: string;
        };

        if (!tenderId || !elementId || !status) {
            console.error("[API Update Coverage] ❌ Błąd: Brak wymaganych parametrów.");
            return NextResponse.json({ error: 'Brak wymaganych pól w żądaniu' }, { status: 400 });
        }

        console.log(`[API Update Coverage] Projekt: ${tenderId} | Element: ${elementId} -> Nowy Status: ${status}`);

        const manifestRef = adminDb.doc(`tenders/${tenderId}/scopeManifest/main`);
        const manifestDoc = await manifestRef.get();

        if (!manifestDoc.exists) {
            console.error("[API Update Coverage] ❌ Błąd: ScopeManifest nie istnieje w bazie.");
            return NextResponse.json({ error: 'ScopeManifest nie istnieje' }, { status: 404 });
        }

        const manifest = manifestDoc.data() as ScopeManifest;
        const now = new Date().toISOString();

        const updatedCoverage = manifest.coverageStatus.map((entry) =>
            entry.elementId === elementId
                ? {
                    ...entry,
                    status: status as any,
                    ...(dataQuality ? { dataQuality: dataQuality as any } : {}),
                    ...(coveredBySectionId ? { coveredBySectionId } : {}),
                    lastUpdatedBy: 'user',
                    lastUpdatedAt: now,
                }
                : entry
        );

        await manifestRef.update({
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
        });

        console.log(`[API Update Coverage] ✅ Pomyślnie zaktualizowano status dla elementu: ${elementId}`);
        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("[API Update Coverage] ❌ Krytyczny błąd serwera:", error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}