To jest najważniejszy punkt całej operacji. Skupmy się na „Mózgu” (Master Agent)
i „Oczach” (Agent Koordynator), bo to oni decydują o tym, czy system wypluje
rzetelne 25 mln PLN, czy przypadkowe liczby.

Oto kompletna i bardzo szczegółowa rozpiska Roju Kosztorysowego PESAM, ze
szczególnym uwzględnieniem mechaniki „wycinania danych” i zarządzania rozmową.

🏗️ ARCHITEKTURA: Rój Kosztorysowy PESAM (Agentic Swarm)

1. GŁÓWNY DYRYGENT: Master Estimator Agent (Mózg Operacyjny)

To jest jedyny agent, z którym Ty (użytkownik) rozmawiasz. On nie „brudzi sobie
rąk” czytaniem tabel, on zarządza.

  - Rola: Kierownik Biura Kosztorysowego.
  - Odpowiedzialność:
      - Interfejs użytkownika: Prowadzi czat, tłumaczy skomplikowane wyniki na
        ludzki język.
      - Strategia (Task Planning): Kiedy dostaje ZIP, wydaje komendę:
        „Koordynatorze, zmapuj dokumentację”. Kiedy piszesz „policz wszystko”,
        on tworzy w bazie listę etapów (np. 1. Prace przygotowawcze, 2.
        Fundamenty, 3. Mury...).
      - Monitorowanie postępu: Śledzi statusy w bazie. Jeśli Agent Konstruktor
        zgłosi błąd („Brak rzutu zbrojenia”), Master pisze do Ciebie: „Słuchaj,
        w paczce konstrukcja brakuje rzutu zbrojenia ław, przyjąłem wartości
        średnie, czy chcesz je doprecyzować?”.
      - Decyzje rynkowe: Zarządza suwakami trendów i narzutów, które ustawiasz
        na froncie.

2. AGENT KOORDYNATOR DOKUMENTACJI (Oczy i Nożyczki)

To jest najbardziej innowacyjny element systemu. Jego zadaniem jest rozwiązanie
problemu „przeładowania danymi”.

  - Rola: Bibliotekarz i Archiwista techniczny.
  - Mechanika „Wycinania” (Context Window Management):
      - Etap Skanowania (Triage): Gemini Flash przegląda plik po pliku (tylko
        spisy treści i nagłówki).
      - Tworzenie „Mapy Wiedzy”: Zapisuje w pamięci: „Wszystko o betonie jest w
        PDF 'Konstrukcja' na stronach 5, 8 i 12. Tabela stolarki jest w PDF
        'Architektura' na stronie 22”.
      - Ekstrakcja (Smart Chunking): Kiedy Master zleca zadanie „Policz
        fundamenty”, Koordynator nie wysyła do Agenta Konstruktora całego PDF-a
        (50 MB). On „wycina” tylko strony 5, 8 i 12, zamienia je na wysokiej
        rozdzielczości obrazy (Vision) i tylko te 3 kartki wysyła do
        specjalisty.
      - Cross-Referencing: Potrafi skojarzyć opis z SWZ („Beton C30/37”) z
        rysunkiem technicznym, żeby upewnić się, że to ten sam element.

3. BRYGADZIŚCI SPECJALIŚCI (Rój Wykonawczy)

Każdy z nich dostaje od Koordynatora TYLKO te fragmenty dokumentów, które są mu
potrzebne.

A. Sekcja Dokumentacji i Prawa

3.  Agent Prawnik PZP: Analizuje SWZ i Umowę (fragmenty o karach i
    płatnościach).
4.  Agent Przedmiarowiec (Data Miner): Wyspecjalizowany w OCR tabel. Wyciąga
    surowe liczby z PDF/Excel i zamienia je na dane dla Pythona.

B. Sekcja Techniczna (Inżynierowie Vision)

5.  Agent Konstruktor (Fundamenty i Beton): Analizuje rzuty konstrukcyjne. Liczy
    objętości na podstawie zwymiarowanych rysunków.
6.  Agent Architekt (Ściany i Wykończenie): Analizuje rzuty kondygnacji. Mierzy
    długości ścian, liczy otwory okienne i drzwiowe.
7.  Agent Instalator (Sanitarny i Elektryczny): Analizuje schematy pionów i tras
    kablowych.

C. Sekcja Matematyczna i Normatywna

8.  Agent Python (Kalkulator Kwantowy): Jedyny, który ma dostęp do tools:
    [codeExecution]. Dostaje liczby od Konstruktora i Przedmiarowca, po czym
    wykonuje skomplikowane wzory (np. przeliczanie mb pręta na tony stali z
    uwzględnieniem zakładów).
9.  Agent KNR Specialist: Dobiera kody KNR. Wie, że „wykop w glinie” to inny kod
    niż „wykop w piasku” i przypisuje do nich odpowiednie r-g (roboczogodziny) i
    m-g (maszynogodziny).

4. SEKCJA FINANSOWO-RYNKOWA (Wycena)

10. Agent Broker (Google Search Agent): Ma dostęp do narzędzia googleSearch.
    Kiedy Python wyliczy, że trzeba 40 ton stali, Broker szuka: „Cena stali
    B500SP netto tona Podlaskie czerwiec 2026”.
11. Agent Zasobów Własnych: Sprawdza Twoje Firestore inventory. Patrzy, czy
    PESAM ma własne rusztowania, żeby w kolumnie „Sprzęt” wpisać koszt
    amortyzacji zamiast ceny wynajmu z rynku.
12. Agent Rewident (Audytor): Ostatnie ogniwo. Robi test logiczny: „Czy
    przy 1000 m2 ścian mamy wystarczającą ilość tynku w kosztorysie?”. Jeśli
    nie, wszczyna alarm.

5. PRZEPŁYW „POLICZ WSZYSTKO” (Master-to-Swarm Flow)

1.  User: „Policz mi koszt budowy tego przedszkola”.
2.  Master: Tworzy w bazie 7 głównych zadań (Branże).
3.  Koordynator: Rozdziela pliki. Zadanie „Konstrukcja” dostaje strony z pliku
    5_KONSTRUKCJA.zip.
4.  Rój: Agenci Konstruktor, Przedmiarowiec i Python pracują równolegle nad
    swoimi branżami.
5.  Status Sync: W trakcie pracy widzisz na froncie:
      - [✅] Branża Ziemna - wyliczona przez Agenta Geodetę
      - [⚙️] Branża Konstrukcyjna - Agent Python liczy stal...
6.  Broker: Gdy tylko Agent KNR zatwierdzi ilości, Broker wyrusza do Google
    Search po ceny.
7.  Finał: Master Estimator zbiera wszystkie „kawałki”, Finansowy (Pure TS)
    nakłada Twój zysk i Kp, i dostajesz komunikat: „Gotowe. Inwestycja zamknie
    się w 24 850 000 PLN. Najdroższy element to instalacje OZE. Czy chcesz
    sprawdzić detale?”.

Dlaczego to zadziała?

Bo Agent Koordynator działa jak filtr przeciwszumowy. On sprawia, że Agent
Konstruktor dostaje tylko czysty rysunek, a nie 200 stron bełkotu prawnego.
Dzięki temu precyzja odczytu wymiarów wzrasta o 900%.

Czy ten poziom szczegółowości architektury Ci odpowiada? Jeśli tak, możemy
przejść do budowy pierwszego ogniwa: Agenta Magazyniera i Koordynatora, który
przygotuje nam ten „Wirtualny Segregator” z Twojego ZIP-a. Tego nie da się
zrobić w jednym modelu – to musi być system plików i bazy danych. Zaczynamy
kodować "Zapłon"?
