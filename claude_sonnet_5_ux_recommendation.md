# PESAM WMS — Ekspercka Analiza UX/UI: Przeprojektowanie Katalogu Materiałów przy Skali "Setek Pozycji"

---

## 0. Założenia brzegowe (potwierdzenie zrozumienia problemu)

Zanim przejdę do diagnozy, ustalam twardy kontrakt projektowy, który musi przetrwać każdy wariant:

| Element | Status |
|---|---|
| `item.category`, `item.subcategory`, `item.isResidual`, `item.availableQuantity`, `item.unit` | **NIETYKALNE** — zmienia się wyłącznie warstwa prezentacji (UI), nie struktura dokumentu Firestore |
| Widżety JPP, powiadomienia, raporty | Czytają dokładnie te same pola — zero refaktoru logiki backendowej |
| Dopuszczalne jest dodanie **nowych, opcjonalnych** pól (np. `needsReview: boolean`, `lastCategorizedAt: timestamp`) — zgodnie z zasadą *additive schema evolution* w NoSQL, stare dokumenty bez tych pól muszą być traktowane jako `needsReview: false`/`undefined → domyślna wartość` |
| Mechanizm zmiany kategorii/podkategorii musi pozostać **1-2 kliknięcia**, bez modala | Twardy wymóg |

To jest kluczowe: **problem nie leży w modelu danych, lecz w sposobie jego prezentacji i grupowania wizualnego przy dużej kardynalności zbioru.**

---

## 1. Diagnoza problemu użyteczności przy dużej skali

### 1.1 Obciążenie poznawcze (Cognitive Load)

- **Płaska lista = brak "kotwic wzrokowych".** Przy 20 pozycjach mózg radzi sobie z liniowym skanowaniem. Przy 300+ pozycjach użytkownik traci punkt odniesienia "gdzie jestem" — klasyczny efekt **serial position / lost-in-the-middle**. Nie ma żadnego sygnału grupującego (np. że 40 wierszy pod rząd to "Kleje i Zaprawy").
- **Redundancja decyzyjna.** Operator widzi 12-opcjowy `<select>` w KAŻDYM wierszu, nawet jeśli 80% kolejnych wierszy ma tę samą kategorię co poprzedni (bo przyjeżdżają partiami z jednej budowy, często tego samego typu materiału). To powtarzalny, nieoptymalizowany wysiłek decyzyjny.
- **Brak statusu "co wymaga uwagi".** Nowe pozycje "Resztki" trafiają do tabeli bez domyślnej kategorii lub z kategorią błędną (np. default pierwszej opcji z `<select>`) — i wizualnie nie różnią się niczym od pozycji już poprawnie sklasyfikowanych. Użytkownik musi "pamiętać" albo przeklikiwać wszystko po kolei.

### 1.2 Wydajność DOM / Rendering

- Każdy wiersz to **minimum 2 kontrolki `<select>` z ~12 i ~6-10 opcjami**, miniatura obrazka, 3 przyciski akcji. Przy 300 wierszach to **~600 elementów `<select>` żywych w DOM jednocześnie** + listenery onChange. Bez wirtualizacji listy (`react-window` / `virtual scroll`) przeglądarka na starszym magazynowym tablecie/laptopie zacznie zacinać się przy scrollu, a czas pierwszego renderu (TTI) rośnie liniowo.
- Inline `<select>` bez debounce = **każda zmiana to osobny request do Firestore** (chyba że jest już batching — trzeba to zweryfikować/wymusić).

### 1.3 Błędy wzrokowe (scanning errors)

- Dwa identyczne wizualnie `<select>` obok siebie (kategoria/podkategoria) w gęstym gridzie → wysokie ryzyko, że operator w rękawicach, na tabletowym ekranie dotykowym, **trafi i zmieni zły wiersz** (fat-finger error), zwłaszcza gdy wiersze mają zbliżoną wysokość i brak wyraźnych separatorów.
- Brak koloru/ikony sygnalizującej kategorię = każda kategoria wygląda "tak samo" (szary select), więc nie da się jej rozpoznać boczno-wzrokowo (peryferyjnie), trzeba czytać tekst w każdym wierszu osobno.

### 1.4 Brak hierarchii informacyjnej

- Widżet JPP operuje na **agregatach per kategoria/strefa**, a katalog materiałów operuje na **pojedynczym itemie**. Te dwa światy nie są ze sobą nigdzie wizualnie spięte — użytkownik musi "w głowie" tłumaczyć: *"zmieniam kategorię tego kleju → to wpłynie na % zapełnienia Magazynu Farb i Chemii"*. Brak feedbacku kontekstowego = brak zrozumienia konsekwencji akcji.

### 1.5 Ryzyko procesowe (nie tylko UX, ale biznesowe)

Błędna kategoryzacja = błędny wskaźnik zapełnienia JPP = błędny alert "krytyczne 88%" dla strefy, która fizycznie nie jest przeciążona (lub odwrotnie — realne przeciążenie niewidoczne). **To nie jest kosmetyczny problem UI — to błąd propagujący się do rdzenia operacyjnego systemu.** Stąd waga tego redesignu jest wyższa niż "zwykła tabelka".

---

## 2. Trzy warianty przeprojektowania

---

### WARIANT 1 — "Smart Table & Quick Filters + Accordion Grouping"

**Koncepcja:** Zachowujemy dokładnie tę samą tabelę i te same inline-selecty (zero zmiany mentalnego modelu pracy użytkownika), ale **grupujemy wiersze w zwijalne sekcje (accordion) wg aktualnej Głównej Kategorii**, dodajemy pasek szybkich filtrów nad tabelą oraz sticky nagłówki grup z mini-podsumowaniem.

**Jak działa:**
1. Nad tabelą: pasek chipów filtrujących (`Wszystkie (312)`, `Nieskategoryzowane (14)` ⚠️, `Kleje i Zaprawy (58)`, `Pustaki… (97)` itd.) — liczby aktualizują się live.
2. Domyślnie tabela jest pogrupowana wg `category` w zwijane sekcje z nagłówkiem: nazwa kategorii, licznik pozycji, mini pasek sumy ilościowej.
3. Wewnątrz sekcji — **dokładnie ta sama tabela co dziś**, bez zmian w kolumnach/selectach.
4. Zmiana kategorii w wierszu → wiersz **animuje się i "wylatuje"** z bieżącej sekcji do nowej (z 400ms fade/slide), żeby dać natychmiastowy feedback "przeniosłem to".
5. Wyszukiwarka tekstowa nad tabelą przeszukuje nazwę + tagi, filtrując w obrębie wszystkich sekcji jednocześnie (sekcje bez wyników są ukrywane, a nie puste).
6. Wirtualizacja renderowana **per sekcja otwarta** — zamknięte accordiony nie renderują swoich wierszy w DOM (ogromny zysk wydajności przy setkach pozycji).

**Zgodność z modelem danych:** 100% — żadna zmiana zapisu, tylko grupowanie po `category` po stronie klienta (`groupBy` w pamięci, pobranej już kolekcji lub przez zapytanie Firestore z `orderBy('category')`).

**Plusy:** Minimalny koszt wdrożenia, zero ryzyka regresji, natychmiastowa poprawa skanowalności i wydajności.
**Minusy:** Nie rozwiązuje w pełni problemu **masowego** przypisywania (nadal 1 wiersz = 1 klik na raz). Dobre dla "uporządkowania widoku", słabsze dla "szybkiej masowej obróbki nowego transportu z budowy".

---

### WARIANT 2 — "Kategorie jako pasek/sidebar + Fast-Tagger / Batch Assign"

**Koncepcja:** Odwracamy relację figura-tło. Kategorie przestają być tylko polem w wierszu — stają się **nawigacją strukturalną** (lewy sidebar lub górny pasek, podobny do etykiet Gmaila), a tabela pokazuje tylko pozycje danej kategorii/filtru. Dodatkowo wprowadzamy **tryb zaznaczania wielokrotnego (checkbox) + pasek akcji masowych ("Fast-Tagger")**.

**Jak działa:**
1. Lewy sidebar (lub górny poziomy pasek na tablecie): lista 12 Głównych Kategorii + specjalna pozycja **"⚠️ Nieskategoryzowane / Do weryfikacji"** na samej górze, z czerwonym badge liczby.
2. Kliknięcie kategorii filtruje tabelę do tej grupy — **mniej wierszy na ekranie = mniejszy cognitive load**, bo operator pracuje "partiami" (dokładnie tak, jak materiały realnie przyjeżdżają — całą ciężarówką jednego typu z budowy).
3. Każdy wiersz ma checkbox na początku. Zaznaczenie ≥1 wiersza aktywuje **sticky pasek dolny/górny "Fast-Tagger"**: `Zaznaczono: 23 pozycje → [Przypisz Kategorię ▾] [Przypisz Podkategorię ▾] [Zastosuj]`.
4. Pojedyncza zmiana nadal działa dokładnie jak dziś (inline select w wierszu) — **nic nie znikło**, tylko doszła ścieżka masowa.
5. Drag selection (shift+klik jak w Excelu) oraz "zaznacz wszystkie widoczne" dla pracy na całej partii dostawy.
6. Batch Assign realizowany jako **jeden Firestore `writeBatch()`** (do 500 operacji na batch) zamiast 23 osobnych write'ów — realny zysk wydajnościowy i spójności (atomic update).

**Zgodność z modelem danych:** 100% — batch po prostu wykonuje `update({category, subcategory})` na wielu dokumentach jednocześnie, polami identycznymi jak dziś.

**Plusy:** Rozwiązuje realny ból: "zwieziono 40 palet z jednej budowy, wszystkie to pustaki" → 3 kliknięcia zamiast 40. Sidebar kategorii naturalnie mapuje się na mentalny model stref (blisko koncepcji z widżetu JPP).
**Minusy:** Wymaga nieco więcej pracy frontendowej (stan zaznaczenia, batch UI, responsywność sidebar→drawer na tablecie). Lekko zmienia layout (sidebar zajmuje miejsce) — do przetestowania na wąskich ekranach magazynowych tabletów.

---

### WARIANT 3 — "Dual-Pane / Split-View: Strefy JPP ↔ Lista Resztek (drag & drop / 1-click assign)"

**Koncepcja:** Najbardziej architektoniczny wariant — **dosłowne połączenie obu ekranów** opisanych w problemie w jeden ekran roboczy typu split-view. Po lewej: skrócony widok stref/kategorii z ich aktualnym zapełnieniem JPP (dokładnie ten sam komponent co dziś w widżecie). Po prawej: lista "Resztek" do przypisania.

**Jak działa:**
1. Lewy panel = żywe karty stref (Plac Zewnętrzny 67%, Magazyn Farb i Chemii 88% 🔴 itd.) — **to ten sam widżet, osadzony jako komponent współdzielony**, nie duplikat.
2. Prawy panel = lista materiałów (filtrowalna, wyszukiwalna), każdy wiersz z uchwytem drag (⠿) lub przyciskiem "Przypisz →".
3. Przeciągnięcie wiersza na kartę strefy → system automatycznie ustawia `category` na jedną z Głównych Kategorii przypisanych do tej strefy (jeśli strefa ma więcej niż jedną kategorię, pojawia się mikro-popover z wyborem podkategorii — 1 dodatkowy klik).
4. **Natychmiastowy visual feedback**: karta strefy "pulsuje" i % zapełnienia animuje się do nowej wartości w czasie rzeczywistym — użytkownik *widzi konsekwencję* swojej decyzji, czego brakuje w wariantach 1 i 2.
5. Dla urządzeń dotykowych/tabletów bez wygodnego drag&drop: alternatywny tryb "1-click assign" — klik na wiersz podświetla dostępne strefy jako duże przyciski ("Przypisz do: [Plac Zewnętrzny] [Regał na stal]..."), klik w strefę = gotowe.

**Zgodność z modelem danych:** 100%, ale wymaga dodatkowej (czysto UI-owej) mapy konfiguracyjnej "która Główna Kategoria należy do której strefy" — **to już i tak istnieje** w strukturze stref (`zone.assignedCategories`), więc nie jest to nowy byt, tylko wykorzystanie istniejących danych w nowym miejscu UI.

**Plusy:** Najwyższa jakość decyzyjna — operator widzi realny wpływ na przeciążenie strefy *zanim* zatwierdzi, co zapobiega katastrofom typu "przypisałem 50 palet kleju do strefy, która już jest na 88%". Najbardziej "wow" i enterprise.
**Minusy:** Największy koszt wdrożenia. Drag&drop na tabletach z rękawicami roboczymi jest ryzykowny ergonomicznie (niska precyzja dotyku) — **musi mieć fallback 1-click**, co podnosi złożoność. Wymaga też przemyślenia przypadku "pozycja pasuje do kilku stref" (UX decyzji wieloznacznej).

---

### Tabela porównawcza

| Kryterium | Wariant 1 (Accordion) | Wariant 2 (Sidebar + Batch) | Wariant 3 (Split-View) |
|---|---|---|---|
| Nakład wdrożenia | Niski (1-2 dni) | Średni (3-5 dni) | Wysoki (1.5-2 tyg.) |
| Ryzyko regresji | Minimalne | Niskie | Średnie (nowy komponent) |
| Szybkość pojedynczej zmiany | Bez zmian (dobra) | Bez zmian (dobra) | Bardzo dobra (1 klik) |
| Szybkość zmiany masowej (np. 40 palet) | Słaba | **Bardzo dobra** | Dobra |
| Widoczność wpływu na JPP | Brak | Pośrednia (osobny widżet) | **Natychmiastowa (sprzężenie zwrotne)** |
| Ergonomia na tablecie/rękawicach | Dobra | Dobra | Wymaga fallbacku 1-click |
| Skalowalność do 1000+ pozycji | Dobra (z wirtualizacją) | Bardzo dobra | Dobra |

---

## 3. Rekomendacja krokowa

### 🟢 QUICK WIN (1 dzień roboczy, wdrożenie natychmiastowe)

Wdrażamy **okrojony Wariant 1 + element statusu z Wariantu 2**, zero zmian w modelu danych, zero nowych komponentów architektonicznych:

1. **Grupowanie wierszy w accordion wg `category`** (prosty `groupBy` po stronie klienta na już pobranej liście — jeśli lista jest paginowana z Firestore, grupowanie robimy na stronie wyświetlanej).
2. **Pasek filtrów-chipów** nad tabelą z licznikami (`Wszystkie`, `Nieskategoryzowane ⚠️`, + top kategorie).
3. **Dodanie wirtualnego pola `needsReview`** (obliczane lokalnie: `true` jeśli `category` jest puste/domyślne — nie wymaga migracji danych, tylko warunku w kodzie) + czerwona kropka/badge na wierszu.
4. **Sticky nagłówek kolumn** przy scrollu + lekkie prążkowanie wierszy (zebra striping) dla redukcji błędów wzrokowych.
5. **Toast/inline spinner przy zapisie zmiany** (patrz sekcja 5) — mikro-feedback, 2h pracy, ogromny zysk zaufania do systemu.

**Efekt:** 80% redukcji "zgubienia się" w liście, bez ryzyka, bez migracji, deployowalne jeszcze w tym tygodniu.

### 🏛️ DOCELOWY WZORZEC ENTERPRISE (architektura docelowa, kwartał)

Rekomenduję **hybrydę Wariantu 2 + elementy Wariantu 3 jako tryb opcjonalny**:

- **Tryb domyślny (codzienna praca)** = Wariant 2: sidebar kategorii + accordion z Wariantu 1 wewnątrz + checkbox batch assign. To pokrywa 90% codziennych operacji (przyjęcie dostawy, masowa korekta).
- **Tryb "Rozładunek Nowej Dostawy" (opcjonalny, wywoływany przyciskiem "🚚 Nowa dostawa")** = uruchamia Split-View z Wariantu 3, skupiony tylko na świeżo dodanych, nieskategoryzowanych pozycjach, sprzężonych wizualnie ze stanem stref JPP — bo to jest moment, w którym decyzje "gdzie to fizycznie położyć + jak skategoryzować" są podejmowane razem, i tam wartość drag&drop/1-click z natychmiastowym feedbackiem JPP jest największa.
- Dolna warstwa danych bez zmian: te same pola, batch write przez `writeBatch()`, opcjonalne pole `needsReview` formalnie dodane do schematu (default `false`) i ustawiane `true` przy tworzeniu nowej pozycji resztkowej bez kategorii.

To podejście respektuje zasadę **progresywnego ujawniania złożoności (progressive disclosure)**: codzienna, szybka praca = prosty, znany interfejs; złożony scenariusz (nowa dostawa, setki palet) = dedykowany, bogatszy tryb, włączany świadomie.

---

## 4. Wireframe'y tekstowe

### 4.0 Stan obecny (punkt odniesienia — problem)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DROBNICA, OSPRZĘT I MATERIAŁY > Pozostałości budowlane                   │
├────┬─────────────────────────┬────────────────┬───────────────┬─────────┤
│Zdj │ Nazwa                   │ Kat. Główna ▾  │ Podkategoria ▾ │ Kod/Ilość│
├────┼─────────────────────────┼────────────────┼───────────────┼─────────┤
│img │ Bednarka 25x4 🧱Resztki │ [Kable...   ▾] │ [Taśmy...  ▾] │ 4/4 krąg│
│img │ Bloczek 590x120x239 🧱  │ [Pustaki...▾] │ [Bloczki...▾] │ 3.5/3.5p│
│img │ Folia kubełkowa 200 🧱  │ [Izolacje...▾]│ [Folie...  ▾] │ 1/1 szt.│
│... (×297 kolejnych identycznie wyglądających wierszy, bez podziału) ...   │
└────┴─────────────────────────┴────────────────┴───────────────┴─────────┘
    ⚠️ Problem: brak punktów orientacyjnych, 600 aktywnych <select>, scroll fatigue
```

---

### 4.1 Wireframe — WARIANT 1 (Accordion + Chipy filtrów)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🔍 [ Szukaj materiału...                     ]   Widok: (●) Grupowany ( ) Lista │
│                                                                            │
│ [ Wszystkie (312) ] [⚠️ Nieskategoryzowane (14)] [Kleje i Zaprawy (58)]  │
│ [Pustaki, Bloczki i Cegły (97)] [Kable, Przewody (41)] [+8 więcej ▾]     │
├──────────────────────────────────────────────────────────────────────────┤
│ ▾ ⚠️ NIESKATEGORYZOWANE / DO WERYFIKACJI (14)         suma: 22 szt./pal.  │
│   ├─ img  Klej do siatki do wełny      [— wybierz —▾] [—wybierz—▾] 2/2szt│
│   ├─ img  Resztka blachy trapez.       [— wybierz —▾] [—wybierz—▾] 1/1szt│
│   └─ ... (12 więcej)                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ KLEJE I ZAPRAWY (58)                                suma: 41.5 palety  │
│   (zwinięte — kliknij by rozwinąć; wiersze NIE są renderowane w DOM)     │
├──────────────────────────────────────────────────────────────────────────┤
│ ▾ PUSTAKI, BLOCZKI I CEGŁY (97)                       suma: 212 szt.    │
│   ├─ img  Bloczek termobet 590x120x239 [Pustaki...▾] [Bloczki..▾] 3.5/3.5│
│   │                                     ↑ zmiana kategorii →              │
│   │                                     wiersz animuje "wylot" z sekcji   │
│   └─ ...                                                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 Wireframe — WARIANT 2 (Sidebar kategorii + Fast-Tagger Batch)

```
┌───────────────────┬────────────────────────────────────────────────────┐
│ KATEGORIE          │ 🔍 [Szukaj...]              ☑ Zaznacz wszystkie   │
│───────────────────│────────────────────────────────────────────────────│
│ ⚠️ Do weryfikacji  │ ☐ img  Bednarka 25x4         [Kable...▾][Taśmy..▾]│
│    🔴 14           │ ☐ img  Przewód YDY 3x2.5     [Kable...▾][Przew..▾]│
│───────────────────│ ☑ img  Bednarka 16x4         [Kable...▾][Taśmy..▾]│
│ Wszystkie (312)    │ ☑ img  Uchwyt bednarki       [Kable...▾][Uchwyty▾]│
│───────────────────│ ☐ img  Złączka kablowa       [Kable...▾][Złącz..▾]│
│ Kable, Przewody    │                                                    │
│ i Elektryka (41)►  │                                                    │
│───────────────────│                                                    │
│ Pustaki, Bloczki   │                                                    │
│ i Cegły (97)       │                                                    │
│───────────────────│                                                    │
│ Kleje i Zaprawy    │                                                    │
│ (58)               │                                                    │
│───────────────────│                                                    │
│ ... (8 więcej)     │                                                    │
└───────────────────┴────────────────────────────────────────────────────┘
       ↑ przy ☑ zaznaczeniu ≥1 wiersza pojawia się dolny sticky pasek:
┌────────────────────────────────────────────────────────────────────────┐
│ ✓ Zaznaczono: 2 pozycje   Kategoria: [Kable, Przewody i Elektryka ▾]   │
│   Podkategoria: [Osprzęt montażowy ▾]        [ Zastosuj do zaznaczonych ]│
└────────────────────────────────────────────────────────────────────────┘
```

---

### 4.3 Wireframe — WARIANT 3 (Split-View: Strefy JPP ↔ Resztki)

```
┌───────────────────────────────┬──────────────────────────────────────────┐
│ STREFY SKŁADOWANIA              │ RESZTKI DO PRZYPISANIA (14)              │
│──────────────────────────────│──────────────────────────────────────────│
│ Plac Zewnętrzny        67% 🟢  │ 🔍 [Szukaj...]                           │
│ ▓▓▓▓▓▓▓▓▓░░░░░             │ ┌──────────────────────────────────────┐ │
│                                 │ │ ⠿ img  Bloczek termobet 590x120   │ │
│ Magazyn Farb i Chemii  88% 🔴  │ │        3.5 / 3.5 pal.               │ │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░          │ │        [ Przypisz do strefy → ]     │ │
│                                 │ └──────────────────────────────────────┘ │
│ Hala rozsuwana         42% 🟢  │ ┌──────────────────────────────────────┐ │
│ ▓▓▓▓▓░░░░░░░░░░░           │ │ ⠿ img  Klej do siatki do wełny      │ │
│                                 │ │        2 / 2 szt.                   │ │
│ Regał na stal          73% 🟡  │ │        [ Przypisz do strefy → ]     │ │
│ ▓▓▓▓▓▓▓▓░░░░░░             │ └──────────────────────────────────────┘ │
│                                 │                                           │
│   ↑ przeciągnij kafelek         │   lub kliknij "Przypisz" → wyskakują    │
│   resztki tutaj (drag&drop)     │   duże przyciski dostępnych stref        │
└───────────────────────────────┴──────────────────────────────────────────┘

PO KLIKU "Przypisz do strefy →" na pozycji "Bloczek termobet":
┌──────────────────────────────────────────────────────────────────────────┐
│ Wybierz strefę dla: Bloczek termobet 590x120x239                        │
│                                                                            │
│  [ Plac Zewnętrzny  67%→69% ]   [ Regał na stal  73%→75% ]              │
│  [ Hala rozsuwana   42%→44% ]                                            │
│  (pokazane tylko strefy, które mają przypisaną kategorię "Pustaki...")  │
└──────────────────────────────────────────────────────────────────────────┘
   ↑ kluczowy element: podgląd WPŁYWU PRZED zatwierdzeniem (preview %)
```

---

## 5. Micro-interakcje — szczegółowe wskazówki

### 5.1 Wyszukiwarka z podpowiedziami kategorialnymi

- Pole wyszukiwania powinno obsługiwać **wyszukiwanie fasetowe inline** — wpisanie `kat:klej` lub prefiksu rozpoznawanego jako kategoria automatycznie filtruje i podświetla pasujący chip/sekcję kategorii (podobnie do Jira/Linear).
- Debounce **250-300ms** przed wykonaniem filtra (nie na każde naciśnięcie klawisza — rękawice robocze = częstsze literówki, nie chcemy migotania wyników).
- Podpowiedzi (dropdown) pod polem: top 5 dopasowań nazw + liczba wyników w danej kategorii, np.:
  ```
  🔍 klej
  ┌────────────────────────────────────┐
  │ Klej do siatki do wełny  (Kleje)    │
  │ Klej do płytek 25kg      (Kleje)    │
  │ Pokaż wszystkie wyniki (12) →       │
  └────────────────────────────────────┘
  ```

### 5.2 Etykiety statusowe "Nieskategoryzowane / Do weryfikacji"

- Zawsze **czerwona/bursztynowa kropka 8px** na lewej krawędzi wiersza + badge liczbowy w sidebarze/chipie — nigdy tylko tekst, bo tekst trzeba czytać, kolor+kształt rozpoznaje się peryferyjnie w 100ms.
- Reguła automatycznego nadawania statusu: `needsReview = true` jeśli `category` jest pusta/null LUB jest wartością placeholder (`"— wybierz —"`) LUB pozycja została utworzona < 24h temu i nigdy nie była edytowana ręcznie (pole pomocnicze `categoryConfirmedAt`, opcjonalne, nie wymaga migracji — brak pola = traktuj jako niepotwierdzone tylko dla nowych wpisów po dacie wdrożenia).
- Status znika natychmiast (optimistic UI) po pierwszej ręcznej zmianie kategorii — nawet przed potwierdzeniem zapisu z serwera.

### 5.3 Skróty klawiszowe (dla pracy na laptopie przy biurku magazynu)

| Skrót | Akcja |
|---|---|
| `/` | Fokus na pole wyszukiwania (jak w Linear/GitHub) |
| `J` / `K` | Nawigacja wiersz w dół / w górę (bez myszy) |
| `C` | Otwiera select kategorii w aktualnie podświetlonym wierszu |
| `Shift + Klik` | Zaznaczenie zakresu wierszy (batch) |
| `Ctrl/Cmd + A` | Zaznacz wszystkie widoczne (w obrębie filtra) |
| `Esc` | Anuluj edycję / zwiń panel batch |
| `Enter` | Zatwierdź Fast-Tagger batch assign |

*(Skróty to "nice to have" dla power userów magazynowych pracujących 8h dziennie w systemie — nie blokują pracy dotykowej na tablecie, są czysto addytywne.)*

### 5.4 Wskaźniki zapisu (najważniejszy element budujący zaufanie do systemu)

Operator w pośpiechu **musi mieć 100% pewność, że kliknięcie w select faktycznie coś zmieniło w bazie** — brak feedbacku = powtórne klikanie = duplikaty żądań / błędy.

Rekomendowany wzorzec (3 fazy, **optimistic UI**):

1. **Natychmiast po zmianie w select** (0ms): wiersz dostaje subtelne żółte obramowanie + mała ikona ⏳ przy nazwie kategorii — UI już pokazuje nową wartość, zanim serwer odpowie.
2. **Po potwierdzeniu zapisu z Firestore** (zwykle 200-600ms): obramowanie znika, pojawia się na 1.5s zielony ptaszek ✓ obok selecta, delikatny flash tła wiersza (np. `background-color` fade z `#e6f9ec` do transparentnego w 800ms).
3. **W razie błędu zapisu** (offline, konflikt uprawnień): czerwone obramowanie + ikona ⚠️ + toast na dole ekranu: *"Nie udało się zapisać zmiany kategorii dla 'Bednarka 25x4' — [Spróbuj ponownie]"*, a wartość w select **wraca do poprzedniej** (rollback optimistic update), żeby nigdy nie pokazywać fałszywego stanu.

Dla operacji batch (Wariant 2/3): pasek postępu tekstowy *"Zapisywanie 23 z 23 pozycji... ✓ Gotowe"* z możliwością cofnięcia (`Undo`, 5s, Firestore batch rollback do poprzednich wartości zapisanych tymczasowo w lokalnym stanie).

### 5.5 Ergonomia dotykowa / rękawice robocze

- Minimalny target dotykowy dla selecta/checkboxa/przycisku: **44×44px** (WCAG + realna praktyka przemysłowa), odstęp między klikalnymi elementami ≥ 8px.
- Checkboxy w trybie batch — **duże, kwadratowe, z wyraźnym stanem zaznaczenia** (nie subtelne outline), bo rękawica nie daje precyzyjnego feedbacku dotykowego, musi dać go ekran.
- Unikać hover-only interakcji (np. "pokaż akcje tylko po najechaniu myszką") — na tablecie hover nie istnieje; wszystkie akcje muszą być zawsze widoczne lub dostępne jednym tapnięciem.

---

## Podsumowanie wykonawcze

| Horyzont | Działanie |
|---|---|
| **Teraz (1 dzień)** | Accordion grouping + chipy filtrów + status "Nieskategoryzowane" + wskaźniki zapisu — zero zmian modelu danych, natychmiastowy efekt |
| **Ten kwartał** | Sidebar kategorii + batch assign (writeBatch) jako główny tryb pracy przy dużej skali |
| **Docelowo (enterprise)** | Opcjonalny tryb "Nowa Dostawa" ze split-view sprzężonym z widżetem JPP, dla scenariuszy wysokiego ryzyka decyzyjnego (masowe przyjęcia z budów) |

Wszystkie trzy horyzonty są **addytywne względem siebie i względem obecnego modelu danych** — każdy kolejny krok rozbudowuje UI, nigdy go nie łamie, i każdy może zostać wdrożony niezależnie bez blokowania pozostałych funkcji systemu PESAM (widżety JPP, raporty, protokoły).