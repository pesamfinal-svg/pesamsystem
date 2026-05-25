// src/app/(dashboard)/dashboard/admin/users/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { db } from "@/lib/firebase/config";
import { ALL_PERMISSIONS, hasPermission } from "@/lib/auth/permissions"; // Dodano hasPermission
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";

// Interfejsy
interface Role {
    id: string;
    name: string;
    permissions: Record<string, boolean>;
}

interface Site {
    id: string;
    name: string;
}

interface UserDoc {
    uid: string;
    firstName: string;
    lastName: string;
    email: string;
    roleId: string;
    assignedSites: string[];
    permissionOverrides: Record<string, boolean>;
}

export default function UsersManagementPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [users, setUsers] = useState<UserDoc[]>([]);
    const [roles, setRoles] = useState<Role[]>([]);
    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);

    // Stan formularza modala
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingUser, setEditingUser] = useState<UserDoc | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Wyszukiwarka budów do przypisania
    const [siteSearch, setSiteSearch] = useState("");

    const [formData, setFormData] = useState({
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        roleId: "",
        assignedSites: [] as string[],
        permissionOverrides: {} as Record<string, boolean>
    });

    // =========================================================================
    // ZABEZPIECZENIE TRASY: DYNAMICZNE (Zamiast sztywnego słowa "admin")
    // =========================================================================
    useEffect(() => {
        if (user && !hasPermission("manageUsers", user.rolePermissions, user.permissionOverrides)) {
            alert("Brak uprawnień do widoku zarządzania pracownikami.");
            router.push("/dashboard");
        }
    }, [user, router]);

    // Pobieranie danych
    const fetchData = async () => {
        setLoading(true);
        try {
            const rolesSnap = await getDocs(collection(db, "roles"));
            const rolesData = rolesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Role[];
            setRoles(rolesData);

            const sitesSnap = await getDocs(collection(db, "sites"));
            const sitesData = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
            setSites(sitesData);

            const usersSnap = await getDocs(collection(db, "users"));
            const usersData = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() })) as UserDoc[];
            setUsers(usersData);
        } catch (error) {
            console.error("Błąd pobierania danych:", error);
            alert("Nie udało się pobrać danych.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    // Otwieranie formularza
    const openModal = (u?: UserDoc) => {
        setSiteSearch("");
        if (u) {
            setEditingUser(u);
            setFormData({
                firstName: u.firstName,
                lastName: u.lastName,
                email: u.email,
                password: "",
                roleId: u.roleId || "",
                assignedSites: u.assignedSites || [],
                permissionOverrides: u.permissionOverrides || {}
            });
        } else {
            setEditingUser(null);
            setFormData({
                firstName: "", lastName: "", email: "", password: "", roleId: "", assignedSites: [], permissionOverrides: {}
            });
        }
        setIsModalOpen(true);
    };

    // Zarządzanie wyjątkami uprawnień
    const selectedRole = roles.find(r => r.id === formData.roleId);

    const handlePermissionToggle = (permKey: string) => {
        if (!selectedRole) {
            alert("Najpierw wybierz rolę użytkownika!");
            return;
        }

        const roleDefault = !!selectedRole.permissions[permKey];
        const currentVal = formData.permissionOverrides[permKey] !== undefined
            ? formData.permissionOverrides[permKey]
            : roleDefault;
        const newVal = !currentVal;

        setFormData(prev => {
            const newOverrides = { ...prev.permissionOverrides };
            if (newVal === roleDefault) {
                delete newOverrides[permKey];
            } else {
                newOverrides[permKey] = newVal;
            }
            return { ...prev, permissionOverrides: newOverrides };
        });
    };

    // Logika Pills (Tagów) budów
    const handleSiteToggle = (siteId: string) => {
        setFormData(prev => {
            let newSites = [...prev.assignedSites];

            if (siteId === "ALL") {
                if (newSites.includes("ALL")) {
                    newSites = [];
                } else {
                    newSites = ["ALL"];
                }
            } else {
                newSites = newSites.filter(id => id !== "ALL");
                if (newSites.includes(siteId)) {
                    newSites = newSites.filter(id => id !== siteId);
                } else {
                    newSites.push(siteId);
                }
            }
            return { ...prev, assignedSites: newSites };
        });
    };

    // Usunięcie użytkownika z bazy danych
    const handleDeleteUser = async (uid: string, fullName: string) => {
        const confirmDelete = window.confirm(
            `⚠️ USUWANIE PRACOWNIKA!\n\n` +
            `Czy na pewno chcesz bezpowrotnie usunąć pracownika "${fullName}" z systemu?\n` +
            `Ta operacja zablokuje jego dostęp do systemu i usunie profil z bazy danych.`
        );
        if (!confirmDelete) return;

        try {
            await deleteDoc(doc(db, "users", uid));
            alert("Pracownik został pomyślnie usunięty z bazy danych!");
            fetchData(); // Odświeżenie listy
        } catch (error: any) {
            console.error("Błąd usuwania użytkownika:", error);
            alert("Błąd: " + error.message);
        }
    };

    // Zapis użytkownika
    const handleSaveUser = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.roleId) return alert("Wybierz rolę!");
        setIsSubmitting(true);

        try {
            if (editingUser) {
                await updateDoc(doc(db, "users", editingUser.uid), {
                    firstName: formData.firstName,
                    lastName: formData.lastName,
                    roleId: formData.roleId,
                    assignedSites: formData.assignedSites,
                    permissionOverrides: formData.permissionOverrides
                });
                alert("Zaktualizowano profil!");
            } else {
                if (!formData.password || formData.password.length < 6) {
                    setIsSubmitting(false);
                    return alert("Hasło musi mieć min. 6 znaków.");
                }

                const firebaseConfig = getAuth().app.options;
                const secondaryApp = initializeApp(firebaseConfig, "SecondaryApp");
                const secondaryAuth = getAuth(secondaryApp);

                const userCredential = await createUserWithEmailAndPassword(secondaryAuth, formData.email, formData.password);
                const newUid = userCredential.user.uid;

                await signOut(secondaryAuth);

                await setDoc(doc(db, "users", newUid), {
                    firstName: formData.firstName,
                    lastName: formData.lastName,
                    email: formData.email,
                    roleId: formData.roleId,
                    assignedSites: formData.assignedSites,
                    permissionOverrides: formData.permissionOverrides,
                    isActive: true,
                    requiresPasswordChange: true, // <-- DODANA FLAGA
                    createdAt: new Date().toISOString()
                });
                alert("Pracownik został pomyślnie utworzony!");
            }

            setIsModalOpen(false);
            fetchData();
        } catch (error: any) {
            console.error("Błąd zapisu usera:", error);
            alert("Błąd: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const isAllSitesSelected = formData.assignedSites.includes("ALL");
    const availableSitesToSelect = sites.filter(s =>
        !formData.assignedSites.includes(s.id) &&
        (s.name.toLowerCase().includes(siteSearch.toLowerCase()) || s.id.toLowerCase().includes(siteSearch.toLowerCase()))
    );

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Pracownicy i Uprawnienia</h1>
                    <p className="text-slate-500 text-sm mt-1">Zarządzaj dostępem pracowników do systemu</p>
                </div>
                <button
                    onClick={() => openModal()}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium shadow-sm transition"
                >
                    + Dodaj Pracownika
                </button>
            </div>

            {loading ? (
                <div className="p-10 text-center">Ładowanie pracowników...</div>
            ) : (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                                <th className="p-4 font-semibold text-slate-700">Imię i Nazwisko</th>
                                <th className="p-4 font-semibold text-slate-700">Email</th>
                                <th className="p-4 font-semibold text-slate-700">Rola</th>
                                <th className="p-4 font-semibold text-slate-700">Dostęp do Budów</th>
                                <th className="p-4 font-semibold text-slate-700 text-center">Wyjątki</th>
                                <th className="p-4 font-semibold text-slate-700 text-right">Akcje</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((u) => {
                                const roleName = roles.find(r => r.id === u.roleId)?.name || u.roleId;
                                const exceptionsCount = Object.keys(u.permissionOverrides || {}).length;

                                const sitesListText = u.assignedSites?.includes("ALL")
                                    ? <span className="font-bold text-blue-600">Wszystkie budowy</span>
                                    : u.assignedSites?.length > 0
                                        ? u.assignedSites.map(id => sites.find(s => s.id === id)?.name || id).join(", ")
                                        : <span className="text-slate-400">Brak</span>;

                                return (
                                    <tr key={u.uid} className="border-b border-slate-100 hover:bg-slate-50 transition">
                                        <td className="p-4 font-medium text-slate-800">{u.firstName} {u.lastName}</td>
                                        <td className="p-4 text-slate-500">{u.email}</td>
                                        <td className="p-4 text-blue-700 font-medium">{roleName}</td>
                                        <td className="p-4 text-slate-700 text-sm max-w-xs truncate" title={typeof sitesListText === 'string' ? sitesListText : ""}>
                                            {sitesListText}
                                        </td>
                                        <td className="p-4 text-center">
                                            {exceptionsCount > 0 ? (
                                                <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded text-xs font-bold" title="Użytkownik posiada specjalne nadpisania uprawnień">
                                                    {exceptionsCount} wyjątków
                                                </span>
                                            ) : (
                                                <span className="text-slate-400 text-xs">Brak</span>
                                            )}
                                        </td>
                                        <td className="p-4 text-right space-x-2.5">
                                            <button onClick={() => openModal(u)} className="text-blue-600 hover:underline text-sm font-medium">Edytuj</button>
                                            <span className="text-slate-300">|</span>
                                            <button onClick={() => handleDeleteUser(u.uid, `${u.firstName} ${u.lastName}`)} className="text-red-600 hover:underline text-sm font-medium">Usuń</button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <h2 className="text-xl font-bold text-slate-800">
                                {editingUser ? `Edycja: ${editingUser.firstName}` : "Nowy Pracownik"}
                            </h2>
                            <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
                        </div>

                        <form onSubmit={handleSaveUser} className="p-6 overflow-y-auto flex-1">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                                {/* Lewa kolumna: Dane podstawowe i Budowy */}
                                <div className="space-y-5">
                                    <h3 className="font-semibold text-slate-800 border-b pb-2">Dane konta</h3>
                                    <div className="flex gap-4">
                                        <div className="flex-1">
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Imię</label>
                                            <input type="text" required value={formData.firstName} onChange={e => setFormData({ ...formData, firstName: e.target.value })} className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                                        </div>
                                        <div className="flex-1">
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Nazwisko</label>
                                            <input type="text" required value={formData.lastName} onChange={e => setFormData({ ...formData, lastName: e.target.value })} className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">E-mail</label>
                                        <input type="email" required disabled={!!editingUser} value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} className="w-full p-2 border rounded-lg outline-none disabled:bg-slate-100 focus:ring-2 focus:ring-blue-500" />
                                    </div>
                                    {!editingUser && (
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">Hasło startowe</label>
                                            <input type="password" required value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                                        </div>
                                    )}
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Przypisana Rola w Systemie</label>
                                        <select required value={formData.roleId} onChange={e => setFormData({ ...formData, roleId: e.target.value, permissionOverrides: {} })} className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white">
                                            <option value="" disabled>-- Wybierz rolę --</option>
                                            {roles.map(r => (
                                                <option key={r.id} value={r.id}>{r.name}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* SEKCJA: Dostęp do Budów (NOWOCZESNA Z PILLS) */}
                                    <div className="mt-6">
                                        <label className="block text-sm font-semibold text-slate-800 mb-2 border-b pb-1">Dostęp do Budów</label>

                                        <label className={`flex items-center cursor-pointer p-3 border rounded-lg transition mb-4 ${isAllSitesSelected ? 'bg-blue-50 border-blue-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'}`}>
                                            <input
                                                type="checkbox"
                                                checked={isAllSitesSelected}
                                                onChange={() => handleSiteToggle("ALL")}
                                                className="w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                            />
                                            <span className={`ml-3 text-sm ${isAllSitesSelected ? 'font-bold text-blue-900' : 'font-medium text-slate-700'}`}>
                                                Pełny dostęp do wszystkich budów
                                            </span>
                                        </label>

                                        {!isAllSitesSelected && (
                                            <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg space-y-3">
                                                <div className="flex flex-wrap gap-2">
                                                    {formData.assignedSites.length === 0 ? (
                                                        <span className="text-sm text-slate-500 italic">Nie przypisano jeszcze żadnej budowy.</span>
                                                    ) : (
                                                        formData.assignedSites.map(siteId => {
                                                            const s = sites.find(x => x.id === siteId);
                                                            return (
                                                                <span key={siteId} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
                                                                    {s ? s.name : siteId}
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleSiteToggle(siteId)}
                                                                        className="text-blue-500 hover:text-red-500 focus:outline-none"
                                                                    >
                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                                                                    </button>
                                                                </span>
                                                            )
                                                        })
                                                    )}
                                                </div>

                                                <div className="pt-2">
                                                    <input
                                                        type="text"
                                                        placeholder="Wyszukaj i dodaj budowę..."
                                                        value={siteSearch}
                                                        onChange={(e) => setSiteSearch(e.target.value)}
                                                        className="w-full text-sm p-2.5 border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 outline-none mb-2"
                                                    />
                                                    <div className="max-h-[140px] overflow-y-auto border border-slate-200 rounded-md bg-white shadow-inner">
                                                        {availableSitesToSelect.length === 0 ? (
                                                            <div className="p-3 text-xs text-slate-500 text-center">Brak wyników.</div>
                                                        ) : (
                                                            availableSitesToSelect.map(site => (
                                                                <div
                                                                    key={site.id}
                                                                    onClick={() => { handleSiteToggle(site.id); setSiteSearch(""); }}
                                                                    className="p-2.5 text-sm text-slate-700 hover:bg-blue-50 cursor-pointer border-b border-slate-50 last:border-0 flex justify-between items-center transition"
                                                                >
                                                                    <span className="font-medium">{site.name}</span>
                                                                    <span className="text-blue-600 font-bold bg-blue-100 px-2 rounded hover:bg-blue-200">+ Dodaj</span>
                                                                </div>
                                                            ))
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Prawa kolumna: Uprawnienia i Wyjątki */}
                                <div className="space-y-5">
                                    <h3 className="font-semibold text-slate-800 border-b pb-2">Modyfikacja Uprawnień (Wyjątki)</h3>
                                    {!selectedRole ? (
                                        <div className="bg-slate-50 p-4 rounded-lg text-sm text-slate-500 text-center">
                                            Wybierz rolę pracownika po lewej stronie, aby wyświetlić siatkę uprawnień.
                                        </div>
                                    ) : (
                                        <div className="space-y-2 max-h-[550px] overflow-y-auto pr-2">
                                            {Object.entries(ALL_PERMISSIONS).map(([key, label]) => {
                                                const isDefault = selectedRole.permissions[key] || false;
                                                const hasOverride = formData.permissionOverrides[key] !== undefined;
                                                const currentActive = hasOverride ? formData.permissionOverrides[key] : isDefault;

                                                return (
                                                    <label key={key} className={`flex items-start p-3 border rounded-lg cursor-pointer transition ${currentActive ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-75'} ${hasOverride ? '!border-orange-300 !bg-orange-50' : ''}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={currentActive}
                                                            onChange={() => handlePermissionToggle(key)}
                                                            className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                        />
                                                        <div className="ml-3 flex-1">
                                                            <div className={`text-sm font-medium ${currentActive ? 'text-slate-800' : 'text-slate-500 line-through'}`}>{label}</div>
                                                            <div className="text-xs mt-1">
                                                                {hasOverride ? (
                                                                    <span className="text-orange-600 font-bold px-1.5 py-0.5 bg-orange-100 rounded">
                                                                        Wyjątek wprowadzony ręcznie
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-slate-400">
                                                                        Zgodnie z rolą: {isDefault ? 'TAK' : 'NIE'}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="border-t border-slate-100 pt-4 flex justify-end gap-3">
                                <button type="button" onClick={() => setIsModalOpen(false)} className="px-5 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg">Anuluj</button>
                                <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm disabled:opacity-50 flex items-center gap-2">
                                    {isSubmitting && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                                    {isSubmitting ? "Zapisywanie..." : "Zapisz pracownika"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}