"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { getAuth, updatePassword } from "firebase/auth";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

type LoginStep = "LOGIN" | "CHANGE_PASSWORD";

export default function LoginPage() {
    const authContext = useAuth();
    const router = useRouter();

    // Stany dla kroku logowania
    const [step, setStep] = useState<LoginStep>("LOGIN");

    // Dane pierwszego kroku
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");

    // Dane drugiego kroku (zmiana hasła)
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!authContext) return null;
    const { signIn } = authContext;

    // KROK 1: Standardowe logowanie
    async function handleLoginSubmit(e: React.FormEvent) {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            await signIn(email, password);
            const auth = getAuth();

            // Jeśli zalogowano pomyślnie, sprawdzamy bazę danych
            if (auth.currentUser) {
                const userDocRef = doc(db, "users", auth.currentUser.uid);
                const userSnap = await getDoc(userDocRef);

                if (userSnap.exists()) {
                    const userData = userSnap.data();

                    // Jeśli użytkownik ma wymuszoną zmianę hasła - przechodzimy do kroku 2
                    if (userData.requiresPasswordChange) {
                        setStep("CHANGE_PASSWORD");
                        setIsSubmitting(false);
                        return; // Przerywamy funkcję, nie puszczamy na dashboard
                    }
                }
            }

            // Jeśli nie wymaga zmiany hasła, puszczamy dalej (obsługa powrotu do dyktafonu)
            const params = new URLSearchParams(window.location.search);
            const redirectParam = params.get("redirect");
            window.location.href = redirectParam || "/dashboard"; // TWARDY REDIRECT DLA TRYBU OFFLINE
        } catch (err: any) {
            console.error("Błąd podczas logowania:", err);
            alert("Błąd logowania: " + (err.message || "Nieznany błąd"));
            setIsSubmitting(false);
        }
    }

    // KROK 2: Wymuszona zmiana hasła
    async function handleChangePasswordSubmit(e: React.FormEvent) {
        e.preventDefault();

        if (newPassword.length < 6) {
            return alert("Nowe hasło musi mieć co najmniej 6 znaków.");
        }
        if (newPassword !== confirmPassword) {
            return alert("Hasła nie są identyczne.");
        }

        setIsSubmitting(true);
        try {
            const auth = getAuth();
            if (auth.currentUser) {
                // 1. Zmiana hasła w Firebase Auth
                await updatePassword(auth.currentUser, newPassword);

                // 2. Usunięcie flagi wymuszającej zmianę hasła z Firestore
                const userDocRef = doc(db, "users", auth.currentUser.uid);
                await updateDoc(userDocRef, {
                    requiresPasswordChange: false
                });

                alert("Hasło zostało zmienione poprawnie!");
                const params = new URLSearchParams(window.location.search);
                const redirectParam = params.get("redirect");
                window.location.href = redirectParam || "/dashboard"; // TWARDY REDIRECT DLA TRYBU OFFLINE
            }
        } catch (err: any) {
            console.error("Błąd podczas zmiany hasła:", err);
            alert("Błąd zmiany hasła: " + (err.message || "Nieznany błąd"));
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
            {step === "LOGIN" ? (
                <form onSubmit={handleLoginSubmit} className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm animate-fade-in">
                    <h2 className="text-2xl font-bold mb-6 text-center text-slate-800">Logowanie PESAM</h2>

                    <div className="mb-4">
                        <label className="block text-sm font-medium mb-1 text-slate-700">Email</label>
                        <input
                            type="email"
                            className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-1 text-slate-700">Hasło</label>
                        <input
                            type="password"
                            className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700 transition disabled:opacity-50 flex justify-center"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? "Logowanie..." : "Zaloguj się"}
                    </button>
                </form>
            ) : (
                <form onSubmit={handleChangePasswordSubmit} className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm animate-fade-in border-t-4 border-orange-500">
                    <h2 className="text-xl font-bold mb-2 text-center text-slate-800">Pierwsze logowanie</h2>
                    <p className="text-sm text-slate-500 text-center mb-6">
                        Dla bezpieczeństwa Twojego konta prosimy o ustawienie własnego hasła.
                    </p>

                    <div className="mb-4">
                        <label className="block text-sm font-medium mb-1 text-slate-700">Nowe hasło</label>
                        <input
                            type="password"
                            className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-orange-500 outline-none"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            minLength={6}
                            required
                        />
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-1 text-slate-700">Powtórz nowe hasło</label>
                        <input
                            type="password"
                            className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-orange-500 outline-none"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            minLength={6}
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-orange-600 text-white p-2 rounded hover:bg-orange-700 transition disabled:opacity-50 flex justify-center"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? "Zapisywanie..." : "Zapisz i kontynuuj"}
                    </button>
                </form>
            )}
        </div>
    );
}