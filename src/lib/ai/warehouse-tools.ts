// src/lib/ai/warehouse-tools.ts
// =============================================================================
// PESAM 2.0 — Deterministyczne Narzędzia Agregujące (TypeScript / Firestore)
// Zastępują zrzut 500 surowych dokumentów do promptu AI.
// Czas wykonania: ~10-50ms. Zero dławienia tokenów, zero wycieków poufnych danych.
// =============================================================================

import { adminDb } from '@/lib/firebase/admin';
import { Type, FunctionDeclaration } from '@google/genai';

// ─── DEKLARACJE NARZĘDZI DLA FUNCTION CALLING (GEMINI) ──────────────────────

export const WAREHOUSE_TOOL_DECLARATIONS: FunctionDeclaration[] = [
    {
        name: 'getRepairsSummary',
        description: 'Zwraca zagregowane koszty napraw i serwisów pojazdów floty PESAM (sumy, ilości, średnie). Użyj, gdy użytkownik pyta o koszty napraw, wydatki serwisowe, awarie lub porównanie marek pojazdów.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                brand: {
                    type: Type.STRING,
                    description: 'Filtruj po marce pojazdu (np. "Iveco", "Ford", "Renault"). Pozostaw puste dla całej floty.'
                },
                year: {
                    type: Type.NUMBER,
                    description: 'Rok naprawy (np. 2024, 2025). Pozostaw puste dla wszystkich lat.'
                },
                category: {
                    type: Type.STRING,
                    description: 'Kategoria naprawy (np. "Silnik", "Układ hamulcowy", "Zawieszenie", "Opony").'
                },
                groupBy: {
                    type: Type.STRING,
                    enum: ['category', 'vehicle', 'month', 'year'],
                    description: 'Po czym pogrupować wyniki: "category" (domyślnie), "vehicle" (wg aut/marek), "month" (trendy miesięczne), "year" (roczne).'
                }
            }
        }
    },
    {
        name: 'getInventorySummary',
        description: 'Zwraca zagregowany stan magazynowy, resztki materiałów oraz stany krytyczne w strefach magazynu PESAM. Użyj przy pytaniach o stany magazynowe, resztki w strefach lub braki towaru.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                zone: {
                    type: Type.STRING,
                    description: 'Strefa magazynowa (np. "A", "B", "C", "Plac"). Pozostaw puste dla całego magazynu.'
                },
                category: {
                    type: Type.STRING,
                    description: 'Kategoria materiału (np. "G-K", "Stal", "Beton", "Chemia", "Izolacje").'
                },
                lowStockOnly: {
                    type: Type.BOOLEAN,
                    description: 'true = zwróć tylko materiały o niskim stanie (poniżej normy).'
                },
                groupBy: {
                    type: Type.STRING,
                    enum: ['zone', 'category'],
                    description: 'Grupowanie: "zone" (wg stref magazynowych), "category" (wg kategorii materiałów).'
                }
            }
        }
    },
    {
        name: 'getFleetOverview',
        description: 'Zwraca zestawienie floty pojazdów PESAM: łączną liczbę aut, podział na marki, modele oraz pojazdy wymagające pilnego badania technicznego.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                brand: {
                    type: Type.STRING,
                    description: 'Filtruj wg marki (np. "Iveco", "Ford"). Pozostaw puste dla całej floty.'
                },
                needsInspectionOnly: {
                    type: Type.BOOLEAN,
                    description: 'true = zwróć tylko auta ze zbliżającym się lub przeterminowanym przeglądem.'
                }
            }
        }
    },
    {
        name: 'getSitesOverview',
        description: 'Zwraca listę i podsumowanie aktywnych budów PESAM, ich lokalizacje oraz przypisanych kierowników.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                activeOnly: {
                    type: Type.BOOLEAN,
                    description: 'true = tylko aktywne budowy.'
                }
            }
        }
    },
    {
        name: 'getClaimsAndCloseoutsSummary',
        description: 'Zwraca podsumowanie sporów (CLS) i zamknięć budów (protokoły strat, nierozliczony sprzęt, kary umowne).',
        parameters: {
            type: Type.OBJECT,
            properties: {
                status: {
                    type: Type.STRING,
                    description: 'Status: "W_TOKU", "ZAMKNIETE", "DO_DECYZJI".'
                }
            }
        }
    }
];

// ─── IMPLEMENTACJE WYKONAWCZE W TYPESCRIPT ───────────────────────────────────

export async function executeRepairsSummary(args: {
    brand?: string;
    year?: number;
    category?: string;
    groupBy?: 'category' | 'vehicle' | 'month' | 'year';
}) {
    const groupBy = args.groupBy || 'category';

    // 1. Pobierz pojazdy, by powiązać vehicleId -> marka / model / rejestracja
    const vehiclesSnap = await adminDb.collection('vehicles').get();
    const vehicleMap = new Map<string, { brand: string; model: string; reg: string }>();

    vehiclesSnap.docs.forEach(d => {
        const data = d.data();
        vehicleMap.set(d.id, {
            brand: data.brand || 'Nieznana',
            model: data.model || '',
            reg: data.registration || d.id
        });
    });

    // 2. Pobierz naprawy z bazy
    let query: FirebaseFirestore.Query = adminDb.collection('repairs');

    if (args.category) {
        query = query.where('category', '==', args.category);
    }

    const repairsSnap = await query.limit(500).get();

    // 3. Szybka agregacja w pamięci serwera (O(N), ~5ms)
    const groups = new Map<string, { totalCost: number; count: number }>();
    let grandTotal = 0;
    let validRecordsCount = 0;

    repairsSnap.docs.forEach(doc => {
        const rep = doc.data();
        const vInfo = vehicleMap.get(rep.vehicleId) || { brand: 'Inne', model: '', reg: 'Brak' };

        // Filtr marki
        if (args.brand && !vInfo.brand.toLowerCase().includes(args.brand.toLowerCase())) {
            return;
        }

        // Filtr roku
        const dateStr = String(rep.date || '');
        if (args.year && !dateStr.startsWith(String(args.year))) {
            return;
        }

        const cost = Number(rep.cost) || 0;
        grandTotal += cost;
        validRecordsCount++;

        let key = 'Inne';
        if (groupBy === 'category') {
            key = rep.category || 'Ogólne';
        } else if (groupBy === 'vehicle') {
            key = `${vInfo.brand} ${vInfo.model} (${vInfo.reg})`.trim();
        } else if (groupBy === 'month') {
            key = dateStr.slice(0, 7) || 'Brak daty'; // YYYY-MM
        } else if (groupBy === 'year') {
            key = dateStr.slice(0, 4) || 'Brak roku';
        }

        const curr = groups.get(key) || { totalCost: 0, count: 0 };
        curr.totalCost += cost;
        curr.count += 1;
        groups.set(key, curr);
    });

    // Sortuj wg kosztu malejąco
    const sorted = Array.from(groups.entries())
        .map(([label, val]) => ({
            label,
            totalCost: Math.round(val.totalCost * 100) / 100,
            count: val.count,
            avgCost: Math.round((val.totalCost / (val.count || 1)) * 100) / 100
        }))
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, 15); // max 15 najważniejszych kategorii/aut dla czytelności

    return {
        filterApplied: {
            brand: args.brand || 'Wszystkie',
            year: args.year || 'Wszystkie',
            category: args.category || 'Wszystkie',
            groupBy
        },
        recordsAnalyzed: validRecordsCount,
        grandTotalCost: Math.round(grandTotal * 100) / 100,
        averagePerRepair: validRecordsCount > 0 ? Math.round((grandTotal / validRecordsCount) * 100) / 100 : 0,
        breakdown: sorted
    };
}

export async function executeInventorySummary(args: {
    zone?: string;
    category?: string;
    lowStockOnly?: boolean;
    groupBy?: 'zone' | 'category';
}) {
    const groupBy = args.groupBy || (args.zone ? 'category' : 'zone');
    const snap = await adminDb.collection('inventory').limit(500).get();

    const groups = new Map<string, { totalQty: number; count: number; items: string[] }>();
    let totalItems = 0;

    snap.docs.forEach(doc => {
        const item = doc.data();
        const zone = item.zone || 'Brak strefy';
        const category = item.category || 'Inne';
        const qty = Number(item.quantity) || 0;

        if (args.zone && !zone.toLowerCase().includes(args.zone.toLowerCase())) {
            return;
        }
        if (args.category && !category.toLowerCase().includes(args.category.toLowerCase())) {
            return;
        }
        if (args.lowStockOnly && qty > 5) {
            return;
        }

        totalItems += qty;
        const key = groupBy === 'zone' ? zone : category;
        const curr = groups.get(key) || { totalQty: 0, count: 0, items: [] };
        curr.totalQty += qty;
        curr.count += 1;
        if (curr.items.length < 3 && item.name) {
            curr.items.push(item.name);
        }
        groups.set(key, curr);
    });

    const breakdown = Array.from(groups.entries())
        .map(([label, val]) => ({
            label,
            totalQuantity: val.totalQty,
            itemTypesCount: val.count,
            examples: val.items
        }))
        .sort((a, b) => b.totalQuantity - a.totalQuantity);

    return {
        totalInventoryCount: totalItems,
        groupBy,
        breakdown
    };
}

export async function executeFleetOverview(args: {
    brand?: string;
    needsInspectionOnly?: boolean;
}) {
    const snap = await adminDb.collection('vehicles').get();
    const today = new Date().toISOString().split('T')[0];

    const vehicles: any[] = [];
    const brandCounts = new Map<string, number>();

    snap.docs.forEach(doc => {
        const v = doc.data();
        const brand = v.brand || 'Inne';

        if (args.brand && !brand.toLowerCase().includes(args.brand.toLowerCase())) {
            return;
        }

        const inspectionDate = v.inspectionDate || '';
        const isUrgent = inspectionDate && inspectionDate <= today;

        if (args.needsInspectionOnly && !isUrgent) {
            return;
        }

        brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);

        vehicles.push({
            id: doc.id,
            brand: v.brand,
            model: v.model,
            registration: v.registration,
            mileage: v.initialMileage || 0,
            inspectionDate: inspectionDate || 'Brak danych',
            isUrgentInspection: Boolean(isUrgent)
        });
    });

    return {
        totalVehicles: vehicles.length,
        brandsBreakdown: Array.from(brandCounts.entries()).map(([brand, count]) => ({ brand, count })),
        vehiclesSample: vehicles.slice(0, 10),
        urgentInspectionsCount: vehicles.filter(v => v.isUrgentInspection).length
    };
}

export async function executeSitesOverview(args: { activeOnly?: boolean }) {
    const snap = await adminDb.collection('sites').limit(100).get();
    const sites = snap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            name: d.name || 'Bez nazwy',
            address: d.address || 'Brak adresu',
            managerId: d.managerId || null
        };
    });

    return {
        totalSites: sites.length,
        sitesList: sites
    };
}

export async function executeClaimsAndCloseoutsSummary(args: { status?: string }) {
    const [claimsSnap, closeoutsSnap] = await Promise.all([
        adminDb.collection('claims').limit(50).get(),
        adminDb.collection('closeouts').limit(50).get()
    ]);

    const claims = claimsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const closeouts = closeoutsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const claimsTotal = claims.reduce((acc, c: any) => acc + (Number(c.amount) || 0), 0);
    const closeoutsTotal = closeouts.reduce((acc, c: any) => acc + (Number(c.totalCost) || 0), 0);

    return {
        activeClaimsCount: claims.length,
        totalClaimsAmountPLN: Math.round(claimsTotal * 100) / 100,
        pendingCloseoutsCount: closeouts.length,
        totalCloseoutLossesPLN: Math.round(closeoutsTotal * 100) / 100
    };
}

// ─── ROUTER NARZĘDZI ─────────────────────────────────────────────────────────

export async function dispatchWarehouseTool(toolName: string, args: any) {
    switch (toolName) {
        case 'getRepairsSummary':
            return await executeRepairsSummary(args || {});
        case 'getInventorySummary':
            return await executeInventorySummary(args || {});
        case 'getFleetOverview':
            return await executeFleetOverview(args || {});
        case 'getSitesOverview':
            return await executeSitesOverview(args || {});
        case 'getClaimsAndCloseoutsSummary':
            return await executeClaimsAndCloseoutsSummary(args || {});
        default:
            throw new Error(`Nieznane narzędzie analityczne: ${toolName}`);
    }
}
