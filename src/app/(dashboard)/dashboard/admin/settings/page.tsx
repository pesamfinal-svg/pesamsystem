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
    closeoutEmailRecipients: string[]; // Lista maili do raportów zamknięcia budów
    isCloseoutSandboxMode: boolean; // NOWOŚĆ: Przełącznik trybu testowego
}

export default function SettingsPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [settings, setSettings] = useState<SystemSettings>({
        orderEmailRecipients: [],
        clsDirectorEmail: "",
        clsBossEmail: "",
        closeoutEmailRecipients: [],
        isCloseoutSandboxMode: true // Domyślnie włączony dla bezpieczeństwa testów
    });
    const [newEmail, setNewEmail] = useState("");
    const [newCloseoutEmail, setNewCloseoutEmail] = useState("");
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
                        isCloseoutSandboxMode: data.isCloseoutSandboxMode !== undefined ? data.isCloseoutSandboxMode : true
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

                    {/* NOWOŚĆ: SEKCJA ROZLICZEŃ BUDÓW */}
                    <div className="space-y-4 pt-6 border-t">
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider border-b pb-2">🏁 Raporty Zamknięcia i Rozliczenia Budów</h3>

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
                                <b>Aktywny tryb testowy:</b> Wszystkie maile i PDF-y kierowane do konkretnych kierowników i dyrekcji będą bezpiecznie przekierowywane na Twoją listę e-maili testowych poniżej (Twoje skrzynki testowe). Wyłącz ten przełącznik przed oddaniem systemu do produkcji, aby maile leciały do prawdziwych kierowników.
                            </p>
                        </div>

                        <p className="text-xs text-slate-500 pt-2">Adresy e-mail do testów, na które system prześle powiadomienia i raporty PDF w trybie piaskownicy:</p>
                        <form onSubmit={handleAddCloseoutEmail} className="flex gap-3">
                            <input type="text" placeholder="np. moj-testowy-email@pesam.pl" value={newCloseoutEmail} onChange={e => setNewCloseoutEmail(e.target.value)} className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-blue-500 font-bold bg-slate-50" />
                            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition">+ Dodaj do listy</button>
                        </form>
                        <div className="flex flex-wrap gap-2 pt-2">
                            {settings.closeoutEmailRecipients.map(email => (
                                <span key={email} className="bg-blue-50 text-blue-800 border border-blue-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm">
                                    {email}
                                    <button type="button" onClick={() => handleRemoveCloseoutEmail(email)} className="text-red-500 hover:text-red-700 text-sm font-black">&times;</button>
                                </span>
                            ))}
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