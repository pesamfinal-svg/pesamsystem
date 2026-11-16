// src/app/api/tarnow-generate-docx/route.ts
// Generuje plik Word (.docx) z wykazem dokumentów archiwalnych

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
    const { pracownik, teczkaOpis, dataOd, dataDo, dokumenty, uwagi, dataWypelnienia } = params;

    // Buduj wiersze tabeli
    const tableRows = dokumenty.map((dok, index) => `
        <w:tr>
            <w:trPr><w:trHeight w:val="400"/></w:trPr>
            <w:tc>
                <w:tcPr><w:tcW w:w="600" w:type="dxa"/><w:tcBorders>
                    <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                </w:tcBorders></w:tcPr>
                <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${index + 1}.</w:t></w:r></w:p>
            </w:tc>
            <w:tc>
                <w:tcPr><w:tcW w:w="4800" w:type="dxa"/><w:tcBorders>
                    <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                </w:tcBorders></w:tcPr>
                <w:p><w:r><w:t>${escapeXml(dok.nazwa)}</w:t></w:r></w:p>
            </w:tc>
            <w:tc>
                <w:tcPr><w:tcW w:w="800" w:type="dxa"/><w:tcBorders>
                    <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                </w:tcBorders></w:tcPr>
                <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${dok.ilosc}</w:t></w:r></w:p>
            </w:tc>
            <w:tc>
                <w:tcPr><w:tcW w:w="2800" w:type="dxa"/><w:tcBorders>
                    <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                    <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
                </w:tcBorders></w:tcPr>
                <w:p><w:r><w:t>${escapeXml(dok.uwagi)}</w:t></w:r></w:p>
            </w:tc>
        </w:tr>`).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 wp14">
  <w:body>

    <!-- Miejsce i data -->
    <w:p>
      <w:pPr><w:jc w:val="right"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>Tarnów, dnia ${escapeXml(dataWypelnienia)}</w:t></w:r>
    </w:p>

    <!-- Tytuł -->
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="200" w:after="100"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>WYKAZ DOKUMENTÓW ARCHIWALNYCH</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="100"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t>PSS SPOŁEM Tarnów – Archiwum</w:t></w:r>
    </w:p>

    <!-- Linia oddzielająca -->
    <w:p>
      <w:pPr><w:spacing w:before="100" w:after="100"/><w:pBdr>
        <w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/>
      </w:pBdr></w:pPr>
    </w:p>

    <!-- Dane pracownika -->
    <w:p>
      <w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Pracownik: </w:t></w:r>
      <w:r><w:t>${escapeXml(pracownik || '............................................')}</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:spacing w:after="80"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Opis teczki/segregatora: </w:t></w:r>
      <w:r><w:t>${escapeXml(teczkaOpis || '............................................')}</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:spacing w:after="80"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Okres dokumentów: </w:t></w:r>
      <w:r><w:t>od ${escapeXml(dataOd || '...............')} do ${escapeXml(dataDo || '...............')}</w:t></w:r>
    </w:p>

    <!-- Tabela dokumentów -->
    <w:p><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Zawartość teczki:</w:t></w:r>
    </w:p>

    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="9000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
          <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
          <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        </w:tblBorders>
        <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>
      </w:tblPr>

      <!-- Nagłówek tabeli -->
      <w:tr>
        <w:trPr><w:tblHeader/><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:trPr>
        <w:tc>
          <w:tcPr><w:tcW w:w="600" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Lp.</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="4800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tcPr>
          <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Nazwa dokumentu</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Ilość</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="2800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tcPr>
          <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Uwagi</w:t></w:r></w:p>
        </w:tc>
      </w:tr>

      ${tableRows}
    </w:tbl>

    <!-- Uwagi -->
    ${uwagi ? `
    <w:p><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Uwagi archiwisty: </w:t></w:r>
      <w:r><w:t>${escapeXml(uwagi)}</w:t></w:r>
    </w:p>` : ''}

    <!-- Klauzula -->
    <w:p>
      <w:pPr><w:spacing w:before="300" w:after="100"/><w:jc w:val="both"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="CC0000"/></w:rPr>
        <w:t>UWAGA: Informujemy, że dokumentacja pracownika po PSS SPOŁEM Tarnów została przekazana w całości, a w naszym posiadaniu nie znajdują się już żadne inne materiały dotyczące tej sprawy.</w:t>
      </w:r>
    </w:p>

    <!-- Podpis -->
    <w:p><w:pPr><w:spacing w:before="600" w:after="0"/><w:jc w:val="right"/></w:pPr>
      <w:r><w:t>.........................................................</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>(czytelny podpis osoby składającej oświadczenie)</w:t></w:r>
    </w:p>

    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>
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

        // Buduj zawartość XML dokumentu
        const documentXml = buildDocumentXml({
            pracownik,
            teczkaOpis,
            dataOd,
            dataDo,
            dokumenty,
            uwagi,
            dataWypelnienia,
        });

        // Buduj DOCX jako ZIP
        const zip = new JSZip();

        // [Content_Types].xml
        zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

        // _rels/.rels
        zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

        // word/document.xml
        zip.file('word/document.xml', documentXml);

        // word/_rels/document.xml.rels
        zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`);

        // word/settings.xml
        zip.file('word/settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`);

        // docProps/app.xml
        zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>PESAM System - Archiwum Tarnów</Application>
  <Company>PSS SPOŁEM Tarnów</Company>
</Properties>`);

        // docProps/core.xml
        zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Wykaz Dokumentów Archiwalnych - ${escapeXml(pracownik)}</dc:title>
  <dc:creator>PESAM System</dc:creator>
  <cp:lastModifiedBy>PESAM System</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`);

        // Generuj plik binarny
        const docxBuffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const arrayBuffer = docxBuffer.buffer.slice(docxBuffer.byteOffset, docxBuffer.byteOffset + docxBuffer.byteLength) as ArrayBuffer;

        const safeName = pracownik
            ? `archiwum-${pracownik.replace(/\s+/g, '-').toLowerCase()}.docx`
            : 'archiwum-tarnow.docx';

        return new Response(arrayBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': `attachment; filename="${safeName}"`,
                'Content-Length': String(docxBuffer.length),
            },
        });

    } catch (error: unknown) {
        console.error('Błąd generowania DOCX:', error);
        const message = error instanceof Error ? error.message : 'Nieznany błąd';
        return NextResponse.json({ error: `Błąd generowania dokumentu: ${message}` }, { status: 500 });
    }
}
