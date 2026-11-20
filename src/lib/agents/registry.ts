// src/lib/agents/registry.ts
// Rejestr współpracowników AI zgodny ze standardem Google Agent-to-Agent (A2A)

export interface A2ASkill {
    id: string;
    name: string;
    description: string;
    parameters?: Record<string, any>;
}

export interface A2AAgentCard {
    id: string;
    name: string;
    description: string;
    version: string;
    endpoint: string; // URL do endpointu A2A JSON-RPC
    cardUrl: string; // URL do well-known agent card
    capabilities: {
        streaming: boolean;
        pushNotifications?: boolean;
    };
    skills: A2ASkill[];
    // Słowa kluczowe i przykłady dla Mózgu (Orchestratora) do szybkiego routingu intencji
    intentKeywords: string[];
    examplePrompts: string[];
}

export const PESAM_A2A_REGISTRY: A2AAgentCard[] = [
    {
        id: "expense",
        name: "PESAM Expense Agent",
        description: "Wyspecjalizowany agent do rejestracji i analizy wydatków, zakupów, paragonów, kosztów paliwa oraz napraw przypisanych do budów.",
        version: "1.0.0",
        endpoint: "/api/plac/agents/expense/a2a",
        cardUrl: "/api/plac/agents/expense/agent-card",
        capabilities: {
            streaming: false,
            pushNotifications: false
        },
        skills: [
            {
                id: "add_site_expense",
                name: "Dopisz wydatek do budowy",
                description: "Rejestruje nowy koszt w kolekcji site_expenses. Wymaga podania budowy, kwoty w PLN oraz tytułu/opisu zakupu.",
                parameters: {
                    siteNameOrId: { type: "string", required: true, description: "Nazwa lub identyfikator budowy" },
                    amount: { type: "number", required: true, description: "Kwota wydatku w PLN" },
                    title: { type: "string", required: true, description: "Tytuł lub przeznaczenie zakupu" },
                    category: { type: "string", required: false, description: "Kategoria: NAPRAWA, MATERIAL, TRANSPORT, NARZĘDZIA, PALIWO, INNE" }
                }
            },
            {
                id: "query_site_expenses",
                name: "Sprawdź wydatki budowy",
                description: "Podsumowuje ostatnie koszty zarejestrowane dla danej budowy.",
                parameters: {
                    siteNameOrId: { type: "string", required: true }
                }
            }
        ],
        intentKeywords: ["koszt", "wydatki", "wydatek", "dopisz", "zakup", "paragon", "paliwo", "faktura", "zł", "złotych", "zapłaciłem", "kupiłem"],
        examplePrompts: [
            "Dopisz do kosztów budowy Tuchów 20 zł",
            "Kupiłem paliwo do zagęszczarki za 50 zł na Wielickiej",
            "Zapisz wydatek 35 zł na śruby dla budowy CZP"
        ]
    },
    {
        id: "equipment",
        name: "PESAM Equipment & Warehouse Agent",
        description: "Agent odpowiedzialny za zarządzanie stanami magazynowymi, lokalizację narzędzi i maszyn, weryfikację numerów magazynowych oraz alokację sprzętu między budowami a magazynem.",
        version: "1.0.0",
        endpoint: "/api/plac/agents/equipment/a2a",
        cardUrl: "/api/plac/agents/equipment/agent-card",
        capabilities: {
            streaming: false,
            pushNotifications: false
        },
        skills: [
            {
                id: "query_equipment_location",
                name: "Zlokalizuj sprzęt",
                description: "Sprawdza na której budowie lub na magazynie znajduje się dany sprzęt po nazwie lub numerze magazynowym.",
                parameters: {
                    searchTerm: { type: "string", required: true, description: "Nazwa narzędzia lub numer magazynowy" },
                    location: { type: "string", required: false, description: "Opcjonalna lokalizacja do zawężenia: MAGAZYN lub nazwa budowy" }
                }
            },
            {
                id: "check_equipment_availability",
                name: "Sprawdź dostępność na magazynie",
                description: "Sprawdza ile sprawnych sztuk danego asortymentu jest obecnie wolnych na magazynie głównym.",
                parameters: {
                    categoryOrName: { type: "string", required: true }
                }
            }
        ],
        intentKeywords: ["sprzęt", "narzędzia", "wiertarka", "młotowiertarka", "agregat", "zagęszczarka", "szlifierka", "magazyn", "gdzie jest", "mamy wolne", "stan sprzętu", "nr mag"],
        examplePrompts: [
            "Gdzie jest młotowiertarka nr 61?",
            "Jakie wiertarki mamy na budowie Tuchów?",
            "Czy na magazynie jest wolna zagęszczarka?"
        ]
    },
    {
        id: "orders",
        name: "PESAM Orders & Dispatch Agent",
        description: "Agent sprawdzający dzisiejsze zlecenia, zapotrzebowania budów i materiały przygotowane do transportu przez kierowców.",
        version: "1.0.0",
        endpoint: "/api/plac/agents/orders/a2a",
        cardUrl: "/api/plac/agents/orders/agent-card",
        capabilities: {
            streaming: false,
            pushNotifications: false
        },
        skills: [
            {
                id: "get_today_orders",
                name: "Dzisiejsze zamówienia",
                description: "Pobiera listę zamówień i kompletacji na dzisiejszy dzień z możliwością filtracji po budowie.",
                parameters: {
                    siteNameOrId: { type: "string", required: false }
                }
            }
        ],
        intentKeywords: ["zamówienia", "zamówienie", "co jedzie", "wyjazd", "transport", "kierowca", "dzisiejsze zlecenia", "załadunek"],
        examplePrompts: [
            "Co dzisiaj jedzie na Tuchów?",
            "Jakie mamy zamówienia na dziś?",
            "Czy zamówienie na Wielicką jest gotowe?"
        ]
    }
];

// Pomocnik do formatowania listy współpracowników dla Mózgu (System Prompt)
export function getAgentsDescriptionForOrchestrator(): string {
    return PESAM_A2A_REGISTRY.map(agent => `
- AGENT ID: "${agent.id}" (${agent.name})
  OPIS: ${agent.description}
  ENDPOINT A2A: ${agent.endpoint}
  UMIEJĘTNOŚCI:
${agent.skills.map(s => `    * ${s.id}: ${s.description}`).join("\n")}
  SŁOWA KLUCZOWE: ${agent.intentKeywords.join(", ")}
  PRZYKŁADY: ${agent.examplePrompts.map(p => `"${p}"`).join(", ")}
`).join("\n");
}
