const fs = require('fs');
const path = require('path');

// Ścieżka do pliku wyjściowego
const outputFilePath = path.join(__dirname, 'kosztorysantamax.txt');

// Ścisła lista plików aktywnego Roju Kosztorysowego PESAM 3.0, nad którymi wspólnie pracowaliśmy
const filesToConsolidate = [
    // --- 🖥️ WIDOK I FRONTEND ---
    'src/app/(dashboard)/dashboard/estimator/page.tsx',                 // Główny panel kosztorysanta z interfejsem czatu i przyciskami STOP/USUŃ

    // --- 🧠 RDZEŃ SYSTEMOWY (Orkiestracja i Klasyfikacja) ---
    'src/app/api/kosztorysant/glowny-kosztorysant/route.ts',             // Główny Orkiestrator (Mózg / ReAct Loop z systemem sędziowskim)
    'src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts',     // Faza 0: Klasyfikacja Hybrydowa i Zapłon Roju
    'src/app/api/kosztorysant/magazynier-zip/route.ts',                  // Magazynier ZIP i PDF (Asynchroniczny rozpakowywacz)

    // --- 🛑 AWARYJNE KONTROLKI (STOP i USUŃ) ---
    'src/app/api/kosztorysant/zatrzymaj/route.ts',                       // Awaryjny wyłącznik Roju i anulowanie zadań (STOP)
    'src/app/api/kosztorysant/usun-przetarg/route.ts',                   // Rekurencyjne czyszczenie bazy Firestore (USUŃ)

    // --- 🧱 AUTONOMICZNI I SZYBCY AGENCI SPECJALIŚCI (Dumb Workers) ---
    'src/app/api/kosztorysant/agent-budowlaniec/route.ts',               // Agent: Budowlaniec (Autonomiczny inżynier)
    'src/app/api/kosztorysant/agent-ilosciowiec/route.ts',                // Agent: BOQ_PARSER (Natywny Excel XLS + GCS fileData PDF)
    'src/app/api/kosztorysant/broker-cenowy/route.ts',                   // Agent: BROKER (Dwuetapowa wycena z sieci B2B i rozbicie R-M-S)
    'src/app/api/kosztorysant/czytacz-dokumentow/route.ts',              // Agent: LEGAL_EXPERT (Smart Czytacz SWZ/Umów po fileData GCS)
    'src/app/api/kosztorysant/agent-wbs-architekt/route.ts',             // Agent: VISION (WBS Architekt / fileData GCS)
    'src/app/api/kosztorysant/agent-cichy-rewident/route.ts',             // Agent: SILENT_AUDITOR (Dwuetapowy rewident technologiczny)
    'src/app/api/kosztorysant/agent-gap-filler/route.ts',                // Agent: GAP_FILLER (Dwuetapowe szacowanie wskaźnikowe)
    'src/app/api/kosztorysant/agent-rewident/route.ts',                  // Agent: REVISOR_JUDGE (Sędzia Roju / Rozstrzyganie konfliktów)
    'src/app/api/kosztorysant/agent-kameleon/route.ts'                   // Agent: KAMELEON (Uniwersalny specjalista branżowy)
];

let consolidatedContent = '';
let foundCount = 0;
let missingCount = 0;

console.log('==================================================');
console.log('[PESAM Backup] Rozpoczynam konsolidację kodu NOWEGO kosztorysanta PESAM 3.0...');
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