// src/app/(dashboard)/dashboard/admin/settings/page.tsx
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
}

export default function SettingsPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [settings, setSettings] = useState<SystemSettings>({
        orderEmailRecipients: [],
        clsDirectorEmail: "",
        clsBossEmail: ""
    });
    const [newEmail, setNewEmail] = useState("");
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
                        clsBossEmail: data.clsBossEmail || ""
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

        // Walidacja formatu e-mail
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Wprowadź poprawny adres e-mail!");

        if (settings.orderEmailRecipients.includes(email)) {
            return alert("Ten e-mail jest już na liście!");
        }

        setSettings(prev => ({
            ...prev,
            orderEmailRecipients: [...prev.orderEmailRecipients, email]
        }));
        setNewEmail("");
    };

    const handleRemoveEmail = (emailToRemove: string) => {
        setSettings(prev => ({
            ...prev,
            orderEmailRecipients: prev.orderEmailRecipients.filter(email => email !== emailToRemove)
        }));
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

    // --- POPRAWIONA LINIA: canManageSettings zamiast canManageRoles ---
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
                    {/* SEKCJA 1: SKLEP (ADRESACI ZAMÓWIEŃ) */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider border-b pb-2">🛒 Lista adresatów zamówień ze Sklepu (WZ)</h3>
                        <p className="text-xs text-slate-500">System wyśle wygenerowany protokół PDF do każdego użytkownika z poniższej listy (np. Magazyn Główny, Biuro, Księgowość).</p>

                        {/* Dodawanie maila */}
                        <form onSubmit={handleAddEmail} className="flex gap-3">
                            <input
                                type="text"
                                placeholder="np. ksiegowa@pesam.pl"
                                value={newEmail}
                                onChange={e => setNewEmail(e.target.value)}
                                className="flex-1 p-3 border-2 rounded-xl text-sm outline-none focus:border-blue-500 font-bold bg-slate-50"
                            />
                            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-black text-xs px-6 rounded-xl shadow-md transition">
                                + Dodaj do listy
                            </button>
                        </form>

                        {/* Lista maili w postaci tagów */}
                        <div className="flex flex-wrap gap-2 pt-2">
                            {settings.orderEmailRecipients.length === 0 ? (
                                <span className="text-xs text-red-500 italic font-bold">⚠️ Brak zdefiniowanych adresów. Zamówienia będą wysyłane na domyślny e-mail z pliku konfiguracyjnego (.env).</span>
                            ) : (
                                settings.orderEmailRecipients.map(email => (
                                    <span key={email} className="bg-blue-50 text-blue-800 border border-blue-200 text-xs font-bold px-3.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm animate-fade-in">
                                        {email}
                                        <button type="button" onClick={() => handleRemoveEmail(email)} className="text-red-500 hover:text-red-700 text-sm font-black">&times;</button>
                                    </span>
                                ))
                            )}
                        </div>
                    </div>

                    {/* SEKCJA 2: SĄD PESAM (POWIADOMIENIA SĄDOWE) */}
                    <div className="space-y-4 pt-6 border-t">
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider border-b pb-2">⚖️ Powiadomienia Sądowe CLS</h3>
                        <p className="text-xs text-slate-500">Adresy e-mail, na które system będzie wysyłał powiadomienia o nowych szkodach, zeznaniach kierowników i wyrokach.</p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Adres e-mail Dyrektora (I Instancja)</label>
                                <input
                                    type="email"
                                    required
                                    placeholder="np. dyrektor@pesam.pl"
                                    value={settings.clsDirectorEmail}
                                    onChange={e => setSettings({ ...settings, clsDirectorEmail: e.target.value })}
                                    className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-slate-50 outline-none focus:border-purple-500"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Adres e-mail Szefa (Ostateczny wyrok)</label>
                                <input
                                    type="email"
                                    required
                                    placeholder="np. szef@pesam.pl"
                                    value={settings.clsBossEmail}
                                    onChange={e => setSettings({ ...settings, clsBossEmail: e.target.value })}
                                    className="w-full p-3 border-2 rounded-xl text-sm font-bold bg-slate-50 outline-none focus:border-purple-500"
                                />
                            </div>
                        </div>
                    </div>

                    {/* STOPKA ZAPISU */}
                    <div className="pt-6 border-t flex justify-end">
                        <button
                            onClick={handleSaveSettings}
                            disabled={saving}
                            className="w-1/2 py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-2xl shadow-xl transition disabled:opacity-50 uppercase tracking-widest text-xs"
                        >
                            {saving ? "Zapisywanie..." : "Zapisz Ustawienia Systemu"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}