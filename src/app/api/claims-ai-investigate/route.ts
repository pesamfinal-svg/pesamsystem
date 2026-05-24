// src/app/api/claims-ai-investigate/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global' // <-- Twój parametr lokalizacji
});

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        const {
            inventoryName,
            inventoryNumber,
            siteName,
            messages,
            isInitial,
            warehouseNotes,
            declaredStatus,
            daysOnSite,
            role,
            purchaseDate,
            purchasePrice
        } = payload;

        // Twój wybrany model gemini-3-flash-preview
        const modelName = 'gemini-3-flash-preview';
        const clientMessages = messages || [];
        const targetRole = role || "MAGAZYN";

        const hasPhotosInHistory = clientMessages.some((m: any) =>
            m.content.toLowerCase().includes("[zdjęcia:") ||
            m.content.toLowerCase().includes("[dołączono") ||
            m.content.toLowerCase().includes("załączyłem zdjęcie")
        );

        let systemInstruction = "";
        let initialPrompt = "";

        // =========================================================================
        // SCENARIUSZ A: ROZMÓWCĄ JEST KIEROWNIK BUDOWY (W Sądzie PESAM)
        // =========================================================================
        if (targetRole === "KIEROWNIK") {
            let contextTimeOnSite = "Brak dokładnych danych o czasie przebywania sprzętu na budowie.";
            if (daysOnSite !== undefined && daysOnSite !== null) {
                if (daysOnSite <= 3) {
                    contextTimeOnSite = `⚠️ ALARM: Sprzęt był na budowie tylko ${daysOnSite} dni przed awarią! To mogło być uszkodzenie transportowe lub wada fabryczna. Zapytaj, czy sprzęt działał w ogóle po dostarczeniu na budowę.`;
                } else if (daysOnSite > 60) {
                    contextTimeOnSite = `💡 INFO: Sprzęt pracował na budowie bardzo długo (${daysOnSite} dni). Zapytaj o regularne czyszczenie, konserwację i czy przed awarią były sygnały ostrzegawcze.`;
                } else {
                    contextTimeOnSite = `Sprzęt pracował na budowie przez typowy okres ${daysOnSite} dni.`;
                }
            }

            systemInstruction = `Jesteś Asystentem Śledczym CLS (Centrum Likwidacji Szkód) w firmie budowlanej PESAM. Twoim rozmówcą jest KIEROWNIK BUDOWY, z którego budowy "${siteName}" zjechało uszkodzone urządzenie "${inventoryName}" (Nr: ${inventoryNumber || 'brak'}).
    Twoje zadanie: przeprowadzić dociekliwe, techniczne przesłuchanie wstępne Kierownika i wygenerować raport końcowy dla Dyrekcji.

    ZASADY WYKORZYSTANIA GOOGLE SEARCH (INTERNETU) DO AUDYTU OSPRZĘTU I EKSPLOATACJI:
    1. Masz stały dostęp do wyszukiwarki Google. Użyj jej, aby wyszukać specyfikację urządzenia "${inventoryName}".
    2. Zrozum kontekst: jesteśmy firmą budowlaną. Jeśli mowa o "Aligator", "Krokodyl" itp., chodzi o piły brzeszczotowe (np. DeWalt Aligator do Ytongu/Porothermu), a nie o zwierzęta!
    3. Wyszukaj instrukcję obsługi lub wytyczne serwisowe dla tego modelu. Dowiedz się, jak wygląda standardowy serwis bieżący tego urządzenia (np. smarowanie, czyszczenie filtrów z pyłu, naciąg łańcucha).
    4. Sformułuj dociekliwe pytanie techniczne: powołaj się na wytyczne producenta z internetu i zapytaj Kierownika, jak to było realizowane na budowie, kto to robił i jak często.

    ANALIZA CZASU NA BUDOWIE:
    ${contextTimeOnSite}

    ZASADY PRZESŁUCHANIA:
    - Zadajesz tylko JEDNO, konkretne, krótkie pytanie na raz.
    - Magazynier zgłosił uszkodzenie jako: "${warehouseNotes || 'Brak opisu'}". Zacznij od zapytania kierownika, czy potwierdza tę usterkę i jak do niej doszło.

    OBOWIĄZKOWE PUNKTY DO USTALENIA:
    1. OKOLICZNOŚCI: Kto pracował na sprzęcie i w jakich warunkach doszło do awarii?
    2. AUDYT OSPRZĘTU: Czy osprzęt (brzeszczot/tarcza/wiertło) był prawidłowo dobrany do ciętego materiału (zgodnie z analizą powyżej)? Jaki to był model?
    3. SERWIS BIEŻĄCY: Czy czyszczono urządzenie z pyłu (np. Ytongowego/gipsowego, który zatyka wentylację i działa ściernie na zębatki) i czy robiono przerwy chłodzące?
    4. PRÓBY NAPRAWY: Czy na budowie próbowano go rozkręcać / naprawiać na własną rękę?

    FORMAT ODPOWIEDZI (WYŁĄCZNIE CZYSTY JSON):
    Gdy zbierasz informacje: {"reply":"Twoje jedno pytanie do kierownika...","isComplete":false,"caseContext":null}
    Gdy masz już komplet informacji i chcesz zakończyć wywiad: {"reply":"Dziękuję za wyjaśnienia. Raport został wygenerowany i przekazany do Dyrekcji w celu wydania wyroku.","isComplete":true,"caseContext":"RAPORT KOŃCOWY ASYSTENTA AI:\\nUrządzenie: ${inventoryName} (Nr: ${inventoryNumber})\\nBudowa: ${siteName}\\nCzas na budowie: ${daysOnSite || 'Brak danych'} dni\\nPierwotne zgłoszenie: ${warehouseNotes}\\nUstalenia z Kierownikiem:\\n- Okoliczności: [Wpisz co ustaliłeś]\\n- Dobór osprzętu (Audyt): [Opisz, czy osprzęt był dobrany prawidłowo, czy doszło do błędu materiałowego]\\n- Eksploatacja i serwis bieżący: [Opisz czy czyszczono filtry/robiono przerwy]\\n- Próby naprawy: [Wpisz czy próbowali sami naprawiać]"}`;

            initialPrompt = `Uruchomienie procedury przesłuchania Kierownika Budowy. 
    Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber}), Budowa: "${siteName}".
    Magazynier przy odbiorze zgłosił usterkę: "${warehouseNotes || 'Brak uwag'}". 
    Czas na budowie: ${daysOnSite || 'Brak'} dni.
    Zadaj pierwsze pytanie kierownikowi dotyczące tej usterki.`;

            // =========================================================================
            // SCENARIUSZ B: ROZMÓWCĄ JEST MAGAZYNIER (Przy Akceptacji Zwrotu)
            // =========================================================================
        } else {
            // --- DYNAMICZNE SPRAWDZANIE DANYCH FINANSOWO-GWARANCYJNYCH Z BAZY ---
            let warrantyRule = "Baza danych jest pusta. Zapytaj magazyniera, z którego roku (orientacyjnie) jest ten sprzęt i czy według niego jest jeszcze na gwarancji producenta.";
            if (purchaseDate) {
                const pDate = new Date(purchaseDate);
                const ageInYears = (new Date().getTime() - pDate.getTime()) / (1000 * 60 * 60 * 24 * 365);

                if (ageInYears >= 4) {
                    warrantyRule = `Sprzęt został zakupiony dnia ${purchaseDate} (ma ponad 4 lata). Oznacz go jako NA PEWNO PO GWARANCJI. Pomiń dopytywanie o gwarancję fabryczną.`;
                } else if (ageInYears >= 2) {
                    warrantyRule = `Sprzęt został zakupiony dnia ${purchaseDate} (ma ponad 2 lata). Prawdopodobnie jest po gwarancji fabrycznej, ale dopytaj dla pewności, czy nie było przedłużonej gwarancji.`;
                } else {
                    warrantyRule = `Sprzęt został zakupiony dnia ${purchaseDate} (ma mniej niż 2 lata). Powinien być na gwarancji fabrycznej. Dopytaj o dostępność dokumentów gwarancyjnych.`;
                }
            }

            let priceRule = "Cena zakupu sprzętu jest znana i wynosi: " + purchasePrice + " zł.";
            if (!purchasePrice || Number(purchasePrice) === 0) {
                priceRule = `⚠️ ALARM: Brak ceny zakupu tego urządzenia w bazie! Wyszukaj w Google, ile kosztuje nowe urządzenie "${inventoryName}". Następnie zapytaj magazyniera: 'Nie mamy ceny tego urządzenia w bazie, ale z moich ustaleń wynika, że kosztuje około [Wpisz wyszukaną kwotę] zł. Czy potwierdzasz taką wartość rynkową?'`;
            }

            systemInstruction = `Jesteś Asystentem Śledczym PESAM. Twoim rozmówcą jest MAGAZYNIER odbierający sprzęt "${inventoryName}" z budowy "${siteName}".
    Twoje zadanie: zebrać techniczny raport wstępny o uszkodzeniu przed przekazaniem sprawy do Zarządu.

    ZASADY WYKORZYSTANIA GOOGLE SEARCH (INTERNETU):
    - Wyszukaj w Google informacje o sprzęcie "${inventoryName}". Dowiedz się, co najczęściej psuje się w tym modelu (np. przekładnia, szczotki silnika, kabel) i wykorzystaj tę wiedzę, zadając pytania.
    
    REGUŁY GWARANCYJNE I FINANSOWE:
    - ${warrantyRule}
    - ${priceRule}

    PROTOKÓŁ PRZESŁUCHANIA MAGAZYNU:
    Zadajesz JEDNO konkretne pytanie naraz.
    Magazynier już wstępnie zdiagnozował problem jako: "${warehouseNotes}". POMIŃ pytanie o stan fizyczny (co jest zepsute). Od razu przejdź do pytań o rokowania (naprawa/złom) lub historię serwisową.

    OBOWIĄZKOWE INFORMACJE DO ZEBRANIA:
    1. ROKOWANIA: Czy sprzęt nadaje się do naprawy, czy to złom?
    2. SERWIS: Czy sprzęt był już w serwisie na diagnozie/naprawie? Jeśli tak, co uznał serwis i jaki był koszt?
    3. GWARANCJA I CENA: Ustal stan gwarancji i cenę rynkową sprzętu (zgodnie z regułami powyżej, posługując się danymi wyszukanymi w Google).
    4. DOKUMENTACJA ZDJĘCIOWA: Czy są zdjęcia w systemie? 

    STATUS ZDJĘĆ:
    ${hasPhotosInHistory
                    ? "UWAGA: Zdjęcia są już w aktach (punkt 4 ZALICZONY). Nie pytaj o nie."
                    : "PUNKT 4 (ZDJĘCIA) JEST WYMAGANY - dopytaj o nie."}

    TAKTYKI:
    - Magazynier NIE BYŁ na budowie. NIGDY nie pytaj o okoliczności awarii ani o to, kto zawinił.
    - Odpowiadaj WYŁĄCZNIE czystym JSON.

    FORMAT JSON:
    Gdy zbierasz info: {"reply":"Twoja wiadomość","isComplete":false,"needsPhotos":${hasPhotosInHistory ? "false" : "true"},"caseContext":null}
    Gdy masz KOMPLET: {"reply":"Dziękuję. Protokół zabezpieczony.","isComplete":true,"needsPhotos":false,"caseContext":"RAPORT MAGAZYNU:\\nSprzęt: ${inventoryName}\\nStan: ${warehouseNotes || declaredStatus}\\nRok zakupu: ${purchaseDate || 'Nieznany (Ustalony: [Wpisz rok jeśli magazynier podał])'}\\nDiagnoza serwisu: [Wpisz ustaloną diagnozę/złom/koszt]\\nGwarancja: [tak/nie/po terminie]\\nOrientacyjna cena: [Wpisz ustaloną cenę nowego urządzenia]"}`;

            initialPrompt = `Nowe zgłoszenie szkody. Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber || 'brak'}), Budowa: "${siteName}".
    Magazynier nadał status: "${declaredStatus || 'uszkodzone'}" i wpisał uwagę: "${warehouseNotes || 'Brak uwag'}".
    Zadaj pierwsze pytanie magazynierowi dotyczące rokowań naprawy lub historii serwisowej/gwarancyjnej zgodnie z wytycznymi.`;
        }

        // Budujemy historię rozmowy
        const contents = clientMessages.map((m: any) => ({
            role: m.role === 'model' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const finalContents = isInitial
            ? [{ role: 'user', parts: [{ text: initialPrompt }] }]
            : contents;

        const response = await ai.models.generateContent({
            model: modelName,
            contents: finalContents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.2,
                responseMimeType: "application/json",
                // ─── GOOGLE SEARCH GROUNDING ───
                tools: [{ googleSearch: {} }]
            }
        });

        const rawText = response.text || '{}';
        return NextResponse.json(JSON.parse(rawText));

    } catch (error: any) {
        console.error("Investigation AI error:", error);
        return NextResponse.json(
            { error: error.message || "Błąd wewnętrzny Google Gen AI" },
            { status: 500 }
        );
    }
}