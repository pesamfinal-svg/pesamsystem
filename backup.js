const fs = require('fs');
const path = require('path');

// Ścieżka do pliku wyjściowego
const outputFilePath = path.join(__dirname, 'kosztorysantamax.txt');

// Ścisła lista wszystkich plików dwumózgowego Roju PESAM 3.0 + Głównego Technologa
const filesToConsolidate = [
    // --- 🖥️ WIDOK I INTERFEJS ---
    'src/app/(dashboard)/dashboard/estimator/page.tsx',                 // Główny panel kosztorysu z czatem, checklistami i podglądem PDF

    // --- 🔑 UTILITY ENDPOINTY ---
    'src/app/api/kosztorysant/dokumenty/podglad/route.ts',               // Bezpieczny generator Signed URLs do podglądu PDF w chmurze

    // --- 🧠 RDZEŃ KOSZTORYSANTA (PESAM) ---
    'src/app/api/kosztorysant/glowny-kosztorysant/route.ts',             // Główny Orkiestrator PESAM (ReAct Loop)
    'src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts',     // Faza 0: Klasyfikacja Sensoryczna, zapłon Kosztorysanta i Technologa
    'src/app/api/kosztorysant/magazynier-zip/route.ts',                  // Asynchroniczny Magazynier i Rozpakowywacz ZIP w RAM

    // --- 🏗️ RDZEŃ TECHNOLOGA (Drugi Mózg Swarmu) ---
    'src/app/api/technolog/glowny-technolog/route.ts',                   // Główny Orkiestrator Technologii Budowlanej (Flash Engine)

    // --- 🛑 AWARYJNE KONTROLKI (STOP i USUŃ) ---
    'src/app/api/kosztorysant/zatrzymaj/route.ts',                       // Awaryjne wstrzymanie Roju i anulowanie zadań (STOP)
    'src/app/api/kosztorysant/usun-przetarg/route.ts',                   // Rekurencyjne, atomowe usuwanie subkolekcji z Firestore (USUŃ)

    // --- 🧱 AUTONOMICZNI AGENCI SPECJALIŚCI PESAM ---
    'src/app/api/kosztorysant/agent-budowlaniec/route.ts',               // Agent: BUDOWLANIEC (Inżynieria domyślna z norm)
    'src/app/api/kosztorysant/agent-ilosciowiec/route.ts',                // Agent: BOQ_PARSER (Skaner przedmiarów Excel/PDF)
    'src/app/api/kosztorysant/broker-cenowy/route.ts',                   // Agent: BROKER (Dwuetapowa wycena RMS z wyszukiwarką Google)
    'src/app/api/kosztorysant/czytacz-dokumentow/route.ts',              // Agent: LEGAL_EXPERT (Analityk SWZ i umów przetargowych)
    'src/app/api/kosztorysant/agent-wbs-architekt/route.ts',             // Agent: VISION (Konstruktor i WBS Architekt do rysunków)
    'src/app/api/kosztorysant/agent-cichy-rewident/route.ts',             // Agent: SILENT_AUDITOR (Audytor zgodności z WT2021/PPOŻ)
    'src/app/api/kosztorysant/agent-gap-filler/route.ts',                // Agent: GAP_FILLER (Szacowanie wskaźnikowe braków)
    'src/app/api/kosztorysant/agent-rewident/route.ts',                  // Agent: REVISOR_JUDGE (Rozjemca konfliktów technologicznych)
    'src/app/api/kosztorysant/agent-kameleon/route.ts',                  // Agent: KAMELEON (Skaner niszowych technologii branżowych)
    'src/app/api/kosztorysant/agent-python-calc/route.ts',               // Agent: PYTHON_CALC (Ekspert matematyczny w piaskownicy)
    'src/app/api/kosztorysant/agent-pdf-splitter/route.ts',              // Agent: PDF_SPLITTER (Fizyczny spliter PDF)
    'src/app/api/kosztorysant/agent-detektyw/route.ts',                  // Agent: MAPPING_DETECTIVE (Korelator 3D PDF)

    // --- 🧬 AGENCI SPECJALIŚCI TECHNOLOGA ---
    'src/app/api/technolog/agent-technolog-materialowy/route.ts',         // Agent: MATERIAL_DETECTIVE (Skaner parametrów materiałów)
    'src/app/api/technolog/agent-technolog-przedmiarowy/route.ts',        // Agent: QUANTITY_ESTIMATOR (Audytor kompletności zakresu)
    'src/app/api/technolog/agent-technolog-norm/route.ts',                // Agent: NORM_ADVISOR (Dobieracz norm budowlanych WT2021)
    'src/app/api/technolog/agent-scope-researcher/route.ts'               // Agent: SCOPE_RESEARCHER (Badacz zakresu rynkowego z wyszukiwarką)
];

let consolidatedContent = '';
let foundCount = 0;
let missingCount = 0;

console.log('==================================================');
console.log('[PESAM Backup] Rozpoczynam konsolidację kodu NOWEGO kosztorysanta PESAM 3.0 + Głównego Technologa...');
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