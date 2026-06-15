import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { tenderId } = await req.json();

        console.log(`[AWARYJNY STOP 🛑] Zatrzymywanie całego Roju (Kosztorysant + Technolog): ${tenderId}`);

        if (!tenderId) {
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const techTasksRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`);
        const batch = adminDb.batch();

        // 1. Zmiana statusu głównego projektu na HALTED
        batch.update(tenderRef, {
            status: "HALTED",
            updatedAt: new Date()
        });

        // 2. Zamrożenie stanów obu Mózgów (żeby nie podejmowały nowych akcji)
        batch.set(adminDb.collection(`tenders/${tenderId}/brain`).doc("main"), { phase: "HALTED" }, { merge: true });
        batch.set(adminDb.collection(`tenders/${tenderId}/technolog`).doc("main"), { phase: "HALTED" }, { merge: true });

        // 3. Pobranie wszystkich aktywnych zadań dla Kosztorysanta ORAZ Technologa
        const [activeTasksSnap, activeTechTasksSnap] = await Promise.all([
            tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get(),
            techTasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get()
        ]);

        console.log(`[AWARYJNY STOP 🛑] Wykryto ${activeTasksSnap.size} zadań Kosztorysanta i ${activeTechTasksSnap.size} zadań Technologa do anulowania.`);

        // 4. Anulowanie zadań Kosztorysanta
        activeTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, {
                status: "ERROR",
                rawResult: { error: "CANCELLED_BY_USER", message: "Zadanie Kosztorysanta przerwane awaryjnie przez użytkownika." },
                processedByBrain: true, // Blokujemy, by Mózg już do tego nie zaglądał
                updatedAt: new Date()
            });
        });

        // 5. Anulowanie zadań Technologa
        activeTechTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, {
                status: "ERROR",
                rawResult: { error: "CANCELLED_BY_USER", message: "Zadanie Technologa przerwane awaryjnie przez użytkownika." },
                processedByTechnolog: true, // Blokujemy, by Technolog już do tego nie zaglądał
                updatedAt: new Date()
            });
        });

        await batch.commit();
        console.log(`[AWARYJNY STOP 🛑] Rój pomyślnie i całkowicie zamrożony.`);

        return NextResponse.json({
            success: true,
            cancelledTasksCount: activeTasksSnap.size + activeTechTasksSnap.size
        });
    } catch (e: any) {
        console.error("[AWARYJNY STOP 🛑] ❌ Błąd zatrzymywania:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}