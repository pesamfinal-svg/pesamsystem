// src/app/api/orders/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// ─── TYPY ────────────────────────────────────────────────────────────────────
interface OrderItem {
    name: string;
    inventoryNumber?: string;
    quantity: number;
    section: 'NARZĘDZIA' | 'RUSZTOWANIA' | 'MATERIAŁY DODATKOWE';
}

interface OrderPayload {
    orderId: string;
    siteId: string;
    siteName: string;
    user: { uid: string; firstName: string; lastName: string; email?: string };
    cart: OrderItem[];
    sections: {
        narzedzia: OrderItem[];
        rusztowania: OrderItem[];
        materialyDodatkowe: OrderItem[];
    };
    notes: string;
}

// ─── HELPER: zamiana polskich znaków na ASCII (fallback) ─────────────────────
function toAscii(text: string): string {
    return text
        .replace(/ą/g, 'a').replace(/Ą/g, 'A')
        .replace(/ć/g, 'c').replace(/Ć/g, 'C')
        .replace(/ę/g, 'e').replace(/Ę/g, 'E')
        .replace(/ł/g, 'l').replace(/Ł/g, 'L')
        .replace(/ń/g, 'n').replace(/Ń/g, 'N')
        .replace(/ó/g, 'o').replace(/Ó/g, 'O')
        .replace(/ś/g, 's').replace(/Ś/g, 'S')
        .replace(/ź/g, 'z').replace(/Ź/g, 'Z')
        .replace(/ż/g, 'z').replace(/Ż/g, 'Z');
}

// ─── GENERATOR PDF ────────────────────────────────────────────────────────────
async function generateOrderPdf(payload: OrderPayload): Promise<Uint8Array> {
    const { orderId, siteName, user, sections, notes } = payload;
    const now = new Date();
    const dateStr = now.toLocaleDateString('pl-PL', {
        year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('pl-PL', {
        hour: '2-digit', minute: '2-digit',
    });

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    // Ładowanie czcionek Roboto obsługujących polskie znaki
    const [fontBytes, fontBoldBytes] = await Promise.all([
        fetch('https://fonts.gstatic.com/s/roboto/v32/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf').then(r => r.arrayBuffer()),
        fetch('https://fonts.gstatic.com/s/roboto/v32/KFOlCnqEu92Fr1MmWUlvAx05IsDqlA.ttf').then(r => r.arrayBuffer()),
    ]);

    const fontRegular = await pdfDoc.embedFont(fontBytes);
    const fontBold = await pdfDoc.embedFont(fontBoldBytes);

    const page = pdfDoc.addPage([595, 842]); // A4
    const { width, height } = page.getSize();

    // Kolory
    const colorBlue = rgb(0.145, 0.388, 0.922);
    const colorSlate = rgb(0.243, 0.298, 0.369);
    const colorLight = rgb(0.949, 0.953, 0.961);
    const colorDark = rgb(0.118, 0.145, 0.18);
    const colorMuted = rgb(0.561, 0.612, 0.659);
    const colorOrange = rgb(0.851, 0.533, 0.098);

    const margin = 48;
    let y = height - margin;

    // ── Nagłówek (pasek niebieski) ──────────────────────────────────────────
    page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: colorBlue });

    page.drawText('PESAM', {
        x: margin, y: height - 48,
        size: 26, font: fontBold, color: rgb(1, 1, 1),
    });
    page.drawText('System Zarzadzania Magazynem', {
        x: margin, y: height - 68,
        size: 9, font: fontRegular, color: rgb(0.8, 0.88, 1),
    });

    // Numer zamówienia (prawy górny róg)
    const orderLabel = `Nr: ${orderId}`;
    const orderLabelWidth = fontBold.widthOfTextAtSize(orderLabel, 10);
    page.drawText(orderLabel, {
        x: width - margin - orderLabelWidth,
        y: height - 42,
        size: 10, font: fontBold, color: rgb(1, 1, 1),
    });
    const dateLabel = `${dateStr}  ${timeStr}`;
    const dateLabelWidth = fontRegular.widthOfTextAtSize(dateLabel, 8);
    page.drawText(dateLabel, {
        x: width - margin - dateLabelWidth,
        y: height - 58,
        size: 8, font: fontRegular, color: rgb(0.8, 0.88, 1),
    });

    y = height - 100;

    // ── Tytuł dokumentu ─────────────────────────────────────────────────────
    page.drawText('DOKUMENT ZAMOWIENIA', {
        x: margin, y,
        size: 16, font: fontBold, color: colorDark,
    });
    y -= 28;

    // ── Blok informacyjny (2 kolumny) ───────────────────────────────────────
    const infoBoxH = 68;
    page.drawRectangle({ x: margin, y: y - infoBoxH, width: width - 2 * margin, height: infoBoxH, color: colorLight });

    const col1x = margin + 16;
    const col2x = margin + (width - 2 * margin) / 2 + 8;
    let iy = y - 20;

    const drawInfoRow = (label: string, value: string, cx: number, cy: number) => {
        page.drawText(label, { x: cx, y: cy, size: 7.5, font: fontRegular, color: colorMuted });
        page.drawText(toAscii(value || '—'), { x: cx, y: cy - 13, size: 9.5, font: fontBold, color: colorDark });
    };

    drawInfoRow('Zamawiajacy:', `${user.firstName} ${user.lastName}`, col1x, iy);
    drawInfoRow('Budowa docelowa:', siteName, col2x, iy);
    iy -= 32;
    drawInfoRow('Data zlozenia:', `${dateStr}, godz. ${timeStr}`, col1x, iy);
    drawInfoRow('Nr zamowienia:', orderId, col2x, iy);

    y -= infoBoxH + 18;

    // ── Pomocnicze funkcje tabeli ────────────────────────────────────────────
    const TABLE_LEFT = margin;
    const TABLE_WIDTH = width - 2 * margin;
    const COL_LP = 28;
    const COL_INV = 70;
    const COL_QTY = 46;
    const COL_NAME = TABLE_WIDTH - COL_LP - COL_INV - COL_QTY;
    const ROW_H = 20;
    const HEADER_H = 22;

    const drawSectionHeader = (title: string, color: typeof colorBlue) => {
        page.drawRectangle({ x: TABLE_LEFT, y: y - 22, width: TABLE_WIDTH, height: 22, color });
        page.drawText(toAscii(title), {
            x: TABLE_LEFT + 10, y: y - 15,
            size: 9, font: fontBold, color: rgb(1, 1, 1),
        });
        y -= 22;
    };

    const drawTableHeader = () => {
        page.drawRectangle({ x: TABLE_LEFT, y: y - HEADER_H, width: TABLE_WIDTH, height: HEADER_H, color: colorSlate });
        const headers = [
            { text: 'Lp.', x: TABLE_LEFT + 6 },
            { text: 'Nazwa przedmiotu', x: TABLE_LEFT + COL_LP + 6 },
            { text: 'Nr Mag.', x: TABLE_LEFT + COL_LP + COL_NAME + 6 },
            { text: 'Ilosc', x: TABLE_LEFT + COL_LP + COL_NAME + COL_INV + 4 },
        ];
        headers.forEach(h => {
            page.drawText(h.text, { x: h.x, y: y - 15, size: 7.5, font: fontBold, color: rgb(1, 1, 1) });
        });
        y -= HEADER_H;
    };

    const drawTableRow = (lp: number, item: OrderItem, shade: boolean) => {
        if (shade) {
            page.drawRectangle({ x: TABLE_LEFT, y: y - ROW_H, width: TABLE_WIDTH, height: ROW_H, color: rgb(0.972, 0.976, 0.984) });
        }
        page.drawLine({ start: { x: TABLE_LEFT, y: y - ROW_H }, end: { x: TABLE_LEFT + TABLE_WIDTH, y: y - ROW_H }, thickness: 0.5, color: rgb(0.88, 0.90, 0.92) });

        const nameMaxChars = 52;
        const rawName = item.name.length > nameMaxChars ? item.name.slice(0, nameMaxChars) + '...' : item.name;

        page.drawText(`${lp}.`, { x: TABLE_LEFT + 6, y: y - 14, size: 8, font: fontRegular, color: colorSlate });
        page.drawText(toAscii(rawName), { x: TABLE_LEFT + COL_LP + 6, y: y - 14, size: 8, font: fontRegular, color: colorDark });
        page.drawText(item.inventoryNumber || '—', { x: TABLE_LEFT + COL_LP + COL_NAME + 6, y: y - 14, size: 8, font: fontRegular, color: colorSlate });
        page.drawText(`${item.quantity} szt.`, { x: TABLE_LEFT + COL_LP + COL_NAME + COL_INV + 4, y: y - 14, size: 8, font: fontBold, color: colorDark });

        y -= ROW_H;
    };

    const drawColumnLines = (startY: number, endY: number) => {
        [COL_LP, COL_LP + COL_NAME, COL_LP + COL_NAME + COL_INV].forEach(cx => {
            page.drawLine({
                start: { x: TABLE_LEFT + cx, y: startY },
                end: { x: TABLE_LEFT + cx, y: endY },
                thickness: 0.5, color: rgb(0.82, 0.85, 0.88),
            });
        });
        page.drawRectangle({ x: TABLE_LEFT, y: endY, width: TABLE_WIDTH, height: startY - endY, borderColor: rgb(0.75, 0.78, 0.82), borderWidth: 0.8 });
    };

    // ── SEKCJA: NARZĘDZIA ────────────────────────────────────────────────────
    if (sections.narzedzia.length > 0) {
        drawSectionHeader('NARZEDZIA I SPRZET', colorBlue);
        const sectionStartY = y;
        drawTableHeader();
        sections.narzedzia.forEach((item, i) => drawTableRow(i + 1, item, i % 2 === 1));
        drawColumnLines(sectionStartY, y);
        y -= 14;
    }

    // ── SEKCJA: RUSZTOWANIA ──────────────────────────────────────────────────
    if (sections.rusztowania.length > 0) {
        drawSectionHeader('RUSZTOWANIA', colorSlate);
        const sectionStartY = y;
        drawTableHeader();
        sections.rusztowania.forEach((item, i) => drawTableRow(i + 1, item, i % 2 === 1));
        drawColumnLines(sectionStartY, y);
        y -= 14;
    }

    // ── SEKCJA: MATERIAŁY DODATKOWE ──────────────────────────────────────────
    if (sections.materialyDodatkowe.length > 0) {
        drawSectionHeader('MATERIALY DODATKOWE', colorOrange);
        const sectionStartY = y;
        drawTableHeader();
        sections.materialyDodatkowe.forEach((item, i) => drawTableRow(i + 1, item, i % 2 === 1));
        drawColumnLines(sectionStartY, y);
        y -= 14;
    }

    // ── Uwagi ────────────────────────────────────────────────────────────────
    if (notes?.trim()) {
        y -= 6;
        page.drawRectangle({ x: TABLE_LEFT, y: y - 46, width: TABLE_WIDTH, height: 46, color: rgb(1, 0.98, 0.93) });
        page.drawRectangle({ x: TABLE_LEFT, y: y - 46, width: 4, height: 46, color: colorOrange });
        page.drawText('UWAGI DO ZAMOWIENIA:', { x: TABLE_LEFT + 12, y: y - 14, size: 7.5, font: fontBold, color: colorOrange });

        const words = toAscii(notes).split(' ');
        let line = '';
        let lineY = y - 26;
        const maxWidth = TABLE_WIDTH - 24;
        for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (fontRegular.widthOfTextAtSize(test, 8.5) > maxWidth) {
                page.drawText(line, { x: TABLE_LEFT + 12, y: lineY, size: 8.5, font: fontRegular, color: colorDark });
                line = word;
                lineY -= 12;
            } else {
                line = test;
            }
        }
        if (line) {
            page.drawText(line, { x: TABLE_LEFT + 12, y: lineY, size: 8.5, font: fontRegular, color: colorDark });
        }
        y -= 60;
    }

    // ── Podpisy ──────────────────────────────────────────────────────────────
    const signY = Math.min(y - 30, 160);
    const signW = (TABLE_WIDTH - 24) / 2;

    const drawSignBox = (label: string, name: string, sx: number) => {
        page.drawLine({ start: { x: sx, y: signY }, end: { x: sx + signW, y: signY }, thickness: 0.8, color: colorSlate });
        page.drawText(label, { x: sx, y: signY - 12, size: 7.5, font: fontRegular, color: colorMuted });
        page.drawText(toAscii(name), { x: sx, y: signY - 24, size: 8.5, font: fontBold, color: colorDark });
    };

    drawSignBox('Zamowil:', `${user.firstName} ${user.lastName}`, TABLE_LEFT);
    drawSignBox('Potwierdzil (Magazyn):', '...................................', TABLE_LEFT + signW + 24);

    // ── Stopka ───────────────────────────────────────────────────────────────
    page.drawRectangle({ x: 0, y: 0, width, height: 28, color: colorLight });
    page.drawText('Wygenerowano automatycznie przez System PESAM  •  Dokument nie wymaga podpisu elektronicznego', {
        x: margin, y: 10, size: 6.5, font: fontRegular, color: colorMuted,
    });
    const pageNum = `Str. 1`;
    const pageNumW = fontRegular.widthOfTextAtSize(pageNum, 6.5);
    page.drawText(pageNum, { x: width - margin - pageNumW, y: 10, size: 6.5, font: fontRegular, color: colorMuted });

    return pdfDoc.save();
}

// ─── HANDLER POST ─────────────────────────────────────────────────────────────
export async function POST(req: Request) {
    try {
        const body: OrderPayload = await req.json();
        const { orderId, siteId, siteName, user, cart, notes, sections } = body;

        // 1. Zapis zamówienia do Firestore (Admin SDK)
        const orderRef = adminDb.collection('orders').doc(orderId);
        await orderRef.set({
            orderId,
            siteId,
            siteName,
            orderedBy: user.uid,
            orderedByName: `${user.firstName} ${user.lastName}`,
            status: 'NOWE',
            notes: notes || '',
            createdAt: new Date().toISOString(),
            items: cart,
        });

        // 2. Usuń draft koszyka (zamówienie złożone)
        try {
            await adminDb.collection('cartDrafts').doc(user.uid).delete();
        } catch (_) {
            // draft mógł nie istnieć
        }

        // 3. Generowanie PDF
        const pdfBytes = await generateOrderPdf(body);
        const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

        // 4. Konfiguracja Nodemailer
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        // 5. Treść HTML e-maila (wspólna)
        const totalItems = cart.length;
        const sectionsSummary = [
            sections.narzedzia.length ? `${sections.narzedzia.length} narzędzi/a` : '',
            sections.rusztowania.length ? `${sections.rusztowania.length} pozycji rusztowań` : '',
            sections.materialyDodatkowe.length ? `${sections.materialyDodatkowe.length} mat. dodatkowych` : '',
        ].filter(Boolean).join(' · ');

        const allItemsHtml = cart.map((item, i) => `
            <tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px">${i + 1}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;font-size:12px">${item.name}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#3b82f6;font-family:monospace;font-size:11px">${item.inventoryNumber || '—'}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:700;font-size:12px">${item.quantity}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:10px;color:#94a3b8">${item.section}</td>
            </tr>
        `).join('');

        const emailHtml = (recipientLabel: string) => `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:680px;margin:0 auto;background:#f1f5f9">
            <div style="background:#2563eb;padding:28px 36px;border-radius:12px 12px 0 0">
                <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900;letter-spacing:-0.5px">PESAM</h1>
                <p style="color:#bfdbfe;margin:4px 0 0;font-size:12px">System Zarządzania Magazynem</p>
            </div>
            <div style="background:#fff;padding:28px 36px">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:20px;border-bottom:2px solid #e2e8f0">
                    <div>
                        <h2 style="margin:0 0 4px;color:#1e293b;font-size:18px">📦 Nowe zamówienie</h2>
                        <p style="margin:0;color:#64748b;font-size:13px">${recipientLabel}</p>
                    </div>
                    <div style="background:#eff6ff;padding:10px 16px;border-radius:8px;text-align:right">
                        <p style="margin:0;font-size:10px;color:#3b82f6;font-weight:700;text-transform:uppercase">Nr zamówienia</p>
                        <p style="margin:4px 0 0;font-size:15px;font-weight:900;color:#1e40af">${orderId}</p>
                    </div>
                </div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
                    <tr>
                        <td style="padding:8px 0;width:50%">
                            <p style="margin:0;font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700">Zamawiający</p>
                            <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#1e293b">${user.firstName} ${user.lastName}</p>
                        </td>
                        <td style="padding:8px 0">
                            <p style="margin:0;font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700">Budowa docelowa</p>
                            <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#1e293b">${siteName}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0" colspan="2">
                            <p style="margin:0;font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700">Pozycje</p>
                            <p style="margin:4px 0 0;font-size:13px;color:#475569">${totalItems} pozycji łącznie: ${sectionsSummary}</p>
                        </td>
                    </tr>
                </table>
                ${notes ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px"><p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#d97706;text-transform:uppercase">Uwagi</p><p style="margin:0;font-size:13px;color:#92400e">${notes}</p></div>` : ''}
                <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
                    <thead>
                        <tr style="background:#1e293b">
                            <th style="padding:10px 12px;color:#fff;text-align:left;font-size:11px;font-weight:700">Lp.</th>
                            <th style="padding:10px 12px;color:#fff;text-align:left;font-size:11px;font-weight:700">Nazwa</th>
                            <th style="padding:10px 12px;color:#fff;text-align:left;font-size:11px;font-weight:700">Nr Mag.</th>
                            <th style="padding:10px 12px;color:#fff;text-align:center;font-size:11px;font-weight:700">Ilość</th>
                            <th style="padding:10px 12px;color:#fff;text-align:left;font-size:11px;font-weight:700">Sekcja</th>
                        </tr>
                    </thead>
                    <tbody>${allItemsHtml}</tbody>
                </table>
            </div>
            <div style="background:#f8fafc;padding:16px 36px;border-radius:0 0 12px 12px;text-align:center">
                <p style="margin:0;font-size:11px;color:#94a3b8">Wiadomość wygenerowana automatycznie przez system PESAM · ${new Date().toLocaleString('pl-PL')}</p>
            </div>
        </div>`;

        // 6. Wysyłka do MAGAZYNU
        await transporter.sendMail({
            from: `"PESAM System" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_WAREHOUSE || process.env.EMAIL_USER,
            subject: `📦 Nowe zamówienie [${siteName}] · ${orderId}`,
            html: emailHtml('Wiadomość do: Magazyn PESAM'),
            attachments: [{
                filename: `zamowienie_${orderId}.pdf`,
                content: pdfBase64,
                encoding: 'base64',
                contentType: 'application/pdf',
            }],
        });

        // 7. Kopia do KIEROWNIKA (jeśli ma e-mail)
        if (user.email && user.email !== process.env.EMAIL_WAREHOUSE) {
            await transporter.sendMail({
                from: `"PESAM System" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: `✅ Twoje zamówienie zostało złożone · ${orderId}`,
                html: emailHtml(`Kopia dla: ${user.firstName} ${user.lastName}`),
                attachments: [{
                    filename: `zamowienie_${orderId}.pdf`,
                    content: pdfBase64,
                    encoding: 'base64',
                    contentType: 'application/pdf',
                }],
            });
        }

        return NextResponse.json({
            success: true,
            message: 'Zamówienie zapisane, PDF wygenerowany i e-maile wysłane!',
            orderId,
        });

    } catch (error: any) {
        console.error('Błąd API Orders:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}