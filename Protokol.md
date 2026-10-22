# Plan Wdrożenia: Mobilny Protokół Zwrotu dla Kierowcy z Notatką Głosową i Akceptacją Kierownika

## 1. Cel i Założenia Biznesowe

1. **Rola Kierowcy na Budowie (Aplikacja mobilna /plac):**
   - Kierowca podjeżdża na wybraną budowę i w telefonie (z dostępem do sieci) otwiera kafelek **"Wypisz protokół"** (`/plac/protokol`).
   - Wybiera daną budowę z listy (`sites`).
   - System natychmiast pobiera sprzęt i narzędzia przypisane do tej budowy (`allocations[siteId] > 0`).
   - Przy każdym sprzęcie kierowca widzi przypisany **osprzęt** (z oznaczeniem `musi wrócić`, np. tarcze, akumulatory, walizki, kable, wiertła).
   - Kierowca zaznacza checkboxami, co fizycznie zabiera na auto (zarówno główny sprzęt, jak i poszczególne elementy osprzętu).
   - **Materiały i resztki budowlane (Notatka głosowa AI):** Zamiast mozolnego wpisywania na ekranie telefonu w rękawicach roboczych ("2 worki kleju, resztka profili 3m, 4 kantówki"), kierowca klika mikrofon i dyktuje notatkę głosową.
   - Nagranie jest zapisywane w chmurze (Firebase Storage), a kierowca klika **"Wyślij szkic protokołu"**.

2. **Rola Kierownika Budowy / Magazynu (Panel główny ERP /protocols):**
   - W module protokołów pojawia się status: `SZKIC KIEROWCY (DO ZATWIERDZENIA)`.
   - Kierownik jednym kliknięciem:
     - Odsłuchuje nagranie lub uruchamia automatyczną transkrypcję AI (wykorzystując istniejący endpoint `/api/parse-audio` z Vertex AI Gemini), która przekształca głos kierowcy w pozycje materiałowe.
     - Sprawdza odznaczone narzędzia i osprzęt.
     - Zatwierdza zwrot, co automatycznie:
       - Zdejmuje stan sprzętu z budowy (`allocations[siteId] -= quantity`).
       - Dodaje sprzęt z powrotem na magazyn centralny.
       - Generuje oficjalny protokół zwrotu PDF z podpisami elektronicznymi i wysyłką e-mail.

---

## 2. Architektura Danych (Firestore)

### Kolekcja `protocols` (nowe pola dla szkicu kierowcy):
```typescript
interface ProtocolDocument {
  id: string;
  protocolNumber: string; // np. "PZ-SZKIC-20261022-1234" -> po zatwierdzeniu "PZ-2026-..."
  type: "ZWROT";
  status: "DRAFT_DRIVER" | "APPROVED" | "REJECTED"; // DRAFT_DRIVER to szkic czekający na kierownika
  siteId: string;
  siteName: string;
  driverUid: string;
  driverName: string;
  createdAt: string; // ISO
  approvedAt?: string;
  approvedBy?: string;
  
  // Zwracany sprzęt
  returnedItems: {
    itemId: string;
    name: string;
    inventoryNumber?: string;
    quantity: number;
    returnedAccessories?: {
      name: string;
      returned: boolean;
      mustReturn?: boolean;
    }[];
  }[];

  // Notatka głosowa i transkrypcja resztek budowlanych
  voiceNote?: {
    audioUrl: string;       // Ścieżka w Firebase Storage
    durationSeconds?: number;
    transcript?: string;    // Wynik przetworzenia przez Gemini
    parsedItems?: {
      name: string;
      quantity: string | number;
      unit?: string;
    }[];
  };

  driverNotes?: string;
}
```

---

## 3. Szczegółowy Zakres Prac i Pliki do Modyfikacji

### Krok 1: Nowa strona mobilna dla kierowcy
- **Plik:** `src/app/plac/protokol/page.tsx`
- **Funkcjonalność:**
  1. **Wybór budowy:** Select z wyszukiwarką aktywnych budów.
  2. **Pobieranie sprzętu na budowie:** Zapytanie do kolekcji `items`, filtrowanie `item.allocations && item.allocations[selectedSiteId] > 0`.
  3. **Wyświetlanie kart sprzętu:**
     - Nazwa, numer inwentarzowy, ilość na budowie.
     - Rozwijana lista osprzętu (`item.accessories`) z plakietką `⚠️ MUSI WRÓCIĆ`.
     - Checkboxy zdania sprzętu oraz zdania każdego elementu osprzętu.
  4. **Moduł nagrywania głosu (MediaRecorder API):**
     - Wielki, czytelny przycisk mikrofonu (Start / Stop).
     - Podgląd czasu nagrania (np. `00:24`).
     - Odsłuch nagrania przed wysłaniem.
  5. **Wysyłka szkicu:**
     - Upload pliku `.webm`/`.mp4` do Firebase Storage: `protocol_audio_notes/{siteId}_{timestamp}.webm`.
     - Zapis dokumentu w `protocols` ze statusem `DRAFT_DRIVER`.
     - Powrót do menu `/plac` z zielonym komunikatem sukcesu.

### Krok 2: Połączenie kafelka w menu głównym placu
- **Plik:** `src/app/plac/page.tsx`
- **Modyfikacja:** Zmiana akcji kafelka `Wypisz protokół` z pustego toastu na link do `/plac/protokol`.

### Krok 3: Panel Kierownika Budowy w ERP
- **Plik:** `src/app/(dashboard)/dashboard/protocols/page.tsx`
- **Funkcjonalność:**
  1. Dodanie zakładki lub filtru: `⚡ Szkice od kierowców (N)`.
  2. Kliknięcie w szkic otwiera modal zatwierdzenia:
     - Odtwarzacz audio (odsłuch głosu kierowcy).
     - Przycisk "🪄 Rozpoznaj resztki budowlane (AI)" – wysyła audio do `/api/parse-audio` i automatycznie wypełnia tabelę materiałów.
     - Weryfikacja listy sprzętu i osprzętu.
     - Przycisk "Zatwierdź zwrot i zdejmij ze stanu budowy".
     - Przycisk "Drukuj / Pobierz PDF".

---

## 4. Bezpieczeństwo i Praca w Terenie
- **Weryfikacja online:** Formularz wymaga połączenia z internetem do odczytania stanu budowy i wysyłki audio.
- **Kompresja audio:** Nagrywanie głosu w formacie Opus/WebM (bardzo mały rozmiar ~100-300 KB dla 1 minuty), co gwarantuje błyskawiczny upload nawet przy słabym zasięgu LTE/3G na budowie.
