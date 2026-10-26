// src/lib/constants/residualCategories.ts

export interface ResidualCategoryDef {
    id: string;
    name: string;
    icon: string;
    description: string;
    subcategories: string[];
}

export const RESIDUAL_MAIN_CATEGORIES: ResidualCategoryDef[] = [
    {
        id: "kleje",
        name: "Kleje i Zaprawy",
        icon: "🧪",
        description: "Kleje workowane, zaprawy murarskie, wylewki i kleje do ociepleń",
        subcategories: [
            "Klej do płytek",
            "Klej do siatki i styropianu",
            "Klej do wełny",
            "Zaprawa murarska",
            "Zaprawa tynkarska",
            "Wylewka samopoziomująca",
            "Klej gipsowy"
        ]
    },
    {
        id: "pustaki",
        name: "Pustaki, Bloczki i Cegły",
        icon: "🧱",
        description: "Elementy murowe, bloczki gazobetonowe, silikaty, cegły i nadproża",
        subcategories: [
            "Bloczek gazobeton / termobet",
            "Pustak ceramiczny (np. Porotherm)",
            "Bloczek betonowy fundamentowy",
            "Cegła klinkierowa",
            "Cegła pełna czerwona",
            "Silikat / bloczek wapienno-piaskowy"
        ]
    },
    {
        id: "plyty-gk",
        name: "Płyty GK i Profile",
        icon: "📄",
        description: "Płyty gipsowo-kartonowe, profile sufitowe i ścienne, wkręty montażowe",
        subcategories: [
            "Płyty GK standard (białe)",
            "Płyty GK impregnowane (zielone)",
            "Płyty GK ogniochronne (czerwone)",
            "Profile sufitowe CD60",
            "Profile przyścienne UD27",
            "Profile ścienne CW / UW",
            "Wkręty, wieszaki i łączniki GK"
        ]
    },
    {
        id: "farby-chemia",
        name: "Farby, Grunty i Chemia",
        icon: "🎨",
        description: "Farby podkładowe i nawierzchniowe, grunty, hydroizolacje, impregnaty",
        subcategories: [
            "Grunt uniwersalny / głęboko penetrujący",
            "Farba biała gruntująca / podkładowa",
            "Farba nawierzchniowa / lateksowa",
            "Folia w płynie / hydroizolacja 1K i 2K",
            "Impregnaty do drewna i betonu",
            "Rozpuszczalniki i zmywacze"
        ]
    },
    {
        id: "pianki-silikony",
        name: "Pianki, Silikony i Uszczelniacze",
        icon: "🧴",
        description: "Piany montażowe pistoletowe i wężykowe, silikony, akryle, kleje montażowe",
        subcategories: [
            "Piana montażowa pistoletowa",
            "Piana montażowa niskoprężna",
            "Silikon sanitarny / neutralny",
            "Akryl szpachlowy / malarski",
            "Klej montażowy (np. Mamut / Fix)",
            "Taśmy uszczelniające i dylatacyjne"
        ]
    },
    {
        id: "kable-elektryka",
        name: "Kable, Przewody i Elektryka",
        icon: "⚡",
        description: "Przewody instalacyjne, kable ziemne, bednarka, osprzęt elektroinstalacyjny",
        subcategories: [
            "Przewody instalacyjne YDY / YDYp",
            "Kable ziemne YKY",
            "Bednarka ocynkowana",
            "Peszle i rury osłonowe",
            "Puszki instalacyjne i rozdzielnice",
            "Złączki WAGO i końcówki kablowe"
        ]
    },
    {
        id: "gipsy-gladzie",
        name: "Gipsy i Gładzie",
        icon: "🪨",
        description: "Gładzie polimerowe, gipsy szpachlowe, tynki gipsowe maszynowe",
        subcategories: [
            "Gładź polimerowa gotowa (wiaderko)",
            "Gładź sypka / szpachlowa",
            "Gips budowlany",
            "Tynk gipsowy maszynowy (np. MP75)",
            "Narożniki aluminiowe i siatka zbrojąca"
        ]
    },
    {
        id: "izolacje-folie",
        name: "Izolacje i Folie",
        icon: "🛡️",
        description: "Wełny mineralne, styropiany, folie paroizolacyjne i fundamentowe",
        subcategories: [
            "Wełna mineralna / szklana w rolkach lub płytach",
            "Styropian fasadowy EPS",
            "Styropian podłogowy / XPS dachowy",
            "Folia paroizolacyjna żółta / aluminiowa",
            "Membrana dachowa / wiatroizolacja",
            "Folia kubełkowa fundamentowa"
        ]
    },
    {
        id: "szalunki",
        name: "Szalunki i Akcesoria Betoniarskie",
        icon: "🏗️",
        description: "Dystanse zbrojeniowe, rurki szalunkowe, konusy, korki betonowe, płyny",
        subcategories: [
            "Rurki szalunkowe dystansowe",
            "Konusy / stożki do rurek",
            "Korki betonowe wklejane",
            "Gwiazdki dystansowe do zbrojenia",
            "Listwy fazujące trójkątne",
            "Płyn antyadhezyjny do szalunków"
        ]
    },
    {
        id: "stal-ogrodzenia",
        name: "Stal, Zbrojenie i Ogrodzenia",
        icon: "🔩",
        description: "Pręty zbrojeniowe, drut wiązałkowy, siatki, panele tymczasowe",
        subcategories: [
            "Pręty zbrojeniowe żebrowane",
            "Drut wiązałkowy",
            "Siatka zbrojeniowa w matach",
            "Panele ogrodzeniowe tymczasowe / ażurowe",
            "Pręty gwintowane i kotwy chemiczne"
        ]
    },
    {
        id: "rury-kanalizacja",
        name: "Rury, Odwodnienia i Kanalizacja",
        icon: "💧",
        description: "Rury kanalizacyjne PVC/PP, dreny, rury wodne PEX/PE, kształtki",
        subcategories: [
            "Rury kanalizacyjne PVC pomarańczowe (zewnętrzne)",
            "Rury kanalizacyjne PP szare (wewnętrzne)",
            "Kształtki, kolana, trójniki i redukcje",
            "Rury drenarskie z otuliną",
            "Rury wielowarstwowe PEX / PE do wody"
        ]
    },
    {
        id: "drewno-odpady",
        name: "Inne Materiały, Drewno i Odpady",
        icon: "📦",
        description: "Drewno szalunkowe, europalety, worki Big-Bag, plandeki, odpady do recyklingu",
        subcategories: [
            "Deski szalunkowe i kantówki",
            "Europalety i palety przemysłowe",
            "Worki Big-Bag na gruz",
            "Plandeki ochronne",
            "Czysty złom stalowy / miedziany"
        ]
    }
];

export interface ResidualRulesDocument {
    // Sekcja główna dla działu
    scope?: "RESIDUALS" | "EQUIPMENT" | "SCAFFOLDING" | "FLEET";
    
    // Reguły ogólne
    bossRules?: string;
    warehouseRules?: string;
    bossUpdatedAt?: string;
    bossUpdatedBy?: string;
    warehouseUpdatedAt?: string;
    warehouseUpdatedBy?: string;

    // Reguły per kategoria (klucz to id kategorii, np. "kleje", "pustaki")
    bossCategoryRules?: Record<string, string>;
    warehouseCategoryRules?: Record<string, string>;
}
