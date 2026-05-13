"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";

export default function LoginPage() {
    const authContext = useAuth();
    const router = useRouter();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Zabezpieczenie przed brakiem kontekstu
    if (!authContext) return null;

    const { signIn } = authContext;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault(); // Zatrzymuje domyślne odświeżenie strony po kliknięciu submit
        console.log("Próba logowania dla:", email);

        setIsSubmitting(true);
        try {
            await signIn(email, password);
            console.log("Logowanie w Firebase zakończone sukcesem!");
            // Po sukcesie przenosimy użytkownika do panelu
            router.push("/dashboard");
        } catch (err: any) {
            console.error("Błąd podczas logowania:", err);
            // Wyświetlamy błąd z Firebase, żebyś wiedział, co poszło nie tak
            alert("Błąd logowania: " + (err.message || "Nieznany błąd"));
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
            <form
                onSubmit={handleSubmit}
                className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm"
            >
                <h2 className="text-2xl font-bold mb-6 text-center">Logowanie PESAM</h2>

                <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">Email</label>
                    <input
                        type="email"
                        className="w-full p-2 border border-gray-300 rounded"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                </div>

                <div className="mb-6">
                    <label className="block text-sm font-medium mb-1">Hasło</label>
                    <input
                        type="password"
                        className="w-full p-2 border border-gray-300 rounded"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                </div>

                <button
                    type="submit"
                    className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700 transition"
                    disabled={isSubmitting}
                >
                    {isSubmitting ? "Logowanie..." : "Zaloguj się"}
                </button>
            </form>
        </div>
    );
}