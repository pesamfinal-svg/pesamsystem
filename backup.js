const fs = require('fs');
const path = require('path');

// Ścieżka do pliku wyjściowego
const outputFilePath = path.join(__dirname, 'kosztorysantamax.txt');

// Lista wszystkich plików powiązanych z nowym modułem Kosztorysanta PESAM
const filesToConsolidate = [
    'src/app/dashboard/estimator/page.tsx',
    'src/components/ScopeHeatMap.tsx',
    'src/hooks/useScopeManifest.ts',
    'src/app/api/kosztorysant/_shared/scopeManifest.types.ts',
    'src/app/api/kosztorysant/_shared/heurystyki.ts',
    'src/app/api/kosztorysant/agent-analityk-zakresu/route.ts',
    'src/app/api/kosztorysant/agent-gap-filler/route.ts',
    'src/app/api/kosztorysant/agent-rewident/route.ts',
    'src/app/api/kosztorysant/agent-rewident/coverageAudit.ts',
    'src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts',
    'src/app/api/kosztorysant/scope-manifest/update-coverage/route.ts',
    'src/app/api/kosztorysant/scope-manifest/answer-question/route.ts'
];

let consolidatedContent = '';
let foundCount = 0;
let missingCount = 0;

console.log('==================================================');
console.log('[PESAM Backup] Rozpoczynam konsolidację kodu kosztorysanta...');
console.log('==================================================\n');

filesToConsolidate.forEach(file => {
    const fullPath = path.join(__dirname, file);

    if (fs.existsSync(fullPath)) {
        console.log(`%c[ZNALEZIONO] -> Dodaję: ${file}`, 'color: #10b981;');
        const content = fs.readFileSync(fullPath, 'utf8');

        // Dodajemy nagłówki ułatwiające późniejszy odczyt lub podział
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
    console.log(`[PESAM Backup] ZAKOŃCZONO SUKCESEM!`);
    console.log(`• Dodanych plików: ${foundCount}`);
    console.log(`• Brakujących plików: ${missingCount}`);
    console.log(`• Wynik zapisano w: ${outputFilePath}`);
    console.log('==================================================');
} catch (err) {
    console.error('\n[PESAM Backup] ❌ Krytyczny błąd zapisu pliku kosztorysantamax.txt:', err);
}