import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { tenderId } = await req.json();

        console.log(`[USUWANIE 🗑️] Otrzymano żądanie pełnego usunięcia przetargu: ${tenderId}`);

        if (!tenderId) {
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // Korzystamy z natywnej, atomowej metody Admin SDK do rekurencyjnego czyszczenia dokumentów wraz z subkolekcjami
        await adminDb.recursiveDelete(tenderRef);

        console.log(`[USUWANIE 🗑️] Pomyślnie i bezpowrotnie usunięto tenders/${tenderId} oraz jego subkolekcje.`);

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("[USUWANIE 🗑️] ❌ Błąd krytyczny podczas rekurencyjnego usuwania:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}