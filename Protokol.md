# Plan Implementacji: Wypisz Protokol - Mobilny szkic zwrotu dla kierowcy + integracja z ERP

> ZASADA NADRZEDNA: NIE zmieniamy zadnej istniejacacej logiki protokolow w ERP.
> Dodajemy nowy przeplyw z jednym punktem integracji: przycisk "Wczytaj protokol kierowcy"
> w oknie Wprowadz Zwrot.

---

## 1. Kluczowa Decyzja Architektoniczna - Automatyczna Transkrypcja AI

### Stary plan (odrzucony):
Kierowca nagrywa -> wysyla szkic -> kierownik odsłuchuje nagranie reczenie

### NOWY plan (zaakceptowany):
Kierowca nagrywa -> klika "Wyslij" -> telefon sam wysyla audio do AI (/api/parse-audio)
-> AI zwraca liste pozycji (JSON) -> kierownik WIDZI JUZ GOTOWA LISTE resztek, nie nagranie

Nagranie glosowe sluzy TYLKO do resztek budowlanych - wszystko inne (sprzet, osprzet)
jest odhaczane checkboxami przez kierowce.

---

## 2. Przeplyw Krok po Kroku

### KIEROWCA (telefon - /plac/protokol):

KROK 1 - Wybor budowy
- Select z lista aktywnych budow z Firestore kolekcja `sites`
- Po wyborze: automatyczne pobranie sprzetu z `inventory` (filtr: allocations[siteId] > 0)

KROK 2 - Lista sprzetu na budowie (checkboxy)
- Karta dla kazdego elementu:
  * Nazwa + nr inwentarzowy + ilosc na budowie
  * Checkbox "Zabieram na auto"
  * Rozwijana sekcja osprzetu (item.accessories):
    - Pozycje z mustReturn: true oznaczone plakietka "MUSI WROCIC"
    - Checkbox przy kazdym elemencie osprzetu
  * Pole numeryczne dla BULK (ile sztuk oddaje)

KROK 3 - Resztki budowlane (notatka glosowa)
- Wielki przycisk mikrofonu (START / STOP)
- Licznik czasu nagrania widoczny na ekranie (np. "00:47")
- Mozliwosc odsluchu nagrania przed wyslaniem
- Mozliwosc ponownego nagrania

KROK 4 - Kliknięcie "Wyslij do kierownika"

Co dzieje sie AUTOMATYCZNIE na telefonie po kliknieciu:

1. Upload pliku audio -> Firebase Storage:
   Sciezka: protocol_audio_drafts/{siteId}_{uid}_{timestamp}.webm

2. Pobranie publicznego URL nagrania z Storage

3. Wywolanie istniejacego endpointu POST /api/parse-audio
   z body: { audioUrl: <url do nagrania> }
   (endpoint uzywa Gemini 2.5 Flash - juz jest w kodzie, juz dziala)

4. Gemini zwraca JSON z lista pozycji:
   [{ roughName: "worki z klej em", quantity: 2, unit: "worek", type: "PURCHASE", ... }, ...]

5. Zapis dokumentu do Firestore kolekcja `protocols`:
   {
     type: "ZWROT",
     status: "SZKIC_KIEROWCY",
     sourceId: selectedSiteId,
     sourceName: selectedSiteName,
     driverUid: user.uid,
     driverName: "Jan Kowalski",
     targetManagerName: "...",
     createdAt: new Date().toISOString(),
     audioNoteUrl: "<URL w Storage>",
     residuals: [
       { name: "worki z klejem", quantity: 2, unit: "worek" },
       { name: "profile 3m", quantity: 5, unit: "szt." }
     ],
     items: [
       {
         inventoryId: "...", name: "...", inventoryNumber: "...",
         type: "UNIQUE" | "BULK", returnQty: 1,
         declaredStatus: "SPRAWNY",
         accessories: [
           { name: "Walizka", isReturning: true, mustReturn: true }
         ]
       }
     ]
   }

6. Powrot do /plac z komunikatem "Szkic wyslany do kierownika"

Wskaznik "Wysylanie..." z animacja przez caly czas przetwarzania (upload + AI).

UWAGA: Jezeli AI zawiedzie (blad sieci, timeout) - szkic zostaje wyslany BEZ listy residuals,
a pole residuals bedzie puste []. Kierownik zobaczy informacje "Nie udalo sie przeanalizowac nagrania"
i bedzie mogl dopisac pozycje recznie. Nagranie i tak jest zapisane w Storage jako zapas.

---

## 3. Modyfikacje w ERP - Co Widzi Kierownik

Plik: src/app/(dashboard)/dashboard/protocols/page.tsx

### Nowy przycisk w oknie "Wprowadz Zwrot":
"Wczytaj protokol kierowcy (N)" - gdzie N to liczba czekajacych szkicow dla wybranej budowy

Klikniecie pokazuje liste szkicow dla wybranej budowy:
  query: where("status", "==", "SZKIC_KIEROWCY") + where("sourceId", "==", paperReturnSiteId)

Kazdy szkic na liscie pokazuje:
  - Imie kierowcy + data wyslania
  - Liczba pozycji sprzetu (items.length)
  - Lista resztek (residuals[]) gotowa jako tekst - BEZ koniecznosci odsłuchiwania

Klikniecie "Zaladuj":
  1. setPaperReturnSiteId(draft.sourceId)
  2. Mapuje draft.items -> PaperReturnCartItem[] -> setPaperReturnCart(...)
  3. Dla kazdego rekordu z draft.residuals: dodaje jako pozycja reczna do koszyka zwrotu
     (tak samo jak dodanie przez "Dodaj recznie" - istniejacy mechanizm)
  4. setPaperDocSource("KIEROWCA")
  5. Zamyka liste szkicow

Po zaladowaniu kierownik widzi normalny formularz zwrotu - juz wypelniony.
Moze korygowac, usuwac, dopisywac.
Klika "ZATWIERDZ I WPROWADZ ZWROT" - istniejaca logika bez zmian.

Po zatwierdzeniu: szkic dostaje status "WCZYTANY" - nie pojawia sie ponownie.

---

## 4. Zrodlowy Endpoint API - parse-audio (juz istnieje!)

Plik: src/app/api/parse-audio/route.ts

Obecne zachowanie:
- Przyjmuje { audioUrl: string }
- Pobiera plik audio i koduje do base64
- Wysyla do Gemini 2.5 Flash
- Zwraca: { items: [{ roughName, quantity, unit, type, suggestions }] }

Konieczna zmiana w parse-audio dla kontekstu protokolu:
- Dodac do systemInstruction kontekst ze to resztki budowlane do zwrotu, nie zamowienie
- LUB: stworzyc nowy endpoint /api/parse-audio-residuals z dostosowanym promptem

Dostosowany prompt dla resztek:
"Jestes pracownikiem firmy budowlanej. Kierowca nagral notatke glosowa z listy
resztek budowlanych pozostalych na budowie. Wyodrebnij pozycje materialow
ktore zostaja na budowie lub wracaja do magazynu.
Nie sugeruj zakupow. Wygeneruj czystą listę: { name, quantity, unit } dla kazdej pozycji."

---

## 5. Lista Plikow do Modyfikacji / Stworzenia

| Plik | Akcja | Co dokladnie |
|------|-------|--------------|
| src/app/plac/page.tsx | MODYFIKACJA MALA | Kafelek "Wypisz protokol" -> Link href="/plac/protokol" |
| src/app/plac/protokol/page.tsx | NOWY PLIK | Cala strona mobilna (kroki 1-4 powyzej) |
| src/app/api/parse-audio-residuals/route.ts | NOWY PLIK (opcjonalnie) | Wersja parse-audio z promptem dla resztek budowlanych |
| src/app/(dashboard)/dashboard/protocols/page.tsx | MODYFIKACJA MINIMALNA | Przycisk + mini-lista szkicow w oknie isPaperReturnModalOpen |

ZADNE inne pliki nie sa modyfikowane. Istniejace sciezki protokolow bez zmian.

---

## 6. Reguly Bezpieczenstwa Danych

- Szkic SZKIC_KIEROWCY NIGDY nie modyfikuje stanow inventory - tylko zapis zamiarów
- Stany modyfikuje dopiero istniejaca handlePaperReturnSubmit() - bez zadnych zmian w niej
- Jezeli kierownik wczyta szkic ale go nie zatwierdzi - nic sie nie zmienia w inventory
- Firebase Storage dla audio jest oddzielnym zasobem od Firestore

---

## 7. Uwagi Techniczne - Nagrywanie na Androidzie

| Aspekt | Rozwiazanie |
|--------|-------------|
| Format nagrania | audio/webm;codecs=opus (domyslny w Chrome Android) |
| Rozmiar | ok. 100-300 KB/min - bezpieczny upload na 3G/LTE na budowie |
| API | MediaRecorder - natywne Web API, Chrome na Androidzie |
| Czas przetwarzania | Upload + Gemini = ok. 5-15 sekund dla 1 minuty nagrania |
| Blad AI? | Kierownik widzi puste residuals + informacje o bledzie, moze wpisac recznie |

---

## 8. Pelny Przeplyw Uzytkowania

KIEROWCA:
1. /plac -> "Wypisz protokol"
2. Wybiera budowe
3. Zaznacza checkboxami co wraca (sprzet + osprzet)
4. Klika mikrofon -> mowi: "dwa worki kleju, 5 profili trzystametrowych, resztka farby"
5. Zatrzymuje nagranie
6. Klika "Wyslij do kierownika"
   -> Ekran: "Przetwarzanie nagrania AI... (moze chwile zajac)"
   -> Upload audio + Gemini + zapis w Firestore
7. Ekran: "Szkic wyslany do kierownika budowy!"

KIEROWNIK BUDOWY:
1. Centrum Protokolow -> "Wprowadz Zwrot"
2. Wybiera budowe -> widzi przycisk "Wczytaj protokol kierowcy (1)"
3. Klika przycisk -> widzi karte szkicu:
   Kierowca: Jan Kowalski, 22.10.2026 godz. 10:45
   Sprzet: 3 pozycje do zwrotu
   Resztki budowlane:
     - 2 worki kleju
     - 5 profili 3m
     - Resztka farby
4. Klika "Zaladuj ten protokol"
5. Formularz wypelnia sie automatycznie (sprzet + resztki)
6. Kierownik weryfikuje, koryguje jesli trzeba
7. Klika "ZATWIERDZ I WPROWADZ ZWROT" -> istniejaca logika
