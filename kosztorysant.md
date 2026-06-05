Racja, mój błąd w założeniach operacyjnych – wpadłem w pułapkę myślenia o
poprzednim module dla kierowników. Profesjonalne kosztorysowanie (zwłaszcza w
zamówieniach publicznych) to praca na gotowej, ogromnej dokumentacji, a nie
ręczne opisywanie wykopów na czacie. Czat w tym panelu ma służyć do korygowania
i sterowania pracą AI (np. "zmień technologię dachu na tańszą"), a głównym
"paliwem" dla systemu są pliki przetargowe.

Oto poprawiony, ostateczny i w pełni profesjonalny dokument architektoniczny,
uwzględniający automatyczną analizę całych paczek przetargowych.

🏗️ ARCHITEKTURA PROFESJONALNEGO SYSTEMU KOSZTORYSOWEGO PESAM

Wirtualne Biuro Przetargowe oparte na Sztucznej Inteligencji Wieloagentowej (Multi-Agent AI System)

1. WSTĘP I FILOZOFIA SYSTEMU

System PESAM w module kosztorysowym to zautomatyzowane Wirtualne Biuro
Przetargowe. Jego głównym celem jest drastyczne skrócenie czasu przygotowania
oferty przetargowej z kilku dni do kilkunastu minut.

Filozofia działania opiera się na pobieraniu całych paczek przetargowych (plików
ZIP zawierających SWZ, PFU, przedmiary ślepe w PDF/Excel oraz rysunki
techniczne) i automatycznym procesowaniu ich przez grupę wyspecjalizowanych
wirtualnych inżynierów (Agentów AI). System samodzielnie buduje strukturę
kosztorysu, rozpoznaje zakres prac i wycenia go, pozwalając Głównemu
Kosztorysantowi jedynie na nadzorowanie procesu, zarządzanie ryzykiem rynkowym i
ostateczną akceptację.

2. ARCHITEKTURA FRONTENDU (Interfejs Użytkownika)

Frontend (/dashboard/estimator) to kokpit dowodzenia Głównego Kosztorysanta.
Składa się z 3 współpracujących stref:

1.  Strefa Akwizycji, Parametryzacji i Ryzyka (Lewa Kolumna):

      - Dropzone Przetargowy: Miejsce do przeciągnięcia i upuszczenia paczki ZIP
        z dokumentacją przetargową lub dokumentów od Generalnego Wykonawcy
        (jeśli PESAM startuje jako podwykonawca).
      - Symulator Rynkowy (Trendy): Narzędzie do zarządzania ryzykiem. Suwaki
        korygujące ceny bazowe odczytane przez AI w oparciu o prognozy
        makroekonomiczne (np. zakładany wzrost cen materiałów o +12%, korekta
        stawek robocizny).
      - Narzuty Kosztorysowe: Kontrola nad Kosztami Pośrednimi (Kp) i Zyskiem
        (Z).
      - Raport Prawno-Ryzykowny: AI generuje tu alerty wyciągnięte z dokumentów
        (np. "Uwaga: SWZ przewiduje bardzo wysokie kary umowne za opóźnienia",
        "Wymagana gwarancja 60 miesięcy").

2.  Konsola Sterowania Wieloagentowego (Środkowa Kolumna):

      - Zamiast ręcznego dyktowania wymiarów, czat służy do nadzorowania i
        wprowadzania korekt inżynieryjnych.
      - Przykłady użycia: "Podmień w całym kosztorysie bloczki silikatowe na
        gazobeton i przelicz ponownie", "W dziale 3 zrezygnuj z naszej koparki,
        weźmiemy podwykonawcę".

3.  Arkusz Kalkulacyjny RMS (Prawa Kolumna):

      - Wielopoziomowa tabela wygenerowana automatycznie z dokumentów
        przetargowych.
      - Podział na Branże, Działy Przedmiarowe i konkretne pozycje (Robocizna,
        Materiały, Sprzęt).
      - Podgląd na żywo różnicy między Kosztem Bezpośrednim a Ceną Ofertową (z
        doliczonymi trendami i narzutami).

3. ARCHITEKTURA BACKENDU: MULTI-AGENT SYSTEM (MAS)

Kiedy Kosztorysant wrzuca plik ZIP, na serwerach PESAM (/api/kosztorysant/)
uruchamia się 5-fazowy proces (Pipeline).

FAZA 1: Moduł Rozpoznania i Akwizycji Danych (Document Parsing & RAG)

Paczka ZIP zostaje rozpakowana i rozesłana do analityków:

  - 📄 Agent Prawno-Przetargowy (NLP / Document AI): Czyta SWZ i wzory umów.
    Wyciąga z nich wymagania formalne, kody CPV zamówienia, czas realizacji i
    obostrzenia materiałowe.
  - 📊 Agent Przedmiarowy (OCR & Data Extraction): Skanuje "ślepe kosztorysy"
    (tabele PDF/Excel) udostępnione przez gminę. Tłumaczy je na ustrukturyzowany
    zbiór danych (JSON).
  - 📐 Agent Architekt / BIM (Vision AI): Jeśli brakuje przedmiaru, analizuje
    rzuty i przekroje, aby samodzielnie zliczyć kubatury betonu, powierzchnie
    dachów i metry bieżące instalacji.
  - 🌍 Agent Logistyk (GIS): Pobiera adres inwestycji z dokumentów, analizuje
    dystans do bazy PESAM, najbliższych węzłów betoniarskich i kopalni kruszyw
    (kluczowe dla wyliczenia Kosztów Zakupu - Kz).

FAZA 2: Główny Inżynier Kontraktu (PRO Master Router)

  - Zadanie: Konsolidacja danych z Fazy 1.
  - Dyspozytor buduje Drzewo Kosztorysu. Jeśli dokumentacja przetargowa narzuca
    własny podział (np. 1. Stan surowy, 2. Wykończenie), odwzorowuje go. Jeśli
    jesteśmy podwykonawcą tylko na "Roboty Ziemne", filtruje projekt i tworzy
    działy tylko dla naszego zakresu. Następnie deleguje każdą pozycję do
    Silnika RMS.

FAZA 3: Wielordzeniowy Silnik Obliczeniowy KNR (RMS Engine)

Najpotężniejszy moduł systemu (wykorzystujący Python Code Execution). Uzupełnia
"ślepy przedmiar" o konkretne nakłady.

  - 📚 Agent Normatywny (KNR Lookup): Przypisuje każdej pozycji z przedmiaru
    odpowiedni kod KNR/KNNR.
  - 🧱 Agent Materiałowy (M): Do wyliczonych kubatur dolicza odpowiednie normy
    zużycia materiałów pobocznych (np. do płytek dolicza klej, fugę, krzyżyki
    i 10% odpadu na docinki).
  - 👷 Agent Robocizny (R): Zgodnie z KNR, rozpisuje ile r-g (roboczogodzin)
    murarza, zbrojarza, cieśli i robotnika potrzeba na wykonanie zadania.
  - 🚜 Agent Sprzętu (S): Rozpisuje m-g (maszynogodziny) niezbędnych żurawi,
    koparek i pomp.

FAZA 4: Moduł Wyceny i Strategii Rynkowej (Pricing & Strategy)

Agenci finansowi nakładają na wyliczone ilości (R, M, S) wartości w PLN.

  - 🏢 Agent Zasobów Własnych: Integruje się z systemem inwentarzowym PESAM.
    Jeśli mamy własny sprzęt lub materiały z odzysku, obniża to koszty w
    wycenie.
  - 📉 Agent Rynku (Sekocenbud/Intercenbud API): Pobiera aktualne średnie
    krajowe/regionalne stawki za r-g i ceny materiałów.
  - 💰 Agent Finansowy: Nakłada na wycenę bazową wartości z suwaków Głównego
    Kosztorysanta (trendy makroekonomiczne, Koszty Pośrednie, Zysk).

FAZA 5: Generowanie Wyników (Output)

Zwrócenie gotowego pakietu do interfejsu Głównego Kosztorysanta:

1.  Wypełniona tabela RMS na frontendzie (gotowa do ostatecznych szlifów
    ręcznych).
2.  Wygenerowany Kosztorys Ofertowy (zgodny z wymogami Prawa Zamówień
    Publicznych) do pobrania w PDF/Excel.
3.  Wewnętrzny Harmonogram i Lista Zakupowa dla logistyki PESAM.

4. PRZYKŁADOWY PRZEPŁYW DANYCH (Use Case: Przetarg na Przedszkole)

1.  Użytkownik (Kosztorysant): Pobiera plik
    Przetarg_Przedszkole_Gmina_Czyzew.zip ze strony urzędu. Przeciąga plik do
    "Dropzone" w lewej kolumnie panelu PESAM i klika "Analizuj i Wyceń".
2.  System (Faza 1): Rozpakowuje plik. Agent Prawny czyta SWZ i wyświetla alert:
    "Wymagany certyfikat BREEAM dla materiałów, kara 10 000 zł za dzień zwłoki,
    termin 18 miesięcy". Agent Przedmiarowy czyta załączonego Excela ze "ślepym
    kosztorysem" i wyciąga 150 pozycji do wykonania.
3.  System (Faza 2 & 3): Dyspozytor układa 150 pozycji w działy. Silnik RMS w
    ułamki sekund dopasowuje do nich kody KNR, rozbija na roboczogodziny,
    kilogramy i maszynogodziny.
4.  System (Faza 4): Agent Rynku pobiera dzisiejsze ceny betonu, stali i
    robocizny z regionu Podlasia (Czyżew).
5.  Frontend: Po kilkudziesięciu sekundach prawa kolumna wypełnia się gotowym
    kosztorysem opiewającym np. na 4 500 000 PLN.
6.  Interakcja Kosztorysanta: Kosztorysant patrzy w lewą kolumnę i myśli:
    "Przetarg będzie trwał długo, a ceny prądu rosną". Przesuwa suwak "Korekta
    Materiałów" na +15%. Tabela przelicza się na żywo, a nowa kwota ofertowa
    rośnie do 4 800 000 PLN.
7.  Korekta przez Czat: Kosztorysant pisze do AI: "W dziale 4 (Dach) gmina
    dopuszcza zamiennik. Policz to na membranie EPDM zamiast papy
    termozgrzewalnej". AI błyskawicznie przelicza tylko Dział 4, aktualizując R,
    M, S i cenę końcową.
8.  Eksport: Kosztorysant klika "Eksportuj Ofertę" i wysyła gotowy dokument do
    urzędu gminy.

5. TECHNOLOGIE I BEZPIECZEŃSTWO

  - Frontend: Next.js 14, Tailwind CSS, Drag & Drop API dla plików.
  - Backend: Next.js API Routes (Serverless).
  - AI Engine:
      - Google Cloud Document AI / Gemini 1.5 Pro Vision: Do analizy plików PDF,
        tabel przedmiarowych i rysunków.
      - Python Code Execution: Dla Silnika RMS zapewniającego brak błędów
        matematycznych w kosztorysach na wielomilionowe kwoty.
  - Bezpieczeństwo: Role-Based Access Control (RBAC) z wymaganą flagą
    useEstimatingPanel. Pliki przetargowe przetwarzane w bezpiecznym środowisku
    chmurowym bez uczenia modeli publicznych na danych firmy.

6. MAPA DROGOWA WDROŻENIA (Roadmap)

- [x] ETAP 1: Przygotowanie infrastruktury uprawnień, bazy oraz Zaawansowanego
  Frontendu (Layout 3-kolumnowy z symulatorem trendów).
- [ ] ETAP 2: Budowa rms-engine (Silnika obliczeniowego w Pythonie,
  przyjmującego zapytania tekstowe i zwracającego tabele KNR).
- [ ] ETAP 3: Implementacja modułu RAG i Document AI (Dropzone na frontendzie +
  skrypty parsujące pliki PDF/ZIP z przetargów na zapleczu).
- [ ] ETAP 4: Podłączenie bazy wiedzy o polskich normach (KNR/KNNR) jako
  wektorowej bazy danych dla Agenta Normatywnego.
- [ ] ETAP 5: Integracja z zewnętrznymi API cennikowymi (np. Sekocenbud) oraz
  systemem magazynowym PESAM (weryfikacja zasobów własnych).
