# Baza wskaźników CO2 – moduł zwrotów resztek budowlanych (magazyn)

Wersja 0.1, utworzona 2026-10-21. Plik opisuje bazę wskaźników i zasady jej rozbudowy. Dane maszynowe: `baza_wskaznikow_co2.json` (ten sam zestaw wartości).

## Dla agenta AI: jak korzystać z tej bazy

1. Przed użyciem jakiegokolwiek wskaźnika sprawdź jego `status`. Tylko `zrodlo_pierwotne` jest pewne; `zrodlo_wtorne_do_weryfikacji`, `zalozenie` i `do_uzupelnienia` oznacz w wyniku obliczenia.
2. Nigdy nie wymyślaj wartości. Brak danych = zwróć "brak danych" i opisz, gdzie szukałeś.
3. Źródła tylko publiczne, bez rejestracji, logowania i opłat. Pomiń źródło, które tego wymaga.
4. Każdy wynik zapisuj z użytymi wskaźnikami (id, wartość, źródło, rok, status) i założeniami.

## Wzory

```
wskaźnik_ON [kg CO2/l] = WO [MJ/kg] × WE [kg CO2/GJ] / 1000 × gęstość [kg/l]
E_kurs [kg CO2]       = dystans_całkowity [km] × zużycie [l/100 km] / 100 × wskaźnik_ON
dystans_całkowity     = mnożnik_trasy × dystans_w_jedną_stronę
E_zwrotu              = E_kurs × (masa_zwrotu / masa_ładunku)   (alokacja wg masy)
E_utylizacji [kg]     = masa [t] × wskaźnik_utylizacji [kg CO2e/t]
E_transport_utyl      = jak E_kurs (własny pojazd) albo masa[t] × dystans[km] × tkm (zewnętrzny)
E_łączna              = E_zwrotu + E_transport_utyl + E_utylizacji (+ E_produkcji opcjonalnie)
```

## Parametry globalne

| id | wartość | jednostka | status | uwagi |
|---|---|---|---|---|
| dystans_domyslny_km | 100 | km (w jedną stronę) | zalozenie | Zakładany promień zwrotu. Gdy znamy adres budowy, użyć realnego dystansu. |
| mnoznik_trasy | 2 | - | zalozenie | Kurs tam i z powrotem (dystans całkowity = 2 × dystans w jedną stronę). |
| metoda_alokacji | masa | - | zalozenie | Emisja kursu dzielona proporcjonalnie do masy ładunku; 100% gdy auto jedzie tylko po zwrot. Do ustalenia z osobą odpowiedzialną za ESG. |

## Paliwa (KOBiZE, tabela 16)

| id | WO [MJ/kg] | WE [kg CO2/GJ] | kg CO2/kg | gęstość [kg/l] | kg CO2/l | status |
|---|---|---|---|---|---|---|
| olej_napedowy | 43.0 | 74.1 | 3.1863 | 0.835 (zalozenie) | 2.661 | zrodlo_pierwotne |
| benzyna_silnikowa | 44.3 | 69.3 | 3.07 | — (do_uzupelnienia) | — | zrodlo_pierwotne |
| gaz_ciekly | 47.3 | 63.1 | 2.9846 | — (do_uzupelnienia) | — | zrodlo_pierwotne |

Źródło: [KOBiZE – WO i WE do monitorowania ETS 2026](https://www.kobize.pl/uploads/materialy/materialy_do_pobrania/aktualnosci/2025/135.WO_i_WE_do_monitorowania_ETS_2026.pdf). Rok danych odczytać z dokumentu. Gęstość oleju napędowego to założenie do potwierdzenia.

## Energia elektryczna (na przyszłość)

| id | wartość | jednostka | status |
|---|---|---|---|
| ee_odbiorca_koncowy | 553 | kg CO2/MWh | zrodlo_pierwotne |
| ee_produkcja_spalanie | 717 | kg CO2/MWh | zrodlo_pierwotne |

Źródło: [KOBiZE – Wskaźniki emisyjności (2025)](https://www.kobize.pl/uploads/materialy/materialy_do_pobrania/aktualnosci/2025/142_Wskazniki_emisyjnosci_2025.pdf).

## Utylizacja odpadów budowlanych (DEFRA 2025)

| id | nazwa | kg CO2e/t | metoda | status |
|---|---|---|---|---|
| util_budowlane_zamknieta_petla | Odpady budowlane – recykling (closed-loop) | 1.008 | recykling_closed_loop | zrodlo_wtorne_do_weryfikacji |
| util_budowlane_otwarta_petla | Odpady budowlane – recykling (open-loop) | 1.00835 | recykling_open_loop | zrodlo_wtorne_do_weryfikacji |
| util_beton_otwarta_petla | Odpady betonowe – recykling (open-loop) | 1.00835 | recykling_open_loop | zrodlo_wtorne_do_weryfikacji |
| util_kruszywa_otwarta_petla | Kruszywa – recykling (open-loop) | 1.00835 | recykling_open_loop | zrodlo_wtorne_do_weryfikacji |
| util_kruszywa_skladowisko | Kruszywa – składowisko | 1.26338 | skladowisko | zrodlo_wtorne_do_weryfikacji |
| util_beton_skladowisko | Odpady betonowe – składowisko | 1.26338 | skladowisko | zrodlo_wtorne_do_weryfikacji |
| util_budowlane_spalanie | Odpady budowlane – spalanie z odzyskiem energii | 4.68568 | spalanie_z_odzyskiem | zrodlo_wtorne_do_weryfikacji |
| util_drewno_skladowisko | Odpady drzewne – składowisko | 925.34348 | skladowisko | zrodlo_wtorne_do_weryfikacji |

Wartości odczytane z kopii DEFRA 2025 w katalogu Climatiq (źródło wtórne). Do weryfikacji w oryginalnym pliku DEFRA (Excel, gov.uk).

## Do uzupełnienia

| element | gdzie szukać |
|---|---|
| Średnie zużycie paliwa Iveco ≤3,5 t | dane własne firmy (karty paliwowe, przebiegi) |
| Gęstość oleju napędowego | norma na olej napędowy lub dokument dostawcy paliwa |
| Wskaźnik tkm dla ciężarówki (transport zewn.) | ÖKOBAUDAT (API soda4LCA) lub DEFRA Freight (HGV) |
| Masa jednostkowa i kod odpadu produktu | karta techniczna, kartoteka, odbiorca odpadów |
| GWP A1–A3 kleju Atlas (opcjonalnie) | EPD producenta / ITB / Environdec / ÖKOBAUDAT |
| Wskaźnik utylizacji opakowania papierowego | DEFRA (Waste disposal) lub ÖKOBAUDAT |

## Uwagi metodyczne

- Utylizacja kruszyw/betonów/kleju mineralnego daje wskaźniki rzędu 1 kg CO2e/t, czyli dla 50 kg odpadu ok. 0,05 kg CO2e. Dominuje transport, nie sama utylizacja.
- Nie wiadomo, czy wskaźniki utylizacji DEFRA obejmują dowóz odpadu do instalacji. Założenie robocze: nie obejmują, więc etap 2 (transport na utylizację) liczymy osobno. Sprawdzić w metodyce DEFRA.
- Opakowania (worek papierowy) mają osobny strumień odpadu; wskaźnik do uzupełnienia.

## Zasady rozbudowy bazy

Nowy wskaźnik dodajemy jako osobny wpis z polami: `id`, `nazwa`, `wartosc`, `jednostka`, `zrodlo`, `url`, `rok`, `data_pobrania`, `status`, `uwagi`. Stare wartości nie są nadpisywane: nowy rok = nowy wpis (wersjonowanie), żeby dawne obliczenia dało się odtworzyć. Nowe kategorie (np. kolejne produkty, energia na budowach, woda) dodajemy jako kolejne sekcje w tym samym formacie.
