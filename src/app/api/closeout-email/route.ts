import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface DebtItemPayload {
    name: string;
    quantity: number;
    unit: string;
    inventoryNumber: string;
    resolution?: "LOSS" | "CONSUMED" | "DISPUTED_INVESTOR" | "SCRAPPED";
    notes?: string;
    estimatedUnitCost?: number;
    estimatedTotalCost?: number;
    isManualEntry?: boolean;
}

interface SiteDamagePayload {
    inventoryName: string;
    inventoryNumber?: string;
    quantity: number;
    unit?: string;
    description: string;
    reportedByName?: string;
}

interface CloseoutEmailPayload {
    type: "CLOSEOUT_INITIATED" | "CLOSEOUT_SIGNED_BY_MANAGER" | "CLOSEOUT_FINALIZED";
    siteName: string;
    managerName: string;
    managerEmail: string;
    warehousemanName: string;
    debtsList: DebtItemPayload[];
    detectiveList?: { name: string; inventoryNumber: string; failureDescription: string; }[];
    siteDamagesList?: SiteDamagePayload[];
    generalNotes?: string;
    financialSummary?: {
        totalLossCost: number;
        totalDisputedCost: number;
        totalScrappedCost: number;
    };
}

export async function POST(req: Request) {
    try {
        const body: CloseoutEmailPayload = await req.json();
        const {
            type,
            siteName,
            managerName,
            managerEmail,
            warehousemanName,
            debtsList = [],
            detectiveList = [],
            siteDamagesList = [],
            generalNotes = "",
            financialSummary
        } = body;

        // Pobierz ustawienia globalne
        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) throw new Error("Brak konfiguracji maili w Ustawieniach Systemu!");

        const settings = settingsSnap.data() || {};
        const testEmails: string[] = settings.closeoutEmailRecipients || [];
        const isSandbox = settings.isCloseoutSandboxMode !== undefined ? settings.isCloseoutSandboxMode : true;

        const dyrektorEmail = settings.closeoutDirectorEmail || settings.clsDirectorEmail || "";
        const szefEmail = settings.closeoutBossEmail || settings.clsBossEmail || "";
        const additionalEmails: string[] = settings.closeoutAdditionalEmails || [];
        const notifyOnInitiate = settings.notifyDirectorOnInitiate || false;

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const senderString = `"Audytor Zamknięć PESAM" <${process.env.EMAIL_USER}>`;

        let subject = "";
        let recipients: string[] = [];
        let htmlContent = "";

        // ROZDZIELENIE POZYCJI WG KATEGORII DECYZJI
        const lossItems = debtsList.filter(item => item.resolution === "LOSS" || !item.resolution);
        const disputedItems = debtsList.filter(item => item.resolution === "DISPUTED_INVESTOR");
        const scrappedItems = debtsList.filter(item => item.resolution === "SCRAPPED");
        const consumedItems = debtsList.filter(item => item.resolution === "CONSUMED");

        // 1. Tabela strat bezpośrednich (LOSS)
        const lossTableRows = lossItems.length > 0
            ? lossItems.map(item => `
                <tr style="border-bottom:1px solid #f1f5f9">
                    <td style="padding:10px 0;font-size:13px;color:#334155">
                        <b>${item.name}</b> ${item.isManualEntry ? '<span style="font-size:9px;background:#e2e8f0;color:#475569;padding:2px 5px;border-radius:4px;text-transform:uppercase;font-weight:bold">Wpis ręczny</span>' : ''}
                        <br/><span style="font-size:10px;color:#94a3b8">Nr Mag: ${item.inventoryNumber || '-'}</span>
                        ${item.notes ? `<div style="font-size:11px;color:#b91c1c;margin-top:4px;font-style:italic">💬 Uwaga: ${item.notes}</div>` : ''}
                    </td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#ef4444;font-weight:bold">
                        ${item.quantity} ${item.unit || 'szt.'}
                        ${item.estimatedTotalCost ? `<br/><span style="font-size:11px;color:#991b1b;font-weight:normal">~${item.estimatedTotalCost} zł</span>` : ''}
                    </td>
                </tr>`).join("")
            : `<tr><td colspan="2" style="padding:10px 0;text-align:center;color:#10b981;font-weight:bold;font-size:13px">Brak bezpośrednich strat sprzętu.</td></tr>`;

        // 2. Tabela sprzętu spornego / u Inwestora (DISPUTED_INVESTOR)
        let disputedHtml = "";
        if (disputedItems.length > 0) {
            const disputedRows = disputedItems.map(item => `
                <tr style="border-bottom:1px solid #fef3c7">
                    <td style="padding:10px 0;font-size:13px;color:#78350f">
                        <b>${item.name}</b>
                        <br/><span style="font-size:10px;color:#92400e">Nr Mag: ${item.inventoryNumber || '-'}</span>
                        ${item.notes ? `<div style="font-size:11px;color:#b45309;margin-top:4px;font-style:italic">💬 Sytuacja: ${item.notes}</div>` : ''}
                    </td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#b45309;font-weight:bold">
                        ${item.quantity} ${item.unit || 'szt.'}
                        ${item.estimatedTotalCost ? `<br/><span style="font-size:11px;color:#92400e;font-weight:normal">Wartość: ~${item.estimatedTotalCost} zł</span>` : ''}
                    </td>
                </tr>`).join("");

            disputedHtml = `
                <h4 style="font-size:12px;color:#b45309;text-transform:uppercase;letter-spacing:1px;margin:25px 0 8px 0;border-bottom:2px solid #fef3c7;padding-bottom:5px">
                    🚧 Sprzęt Pozostawiony u Inwestora / Sprawa Sporna (Do refakturowania lub odbioru):
                </h4>
                <p style="font-size:11px;color:#78350f;margin-bottom:10px">
                    Poniższy sprzęt (np. ogrodzenie, szalunki) nie został skradziony ani zniszczony, lecz pozostał na budowie w toku ustaleń z inwestorem:
                </p>
                <table style="width:100%;border-collapse:collapse">${disputedRows}</table>
            `;
        }

        // 3. Tabela złomowania / utylizacji (SCRAPPED)
        let scrappedHtml = "";
        if (scrappedItems.length > 0) {
            const scrappedRows = scrappedItems.map(item => `
                <tr style="border-bottom:1px solid #f1f5f9">
                    <td style="padding:10px 0;font-size:13px;color:#475569">
                        <b>${item.name}</b>
                        <br/><span style="font-size:10px;color:#64748b">Nr Mag: ${item.inventoryNumber || '-'}</span>
                        <div style="font-size:11px;color:#475569;margin-top:4px;font-style:italic">
                            ⚙️ Powód złomowania: ${item.notes || 'Sprzęt nienaprawialny / brak części zamiennych'}
                        </div>
                    </td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#64748b;font-weight:bold">
                        ${item.quantity} ${item.unit || 'szt.'}
                        ${item.estimatedTotalCost ? `<br/><span style="font-size:11px;color:#94a3b8;font-weight:normal">~${item.estimatedTotalCost} zł</span>` : ''}
                    </td>
                </tr>`).join("");

            scrappedHtml = `
                <h4 style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin:25px 0 8px 0;border-bottom:2px solid #e2e8f0;padding-bottom:5px">
                    ♻️ Sprzęt Przeznaczony do Złomowania / Utylizacji:
                </h4>
                <table style="width:100%;border-collapse:collapse">${scrappedRows}</table>
            `;
        }

        // 4. Tabela normalnego zużycia eksploatacyjnego (CONSUMED)
        let consumedHtml = "";
        if (consumedItems.length > 0) {
            const consumedRows = consumedItems.map(item => `
                <tr style="border-bottom:1px solid #f1f5f9">
                    <td style="padding:10px 0;font-size:13px;color:#475569"><b>${item.name}</b></td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#64748b;font-weight:bold">${item.quantity} ${item.unit || 'szt.'}</td>
                </tr>`).join("");

            consumedHtml = `
                <h4 style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:25px 0 8px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">
                    🧼 Zużycie Normalne (Koszty eksploatacyjne budowy):
                </h4>
                <table style="width:100%;border-collapse:collapse">${consumedRows}</table>
            `;
        }

        // 5. Tabela uszkodzeń zgłoszonych w trakcie budowy (siteDamagesList)
        let siteDamagesHtml = "";
        if (siteDamagesList && siteDamagesList.length > 0) {
            const damageRows = siteDamagesList.map(dmg => `
                <div style="background:#fff7ed;border-left:4px solid #f97316;padding:10px 14px;margin-bottom:8px;border-radius:0 8px 8px 0;font-size:12px;color:#431407">
                    <b>${dmg.inventoryName}</b> (${dmg.quantity} ${dmg.unit || 'szt.'}) - <i>zgłosił: ${dmg.reportedByName || 'Kierownik'}</i>
                    <div style="margin-top:4px;color:#9a3412">Opis awarii z placu: ${dmg.description}</div>
                </div>
            `).join("");

            siteDamagesHtml = `
                <h4 style="font-size:12px;color:#ea580c;text-transform:uppercase;letter-spacing:1px;margin:25px 0 8px 0;border-bottom:2px solid #ffedd5;padding-bottom:5px">
                    💥 Uszkodzenia Zgłoszone na Placu w Trakcie Trwania Projektu:
                </h4>
                ${damageRows}
            `;
        }

        // 6. Detektyw
        let detectiveHtml = "";
        if (detectiveList && detectiveList.length > 0) {
            const detRows = detectiveList.map(item => `
                <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:10px 14px;margin-bottom:8px;border-radius:0 8px 8px 0;font-size:12px;color:#7f1d1d">
                    <b>${item.name}</b> (Nr: ${item.inventoryNumber || '-'})<br/>
                    <i>Usterka z bazy magazynowej: ${item.failureDescription}</i>
                </div>
            `).join("");

            detectiveHtml = `
                <h4 style="font-size:12px;color:#dc2626;text-transform:uppercase;letter-spacing:1px;margin:25px 0 8px 0;border-bottom:2px solid #fee2e2;padding-bottom:5px">
                    🕵️ Detektyw PESAM (Awaria bezpośrednio po zdaniu sprzętu):
                </h4>
                ${detRows}
            `;
        }

        // 7. Podsumowanie finansowe (PLN)
        let financeBoxHtml = "";
        if (financialSummary) {
            financeBoxHtml = `
                <div style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:15px;margin:20px 0;display:flex;justify-content:space-between">
                    <div>
                        <div style="font-size:10px;font-weight:bold;color:#64748b;text-transform:uppercase">Straty bezpośrednie:</div>
                        <div style="font-size:16px;font-weight:black;color:#ef4444">${financialSummary.totalLossCost || 0} zł</div>
                    </div>
                    <div>
                        <div style="font-size:10px;font-weight:bold;color:#64748b;text-transform:uppercase">Sprzęt u inwestora:</div>
                        <div style="font-size:16px;font-weight:black;color:#b45309">${financialSummary.totalDisputedCost || 0} zł</div>
                    </div>
                    <div>
                        <div style="font-size:10px;font-weight:bold;color:#64748b;text-transform:uppercase">Do złomowania:</div>
                        <div style="font-size:16px;font-weight:black;color:#475569">${financialSummary.totalScrappedCost || 0} zł</div>
                    </div>
                </div>
            `;
        }

        // Ogólne uwagi
        const notesHtml = generalNotes ? `
            <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px;margin:15px 0;border-radius:0 8px 8px 0;font-size:12px;color:#1e3a8a">
                <b>Notatki i uwagi audytora do zamknięcia budowy:</b><br/>
                <p style="margin:5px 0 0 0;line-height:1.4">${generalNotes}</p>
            </div>
        ` : '';

        if (type === "CLOSEOUT_INITIATED") {
            subject = `⏳ [ROZLICZENIE BUDOWY] Audyt końcowy projektu · ${siteName}`;
            recipients = [managerEmail];
            if (notifyOnInitiate && (dyrektorEmail || szefEmail)) {
                recipients.push(dyrektorEmail, szefEmail);
            }

            htmlContent = `
                <div style="font-family:sans-serif;max-width:650px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#0f172a;color:#fff;padding:16px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">⏳ Zgłoszenie Zamknięcia Budowy</h2>
                        <p style="margin:4px 0 0 0;font-size:12px;color:#94a3b8">Projekt: <b>${siteName}</b></p>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Cześć <b>${managerName}</b>,</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">Magazynier centralny (<b>${warehousemanName}</b>) zakończył fizyczny audyt sprzętu na Twoim projekcie: <b>${siteName}</b> i rozpoczął procedurę zamknięcia budowy.</p>
                        
                        ${financeBoxHtml}
                        ${notesHtml}

                        <h4 style="font-size:12px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Wykaz strat obciążających budowę (Długi):</h4>
                        <table style="width:100%;border-collapse:collapse">${lossTableRows}</table>

                        ${disputedHtml}
                        ${scrappedHtml}
                        ${consumedHtml}
                        ${siteDamagesHtml}
                        ${detectiveHtml}

                        <div style="margin-top:25px;background:#fef2f2;border-left:4px solid #ef4444;padding:14px;border-radius:6px">
                            <p style="margin:0;font-size:13px;color:#991b1b;font-weight:bold">
                                ✍️ WYMAGANY PODPIS KIEROWNIKA:
                            </p>
                            <p style="margin:6px 0 0 0;font-size:12px;color:#7f1d1d;line-height:1.4">
                                Zaloguj się do systemu PESAM, przejdź do zakładki <b>"Zatwierdzanie Zamknięć"</b> i złóż podpis cyfrowy pod rozliczeniem, aby sprawa mogła trafić do ostatecznej autoryzacji przez Dyrekcję i Prezesa.
                            </p>
                        </div>
                    </div>
                    ${isSandbox ? `<div style="text-align:center;font-size:10px;color:#f97316;margin-top:10px;font-weight:bold">🧪 [KOMUNIKAT PIASKOWNICY]: Mail w trybie produkcyjnym leciałby do: ${recipients.join(", ")}</div>` : ""}
                </div>`;
        }
        else if (type === "CLOSEOUT_SIGNED_BY_MANAGER") {
            subject = `✍️ [PROŚBA O AUTORYZACJĘ ZAMKNIĘCIA] Kierownik podpisał raport · ${siteName}`;
            recipients = [dyrektorEmail, szefEmail].filter(Boolean);

            htmlContent = `
                <div style="font-family:sans-serif;max-width:650px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#1d4ed8;color:#fff;padding:16px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">✍️ Złożono Podpis Kierownika Budowy</h2>
                        <p style="margin:4px 0 0 0;font-size:12px;color:#bfdbfe">Projekt: <b>${siteName}</b></p>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Szanowna Dyrekcjo / Prezesie,</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">
                            Kierownik Budowy <b>${managerName}</b> zapoznał się z audytem i <b>złożył cyfrowy podpis</b> pod rozliczeniem budowy: <b>${siteName}</b>.
                        </p>

                        <!-- CALL TO ACTION DO LOGOWANIA DLA DYREKTORA/PREZESA -->
                        <div style="margin:20px 0;background:#eff6ff;border:2px solid #3b82f6;border-radius:10px;padding:16px;text-align:center">
                            <p style="margin:0;font-size:14px;color:#1e3a8a;font-weight:bold">
                                🔒 PROŚBA O WEJŚCIE NA SWOJE KONTO I ZAMKNIĘCIE BUDOWY:
                            </p>
                            <p style="margin:8px 0 14px 0;font-size:12px;color:#1e40af;line-height:1.5">
                                Posiadają Państwo uprawnienia do ostatecznego zamykania projektów w PESAM.<br/>
                                Prosimy o zalogowanie się na swoje konto, przejście do zakładki <b>"Zatwierdzanie Zamknięć"</b> i podjęcie ostatecznej decyzji.
                            </p>
                            <a href="https://pesam-magazyn--pesam-system-81165.europe-west4.hosted.app/dashboard/closeout-approvals" style="display:inline-block;background:#2563eb;color:#fff;font-weight:bold;text-decoration:none;font-size:13px;padding:10px 24px;border-radius:8px;text-transform:uppercase;letter-spacing:0.5px">
                                Otwórz Zatwierdzanie Zamknięć w PESAM &rarr;
                            </a>
                        </div>

                        ${financeBoxHtml}
                        ${notesHtml}

                        <h4 style="font-size:12px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Zatwierdzony wykaz ubytków (Długi):</h4>
                        <table style="width:100%;border-collapse:collapse">${lossTableRows}</table>

                        ${disputedHtml}
                        ${scrappedHtml}
                        ${consumedHtml}
                        ${siteDamagesHtml}
                        ${detectiveHtml}
                    </div>
                    ${isSandbox ? `<div style="text-align:center;font-size:10px;color:#f97316;margin-top:10px;font-weight:bold">🧪 [KOMUNIKAT PIASKOWNICY]: Ten mail w trybie produkcyjnym leciałby do Dyrekcji/Prezesa: ${recipients.join(", ")}</div>` : ""}
                </div>`;
        }
        else if (type === "CLOSEOUT_FINALIZED") {
            subject = `🔒 [PROJEKT ROZLICZONY] Oficjalne zamknięcie budowy · ${siteName}`;
            recipients = [managerEmail, dyrektorEmail, szefEmail, ...additionalEmails].filter(Boolean);

            htmlContent = `
                <div style="font-family:sans-serif;max-width:650px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#15803d;color:#fff;padding:16px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">🔒 Projekt Został Oficjalnie Zamknięty</h2>
                        <p style="margin:4px 0 0 0;font-size:12px;color:#bbf7d0">Budowa: <b>${siteName}</b></p>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Dyrektor / Prezes autoryzował podpisem zamknięcie projektu: <b>${siteName}</b>.</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">Budowa została oznaczona w systemie PESAM jako <b>ZAKOŃCZONA</b>. Alokacje sprzętowe zostały rozliczone, straty spisano w koszty, a pozycje sporne przekazano do ewentualnego refakturowania inwestora.</p>
                        
                        ${financeBoxHtml}
                        ${notesHtml}

                        <h4 style="font-size:12px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Ostateczny wykaz spisanych strat (LIKWIDACJA):</h4>
                        <table style="width:100%;border-collapse:collapse">${lossTableRows}</table>

                        ${disputedHtml}
                        ${scrappedHtml}
                        ${consumedHtml}
                        ${siteDamagesHtml}
                        ${detectiveHtml}

                        <p style="font-size:12px;color:#64748b;text-align:center;margin-top:20px;border-top:1px dashed #e2e8f0;padding-top:10px">
                            Oficjalny dokument rozliczeniowy został trwale zarchiwizowany w bazie PESAM Cloud. Sprawa zakończona.
                        </p>
                    </div>
                </div>`;
        }

        const finalRecipients = isSandbox ? testEmails : recipients.filter(Boolean);

        if (finalRecipients.length === 0) {
            console.warn(`[Mailer] Brak odbiorców dla wysyłki ${type}!`);
            return NextResponse.json({
                success: false,
                error: isSandbox
                    ? "Brak skonfigurowanych adresów testowych w Ustawieniach Systemu!"
                    : "Brak zdefiniowanych adresatów (sprawdź e-mail kierownika lub dyrekcji w Ustawieniach)!"
            }, { status: 400 });
        }

        await transporter.sendMail({
            from: senderString,
            to: finalRecipients.join(", "),
            subject: subject,
            html: htmlContent
        });

        console.log(`[Mailer] Pomyślnie wysłano e-mail rozliczenia do: ${finalRecipients.join(", ")}`);
        return NextResponse.json({ success: true, message: `Wysłano e-mail rozliczenia budowy` });

    } catch (error: any) {
        console.error("Błąd krytyczny wysyłki e-mail Closeout:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
