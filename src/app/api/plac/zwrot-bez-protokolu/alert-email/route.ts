// src/app/api/plac/zwrot-bez-protokolu/alert-email/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface AlertItem {
    name: string;
    quantity?: number;
    returnQty?: number;
    unit?: string;
    category?: string;
    inventoryNumber?: string;
    condition?: string;
    isSecured?: boolean;
    rulesCompliant?: boolean;
    ruleNotes?: string;
    isSuspectedTransfer?: boolean;
}

interface AlertEmailPayload {
    protocolId: string;
    siteName: string;
    driverName: string;
    reasonForNoProtocol?: string;
    items: AlertItem[];
    photoUrls?: string[];
    aiConversationTranscript?: string;
    bypassCode?: string;
    suggestedNewRule?: string;
}

export async function POST(req: Request) {
    try {
        const body: AlertEmailPayload = await req.json();
        const {
            protocolId,
            siteName,
            driverName,
            reasonForNoProtocol = "Nie określono",
            items = [],
            photoUrls = [],
            aiConversationTranscript = "",
            bypassCode = "",
            suggestedNewRule = ""
        } = body;

        // 1. Pobierz konfigurację powiadomień z settings/system
        const settingsSnap = await adminDb.doc("settings/system").get();
        const settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};

        const configuredBypass = (settings.noProtocolBypassCode || "jebacto").trim().toLowerCase();
        const providedBypass = bypassCode.trim().toLowerCase();

        // 2. KOD ZABEZPIECZAJĄCY (BYPASS)
        // Jeśli podano poprawny kod (np. "jebacto"), celowo powstrzymujemy wysyłkę e-maila
        if (providedBypass && providedBypass === configuredBypass) {
            console.log(`[AlertEmail] Wysyłka e-mail dla ${protocolId} pominięta przez kod zabezpieczający: ${providedBypass}`);
            return NextResponse.json({
                success: true,
                bypassed: true,
                message: "Alert e-mail pominięty na podstawie kodu zabezpieczającego (bypass)."
            }, { status: 200 });
        }

        const recipients: string[] = settings.noProtocolEmailRecipients || [];
        if (recipients.length === 0) {
            return NextResponse.json({
                success: true,
                message: "Brak zdefiniowanych odbiorców powiadomień o zwrotach bez protokołu w Ustawieniach Systemu."
            }, { status: 200 });
        }

        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("Brak konfiguracji EMAIL_USER / EMAIL_PASS w środowisku!");
            return NextResponse.json({
                success: false,
                message: "Brak zmiennych środowiskowych poczty EMAIL_USER/EMAIL_PASS."
            }, { status: 200 });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const hasTransfer = items.some(it => it.isSuspectedTransfer);
        const hasViolations = items.some(it => it.rulesCompliant === false || it.isSecured === false || it.condition === "USZKODZONY");

        const subject = `🚨 [PESAM PLAC] Zwrot Bez Protokołu · ${protocolId} · Budowa: ${siteName || "Nieznana"} · Kierowca: ${driverName || "Nieznany"}${hasTransfer ? " ⚠️ [PODEJRZENIE PRZERZUTU]" : ""}`;

        const rowsHtml = items.map((it, idx) => {
            const rawQty = it.quantity ?? it.returnQty;
            const itemQty = (typeof rawQty === 'number' && !isNaN(rawQty) && rawQty > 0) ? rawQty : (Number(rawQty) > 0 ? Number(rawQty) : 1);
            return `
            <tr style="border-bottom:1px solid #e2e8f0; background-color: ${idx % 2 === 0 ? '#fff' : '#f8fafc'};">
                <td style="padding:10px 12px; font-weight:bold; color:#1e293b;">
                    ${it.name}
                    ${it.inventoryNumber ? `<br/><span style="display:inline-block; background:#e0f2fe; color:#0369a1; padding:2px 6px; border-radius:4px; font-size:10px; font-family:monospace; font-weight:bold; margin-top:3px;">Nr mag: ${it.inventoryNumber}</span>` : ''}
                    ${it.isSuspectedTransfer ? `<br/><span style="display:inline-block; background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-top:3px;">⚠️ Podejrzenie przerzutu</span>` : ''}
                </td>
                <td style="padding:10px 12px; color:#475569; font-size:12px;">
                    ${it.category || "Inne"}
                </td>
                <td style="padding:10px 12px; color:#1e293b; font-weight:bold; text-align:center;">
                    ${itemQty} ${it.unit || "szt."}
                </td>
                <td style="padding:10px 12px; font-size:11px;">
                    ${it.condition ? `<b style="color:${it.condition === 'USZKODZONY' ? '#dc2626' : '#16a34a'};">${it.condition}</b><br/>` : ''}
                    ${it.isSecured === false ? '<span style="color:#dc2626; font-weight:bold;">Niepospinane</span><br/>' : ''}
                    <span style="color:#64748b; font-style:italic;">${it.ruleNotes || "-"}</span>
                </td>
            </tr>
        `;
        }).join("");

        const photosHtml = photoUrls && photoUrls.length > 0
            ? `
                <div style="margin-top:16px; padding:12px; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">
                    <h4 style="margin:0 0 10px; font-size:12px; text-transform:uppercase; color:#475569; font-weight:bold;">
                        📸 Zdjęcia wykonane telefonem na placu (${photoUrls.length}):
                    </h4>
                    <div style="display:flex; gap:10px; flex-wrap:wrap;">
                        ${photoUrls.map((url, i) => `
                            <a href="${url}" target="_blank" style="display:inline-block; border-radius:8px; overflow:hidden; border:1px solid #cbd5e1;">
                                <img src="${url}" alt="Foto ${i + 1}" style="width:120px; height:120px; object-fit:cover; display:block;" />
                            </a>
                        `).join("")}
                    </div>
                </div>
            `
            : '';

        const transcriptHtml = aiConversationTranscript
            ? `
                <div style="margin-top:16px; padding:12px; background:#0f172a; color:#f8fafc; border-radius:12px; font-family:monospace; font-size:11px; max-height:220px; overflow-y:auto; line-height:1.5; white-space:pre-wrap;">
                    <div style="color:#94a3b8; font-weight:bold; margin-bottom:6px; text-transform:uppercase; font-size:10px;">Zapis dialogu magazyniera z asystentem AI:</div>
                    ${aiConversationTranscript}
                </div>
            `
            : '';

        const htmlContent = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width:680px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:16px; border:1px solid #e2e8f0;">
                <div style="background: linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%); color:#fff; padding:20px; border-radius:14px; text-align:center; box-shadow:0 4px 14px rgba(67, 56, 202, 0.25);">
                    <div style="font-size:28px; margin-bottom:4px;">🎙️ 🚨</div>
                    <h2 style="margin:0; font-size:18px; text-transform:uppercase; letter-spacing:1px; font-weight:900;">
                        Zgłoszenie Zwrotu Bez Protokołu (ZBP)
                    </h2>
                    <p style="margin:6px 0 0; font-size:12px; opacity:0.9;">
                        Na placu magazynowym PESAM przyjęto materiały lub sprzęt bez fizycznego protokołu z budowy.
                    </p>
                </div>

                <div style="background:#ffffff; padding:18px; margin-top:16px; border-radius:14px; border:1px solid #e2e8f0;">
                    <table style="width:100%; font-size:13px; color:#334155; border-collapse:collapse;">
                        <tr>
                            <td style="padding:6px 0; color:#64748b; width:150px;">Numer ewidencji:</td>
                            <td style="padding:6px 0; font-weight:bold; font-family:monospace; color:#4338ca;">${protocolId}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0; color:#64748b;">Budowa źródłowa:</td>
                            <td style="padding:6px 0; font-weight:bold; color:#0f172a;">${siteName || "Nieokreślona"}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0; color:#64748b;">Kierowca / Zdający:</td>
                            <td style="padding:6px 0; font-weight:bold; color:#0f172a;">${driverName || "Nieokreślony"}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0; color:#64748b;">Powód braku protokołu:</td>
                            <td style="padding:6px 0; font-weight:bold; color:#b45309; background:#fffbeb; padding-left:6px; border-radius:6px;">
                                ${reasonForNoProtocol}
                            </td>
                        </tr>
                        ${hasTransfer ? `
                        <tr>
                            <td style="padding:6px 0; color:#b45309; font-weight:bold;">⚠️ Status alokacji:</td>
                            <td style="padding:6px 0; font-weight:bold; color:#b45309;">
                                PODEJRZENIE PRZERZUTU SPRZĘTU MIĘDZY BUDOWAMI (sprzęt nie figurował w systemie na stanie tej budowy)
                            </td>
                        </tr>
                        ` : ''}
                    </table>
                </div>

                ${suggestedNewRule ? `
                <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:14px; padding:14px 18px; margin-top:16px;">
                    <div style="color:#1d4ed8; font-weight:900; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">
                        💡 NOWA REGUŁA / ZGŁOSZENIE PROCEDURALNE OD MAGAZYNIERA (AI):
                    </div>
                    <div style="color:#1e3a8a; font-size:13px; font-weight:bold;">
                        "${suggestedNewRule}"
                    </div>
                    <div style="color:#64748b; font-size:11px; margin-top:4px;">
                        Asystent AI zarejestrował tę uwagę z dialogu. Reguła została zaktualizowana w Ustawieniach Reguł Magazynu.
                    </div>
                </div>
                ` : ''}

                <div style="background:#ffffff; margin-top:16px; border-radius:14px; border:1px solid #e2e8f0; overflow:hidden;">
                    <div style="padding:12px 16px; background:#f1f5f9; border-bottom:1px solid #e2e8f0; font-weight:bold; font-size:12px; color:#334155; text-transform:uppercase;">
                        📦 Zwrócone pozycje (${items.length}):
                    </div>
                    <table style="width:100%; font-size:12px; border-collapse:collapse;">
                        <thead>
                            <tr style="background:#f8fafc; border-bottom:1px solid #cbd5e1; text-align:left; color:#64748b; font-size:11px;">
                                <th style="padding:8px 12px;">Materiał / Sprzęt</th>
                                <th style="padding:8px 12px;">Kategoria</th>
                                <th style="padding:8px 12px; text-align:center;">Ilość</th>
                                <th style="padding:8px 12px;">Stan / Reguły</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>

                ${photosHtml}
                ${transcriptHtml}

                <div style="text-align:center; margin-top:20px; font-size:11px; color:#94a3b8;">
                    Wiadomość wygenerowana automatycznie przez <b>PESAM System AI (Moduł Placu)</b>.<br/>
                    Aby anulować alerty przy testach, użyj skonfigurowanego kodu zabezpieczającego.
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"PESAM System AI - Plac" <${process.env.EMAIL_USER}>`,
            to: recipients.join(', '),
            subject: subject,
            html: htmlContent,
        });

        console.log(`[AlertEmail] Wysłano powiadomienie o zwrocie bez protokołu (${protocolId}) do: ${recipients.join(', ')}`);

        return NextResponse.json({
            success: true,
            bypassed: false,
            message: `Wysłano alert e-mail do ${recipients.length} odbiorców.`
        });
    } catch (error: any) {
        console.error("Błąd wysyłania alert-email:", error);
        return NextResponse.json({
            success: false,
            error: error?.message || "Internal server error"
        }, { status: 500 });
    }
}
