// src/app/api/merge-attachments/route.ts
import { NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';

// Zwiększenie limitu czasu wykonania (na wypadek bardzo wielu ciężkich plików)
export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do połączenia" }, { status: 400 });
        }

        // Tworzymy nowy, czysty dokument PDF
        const mergedPdf = await PDFDocument.create();

        for (const file of files) {
            const fileBytes = Buffer.from(file.fileBase64, 'base64');

            if (file.mimeType === 'application/pdf') {
                // Obsługa PDF: ładujemy i kopiujemy KAŻDĄ stronę (obsługuje pliki wielostronicowe!)
                const pdfDoc = await PDFDocument.load(fileBytes);
                const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                copiedPages.forEach((page) => mergedPdf.addPage(page));
            } else if (file.mimeType.startsWith('image/')) {
                // Obsługa zdjęć i screenshotów: tworzymy nową stronę A4 i osadzamy obraz
                const page = mergedPdf.addPage();
                const { width, height } = page.getSize();

                let embeddedImage;
                if (file.mimeType === 'image/png') {
                    embeddedImage = await mergedPdf.embedPng(fileBytes);
                } else {
                    embeddedImage = await mergedPdf.embedJpg(fileBytes);
                }

                // Automatyczne dopasowanie proporcji obrazu do strony A4
                const imageDims = embeddedImage.scaleToFit(width - 40, height - 40);

                // Centrowanie obrazu na stronie
                const x = (width - imageDims.width) / 2;
                const y = (height - imageDims.height) / 2;

                page.drawImage(embeddedImage, {
                    x,
                    y,
                    width: imageDims.width,
                    height: imageDims.height,
                });
            }
        }

        // Generujemy scalony plik PDF
        const mergedPdfBytes = await mergedPdf.save();
        const mergedPdfBase64 = Buffer.from(mergedPdfBytes).toString('base64');

        return NextResponse.json({ pdfBase64: mergedPdfBase64 }, { status: 200 });

    } catch (error: any) {
        console.error("Błąd podczas bezlimitowego scalania plików PDF:", error);
        return NextResponse.json({ error: error.message || "Błąd serwera" }, { status: 500 });
    }
}