// src/lib/db/pesam-db.ts
// =============================================================================
// PESAM Fleet — Lokalna baza danych IndexedDB (Dexie.js)
// Zastępuje ulotny cache useState. Dane przeżywają odświeżenie strony.
// =============================================================================
import Dexie, { Table } from 'dexie';

// ─────────────────────────────────────────────────────────────────────────────
// TYPY (identyczne jak w Firestore — jedna źródło prawdy)
// ─────────────────────────────────────────────────────────────────────────────
export interface LocalVehicle {
    id: string;
    brand: string;
    model: string;
    year: number;
    registration: string;
    summerTires: 'Tak' | 'Nie';
    winterTires: 'Tak' | 'Nie';
    currentTires: 'Letnie' | 'Zimowe';
    inspectionDate: string;
    dateAdded: string;
    initialMileage: number;
    updatedAt: string;
}

export interface LocalRepair {
    id: string;
    vehicleId: string;
    date: string;
    cost: number;
    accountingNumber: string;
    mileage: number;
    comments: string;
    location: string;
    category: string;
    invoiceUrl?: string;
    legacyId?: string;
    partsList?: string[];
    registrationNumberFromInvoice?: string;
    hasAiData?: boolean;
    updatedAt: string;
}

export interface LocalMeta {
    key: string;   // np. 'lastVehicleSync', 'lastRepairSync'
    value: string; // ISO timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFINICJA BAZY DEXIE
// ─────────────────────────────────────────────────────────────────────────────
class PesamDatabase extends Dexie {
    vehicles!: Table<LocalVehicle, string>;
    repairs!: Table<LocalRepair, string>;
    meta!: Table<LocalMeta, string>;

    constructor() {
        super('PesamFleetDB'); // Nazwa bazy w przeglądarce

        this.version(1).stores({
            // Indeksy: pierwsze pole = klucz główny, reszta = pola do szybkiego wyszukiwania
            vehicles: 'id, brand, registration, updatedAt',
            repairs: 'id, vehicleId, date, category, updatedAt',
            meta: 'key'
        });
    }
}

// Singleton — jedna instancja na całą aplikację
export const pesamDb = new PesamDatabase();

// ─────────────────────────────────────────────────────────────────────────────
// POMOCNICZE FUNKCJE ODCZYTU (używane przez AI Analyst i komponenty React)
// ─────────────────────────────────────────────────────────────────────────────

/** Pobiera wszystkie pojazdy z lokalnej bazy */
export async function localGetAllVehicles(): Promise<LocalVehicle[]> {
    return pesamDb.vehicles.orderBy('brand').toArray();
}

/** Pobiera naprawy dla konkretnego pojazdu */
export async function localGetRepairsForVehicle(vehicleId: string): Promise<LocalRepair[]> {
    return pesamDb.repairs
        .where('vehicleId').equals(vehicleId)
        .sortBy('date')
        .then(arr => arr.reverse()); // Najnowsze pierwsze
}

/** Pobiera wszystkie naprawy (dla AI Analyst) */
export async function localGetAllRepairs(): Promise<LocalRepair[]> {
    return pesamDb.repairs.toArray();
}

/** Sprawdza kiedy ostatnio synchronizowano pojazdy */
export async function getLastVehicleSync(): Promise<string | null> {
    const meta = await pesamDb.meta.get('lastVehicleSync');
    return meta?.value || null;
}

/** Sprawdza kiedy ostatnio synchronizowano naprawy */
export async function getLastRepairSync(): Promise<string | null> {
    const meta = await pesamDb.meta.get('lastRepairSync');
    return meta?.value || null;
}

/** Zapisuje timestamp ostatniej synchronizacji */
export async function setLastVehicleSync(timestamp: string): Promise<void> {
    await pesamDb.meta.put({ key: 'lastVehicleSync', value: timestamp });
}

export async function setLastRepairSync(timestamp: string): Promise<void> {
    await pesamDb.meta.put({ key: 'lastRepairSync', value: timestamp });
}

/** Czyści całą lokalną bazę (np. po wylogowaniu) */
export async function clearLocalDatabase(): Promise<void> {
    await Promise.all([
        pesamDb.vehicles.clear(),
        pesamDb.repairs.clear(),
        pesamDb.meta.clear()
    ]);
}