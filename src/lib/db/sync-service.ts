// src/lib/db/sync-service.ts
// =============================================================================
// PESAM Fleet — Serwis synchronizacji Firestore ↔ IndexedDB
// Logika: pobierz TYLKO to co się zmieniło od ostatniej synchronizacji
// =============================================================================
import {
    collection, getDocs, query, where, orderBy
} from 'firebase/firestore';
import { db } from '@/lib/firebase/config';
import {
    pesamDb,
    LocalVehicle,
    LocalRepair,
    getLastVehicleSync,
    getLastRepairSync,
    setLastVehicleSync,
    setLastRepairSync
} from './pesam-db';

// ─────────────────────────────────────────────────────────────────────────────
// TYPY WYNIKU SYNCHRONIZACJI
// ─────────────────────────────────────────────────────────────────────────────
export interface SyncResult {
    vehiclesAdded: number;
    repairsAdded: number;
    wasFullSync: boolean;
    syncedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GŁÓWNA FUNKCJA SYNCHRONIZACJI
// Wywołaj ją przy starcie aplikacji (np. w layout.tsx lub głównym komponencie)
// ─────────────────────────────────────────────────────────────────────────────
export async function syncWithFirestore(
    onProgress?: (msg: string) => void
): Promise<SyncResult> {
    const log = (msg: string) => {
        console.log(`[PESAM Sync] ${msg}`);
        onProgress?.(msg);
    };

    const syncedAt = new Date().toISOString();
    let vehiclesAdded = 0;
    let repairsAdded = 0;
    let wasFullSync = false;

    // ─────────────────────────────────────────────────────────────────────────
    // 1. SYNCHRONIZACJA POJAZDÓW
    // ─────────────────────────────────────────────────────────────────────────
    const lastVehicleSync = await getLastVehicleSync();

    if (!lastVehicleSync) {
        // PIERWSZE URUCHOMIENIE — pobierz wszystkie pojazdy
        log('Pierwsze uruchomienie: pobieram wszystkie pojazdy z Firestore...');
        wasFullSync = true;

        const snap = await getDocs(
            query(collection(db, 'vehicles'), orderBy('brand', 'asc'))
        );

        const vehicles: LocalVehicle[] = snap.docs.map(doc => {
            const d = doc.data();
            return {
                id: doc.id,
                brand: d.brand || 'Nieznany',
                model: d.model || 'Nieznany',
                year: d.year || 2000,
                registration: d.registration || 'Brak tablic',
                summerTires: d.summerTires || 'Tak',
                winterTires: d.winterTires || 'Tak',
                currentTires: d.currentTires || 'Letnie',
                inspectionDate: d.inspectionDate || '',
                dateAdded: d.dateAdded || '',
                initialMileage: d.initialMileage || 0,
                // Stare rekordy bez updatedAt dostają datę dodania lub "bardzo starą"
                updatedAt: d.updatedAt || d.dateAdded || '2020-01-01T00:00:00.000Z'
            };
        });

        // Zapisz wszystkie do IndexedDB jedną transakcją (szybko)
        await pesamDb.vehicles.bulkPut(vehicles);
        vehiclesAdded = vehicles.length;
        log(`✓ Zapisano ${vehicles.length} pojazdów do lokalnej bazy.`);

    } else {
        // KOLEJNE URUCHOMIENIA — pobierz tylko zmienione od ostatniego syncu
        log(`Sync przyrostowy pojazdów (od: ${lastVehicleSync})...`);

        const snap = await getDocs(
            query(
                collection(db, 'vehicles'),
                where('updatedAt', '>', lastVehicleSync),
                orderBy('updatedAt', 'desc')
            )
        );

        if (!snap.empty) {
            const vehicles: LocalVehicle[] = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    id: doc.id,
                    brand: d.brand || 'Nieznany',
                    model: d.model || 'Nieznany',
                    year: d.year || 2000,
                    registration: d.registration || 'Brak tablic',
                    summerTires: d.summerTires || 'Tak',
                    winterTires: d.winterTires || 'Tak',
                    currentTires: d.currentTires || 'Letnie',
                    inspectionDate: d.inspectionDate || '',
                    dateAdded: d.dateAdded || '',
                    initialMileage: d.initialMileage || 0,
                    updatedAt: d.updatedAt || syncedAt
                };
            });

            await pesamDb.vehicles.bulkPut(vehicles);
            vehiclesAdded = vehicles.length;
            log(`✓ Zaktualizowano ${vehicles.length} pojazdów.`);
        } else {
            log('✓ Pojazdy aktualne — brak zmian w Firestore.');
        }
    }

    await setLastVehicleSync(syncedAt);

    // ─────────────────────────────────────────────────────────────────────────
    // 2. SYNCHRONIZACJA NAPRAW
    // ─────────────────────────────────────────────────────────────────────────
    const lastRepairSync = await getLastRepairSync();

    if (!lastRepairSync) {
        // PIERWSZE URUCHOMIENIE — pobierz wszystkie naprawy
        log('Pierwsze uruchomienie: pobieram wszystkie naprawy z Firestore...');

        const snap = await getDocs(collection(db, 'repairs'));

        const repairs: LocalRepair[] = snap.docs.map(doc => {
            const d = doc.data();

            // Parsowanie kosztu (zabezpieczenie przed starymi stringami)
            let cost = 0;
            if (typeof d.cost === 'number') cost = d.cost;
            else if (typeof d.cost === 'string') cost = parseFloat(d.cost.replace(/[^0-9.]/g, '')) || 0;

            return {
                id: doc.id,
                vehicleId: d.vehicleId || '',
                date: d.date || '2020-01-01',
                cost,
                accountingNumber: d.accountingNumber || '',
                mileage: d.mileage || 0,
                comments: d.comments || '',
                location: d.location || '',
                // Kompatybilność wsteczna: stare rekordy mogą mieć repairType zamiast category
                category: d.category || d.repairType || 'Inne',
                invoiceUrl: d.invoiceUrl || '',
                legacyId: d.legacyId || '',
                partsList: Array.isArray(d.partsList) ? d.partsList : [],
                registrationNumberFromInvoice: d.registrationNumberFromInvoice || '',
                hasAiData: d.hasAiData || false,
                // Stare rekordy: użyj daty naprawy jako updatedAt
                updatedAt: d.updatedAt || (d.date ? `${d.date}T00:00:00.000Z` : '2020-01-01T00:00:00.000Z')
            };
        });

        await pesamDb.repairs.bulkPut(repairs);
        repairsAdded = repairs.length;
        log(`✓ Zapisano ${repairs.length} napraw do lokalnej bazy.`);

    } else {
        // KOLEJNE URUCHOMIENIA — tylko nowe/zmienione naprawy
        log(`Sync przyrostowy napraw (od: ${lastRepairSync})...`);

        const snap = await getDocs(
            query(
                collection(db, 'repairs'),
                where('updatedAt', '>', lastRepairSync),
                orderBy('updatedAt', 'desc')
            )
        );

        if (!snap.empty) {
            const repairs: LocalRepair[] = snap.docs.map(doc => {
                const d = doc.data();
                let cost = 0;
                if (typeof d.cost === 'number') cost = d.cost;
                else if (typeof d.cost === 'string') cost = parseFloat(d.cost.replace(/[^0-9.]/g, '')) || 0;

                return {
                    id: doc.id,
                    vehicleId: d.vehicleId || '',
                    date: d.date || '2020-01-01',
                    cost,
                    accountingNumber: d.accountingNumber || '',
                    mileage: d.mileage || 0,
                    comments: d.comments || '',
                    location: d.location || '',
                    category: d.category || d.repairType || 'Inne',
                    invoiceUrl: d.invoiceUrl || '',
                    legacyId: d.legacyId || '',
                    partsList: Array.isArray(d.partsList) ? d.partsList : [],
                    registrationNumberFromInvoice: d.registrationNumberFromInvoice || '',
                    hasAiData: d.hasAiData || false,
                    updatedAt: d.updatedAt || syncedAt
                };
            });

            await pesamDb.repairs.bulkPut(repairs);
            repairsAdded = repairs.length;
            log(`✓ Zaktualizowano ${repairs.length} napraw.`);
        } else {
            log('✓ Naprawy aktualne — brak zmian w Firestore.');
        }
    }

    await setLastRepairSync(syncedAt);

    return { vehiclesAdded, repairsAdded, wasFullSync, syncedAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNKCJA: WYMUŚ PEŁNĄ RESYNCHRONIZACJĘ
// Użyj gdy podejrzewasz że lokalna baza jest nieaktualna
// ─────────────────────────────────────────────────────────────────────────────
export async function forceFullResync(
    onProgress?: (msg: string) => void
): Promise<SyncResult> {
    const log = (msg: string) => onProgress?.(msg);
    log('Resetuję znaczniki synchronizacji...');

    // Kasujemy timestamps — przy następnym syncWithFirestore pobierze wszystko od nowa
    await pesamDb.meta.delete('lastVehicleSync');
    await pesamDb.meta.delete('lastRepairSync');
    await pesamDb.vehicles.clear();
    await pesamDb.repairs.clear();

    log('Rozpoczynam pełną synchronizację...');
    return syncWithFirestore(onProgress);
}