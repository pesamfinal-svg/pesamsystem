// src/lib/db/migrate-updated-at.ts
// =============================================================================
// PESAM Fleet — Jednorazowy skrypt migracji
// Dodaje pole updatedAt do wszystkich starych napraw i pojazdów w Firestore.
// URUCHOM RAZ, potem możesz ten plik usunąć.
// =============================================================================
import {
    collection, getDocs, writeBatch, doc
} from 'firebase/firestore';
import { db } from '@/lib/firebase/config';

export interface MigrationResult {
    vehiclesUpdated: number;
    repairsUpdated: number;
    errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore writeBatch ma limit 500 operacji — ta funkcja obsługuje to auto
// ─────────────────────────────────────────────────────────────────────────────
async function runBatchedUpdates(
    updates: Array<{ id: string; collectionName: string; data: object }>
): Promise<number> {
    const BATCH_SIZE = 499;
    let totalUpdated = 0;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const chunk = updates.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);

        for (const update of chunk) {
            const ref = doc(db, update.collectionName, update.id);
            batch.update(ref, update.data);
        }

        await batch.commit();
        totalUpdated += chunk.length;
        console.log(`[Migracja] Zapisano batch ${Math.ceil((i + 1) / BATCH_SIZE)}: ${totalUpdated} rekordów...`);
    }

    return totalUpdated;
}

// ─────────────────────────────────────────────────────────────────────────────
// GŁÓWNA FUNKCJA MIGRACJI
// ─────────────────────────────────────────────────────────────────────────────
export async function migrateUpdatedAtField(
    onProgress?: (msg: string) => void
): Promise<MigrationResult> {
    const log = (msg: string) => {
        console.log(`[Migracja] ${msg}`);
        onProgress?.(msg);
    };

    const errors: string[] = [];
    let vehiclesUpdated = 0;
    let repairsUpdated = 0;

    // ─────────────────────────────────────────────────────────────────────────
    // 1. MIGRACJA POJAZDÓW
    // ─────────────────────────────────────────────────────────────────────────
    log('Skanowanie pojazdów...');
    try {
        const vehiclesSnap = await getDocs(collection(db, 'vehicles'));
        const vehicleUpdates: Array<{ id: string; collectionName: string; data: object }> = [];

        for (const docSnap of vehiclesSnap.docs) {
            const data = docSnap.data();

            // Pomijamy rekordy które już mają updatedAt
            if (data.updatedAt) continue;

            // Używamy dateAdded jako updatedAt — logiczne i zachowuje historię
            const updatedAt = data.dateAdded
                ? `${data.dateAdded}T00:00:00.000Z`
                : '2020-01-01T00:00:00.000Z';

            vehicleUpdates.push({
                id: docSnap.id,
                collectionName: 'vehicles',
                data: { updatedAt }
            });
        }

        if (vehicleUpdates.length > 0) {
            log(`Znaleziono ${vehicleUpdates.length} pojazdów bez updatedAt. Aktualizuję...`);
            vehiclesUpdated = await runBatchedUpdates(vehicleUpdates);
            log(`✓ Zaktualizowano ${vehiclesUpdated} pojazdów.`);
        } else {
            log('✓ Wszystkie pojazdy już mają pole updatedAt — pomijam.');
        }
    } catch (err: any) {
        const msg = `Błąd migracji pojazdów: ${err.message}`;
        errors.push(msg);
        log(`❌ ${msg}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. MIGRACJA NAPRAW
    // ─────────────────────────────────────────────────────────────────────────
    log('Skanowanie napraw...');
    try {
        const repairsSnap = await getDocs(collection(db, 'repairs'));
        const repairUpdates: Array<{ id: string; collectionName: string; data: object }> = [];

        for (const docSnap of repairsSnap.docs) {
            const data = docSnap.data();

            // Pomijamy rekordy które już mają updatedAt
            if (data.updatedAt) continue;

            // Używamy daty naprawy jako updatedAt — najlepsze przybliżenie
            // Stare naprawy z 2022 dostaną updatedAt = "2022-XX-XXT00:00:00.000Z"
            const updatedAt = data.date
                ? `${data.date}T00:00:00.000Z`
                : '2020-01-01T00:00:00.000Z';

            repairUpdates.push({
                id: docSnap.id,
                collectionName: 'repairs',
                data: { updatedAt }
            });
        }

        if (repairUpdates.length > 0) {
            log(`Znaleziono ${repairUpdates.length} napraw bez updatedAt. Aktualizuję...`);
            repairsUpdated = await runBatchedUpdates(repairUpdates);
            log(`✓ Zaktualizowano ${repairsUpdated} napraw.`);
        } else {
            log('✓ Wszystkie naprawy już mają pole updatedAt — pomijam.');
        }
    } catch (err: any) {
        const msg = `Błąd migracji napraw: ${err.message}`;
        errors.push(msg);
        log(`❌ ${msg}`);
    }

    log('🎉 Migracja zakończona!');
    return { vehiclesUpdated, repairsUpdated, errors };
}