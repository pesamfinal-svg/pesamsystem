// src/app/api/tarnow-generate-docx/route.ts
// Generuje plik Word (.docx) z Oświadczeniem właściciela o przejęciu odpowiedzialności

import { NextResponse } from 'next/server';
import JSZip from 'jszip';

export const maxDuration = 30;

interface Dokument {
    nazwa: string;
    ilosc: number;
    uwagi: string;
}

function escapeXml(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildDocumentXml(params: {
    pracownik: string;
    teczkaOpis: string;
    dataOd: string;
    dataDo: string;
    dokumenty: Dokument[];
    uwagi: string;
    dataWypelnienia: string;
}): string {
    const { pracownik, dokumenty, dataWypelnienia } = params;

    // Buduj listę numerowaną dokumentów
    const docItemsXml = dokumenty.map((dok, index) => {
        const countInfo = dok.ilosc > 1 ? ` (${dok.ilosc} szt.)` : '';
        const uwagiInfo = dok.uwagi ? ` — ${dok.uwagi}` : '';
        const fullText = `${index + 1}.   ${dok.nazwa}${countInfo}${uwagiInfo}`;
        return `
    <w:p>
      <w:pPr>
        <w:ind w:left="360"/>
        <w:spacing w:after="60"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          <w:sz w:val="22"/>
        </w:rPr>
        <w:t>${escapeXml(fullText)}</w:t>
      </w:r>
    </w:p>`;
    }).join('');

    const formattedDate = dataWypelnienia
        ? new Date(dataWypelnienia).toLocaleDateString('pl-PL')
        : '........................';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>

    <!-- Miejsce i data po prawej -->
    <w:p>
      <w:pPr>
        <w:jc w:val="right"/>
        <w:spacing w:after="360"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          <w:sz w:val="22"/>
        </w:rPr>
        <w:t xml:space="preserve">Dębica, dnia ${escapeXml(formattedDate)}</w:t>
      </w:r>
    </w:p>

    <!-- Tytuł dokumentu wycentrowany -->
    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:spacing w:before="200" w:after="60"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          <w:b/>
          <w:sz w:val="28"/>
        </w:rPr>
        <w:t>OŚWIADCZENIE właściciela</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:spacing w:after="300"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          <w:b/>
          <w:sz w:val="22"/>
        </w:rPr>
        <w:t>o przejęciu odpowiedzialności za dokumenty i ich stan</w:t>
      </w:r>
    </w:p>

    <!-- Dane osobowe -->
    <w:p>
      <w:pPr><w:spacing w:after="100"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t xml:space="preserve">Ja, niżej podpisany/a: </w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="22"/></w:rPr>
        <w:t>${escapeXml(pracownik || '......................................................')}</w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t xml:space="preserve"> ur. ..........................................</w:t>
      </w:r>
    </w:p>

    <w:p>
      <w:pPr><w:spacing w:after="140"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t>Seria i numer dowodu osobistego / PESEL: ....................................................</w:t>
      </w:r>
    </w:p>

    <w:p>
      <w:pPr><w:spacing w:after="140"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t>niniejszym oświadczam, że w dniu .............................2026 r. przyjąłem/am do swojej dyspozycji dokumenty wyszczególnione w poniższym zestawieniu:</w:t>
      </w:r>
    </w:p>

    <!-- Lista dokumentów -->
    ${docItemsXml}

    <!-- Punkty oświadczenia -->
    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="22"/></w:rPr>
        <w:t>W związku z powyższym oświadczam, że:</w:t>
      </w:r>
    </w:p>

    <w:p>
      <w:pPr><w:ind w:left="240"/><w:spacing w:after="80"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t>- w momencie odbioru zapoznałem/am się ze stanem technicznym i wizualnym dokumentów i nie wnoszę do ich stanu żadnych zastrzeżeń</w:t>
      </w:r>
    </w:p>

    <w:p>
      <w:pPr><w:ind w:left="240"/><w:spacing w:after="80"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t xml:space="preserve">- biorę </w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="22"/></w:rPr>
        <w:t>pełną odpowiedzialność</w:t>
      </w:r>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t xml:space="preserve"> za odebrane dokumenty</w:t>
      </w:r>
    </w:p>

    <w:p>
      <w:pPr><w:ind w:left="240"/><w:spacing w:after="180"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
        <w:t>- akceptuję fakt, iż strona przekazująca nie miała wpływu na sposób, ilość, wady ukryte, ewentualne braki w dokumentacji, błędy w treści ani naturalne zniszczenie i nie będę wnosił/a w przyszłości żadnych roszczeń w związku z powyższym.</w:t>
      </w:r>
    </w:p>

    <!-- Klauzula czerwona UWAGA -->
    <w:p>
      <w:pPr>
        <w:spacing w:before="200" w:after="400"/>
        <w:pBdr>
          <w:top w:val="single" w:sz="6" w:space="4" w:color="CCCCCC"/>
          <w:bottom w:val="single" w:sz="6" w:space="4" w:color="CCCCCC"/>
        </w:pBdr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          <w:b/>
          <w:color w:val="CC0000"/>
          <w:sz w:val="22"/>
        </w:rPr>
        <w:t>UWAGA: Informujemy, iż dokumentacja pracownicza po PSS SPOŁEM Tarnów została przekazana w całości, a w naszym posiadaniu nie znajdują się już żadne inne materiały dotyczące tej sprawy.</w:t>
      </w:r>
    </w:p>

    <!-- Linia na podpis -->
    <w:p>
      <w:pPr>
        <w:jc w:val="right"/>
        <w:spacing w:before="500" w:after="40"/>
      </w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/></w:rPr>
        <w:t>........................................................................................</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:jc w:val="right"/>
        <w:spacing w:after="0"/>
      </w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="18"/></w:rPr>
        <w:t>(czytelny podpis osoby składającej oświadczenie)</w:t>
      </w:r>
    </w:p>

    <!-- Ustawienia strony A4 -->
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const {
            pracownik = '',
            teczkaOpis = '',
            dataOd = '',
            dataDo = '',
            dokumenty = [] as Dokument[],
            uwagi = '',
            dataWypelnienia = new Date().toISOString().split('T')[0],
        } = body;

        const documentXml = buildDocumentXml({
            pracownik,
            teczkaOpis,
            dataOd,
            dataDo,
            dokumenty,
            uwagi,
            dataWypelnienia,
        });

        const zip = new JSZip();

        // 1. [Content_Types].xml — pełny zestaw typów dla Microsoft Word
        zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

        // 2. _rels/.rels
        zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

        // 3. word/document.xml
        zip.file('word/document.xml', documentXml);

        // 4. docProps/core.xml
        zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Oświadczenie - ${escapeXml(pracownik)}</dc:title>
  <dc:creator>PESAM System</dc:creator>
  <cp:lastModifiedBy>PESAM System</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`);

        // 5. docProps/app.xml
        zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Microsoft Office Word</Application>
</Properties>`);

        // Generuj binarkę
        const docxBuffer = await zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const arrayBuffer = docxBuffer.buffer.slice(docxBuffer.byteOffset, docxBuffer.byteOffset + docxBuffer.byteLength) as ArrayBuffer;

        const cleanPracownik = (pracownik || 'oswiadczenie')
            .replace(/ł/g, 'l').replace(/Ł/g, 'L')
            .replace(/ą/g, 'a').replace(/Ą/g, 'A')
            .replace(/ć/g, 'c').replace(/Ć/g, 'C')
            .replace(/ę/g, 'e').replace(/Ę/g, 'E')
            .replace(/ń/g, 'n').replace(/Ń/g, 'N')
            .replace(/ó/g, 'o').replace(/Ó/g, 'O')
            .replace(/ś/g, 's').replace(/Ś/g, 'S')
            .replace(/ź/g, 'z').replace(/Ź/g, 'Z')
            .replace(/ż/g, 'z').replace(/Ż/g, 'Z')
            .replace(/[^a-zA-Z0-9_-]/g, '-')
            .toLowerCase();

        const asciiName = `oswiadczenie-${cleanPracownik}.docx`;
        const utf8Name = encodeURIComponent(`oswiadczenie-${(pracownik || 'dokumenty').replace(/\s+/g, '-').toLowerCase()}.docx`);

        return new Response(arrayBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
                'Content-Length': String(docxBuffer.length),
            },
        });

    } catch (error: unknown) {
        console.error('Błąd generowania DOCX:', error);
        const message = error instanceof Error ? error.message : 'Nieznany błąd';
        return NextResponse.json({ error: `Błąd generowania dokumentu: ${message}` }, { status: 500 });
    }
}
