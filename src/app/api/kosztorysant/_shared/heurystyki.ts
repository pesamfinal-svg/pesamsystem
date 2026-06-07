// ============================================================
// PESAM – Dynamiczna Baza Heurystyk (Zintegrowana z Firestore)
// Jeśli baza w Firestore jest pusta, skrypt automatycznie ją zasili.
// ============================================================

import { adminDb } from '@/lib/firebase/admin';
import type { ScopeElement, ObjectType, DocLevel, GapFillerStrategy } from './scopeManifest.types';

// ============================================================
// DOMYŚLNE WZORCE (Używane tylko do pierwszego zasilenia bazy)
// ============================================================

const DEFAULT_UNIVERSAL: ScopeElement[] = [
    {
        elementId: 'UNIV-E1',
        name: 'Roboty ziemne i wykopy',
        unit: 'm³',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'EUROKOD_NORM',
        gapFillerHint: 'Objętość wykopu ≈ powierzchnia zabudowy × 1.5m głębokości posadowienia',
        gapFillerMultiplier: 1.5,
    },
    {
        elementId: 'UNIV-E2',
        name: 'Fundamenty żelbetowe (ławy, stopy, płyta)',
        unit: 'm³',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'EUROKOD_NORM',
        gapFillerHint: '0.15–0.25 m³ betonu na 1 m² powierzchni zabudowy wg PN-EN 1992',
        gapFillerMultiplier: 0.2,
    },
    {
        elementId: 'UNIV-E3',
        name: 'Izolacje przeciwwilgociowe i termiczne fundamentów',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: true,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'EUROKOD_NORM',
        gapFillerHint: 'Obwód fundamentów × wysokość ścian fundamentowych',
    },
    {
        elementId: 'UNIV-E4',
        name: 'Ściany konstrukcyjne i nośne',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'SEKOCENBUD_M2',
        gapFillerHint: 'Szacunek z Sekocenbud – ściany nośne na m² PUM',
    },
    {
        elementId: 'UNIV-E5',
        name: 'Stropy żelbetowe lub prefabrykowane',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 2,
        gapFillerStrategy: 'EUROKOD_NORM',
        gapFillerHint: '≈ powierzchnia kondygnacji × liczba stropów',
    },
    {
        elementId: 'UNIV-E6',
        name: 'Dach – konstrukcja i pokrycie',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'SEKOCENBUD_M2',
        gapFillerHint: 'Powierzchnia dachu ≈ 1.15 × powierzchnia rzutu',
    },
    {
        elementId: 'UNIV-E7',
        name: 'Tynki wewnętrzne maszynowe',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'EUROKOD_NORM',
        gapFillerHint: 'Powierzchnia tynków ≈ 3.2 × PUM (ściany + sufity)',
        gapFillerMultiplier: 3.2,
    },
    {
        elementId: 'UNIV-E8',
        name: 'Posadzki i wylewki',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'SEKOCENBUD_M2',
    },
    {
        elementId: 'UNIV-E9',
        name: 'Stolarka okienna i drzwiowa',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'SEKOCENBUD_M2',
        gapFillerHint: 'Okna ≈ 15–20% powierzchni ścian zewnętrznych',
    },
    {
        elementId: 'UNIV-E10',
        name: 'Instalacja elektryczna (WLZ, tablice, okablowanie)',
        unit: 'kpl.',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: true,
        applicableObjectTypes: 'ALL',
        minDocLevel: 0,
        gapFillerStrategy: 'GUS_PERCENT',
        gapFillerHint: '8–12% kosztu stanu surowego zamkniętego wg GUS',
        gapFillerMultiplier: 0.10,
    },
    {
        elementId: 'UNIV-E11',
        name: 'Instalacja sanitarna (wod-kan, biały montaż)',
        unit: 'kpl.',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: true,
        applicableObjectTypes: 'ALL',
        minDocLevel: 0,
        gapFillerStrategy: 'GUS_PERCENT',
        gapFillerHint: '6–10% kosztu stanu surowego wg GUS',
        gapFillerMultiplier: 0.08,
    },
    {
        elementId: 'UNIV-E12',
        name: 'Instalacja C.O. i wentylacja',
        unit: 'kpl.',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: true,
        applicableObjectTypes: 'ALL',
        minDocLevel: 0,
        gapFillerStrategy: 'GUS_PERCENT',
        gapFillerHint: '10–15% kosztu stanu surowego wg GUS',
        gapFillerMultiplier: 0.12,
    },
    {
        elementId: 'UNIV-E13',
        name: 'Instalacja odgromowa i uziemiająca',
        unit: 'kpl.',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: true,
        applicableObjectTypes: 'ALL',
        minDocLevel: 0,
        gapFillerStrategy: 'GUS_PERCENT',
        gapFillerHint: '0.5–1.0% kosztu stanu surowego',
        gapFillerMultiplier: 0.007,
    },
    {
        elementId: 'UNIV-E14',
        name: 'Zagospodarowanie terenu i drogi wewnętrzne',
        unit: 'm²',
        source: 'HARDCODED_NORM',
        isMandatoryByLaw: false,
        applicableObjectTypes: 'ALL',
        minDocLevel: 1,
        gapFillerStrategy: 'SEKOCENBUD_M2',
    },
];

const DEFAULT_SPECIFIC: Record<ObjectType, ScopeElement[]> = {
    przedszkole: [
        {
            elementId: 'PRZ-E1',
            name: 'Instalacja ppoż. (tryskacze, hydranty, czujniki)',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['przedszkole'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerHint: '3–5% kosztu stanu surowego dla obiektów ZL II',
            gapFillerMultiplier: 0.04,
        },
        {
            elementId: 'PRZ-E2',
            name: 'Oświetlenie ewakuacyjne i awaryjne',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['przedszkole'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerMultiplier: 0.015,
        },
        {
            elementId: 'PRZ-E3',
            name: 'Kuchnia z zapleczem (wyposażenie technologiczne)',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['przedszkole'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
            gapFillerHint: 'Koszt kuchni silnie zależy od liczby posiłków i standardu.',
        },
        {
            elementId: 'PRZ-E4',
            name: 'Plac zabaw z nawierzchnią bezpieczną',
            unit: 'm²',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['przedszkole'],
            minDocLevel: 0,
            gapFillerStrategy: 'SEKOCENBUD_M2',
            gapFillerHint: 'Min. 15 m² na oddział wg przepisów.',
        },
        {
            elementId: 'PRZ-E5',
            name: 'Winda / platforma dla osób niepełnosprawnych',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['przedszkole'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
        },
    ],
    szkola: [
        {
            elementId: 'SZK-E1',
            name: 'Instalacja ppoż.',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['szkola'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerMultiplier: 0.04,
        },
        {
            elementId: 'SZK-E2',
            name: 'Sala gimnastyczna – podłoga sportowa i wyposażenie',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['szkola'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
            gapFillerHint: 'Zależy od powierzchni sali i standardu.',
        },
        {
            elementId: 'SZK-E3',
            name: 'Sieć komputerowa i instalacja AV (multimedialna)',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['szkola'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerMultiplier: 0.025,
        },
    ],
    hala_sportowa: [
        {
            elementId: 'HALS-E1',
            name: 'Konstrukcja stalowa hali (słupy, rygle, płatwie)',
            unit: 't',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['hala_sportowa'],
            minDocLevel: 1,
            gapFillerStrategy: 'EUROKOD_NORM',
            gapFillerHint: '25–40 kg/m² powierzchni dachu hali wg PN-EN 1993',
            gapFillerMultiplier: 32,
        },
        {
            elementId: 'HALS-E2',
            name: 'Trybuny lub widownia',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['hala_sportowa'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
        },
        {
            elementId: 'HALS-E3',
            name: 'Nawierzchnia sportowa (parkiet, tartan)',
            unit: 'm²',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['hala_sportowa'],
            minDocLevel: 0,
            gapFillerStrategy: 'SEKOCENBUD_M2',
        },
    ],
    hala_produkcyjna: [
        {
            elementId: 'HALP-E1',
            name: 'Konstrukcja stalowa hali przemysłowej',
            unit: 't',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['hala_produkcyjna'],
            minDocLevel: 1,
            gapFillerStrategy: 'EUROKOD_NORM',
            gapFillerHint: '35–60 kg/m² – konstrukcja dachu',
            gapFillerMultiplier: 45,
        },
        {
            elementId: 'HALP-E2',
            name: 'Posadzka przemysłowa (beton utwardzony, żywica)',
            unit: 'm²',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['hala_produkcyjna'],
            minDocLevel: 0,
            gapFillerStrategy: 'SEKOCENBUD_M2',
        },
        {
            elementId: 'HALP-E3',
            name: 'Wentylacja przemysłowa i odciągi',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['hala_produkcyjna'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
            gapFillerHint: 'Wymaga danych procesowych od użytkownika.',
        },
    ],
    biurowiec: [
        {
            elementId: 'BIU-E1',
            name: 'Windy osobowe',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['biurowiec'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
            gapFillerHint: 'Liczba wind zależy od wysokości i liczby pięter',
        },
        {
            elementId: 'BIU-E2',
            name: 'System kontroli dostępu i monitoring CCTV',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['biurowiec'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerMultiplier: 0.02,
        },
        {
            elementId: 'BIU-E3',
            name: 'Klimatyzacja i wentylacja mechaniczna (VRF/VRV)',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['biurowiec'],
            minDocLevel: 0,
            gapFillerStrategy: 'GUS_PERCENT',
            gapFillerMultiplier: 0.17,
        },
    ],
    szpital: [
        {
            elementId: 'SZP-E1',
            name: 'Instalacja gazów medycznych',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: true,
            applicableObjectTypes: ['szpital'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
        },
    ],
    budynek_mieszkalny: [
        {
            elementId: 'MIE-E1',
            name: 'Garaż podziemny lub parkingi',
            unit: 'kpl.',
            source: 'HARDCODED_NORM',
            isMandatoryByLaw: false,
            applicableObjectTypes: ['budynek_mieszkalny'],
            minDocLevel: 0,
            gapFillerStrategy: 'ASK_USER',
        },
    ],
    inne: []
};

// ============================================================
// METODY MECHANIZMU UNIKANIA HARDKODOWANIA (FIRESTORE)
// ============================================================

const SETTINGS_PATH = 'settings/estimatorTemplates';

/**
 * Automatyczna inicjalizacja bazy w Firestore (Self-Seeding)
 */
async function ensureDatabaseIsSeeded(): Promise<void> {
    const metaRef = adminDb.doc(SETTINGS_PATH);
    const metaSnap = await metaRef.get();

    if (metaSnap.exists()) {
        return; // Baza już jest zainicjowana, nic nie robimy
    }

    console.log('[Heurystyki] ⚠️ Wykryto BRAK bazy szablonów w Firestore. Rozpoczynam automatyczne inicjowanie (Self-Seeding)...');

    try {
        const batch = adminDb.batch();

        // 1. Zapisz meta-informację o szablonach
        batch.set(metaRef, {
            initializedAt: new Date().toISOString(),
            version: '1.0.0',
            description: 'Dynamiczne szablony kosztorysowe PESAM'
        });

        // 2. Zapisz uniwersalny szablon
        const universalRef = adminDb.doc(`${SETTINGS_PATH}/templates/universal`);
        batch.set(universalRef, { elements: DEFAULT_UNIVERSAL });

        // 3. Zapisz specyficzne szablony dla typów obiektów
        for (const [key, elements] of Object.entries(DEFAULT_SPECIFIC)) {
            const docRef = adminDb.doc(`${SETTINGS_PATH}/templates/${key}`);
            batch.set(docRef, { elements });
        }

        await batch.commit();
        console.log('[Heurystyki] ✅ Sukces: Baza szablonów w Firestore została zasilona domyślnymi wartościami.');
    } catch (err) {
        console.error('[Heurystyki] ❌ Błąd krytyczny podczas inicjalizacji bazy:', err);
    }
}

/**
 * Pobiera elementy z szablonu w Firestore
 */
async function fetchTemplateElements(templateId: string): Promise<ScopeElement[]> {
    await ensureDatabaseIsSeeded(); // upewnij się, że baza istnieje

    const docRef = adminDb.doc(`${SETTINGS_PATH}/templates/${templateId}`);
    const snap = await docRef.get();

    if (snap.exists()) {
        const data = snap.data();
        return (data?.elements as ScopeElement[]) || [];
    }

    console.warn(`[Heurystyki] Ostrzeżenie: Szablon ${templateId} nie istnieje w Firestore.`);
    return [];
}

// ============================================================
// PODSTAWOWE METODY WYWOŁYWANE PRZEZ AGENTY
// ============================================================

/**
 * Buduje obowiązkowe minimum dla danego obiektu, czytając z Firestore
 */
export async function buildMandatoryMinimum(
    objectType: ObjectType,
    docLevel: DocLevel
): Promise<ScopeElement[]> {
    console.log(`[Heurystyki] 🔍 Buduję dynamiczne minimum dla: "${objectType}" (Level ${docLevel}) z Firestore...`);

    // Pobierz dane równolegle
    const [universalElements, specificElements] = await Promise.all([
        fetchTemplateElements('universal'),
        fetchTemplateElements(objectType)
    ]);

    const filteredUniversal = universalElements.filter(
        (el) => el.minDocLevel <= docLevel
    );

    const finalMin = [...filteredUniversal, ...specificElements];
    console.log(`[Heurystyki] Skonstruowano minimum: ${finalMin.length} pozycji.`);
    return finalMin;
}

/**
 * Sprawdza w Firestore, czy dany element jest obowiązkowy prawnie
 */
export async function isMandatoryByLaw(elementId: string, objectType: ObjectType): Promise<boolean> {
    const [universal, specific] = await Promise.all([
        fetchTemplateElements('universal'),
        fetchTemplateElements(objectType)
    ]);

    const all = [...universal, ...specific];
    const found = all.find((el) => el.elementId === elementId);
    return found?.isMandatoryByLaw ?? false;
}

/**
 * Pobiera z bazy strategię Gap Fillera dla elementu
 */
export async function getGapFillerStrategy(elementId: string, objectType: ObjectType): Promise<GapFillerStrategy> {
    const [universal, specific] = await Promise.all([
        fetchTemplateElements('universal'),
        fetchTemplateElements(objectType)
    ]);

    const all = [...universal, ...specific];
    const found = all.find((el) => el.elementId === elementId);
    return found?.gapFillerStrategy ?? 'ASK_USER';
}