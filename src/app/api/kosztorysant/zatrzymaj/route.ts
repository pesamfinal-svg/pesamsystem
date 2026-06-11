import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { tenderId } = await req.json();

        console.log(`[AWARYJNY STOP 🛑] Zatrzymywanie przetargu: ${tenderId}`);

        if (!tenderId) {
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const batch = adminDb.batch();

        // 1. Zmiana statusu głównego na HALTED
        batch.update(tenderRef, {
            status: "HALTED",
            updatedAt: new Date()
        });

        // 2. Anulujemy wszystkie aktywne lub zaplanowane zadania
        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        console.log(`[AWARYJNY STOP 🛑] Wykryto ${activeTasksSnap.size} aktywnych/oczekujących zadań do anulowania.`);

        activeTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, {
                status: "ERROR",
                rawResult: { error: "CANCELLED_BY_USER", message: "Zadanie przerwane awaryjnie przez użytkownika." },
                processedByBrain: true, // Blokujemy, by Mózg już do tego nie zaglądał
                updatedAt: new Date()
            });
        });

        await batch.commit();
        console.log(`[AWARYJNY STOP 🛑] Rój pomyślnie zatrzymany.`);

        return NextResponse.json({ success: true, cancelledTasksCount: activeTasksSnap.size });
    } catch (e: any) {
        console.error("[AWARYJNY STOP 🛑] ❌ Błąd zatrzymywania:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}