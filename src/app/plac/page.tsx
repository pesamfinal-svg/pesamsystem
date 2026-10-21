"use client";

import React, { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import Link from "next/link";
import { useRouter } from "next/navigation";

type ModalInfo = {
  title: string;
  icon: string;
  desc: string;
};

export default function PlacPage() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isPwaModalOpen, setIsPwaModalOpen] = useState<boolean>(false);
  const [modalInfo, setModalInfo] = useState<ModalInfo | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsOnline(navigator.onLine);

      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);

      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }
  }, []);

  useEffect(() => {
    if (!modalInfo && !isPwaModalOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModalInfo(null);
        setIsPwaModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modalInfo, isPwaModalOpen]);

  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  const userName = user?.firstName || "Pracowniku";
  const userRole = (user as { role?: string } | null)?.role ?? "Pracownik placu";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-12">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
        <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-3xl" aria-hidden="true">🏗️</span>
            <div className="min-w-0">
              <h1 className="text-lg font-black tracking-wider text-amber-400 leading-tight uppercase">
                PESAM PLAC
              </h1>
              <p className="text-[11px] font-bold text-slate-400 tracking-wide leading-tight">
                Panel Operacyjny Placu i Kierowców
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-black tracking-wider uppercase whitespace-nowrap ${
                isOnline
                  ? "border-emerald-700/60 bg-emerald-950/80 text-emerald-400"
                  : "border-amber-700/60 bg-amber-950/80 text-amber-400"
              }`}
            >
              {isOnline ? "🟢 Online" : "🟠 Offline"}
            </span>

            <button
              type="button"
              onClick={() => setIsPwaModalOpen(true)}
              className="flex items-center gap-1.5 rounded-xl border border-blue-500/30 bg-blue-600/20 px-3 py-2 text-xs font-bold text-blue-300 hover:bg-blue-600/30 active:scale-95 transition min-h-[40px]"
            >
              <span aria-hidden="true">📱</span>
              <span className="hidden sm:inline">Na telefon</span>
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              title="Wyloguj"
              className="flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 active:scale-95 transition min-h-[40px]"
            >
              <span aria-hidden="true">🚪</span>
              <span className="hidden sm:inline">Wyloguj</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">
        {/* Welcome Card */}
        <section className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-5 shadow-lg">
          <h2 className="text-xl font-black text-white">
            Cześć, {userName} 👋
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Wybierz moduł operacyjny z poniższego menu kafelkowego:
          </p>
        </section>

        {/* 4 Duże Kafelki Menu */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {/* Kafelek 1: Resztki i Odpady */}
          <Link
            href="/plac/resztki"
            className="group relative block rounded-3xl border border-amber-500/40 bg-gradient-to-br from-amber-500/15 via-slate-900 to-slate-950 p-5 min-h-[170px] shadow-lg hover:border-amber-400 active:scale-[0.98] transition flex flex-col justify-between"
          >
            <div>
              <div className="text-4xl mb-2" aria-hidden="true">🧱</div>
              <h3 className="text-lg font-black text-amber-400 group-hover:text-amber-300 transition">
                Resztki i Odpady
              </h3>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                Magazyn końcówek budowlanych, dodawanie zdjęć aparatem, szybki przegląd stanów
              </p>
            </div>
            <div className="mt-4 inline-flex items-center gap-1.5 self-start rounded-xl bg-amber-500 hover:bg-amber-400 px-3.5 py-2 text-xs font-black text-slate-950 shadow">
              <span>Otwórz magazyn resztek</span>
              <span>→</span>
            </div>
          </Link>

          {/* Kafelek 2: Zamówienia Dzisiejsze */}
          <Link
            href="/plac/zamowienia"
            className="group relative block rounded-3xl border border-blue-500/40 bg-gradient-to-br from-blue-500/15 via-slate-900 to-slate-950 p-5 min-h-[170px] shadow-lg hover:border-blue-400 active:scale-[0.98] transition flex flex-col justify-between"
          >
            <div>
              <div className="text-4xl mb-2" aria-hidden="true">📦</div>
              <h3 className="text-lg font-black text-blue-400 group-hover:text-blue-300 transition">
                Zamówienia Dzisiejsze
              </h3>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                Aktualne zlecenia materiałowe z danego dnia w systemie (dla kierowców i załadunku)
              </p>
            </div>
            <div className="mt-4 inline-flex items-center gap-1.5 self-start rounded-xl bg-blue-600 hover:bg-blue-500 px-3.5 py-2 text-xs font-black text-white shadow">
              <span>Zobacz zamówienia</span>
              <span>→</span>
            </div>
          </Link>

          {/* Kafelek 3: Wypisz Protokół */}
          <button
            type="button"
            onClick={() =>
              setModalInfo({
                title: "Wypisz Protokół",
                icon: "📋",
                desc: "Moduł mobilnych protokołów zdawczo-odbiorczych (wydania na budowę i zwroty materiałów) jest w trakcie przygotowywania procedury. Wkrótce będzie dostępny.",
              })
            }
            className="relative block w-full text-left rounded-3xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-slate-900 to-slate-950 p-5 min-h-[170px] shadow-lg hover:border-purple-400/60 active:scale-[0.98] transition flex flex-col justify-between"
          >
            <span className="absolute top-4 right-4 rounded-full border border-purple-500/40 bg-purple-950/80 px-2.5 py-0.5 text-[10px] font-black tracking-wider text-purple-300 uppercase">
              Wkrótce
            </span>
            <div>
              <div className="text-4xl mb-2" aria-hidden="true">📋</div>
              <h3 className="text-lg font-black text-purple-300">
                Wypisz Protokół
              </h3>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Mobilne protokoły zdawczo-odbiorcze: wydania i zwroty z budów z podpisem
              </p>
            </div>
            <div className="mt-4 inline-flex items-center gap-1 self-start rounded-xl border border-purple-500/40 px-3 py-1.5 text-xs font-bold text-purple-300 bg-purple-950/40">
              <span>Informacja</span>
              <span>→</span>
            </div>
          </button>

          {/* Kafelek 4: Inwentaryzacja */}
          <button
            type="button"
            onClick={() =>
              setModalInfo({
                title: "Inwentaryzacja Placu",
                icon: "📊",
                desc: "Moduł szybkiej inwentaryzacji mobilnej (spis z natury na placu, kody i weryfikacja ilościowa) jest w fazie opracowywania.",
              })
            }
            className="relative block w-full text-left rounded-3xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-slate-900 to-slate-950 p-5 min-h-[170px] shadow-lg hover:border-emerald-400/60 active:scale-[0.98] transition flex flex-col justify-between"
          >
            <span className="absolute top-4 right-4 rounded-full border border-emerald-500/40 bg-emerald-950/80 px-2.5 py-0.5 text-[10px] font-black tracking-wider text-emerald-300 uppercase">
              Wkrótce
            </span>
            <div>
              <div className="text-4xl mb-2" aria-hidden="true">📊</div>
              <h3 className="text-lg font-black text-emerald-300">
                Inwentaryzacja
              </h3>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Szybki spis z natury, weryfikacja ilościowa i fotograficzna na placu
              </p>
            </div>
            <div className="mt-4 inline-flex items-center gap-1 self-start rounded-xl border border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-emerald-300 bg-emerald-950/40">
              <span>Informacja</span>
              <span>→</span>
            </div>
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 mt-auto">
        <div className="max-w-xl mx-auto w-full p-4 space-y-3 text-center">
          <Link
            href="/dashboard/inventory"
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-3 text-xs font-bold text-slate-300 transition"
          >
            <span>Przejdź do pełnego panelu ERP na komputerze</span>
            <span>🖥️</span>
          </Link>
          <p className="text-[11px] text-slate-400">
            Zalogowano jako: <span className="font-bold text-slate-200">{userName}</span> · Rola:{" "}
            <span className="font-bold text-amber-400">{userRole}</span>
          </p>
        </div>
      </footer>

      {/* Info Modal (Kafelki w przygotowaniu) */}
      {modalInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setModalInfo(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-5xl mb-2" aria-hidden="true">
              {modalInfo.icon}
            </div>
            <h2 className="text-lg font-black text-white">
              {modalInfo.title}
            </h2>
            <p className="mt-3 text-xs leading-relaxed text-slate-300 bg-slate-800/60 p-4 rounded-2xl border border-slate-700/50">
              {modalInfo.desc}
            </p>
            <button
              type="button"
              onClick={() => setModalInfo(null)}
              className="mt-5 w-full rounded-2xl bg-amber-500 hover:bg-amber-400 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-950 active:scale-95 transition"
            >
              Rozumiem, wracam
            </button>
          </div>
        </div>
      )}

      {/* PWA Install Modal */}
      {isPwaModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setIsPwaModalOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-4xl text-center mb-2" aria-hidden="true">📱</div>
            <h2 className="text-center text-lg font-black text-white uppercase tracking-wider">
              Aplikacja na telefon
            </h2>
            <p className="mt-1 text-center text-xs text-slate-400">
              Zainstaluj PESAM PLAC na pulpicie telefonu, aby mieć natychmiastowy dostęp w terenie.
            </p>

            <div className="mt-4 space-y-3">
              <section className="rounded-2xl border border-slate-700/60 bg-slate-800/60 p-3.5">
                <h3 className="flex items-center gap-1.5 text-xs font-black text-amber-400 uppercase">
                  <span>🍏</span> iPhone (Safari)
                </h3>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-slate-300">
                  <li>Otwórz stronę w <b>Safari</b>.</li>
                  <li>Dotknij przycisku <b>Udostępnij</b> (kwadrat ze strzałką w górę).</li>
                  <li>Wybierz <b>„Do ekranu początkowego”</b>.</li>
                  <li>Potwierdź klikając <b>Dodaj</b>.</li>
                </ol>
              </section>

              <section className="rounded-2xl border border-slate-700/60 bg-slate-800/60 p-3.5">
                <h3 className="flex items-center gap-1.5 text-xs font-black text-amber-400 uppercase">
                  <span>🤖</span> Android (Chrome)
                </h3>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-slate-300">
                  <li>Otwórz stronę w <b>Chrome</b>.</li>
                  <li>Dotknij <b>trzy kropki ⋮</b> w prawym górnym rogu.</li>
                  <li>Wybierz <b>„Dodaj do ekranu głównego”</b> lub <b>„Zainstaluj aplikację”</b>.</li>
                </ol>
              </section>
            </div>

            <button
              type="button"
              onClick={() => setIsPwaModalOpen(false)}
              className="mt-5 w-full rounded-2xl bg-amber-500 hover:bg-amber-400 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-950 active:scale-95 transition"
            >
              Zamknij
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
