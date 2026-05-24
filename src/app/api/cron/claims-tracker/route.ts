// src/app/api/cron/claims-tracker/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');

    // Klucz zabezpieczający (Darmowy token)
    const cronSecret = process.env.CRON_SECRET || 'pesam-system-cron-secret-2026';

    if (key !== cronSecret) {
        return NextResponse.json({ error: "Brak autoryzacji" }, { status: 401 });
    }

    const now = new Date();
    const logs: string[] = [];

    try {
        // =========================================================================
        // CZĘŚĆ 1: KONTROLA PRZESŁUCHANIA KIEROWNIKÓW (STATUS: NOWA)
        // =========================================================================
        const claimsSnap = await adminDb.collection("claims").where("status", "==", "NOWA").get();

        for (const docSnap of claimsSnap.docs) {
            const claim = docSnap.data();
            const createdAt = new Date(claim.createdAt);
            const diffHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

            const currentReminderCount = claim.reminderCount || 0;

            // A. Po 24h -> Przypomnienie I
            if (diffHours >= 24 && diffHours < 48 && currentReminderCount === 0) {
                await triggerEmail("REMINDER_1", claim);
                await docSnap.ref.update({ reminderCount: 1 });
                logs.push(`Sprawa ${claim.claimId}: Wysłano przypomnienie I (24h) do Kierownika.`);
            }
            // B. Po 48h -> Przypomnienie II (Ostateczne)
            else if (diffHours >= 48 && diffHours < 72 && currentReminderCount === 1) {
                await triggerEmail("REMINDER_2", claim);
                await docSnap.ref.update({ reminderCount: 2 });
                logs.push(`Sprawa ${claim.claimId}: Wysłano przypomnienie II (48h) do Kierownika.`);
            }
            // C. Po 72h -> Odmowa współpracy (Zablokowanie obrony i przekazanie do Szefa)
            else if (diffHours >= 72 && currentReminderCount < 3) {
                const refusalReport = `RAPORT KOŃCOWY SĘDZIEGO (AUTOMATYCZNY):\nKierownik budowy nie podjął współpracy z Asystentem AI i nie złożył wyjaśnień w ustawowym terminie 72 godzin.\n\nSprawa została przekazana bezpośrednio do ostatecznej decyzji Zarządu bez zeznań Kierownika.`;

                await docSnap.ref.update({
                    status: "W_TOKU", // Przechodzi do Szefa
                    aiReport: refusalReport,
                    reminderCount: 3 // Oznacz, że procedurę zamknięto
                });

                await triggerEmail("REFUSAL", claim);
                logs.push(`Sprawa ${claim.claimId}: Kierownik zignorował sprawę (72h). Przekazano do Szefa.`);
            }
        }

        // =========================================================================
        // CZĘŚĆ 2: AUTO-AKCEPTACJA WYROKÓW DYREKTORA (STATUS: DO_AKCEPTACJI)
        // =========================================================================
        const verdictsSnap = await adminDb.collection("claims").where("status", "==", "DO_AKCEPTACJI").get();

        for (const docSnap of verdictsSnap.docs) {
            const claim = docSnap.data();

            // Liczymy czas od momentu wydania wyroku przez Dyrektora
            const verdictDyrektorAt = claim.verdictDyrektorAt ? new Date(claim.verdictDyrektorAt) : new Date(claim.createdAt);
            const diffHoursVerd = (now.getTime() - verdictDyrektorAt.getTime()) / (1000 * 60 * 60);

            if (diffHoursVerd >= 72) {
                // Auto-akceptacja po 72h: kopiujemy wyrok Dyrektora jako ostateczny i zamykamy
                await docSnap.ref.update({
                    status: "ZAMKNIETA",
                    decisionInternal: claim.decisionInternalDyrektor || "Zatwierdzono automatycznie z powodu braku zmian.",
                    decisionWarehouse: claim.decisionWarehouseDyrektor || "Zatwierdzono automatycznie z powodu braku zmian.",
                    autoAcceptedAt: new Date().toISOString()
                });

                // Wysyłamy ostateczny mail o zamknięciu sprawy
                await triggerEmail("VERDICT_FINAL", {
                    ...claim,
                    status: "ZAMKNIETA"
                });
                logs.push(`Sprawa ${claim.claimId}: Wyrok Dyrektora zatwierdzony automatycznie po 72h.`);
            }
        }

        return NextResponse.json({ success: true, executedAt: now.toISOString(), logs });

    } catch (error: any) {
        console.error("Błąd skryptu Cron Tracker:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// Funkcja pomocnicza wywołująca lokalny moduł e-mail
async function triggerEmail(type: string, claim: any) {
    try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
        await fetch(`${siteUrl}/api/claims-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type,
                claimId: claim.claimId,
                inventoryName: claim.inventoryName,
                inventoryNumber: claim.inventoryNumber,
                siteName: claim.siteName,
                managerUid: claim.assignedManagers?.[0] || null,
                managerName: claim.reportedByName || "Kierownik",
                reportText: claim.aiReport || ""
            })
        });
    } catch (e) {
        console.error("Błąd pomocniczej wysyłki maila przez Cron:", e);
    }
}