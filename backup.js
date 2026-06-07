const fs = require('fs');
const path = require('path');

// Sciezka do pliku wyjsciowego
const outputFilePath = path.join(__dirname, 'kosztorysantamax.txt');

// Lista wszystkich plikow powiazanych z modulem Kosztorysanta i PESAM Brain
const filesToConsolidate = [
    // --- STRONY I WIDOKI (Next.js) ---
    'src/app/(dashboard)/dashboard/estimator/page.tsx',         // Panel kosztorysanta
    'src/app/(dashboard)/dashboard/brain/page.tsx',             // Panel PESAM Brain

    // --- REAKTYWNE HOOKI ---
    'src/hooks/useScopeManifest.ts',                            // Real-time listener ScopeManifestu
    'src/hooks/useBrainUploads.ts',                             // Real-time listener bazy wiedzy

    // --- KOMPONENTY UI ---
    'src/components/ScopeHeatMap.tsx',                          // Mapa ciepla szczelnosci
    'src/components/BrainStatsPanel.tsx',                       // Wykresy wskaznikow mozgu
    'src/components/BrainFileUploader.tsx',                     // Strefa drag&drop dla wycen historycznych
    'src/components/BrainUploadCard.tsx',                       // Karta autoryzacji uczenia mozgu

    // --- METADANE I SCHEMATY TYPOW (_shared) ---
    'src/app/api/kosztorysant/_shared/scopeManifest.types.ts',   // Typy ScopeManifestu (Poziomy 1-5)
    'src/app/api/kosztorysant/_shared/brainKnowledge.types.ts',  // Typy bazy wiedzy i rolling average
    'src/app/api/kosztorysant/_shared/heurystyki.ts',            // Dynamiczne minimum inzynieryjne
    'src/app/api/kosztorysant/_shared/types.ts',                 // Ogolne typy RMS i magazynu

    // --- WSZYSTKIE AGENTY KOSZTORYSUJACE (API /kosztorysant/) ---
    'src/app/api/kosztorysant/agent-analityk-zakresu/route.ts',  // Gemini ScopeManifest Builder
    'src/app/api/kosztorysant/agent-gap-filler/route.ts',        // Szacowanie luk (Mozg + Normy)
    'src/app/api/kosztorysant/agent-klasyfikator/route.ts',      // Agent klasyfikujacy pliki
    'src/app/api/kosztorysant/agent-knr/route.ts',               // Agent wyliczajacy KNR (Python)
    'src/app/api/kosztorysant/agent-normatywne-zbrojenie/route.ts', // Agent szacujacy stal zbrojeniowa
    'src/app/api/kosztorysant/agent-rewident/route.ts',          // Glowny audytor matematyczny
    'src/app/api/kosztorysant/agent-rewident/coverageAudit.ts',  // Audytor pokrycia ScopeManifestu
    'src/app/api/kosztorysant/agent-vision-konstruktor/route.ts', // Agent analizujacy rysunki (Vision)
    'src/app/api/kosztorysant/agent-wycena-wskaznikowa/route.ts', // Agent Parametryczny (2.5 Pro)
    'src/app/api/kosztorysant/broker-cenowy/route.ts',           // Broker cenowy (Google Search)
    'src/app/api/kosztorysant/czytacz-dokumentow/route.ts',      // Czytacz dokumentow prawnych/SWZ
    'src/app/api/kosztorysant/dyspozytor/route.ts',              // Dyspozytor zadan / Router
    'src/app/api/kosztorysant/glowny-kosztorysant/route.ts',     // Glowny orchestrator czatu
    'src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts', // Klasyfikator i zaplon roju (DAG)
    'src/app/api/kosztorysant/magazynier-zip/route.ts',          // Zoptymalizowany pod katem RAM rozpakowywacz
    'src/app/api/kosztorysant/merge-attachments/route.ts',       // Laczenie zalacznikow PDF

    // --- INTERFEJSY CZLOWIEK-W-PETLI ---
    'src/app/api/kosztorysant/scope-manifest/update-coverage/route.ts',
    'src/app/api/kosztorysant/scope-manifest/answer-question/route.ts',

    // --- SILNIK BAZY WIEDZY (PESAM Brain API) ---
    'src/app/api/kosztorysant/brain/ekstraktor/route.ts',        // Ekstraktor wskaznikow z starych PDF/Exceli
    'src/app/api/kosztorysant/brain/uczacy/route.ts',            // Agent zapisujacy rolling average w transakcji
    'src/app/api/kosztorysant/brain/approve/route.ts',           // API odrzucania/notatek historycznych
    'src/app/api/kosztorysant/brain/context/route.ts',           // API udostepniajace wiedze z bazy dla Roju

    // --- GLOBALNA KONFIGURACJA CHMURY ---
    'apphosting.yaml'                                            //S Zasoby RAM i CPU dla App Hosting
];

let consolidatedContent = '';
let foundCount = 0;
let missingCount = 0;

console.log('==================================================');
console.log('[PESAM Backup] Rozpoczynam konsolidacje kodu kosztorysanta...');
console.log('==================================================\n');

filesToConsolidate.forEach(file => {
    const fullPath = path.join(__dirname, file);

    if (fs.existsSync(fullPath)) {
        console.log(`[ZNALEZIONO] -> Dodaje: ${file}`);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Dodajemy naglowki ulatwiajace pozniejszy odczyt
        consolidatedContent += `--- START OF FILE ${file} ---\n\n${content}\n\n--- END OF FILE ${file} ---\n\n\n`;
        foundCount++;
    } else {
        console.warn(`[BRAK] x Pomijam (brak pliku): ${file}`);
        missingCount++;
    }
});

try {
    // Zapisujemy polaczony kod do pliku wyjsciowego
    fs.writeFileSync(outputFilePath, consolidatedContent, 'utf8');

    console.log('\n==================================================');
    console.log('[PESAM Backup] ZAKONCZONO SUKCESEM!');
    console.log(`- Dodanych plikow: ${foundCount}`);
    console.log(`- Brakujacych plikow: ${missingCount}`);
    console.log(`- Wynik zapisano w: ${outputFilePath}`);
    console.log('==================================================');
} catch (err) {
    console.error('\n[PESAM Backup] Blad zapisu pliku kosztorysantamax.txt:', err);
}