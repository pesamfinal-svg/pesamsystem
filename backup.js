const fs = require('fs');
const path = require('path');

// Ścieżka do pliku wyjściowego
const outputFilePath = path.join(__dirname, 'kosztorysantamax.txt');

// Lista wszystkich plików powiązanych z modułem Kosztorysanta PESAM 1.0 oraz 2.1
const filesToConsolidate = [
    // --- STRONY I WIDOKI (Next.js) ---
    'src/app/(dashboard)/dashboard/estimator/page.tsx',         // Panel kosztorysanta
    'src/app/(dashboard)/dashboard/brain/page.tsx',             // Panel PESAM Brain

    // --- REAKTYWNE HOOKI ---
    'src/hooks/useScopeManifest.ts',                            // Real-time listener ScopeManifestu
    'src/hooks/useBrainUploads.ts',                             // Real-time listener bazy wiedzy

    // --- KOMPONENTY UI ---
    'src/components/ScopeHeatMap.tsx',                          // Mapa ciepła szczelności zakresu
    'src/components/BrainStatsPanel.tsx',                       // Wykresy wskaźników mózgu
    'src/components/BrainFileUploader.tsx',                     // Strefa drag&drop dla wycen historycznych
    'src/components/BrainUploadCard.tsx',                       // Karta autoryzacji uczenia mózgu

    // --- METADANE I SCHEMATY TYPÓW (_shared) ---
    'src/app/api/kosztorysant/_shared/scopeManifest.types.ts',   // Typy ScopeManifestu (Poziomy 1-5)
    'src/app/api/kosztorysant/_shared/brainKnowledge.types.ts',  // Typy bazy wiedzy i rolling average
    'src/app/api/kosztorysant/_shared/heurystyki.ts',            // Dynamiczne minimum inżynieryjne
    'src/app/api/kosztorysant/_shared/types.ts',                 // Ogólne typy RMS i magazynu

    // --- 🚨 NOWE PROGRESYWNE AGENTY PESAM 2.1 (API /kosztorysant/) 🚨 ---
    'src/app/api/kosztorysant/agent-wbs-architekt/route.ts',     // Agent 0: Architekt Struktury WBS (DNA budynku)
    'src/app/api/kosztorysant/agent-detektyw-mapowania/route.ts', // Agent 1: Detektyw Mapowania plików
    'src/app/api/kosztorysant/agent-ilosciowiec/route.ts',        // Agent 2: Ilościowiec (Vision lub Brain)
    'src/app/api/kosztorysant/agent-cichy-rewident/route.ts',     // Agent 3: Cichy Rewident (Pułapki technologiczne)

    // --- KLASYCZNE AGENTY KOSZTORYSUJĄCE (API /kosztorysant/) ---
    'src/app/api/kosztorysant/agent-analityk-zakresu/route.ts',  // Gemini ScopeManifest Fallback
    'src/app/api/kosztorysant/agent-gap-filler/route.ts',        // Szacowanie luk (Zintegrowane z Ilościowcem)
    'src/app/api/kosztorysant/agent-klasyfikator/route.ts',      // Agent klasyfikujący pliki wejściowe
    'src/app/api/kosztorysant/agent-knr/route.ts',               // Agent wyliczający KNR (Python)
    'src/app/api/kosztorysant/agent-normatywne-zbrojenie/route.ts', // Agent szacujący stal zbrojeniową
    'src/app/api/kosztorysant/agent-rewident/route.ts',          // Główny audytor matematyczny
    'src/app/api/kosztorysant/agent-rewident/coverageAudit.ts',  // Audytor pokrycia ScopeManifestu
    'src/app/api/kosztorysant/agent-vision-konstruktor/route.ts', // Agent analizujący rysunki (Vision)
    'src/app/api/kosztorysant/agent-wycena-wskaznikowa/route.ts', // Agent Parametryczny (Usunięte enums)
    'src/app/api/kosztorysant/broker-cenowy/route.ts',           // Broker cenowy (Google Search)
    'src/app/api/kosztorysant/czytacz-dokumentow/route.ts',      // Czytacz dokumentów prawnych/SWZ (Smart Chunking)
    'src/app/api/kosztorysant/dyspozytor/route.ts',              // Dyspozytor zadań / Router
    'src/app/api/kosztorysant/glowny-kosztorysant/route.ts',     // Główny orchestrator czatu
    'src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts', // Inicjalizator i zapłon roju (DAG v2.1)
    'src/app/api/kosztorysant/magazynier-zip/route.ts',          // Rozpakowywacz ZIP i PDF (Local Loopback)
    'src/app/api/kosztorysant/merge-attachments/route.ts',       // Łączenie załączników PDF

    // --- INTERFEJSY CZŁOWIEK-W-PĘTLI ---
    'src/app/api/kosztorysant/scope-manifest/update-coverage/route.ts',
    'src/app/api/kosztorysant/scope-manifest/answer-question/route.ts',

    // --- SILNIK BAZY WIEDZY (PESAM Brain API) ---
    'src/app/api/kosztorysant/brain/ekstraktor/route.ts',        // Ekstraktor wskaźników ze starych kosztorysów
    'src/app/api/kosztorysant/brain/uczacy/route.ts',            // Agent zapisujący rolling average w transakcji
    'src/app/api/kosztorysant/brain/approve/route.ts',           // API odrzucania/notatek historycznych
    'src/app/api/kosztorysant/brain/context/route.ts',           // API udostępniające wiedzę z Mózgu dla Roju

    // --- GLOBALNA KONFIGURACJA CHMURY ---
    'apphosting.yaml'                                            // Zasoby RAM i CPU dla App Hosting
];

let consolidatedContent = '';
let foundCount = 0;
let missingCount = 0;

console.log('==================================================');
console.log('[PESAM Backup] Rozpoczynam konsolidację kodu kosztorysanta PESAM 1.0 & 2.1...');
console.log('==================================================\n');

filesToConsolidate.forEach(file => {
    const fullPath = path.join(__dirname, file);

    if (fs.existsSync(fullPath)) {
        console.log(`[ZNALEZIONO] -> Dodaję do paczki: ${file}`);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Dodajemy nagłówki ułatwiające późniejszy odczyt pliku tekstowego
        consolidatedContent += `--- START OF FILE ${file} ---\n\n${content}\n\n--- END OF FILE ${file} ---\n\n\n`;
        foundCount++;
    } else {
        console.warn(`[BRAK] x Pomijam (brak pliku): ${file}`);
        missingCount++;
    }
});

try {
    // Zapisujemy połączony kod do pliku wyjściowego
    fs.writeFileSync(outputFilePath, consolidatedContent, 'utf8');

    console.log('\n==================================================');
    console.log('[PESAM Backup] KONSOLIDACJA ZAKOŃCZONA SUKCESEM!');
    console.log(`- Dodanych plików: ${foundCount}`);
    console.log(`- Brakujących plików: ${missingCount}`);
    console.log(`- Wynik zapisano w: ${outputFilePath}`);
    console.log('==================================================');
} catch (err) {
    console.error('\n[PESAM Backup] Błąd zapisu pliku kosztorysantamax.txt:', err);
}