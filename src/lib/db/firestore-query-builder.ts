// src/lib/db/firestore-query-builder.ts
// =============================================================================
// PESAM — Strateg Danych (Agent 0)
// Poprawka: filtry where() MUSZĄ być przed orderBy() w Firestore Admin SDK
// =============================================================================

import { getFirestore, Query, DocumentData } from 'firebase-admin/firestore';
import { initializeApp, getApps, cert } from 'firebase-admin/app';

// ─────────────────────────────────────────────────────────────────────────────
// Inicjalizacja Firebase Admin
// ─────────────────────────────────────────────────────────────────────────────
function getAdminDb() {
    if (!getApps().length) {
        initializeApp({
            credential: cert({
                projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
                clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
        });
    }
    return getFirestore();
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPY
// ─────────────────────────────────────────────────────────────────────────────
export interface FirestoreQueryPlan {
    needsVehicles: boolean;
    vehicleFilters: {
        brand?: string;
        model?: string;
        registration?: string;
    };
    needsRepairs: boolean;
    repairFilters: {
        dateFrom?: string;
        dateTo?: string;
        category?: string;
        vehicleIds?: string[];
    };
    repairFields: {
        needsComments: boolean;
        needsLocation: boolean;
        needsPartsList: boolean;
        needsMileage: boolean;
    };
    repairsLimit: number;
    reasoning: string;
}

export interface Vehicle {
    id: string;
    brand: string;
    model: string;
    registration: string;
    initialMileage: number;
}

export interface Repair {
    vehicleId: string;
    cost: number;
    date: string;
    category: string;
    mileage?: number;
    comments?: string;
    location?: string;
    partsList?: string[];
}

export interface QueryResult {
    vehicles: Vehicle[];
    repairs: Repair[];
    fetchSummary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — buduje zapytanie o naprawy z zachowaniem kolejności Firestore:
//   where() → where() → orderBy() → limit()
//
// ZASADA FIRESTORE:
//   1. Jeśli filtrujesz po polu X i sortujesz po polu Y (różne pola)
//      → potrzebujesz composite index w Firestore Console
//   2. Jeśli filtrujesz po polu X i sortujesz po tym samym polu X
//      → działa bez dodatkowego indexu
//   3. where() zawsze PRZED orderBy()
//
// DLATEGO: przy filtrze dateFrom/dateTo sortujemy po 'date' (to samo pole)
//          przy filtrze category + daty potrzebny composite index:
//          repairs: category ASC, date DESC
// ─────────────────────────────────────────────────────────────────────────────
function buildRepairQuery(
    db: ReturnType<typeof getFirestore>,
    vehicleIds: string[] | null,
    repairFilters: FirestoreQueryPlan['repairFilters'],
    repairsLimit: number
): Query<DocumentData>[] {
    const CHUNK_SIZE = 30;
    const queries: Query<DocumentData>[] = [];

    const buildSingle = (ids: string[] | null): Query<DocumentData> => {
        let q: Query<DocumentData> = db.collection('repairs');

        // 1. Filtry where() — ZAWSZE pierwsze
        if (ids && ids.length > 0) {
            q = q.where('vehicleId', 'in', ids);
        }
        if (repairFilters.category) {
            q = q.where('category', '==', repairFilters.category);
        }
        if (repairFilters.dateFrom) {
            q = q.where('date', '>=', repairFilters.dateFrom);
        }
        if (repairFilters.dateTo) {
            q = q.where('date', '<=', repairFilters.dateTo);
        }

        // 2. orderBy() — po filtrach
        // Jeśli filtrujemy po dacie, sortujemy po dacie (ten sam field — OK bez indexu)
        // Jeśli filtrujemy po category + dacie, potrzebny composite index w Firestore
        q = q.orderBy('date', 'desc');

        // 3. limit() — na końcu
        q = q.limit(repairsLimit);

        return q;
    };

    if (vehicleIds && vehicleIds.length > 0) {
        // Dzielimy na chunki po 30 (limit operatora 'in' w Firestore)
        for (let i = 0; i < vehicleIds.length; i += CHUNK_SIZE) {
            queries.push(buildSingle(vehicleIds.slice(i, i + CHUNK_SIZE)));
        }
    } else {
        queries.push(buildSingle(null));
    }

    return queries;
}

// ─────────────────────────────────────────────────────────────────────────────
// GŁÓWNA FUNKCJA
// ─────────────────────────────────────────────────────────────────────────────
export async function executeQueryPlan(plan: FirestoreQueryPlan): Promise<QueryResult> {
    const db = getAdminDb();
    let vehicles: Vehicle[] = [];
    let repairs: Repair[] = [];
    const summaryParts: string[] = [];

    // ── 1. Pobierz pojazdy ───────────────────────────────────────────────────
    if (plan.needsVehicles) {
        let vehicleQuery: Query<DocumentData> = db.collection('vehicles');

        // Jedyne co możemy filtrować w Firestore bez JS = dokładny nr rejestracyjny
        if (plan.vehicleFilters.registration) {
            vehicleQuery = vehicleQuery.where('registration', '==', plan.vehicleFilters.registration);
        }

        const snap = await vehicleQuery.get();
        const all: Vehicle[] = snap.docs.map(d => ({
            id: d.id,
            brand: d.data().brand || '',
            model: d.data().model || '',
            registration: d.data().registration || '',
            initialMileage: d.data().initialMileage || 0,
        }));

        // Brand i model: filtrujemy JS-owo (case-insensitive, Firestore nie ma ILIKE)
        vehicles = all.filter(v => {
            const brandOk = !plan.vehicleFilters.brand ||
                v.brand.toLowerCase().includes(plan.vehicleFilters.brand.toLowerCase());
            const modelOk = !plan.vehicleFilters.model ||
                v.model.toLowerCase().includes(plan.vehicleFilters.model.toLowerCase());
            return brandOk && modelOk;
        });

        summaryParts.push(`pojazdy: ${vehicles.length}`);
    }

    // ── 2. Pobierz naprawy ───────────────────────────────────────────────────
    if (plan.needsRepairs) {
        const targetIds: string[] | null = plan.repairFilters.vehicleIds?.length
            ? plan.repairFilters.vehicleIds
            : vehicles.length > 0
                ? vehicles.map(v => v.id)
                : null; // null = brak filtrów ID = pobierz całą flotę

        const queries = buildRepairQuery(db, targetIds, plan.repairFilters, plan.repairsLimit);

        // Wykonaj wszystkie zapytania równolegle (Promise.all dla chunków)
        const snapshots = await Promise.all(queries.map(q => q.get()));

        const seen = new Set<string>(); // deduplikacja jeśli auto pasuje do wielu chunków

        snapshots.forEach(snap => {
            snap.docs.forEach(d => {
                if (seen.has(d.id)) return;
                seen.add(d.id);

                const data = d.data();
                repairs.push({
                    vehicleId: data.vehicleId || '',
                    cost: Number(data.cost) || 0,
                    date: data.date || '',
                    category: data.category || '',
                    ...(plan.repairFields.needsMileage && { mileage: data.mileage }),
                    ...(plan.repairFields.needsComments && { comments: data.comments }),
                    ...(plan.repairFields.needsLocation && { location: data.location }),
                    ...(plan.repairFields.needsPartsList && { partsList: data.partsList }),
                });
            });
        });

        summaryParts.push(`naprawy: ${repairs.length} (limit/chunk: ${plan.repairsLimit})`);
    }

    return {
        vehicles,
        repairs,
        fetchSummary: summaryParts.join(' | '),
    };
}