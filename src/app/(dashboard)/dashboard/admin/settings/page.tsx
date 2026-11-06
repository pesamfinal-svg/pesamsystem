"use client";

import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";

interface SystemSettings {
    orderEmailRecipients: string[]; // Lista maili do sklepu
    clsDirectorEmail: string; // Mail Dyrektora do powiadomień CLS
    clsBossEmail: string; // Mail Szefa do powiadomień CLS
    closeoutEmailRecipients: string[]; // Lista maili do raportów zamknięcia budów w trybie sandbox
    closeoutDirectorEmail?: string; // Dedykowany mail Dyrektora do zamknięć budów
    closeoutBossEmail?: string; // Dedykowany mail Szefa/Prezesa do zamknięć budów
    closeoutAdditionalEmails?: string[]; // Dodatkowi odbiorcy raportu końcowego
    notifyDirectorOnInitiate?: boolean; // Czy wysyłać raport już przy inicjacji
    isCloseoutSandboxMode: boolean; // Przełącznik trybu testowego
    residualAlertRecipients: string[]; // Lista maili do alertów o naruszeniu reguł zwrotu AI
    capacityAlertRecipients?: string[]; // Lista maili do alertów o zapełnieniu stref magazynowych (JPP)
}

export default function SettingsPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [settings, setSettings] = useState<SystemSettings>({
        orderEmailRecipients: [],
        clsDirectorEmail: "",
        clsBossEmail: "",
        closeoutEmailRecipients: [],
        closeoutDirectorEmail: "",
        closeoutBossEmail: "",
        closeoutAdditionalEmails: [],
        notifyDirectorOnInitiate: false,
        isCloseoutSandboxMode: true, // Domyślnie włączony dla bezpieczeństwa testów
        residualAlertRecipients: [],
        capacityAlertRecipients: []
    });
    const [newEmail, setNewEmail] = useState("");
    const [newCloseoutEmail, setNewCloseoutEmail] = useState("");
    const [newCloseoutAdditionalEmail, setNewCloseoutAdditionalEmail] = useState("");
    const [newResidualAlertEmail, setNewResidualAlertEmail] = useState("");
    const [newCapacityAlertEmail, setNewCapacityAlertEmail] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const canManageSettings = user ? hasPermission("manageSettings", user.rolePermissions, user.permissionOverrides) : false;

    useEffect(() => {
        if (user && !canManageSettings) {
            alert("Brak uprawnień do edycji ustawień systemu.");
            router.push("/dashboard");
        }
    }, [user, canManageSettings, router]);

    useEffect(() => {
        const fetchSettings = async () => {
            setLoading(true);
            try {
                const docSnap = await getDoc(doc(db, "settings", "system"));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    setSettings({
                        orderEmailRecipients: data.orderEmailRecipients || [],
                        clsDirectorEmail: data.clsDirectorEmail || "",
                        clsBossEmail: data.clsBossEmail || "",
                        closeoutEmailRecipients: data.closeoutEmailRecipients || [],
                        closeoutDirectorEmail: data.closeoutDirectorEmail || "",
                        closeoutBossEmail: data.closeoutBossEmail || "",
                        closeoutAdditionalEmails: data.closeoutAdditionalEmails || [],
                        notifyDirectorOnInitiate: data.notifyDirectorOnInitiate || false,
                        isCloseoutSandboxMode: data.isCloseoutSandboxMode !== undefined ? data.isCloseoutSandboxMode : true,
                        residualAlertRecipients: data.residualAlertRecipients || [],
                        capacityAlertRecipients: data.capacityAlertRecipients || []
                    });
                }
            } catch (e) {
                console.error("Błąd pobierania ustawień:", e);
            } finally {
                setLoading(false);
            }
        };

        if (user && canManageSettings) fetchSettings();
    }, [user, canManageSettings]);

    const handleAddEmail = (e: React.FormEvent) => {
        e.preventDefault();
        const email = newEmail.trim().toLowerCase();
        if (!email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");
        if (settings.orderEmailRecipients.includes(email)) return alert("Ten e-mail jest już na liście!");

        setSettings(prev => ({ ...prev, orderEmailRecipients: [...prev.orderEmailRecipients, email] }));
        setNewEmail("");
    };

    const handleAddCloseoutEmail = (e: React.FormEvent) => {
        e.preventDefault();
        const email = newCloseoutEmail.trim().toLowerCase();
        if (!email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");
        if (settings.closeoutEmailRecipients.includes(email)) return alert("Ten e-mail jest już na liście!");

        setSettings(prev => ({ ...prev, closeoutEmailRecipients: [...prev.closeoutEmailRecipients, email] }));
        setNewCloseoutEmail("");
    };

    const handleRemoveEmail = (emailToRemove: string) => {
        setSettings(prev => ({ ...prev, orderEmailRecipients: prev.orderEmailRecipients.filter(email => email !== emailToRemove) }));
    };

    const handleRemoveCloseoutEmail = (emailToRemove: string) => {
        setSettings(prev => ({ ...prev, closeoutEmailRecipients: prev.closeoutEmailRecipients.filter(email => email !== emailToRemove) }));
    };

    const handleAddCloseoutAdditionalEmail = (e: React.FormEvent) => {
        e.preventDefault();
        const email = newCloseoutAdditionalEmail.trim().toLowerCase();
        if (!email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");
        if (settings.closeoutAdditionalEmails?.includes(email)) return alert("Ten e-mail jest już na liście!");

        setSettings(prev => ({ ...prev, closeoutAdditionalEmails: [...(prev.closeoutAdditionalEmails || []), email] }));
        setNewCloseoutAdditionalEmail("");
    };

    const handleRemoveCloseoutAdditionalEmail = (emailToRemove: string) => {
        setSettings(prev => ({ ...prev, closeoutAdditionalEmails: (prev.closeoutAdditionalEmails || []).filter(email => email !== emailToRemove) }));
    };

    const handleAddResidualAlertEmail = (e: React.FormEvent) => {
        e.preventDefault();
        const email = newResidualAlertEmail.trim().toLowerCase();
        if (!email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");
        if (settings.residualAlertRecipients?.includes(email)) return alert("Ten e-mail jest już na liście!");

        setSettings(prev => ({ ...prev, residualAlertRecipients: [...(prev.residualAlertRecipients || []), email] }));
        setNewResidualAlertEmail("");
    };

    const handleRemoveResidualAlertEmail = (emailToRemove: string) => {
        setSettings(prev => ({ ...prev, residualAlertRecipients: (prev.residualAlertRecipients || []).filter(email => email !== emailToRemove) }));
    };

    const handleAddCapacityAlertEmail = (e: React.FormEvent) => {
        e.preventDefault();
        const email = newCapacityAlertEmail.trim().toLowerCase();
        if (!email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");
        if (settings.capacityAlertRecipients?.includes(email)) return alert("Ten e-mail jest już na liście!");

        setSettings(prev => ({ ...prev, capacityAlertRecipients: [...(prev.capacityAlertRecipients || []), email] }));
        setNewCapacityAlertEmail("");
    };

    const handleRemoveCapacityAlertEmail = (emailToRemove: string) => {
        setSettings(prev => ({ ...prev, capacityAlertRecipients: (prev.capacityAlertRecipients || []).filter(email => email !== emailToRemove) }));
    };

    const handleSaveSettings = async () => {
        setSaving(true);
        try {
            await setDoc(doc(db, "settings", "system"), settings);
            alert("✅ Ustawienia systemu zostały pomyślnie zapisane w bazie!");
        } catch (e: any) {
            alert("Błąd zapisu: " + e.message);
        } finally {
            setSaving(false);
        }
    };

    if (!canManageSettings) return null;
    if (loading) return <div className="p-10 text-center animate-pulse text-slate-500 italic">Wczytywanie konfiguracji systemu...</div>;

    return (
        <div className="p-6 md:p-10 max-w-3xl mx-auto space-y-8 animate-fade-in">
            <div className="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
                <div className="p-6 bg-slate-900 text-white flex items-center gap-4">
                    <span className="text-3xl">⚙️</span>
                    <div>
                        <h1 className="text-2xl font-black tracking-tight uppercase italic">Ustawienia Globalne Systemu PESAM</h1>
                        <p className="text-xs text-slate-400 mt-1">Konfiguracja skrzynek e-mail dla zamówień sklepowych oraz powiadomień sądowych CLS.</p>
                    </div>
                </div>

                <div className="p-8 space-y-8">
                    {/* SEKCJA 1: SKLEP */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider border-b pb-2">🛒 Lista adresatów zamówień ze Sklepu (WZ)</h3>
                        <form onSubmit={handleAddEmail} className="flex gap-3">
                            <input type="text" placeholder="np. ksiegowa@pesam.pl" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-blue-500 font-bold bg-slate-50" />
                            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition">+ Dodaj do listy</button>
                        </form>
                        <div className="flex flex-wrap gap-2 pt-2">
                            {settings.orderEmailRecipients.map(email => (
                                <span key={email} className="bg-blue-50 text-blue-800 border border-blue-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm">
                                    {email}
                                    <button type="button" onClick={() => handleRemoveEmail(email)} className="text-red-500 hover:text-red-700 text-sm font-black">&times;</button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* SEKCJA ROZLICZEŃ BUDÓW */}
                    <div className="space-y-6 pt-6 border-t">
                        <div className="border-b pb-2 flex items-center justify-between">
                            <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center gap-2">
                                <span>🏁</span> Raporty Zamknięcia i Rozliczenia Budów
                            </h3>
                            <span className="text-[10px] bg-blue-100 text-blue-800 font-bold px-2 py-0.5 rounded-full">
                                Obieg Zarządu i Dyrekcji
                            </span>
                        </div>

                        {/* OSOBY UPRAWNIONE DO ZAMKNIĘCIA: DYREKTOR I PREZES */}
                        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
                            <h4 className="text-xs font-black text-slate-700 uppercase tracking-wide flex items-center gap-2">
                                <span>👤</span> Uprawnieni do zamykania budów (Dyrektor / Prezes)
                            </h4>
                            <p className="text-[11px] text-slate-500 leading-relaxed">
                                Na te adresy system prześle raport ubytków oraz <b>wezwanie z prośbą o zalogowanie się na swoje konto PESAM</b> w celu ostatecznej autoryzacji i zamknięcia budowy w zakładce <i>Zatwierdzanie Zamknięć</i>.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                                        Adres E-mail Dyrektora (ds. Realizacji)
                                    </label>
                                    <input
                                        type="email"
                                        placeholder="np. dyrektor@pesam.pl"
                                        value={settings.closeoutDirectorEmail || ""}
                                        onChange={e => setSettings({ ...settings, closeoutDirectorEmail: e.target.value })}
                                        className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-white outline-none focus:border-blue-500 shadow-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                                        Adres E-mail Prezesa Zarządu / Szefa
                                    </label>
                                    <input
                                        type="email"
                                        placeholder="np. prezes@pesam.pl"
                                        value={settings.closeoutBossEmail || ""}
                                        onChange={e => setSettings({ ...settings, closeoutBossEmail: e.target.value })}
                                        className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-white outline-none focus:border-blue-500 shadow-sm"
                                    />
                                </div>
                            </div>

                            <label className="flex items-center gap-3 cursor-pointer pt-2">
                                <input
                                    type="checkbox"
                                    checked={settings.notifyDirectorOnInitiate || false}
                                    onChange={e => setSettings({ ...settings, notifyDirectorOnInitiate: e.target.checked })}
                                    className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                                />
                                <span className="text-xs font-bold text-slate-700">
                                    Wyślij e-mail informacyjny do Dyrekcji/Prezesa już przy <b>zainicjowaniu audytu</b> przez magazyniera (zanim kierownik podpisze)
                                </span>
                            </label>
                        </div>

                        {/* DODATKOWI ODBIORCY RAPORTU KOŃCOWEGO (NP. CONTROLLING / KSIĘGOWOŚĆ) */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-black text-slate-700 uppercase tracking-wide">
                                📋 Dodatkowi odbiorcy raportu rozliczenia (np. Controlling / Księgowość)
                            </h4>
                            <p className="text-[11px] text-slate-500">
                                Osoby z tej listy otrzymają kopię oficjalnego raportu finansowego po zamknięciu budowy.
                            </p>
                            <form onSubmit={handleAddCloseoutAdditionalEmail} className="flex gap-3">
                                <input
                                    type="text"
                                    placeholder="np. ksiegowosc@pesam.pl lub controlling@pesam.pl"
                                    value={newCloseoutAdditionalEmail}
                                    onChange={e => setNewCloseoutAdditionalEmail(e.target.value)}
                                    className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-blue-500 font-bold bg-slate-50"
                                />
                                <button
                                    type="submit"
                                    className="bg-slate-800 hover:bg-slate-900 text-white font-black text-xs px-6 rounded-xl shadow-md transition"
                                >
                                    + Dodaj do raportów
                                </button>
                            </form>
                            <div className="flex flex-wrap gap-2 pt-1">
                                {(settings.closeoutAdditionalEmails || []).map(email => (
                                    <span key={email} className="bg-slate-100 text-slate-800 border border-slate-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm">
                                        {email}
                                        <button type="button" onClick={() => handleRemoveCloseoutAdditionalEmail(email)} className="text-red-500 hover:text-red-700 text-sm font-black">&times;</button>
                                    </span>
                                ))}
                                {(!settings.closeoutAdditionalEmails || settings.closeoutAdditionalEmails.length === 0) && (
                                    <p className="text-xs text-slate-400 italic">Brak dodatkowych odbiorców raportu.</p>
                                )}
                            </div>
                        </div>

                        {/* PRZEŁĄCZNIK TRYBU TESTOWEGO (SANDBOX) */}
                        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 space-y-3 shadow-sm">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={settings.isCloseoutSandboxMode}
                                    onChange={e => setSettings({ ...settings, isCloseoutSandboxMode: e.target.checked })}
                                    className="w-5 h-5 text-orange-600 rounded border-orange-300 focus:ring-orange-500 cursor-pointer"
                                />
                                <span className="text-xs font-black text-orange-950 uppercase tracking-wide">
                                    🧪 Włącz Tryb Testowy (Sandbox) dla Rozliczeń Budów
                                </span>
                            </label>
                            <p className="text-[11px] text-orange-800 leading-relaxed">
                                <b>Aktywny tryb testowy:</b> Wszystkie maile i powiadomienia kierowane do Kierowników, Dyrekcji i Prezesa będą bezpiecznie przekierowywane na poniższą listę e-maili testowych. Wyłącz przed oddaniem na produkcję.
                            </p>
                        </div>

                        <p className="text-xs text-slate-500 pt-1">Adresy e-mail do testów (Sandbox):</p>
                        <form onSubmit={handleAddCloseoutEmail} className="flex gap-3">
                            <input type="text" placeholder="np. moj-testowy-email@pesam.pl" value={newCloseoutEmail} onChange={e => setNewCloseoutEmail(e.target.value)} className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-blue-500 font-bold bg-slate-50" />
                            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition">+ Dodaj do listy testowej</button>
                        </form>
                        <div className="flex flex-wrap gap-2 pt-1">
                            {settings.closeoutEmailRecipients.map(email => (
                                <span key={email} className="bg-orange-50 text-orange-900 border border-orange-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm">
                                    {email}
                                    <button type="button" onClick={() => handleRemoveCloseoutEmail(email)} className="text-red-500 hover:text-red-700 text-sm font-black">&times;</button>
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* NOWOŚĆ: SEKCJA POWIADOMIEŃ O NARUSZENIACH REGUŁ ZWROTÓW (AI RESZTKI) */}
                    <div className="space-y-4 pt-6 border-t">
                        <div className="border-b pb-2 flex items-center justify-between">
                            <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center gap-2">
                                <span>🚨</span> Powiadomienia o naruszeniach reguł zwrotu (AI Resztki)
                            </h3>
                            <span className="text-[10px] bg-red-100 text-red-800 font-bold px-2 py-0.5 rounded-full">
                                Alert e-mail
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed">
                            Adresy e-mail, na które system wyśle natychmiastowe powiadomienie, gdy kierowca w nagraniu lub zwrocie przekaże pozycje <b>łamiące reguły Szefa/Dyrekcji lub Magazynu</b> (np. otwarte worki powyżej 30 dni, odrzucone odpady, brak etykiet).
                        </p>
                        <form onSubmit={handleAddResidualAlertEmail} className="flex gap-3">
                            <input
                                type="text"
                                placeholder="np. szef@pesam.pl lub magazyn@pesam.pl"
                                value={newResidualAlertEmail}
                                onChange={e => setNewResidualAlertEmail(e.target.value)}
                                className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-red-500 font-bold bg-slate-50"
                            />
                            <button
                                type="submit"
                                className="bg-red-600 hover:bg-red-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition"
                            >
                                + Dodaj do listy
                            </button>
                        </form>
                        <div className="flex flex-wrap gap-2 pt-2">
                            {(settings.residualAlertRecipients || []).map(email => (
                                <span
                                    key={email}
                                    className="bg-red-50 text-red-800 border border-red-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm"
                                >
                                    {email}
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveResidualAlertEmail(email)}
                                        className="text-red-500 hover:text-red-700 text-sm font-black"
                                    >
                                        &times;
                                    </button>
                                </span>
                            ))}
                            {(!settings.residualAlertRecipients || settings.residualAlertRecipients.length === 0) && (
                                <p className="text-xs text-slate-400 italic">Brak zdefiniowanych odbiorców alertów o naruszeniach reguł.</p>
                            )}
                        </div>
                    </div>

                    {/* NOWOŚĆ: SEKCJA POWIADOMIEŃ O ZAPEŁNIENIU STREF MAGAZYNOWYCH (JPP / PLAC / HALE) */}
                    <div className="space-y-4 pt-6 border-t">
                        <div className="border-b pb-2 flex items-center justify-between">
                            <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center gap-2">
                                <span>📍</span> Powiadomienia o zapełnieniu stref magazynowych (JPP / Plac / Hale)
                            </h3>
                            <span className="text-[10px] bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full">
                                Alert e-mail
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed">
                            Adresy e-mail, na które system wyśle natychmiastowe ostrzeżenie, gdy którekolwiek <b>miejsce składowania (np. Plac Zewnętrzny, Magazyn Farb i Chemii)</b> osiągnie próg ostrzegawczy (np. 70%) lub próg krytyczny (np. 85%).
                        </p>
                        <form onSubmit={handleAddCapacityAlertEmail} className="flex gap-3">
                            <input
                                type="text"
                                placeholder="np. magazyn@pesam.pl lub kierownik@pesam.pl"
                                value={newCapacityAlertEmail}
                                onChange={e => setNewCapacityAlertEmail(e.target.value)}
                                className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-amber-500 font-bold bg-slate-50"
                            />
                            <button
                                type="submit"
                                className="bg-amber-600 hover:bg-amber-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition"
                            >
                                + Dodaj do listy
                            </button>
                        </form>
                        <div className="flex flex-wrap gap-2 pt-2">
                            {(settings.capacityAlertRecipients || []).map(email => (
                                <span
                                    key={email}
                                    className="bg-amber-50 text-amber-900 border border-amber-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm"
                                >
                                    {email}
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveCapacityAlertEmail(email)}
                                        className="text-red-500 hover:text-red-700 text-sm font-black"
                                    >
                                        &times;
                                    </button>
                                </span>
                            ))}
                            {(!settings.capacityAlertRecipients || settings.capacityAlertRecipients.length === 0) && (
                                <p className="text-xs text-slate-400 italic">Brak zdefiniowanych odbiorców alertów o zapełnieniu stref magazynowych.</p>
                            )}
                        </div>
                    </div>

                    {/* SEKCJA SĄD */}
                    <div className="space-y-4 pt-6 border-t">
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider border-b pb-2">⚖️ Powiadomienia Sądowe CLS</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Adres e-mail Dyrektora (I Instancja)</label>
                                <input type="email" required placeholder="np. dyrektor@pesam.pl" value={settings.clsDirectorEmail} onChange={e => setSettings({ ...settings, clsDirectorEmail: e.target.value })} className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-slate-50 outline-none focus:border-purple-500" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Adres e-mail Szefa (Ostateczny wyrok)</label>
                                <input type="email" required placeholder="np. szef@pesam.pl" value={settings.clsBossEmail} onChange={e => setSettings({ ...settings, clsBossEmail: e.target.value })} className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-slate-50 outline-none focus:border-purple-500" />
                            </div>
                        </div>
                    </div>

                    <div className="pt-6 border-t flex justify-end">
                        <button onClick={handleSaveSettings} disabled={saving} className="w-1/2 py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-2xl shadow-xl transition disabled:opacity-50 uppercase tracking-widest text-xs">
                            {saving ? "Zapisywanie..." : "Zapisz Ustawienia Systemu"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}